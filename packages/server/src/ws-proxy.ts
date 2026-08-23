/**
 * 浏览器 WS ↔ 隧道 ws 通道桥接（spec §7.2）。
 * 注意：无/失效 cookie 与各类握手失败都在 upgrade 前的原始 socket 上手写 HTTP 响应（WS 握手无法 302）；
 * ws.reject 的响应原样回写（鉴权拒绝透传到浏览器）；回选子协议必须属于 ws.open.protocols，不符即断通道（第三轮修订）；
 * handleUpgrade 前改写 req.headers['sec-websocket-protocol'] 为客户端回选值，
 * 配合 browserWss 的 handleProtocols 完成回显。
 */

import { STATUS_CODES } from 'node:http';

import { type BrowserSessionStore, readSessionCookie, stripSessionCookie } from './browser-session';
import { type ControlFrame, type DataHeader, exceedsMaxDataFrame, type HeadersJson, normalizeHeaders, stripHopByHop } from './protocol';
import { safePathname } from './url';

import type { Logger } from './logger';
import type { PendingChannel, TunnelRegistry } from './session';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';



export interface ProxyContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  selectPath: string;
  headTimeoutMs: number;
  logger: Logger;
}

/** 在 upgrade 前的原始 socket 上手写 HTTP 响应（401/502/504/ws.reject 透传共用） */
function writeRawResponse(
  socket: Duplex,
  status: number,
  headers: HeadersJson,
  body: Buffer,
): void {
  const filtered = stripHopByHop(normalizeHeaders(headers));
  delete filtered['content-length']; // 长度以实际 body 为准，防止透传值不一致
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    ...Object.entries(filtered).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`)),
    `content-length: ${body.length}`,
    'connection: close',
    '',
    '',
  ];
  // socket.end 一次性写出：Node 保证 flush 后才 FIN；write+destroy 可能 RST 截断待发数据（审查修复 Important 1）
  const head = lines.join('\r\n');
  socket.end(body.length > 0 ? Buffer.concat([Buffer.from(head), body]) : head);
}

/**
 * 关闭码矫正（与客户端 ws-channel 已审定口径一致：仅 1000 或 3000-4999，非法→1000）：
 * ws.close 对非法码同步抛 RangeError，双端同一口径避免矫正结果不对称。
 */
function sanitizeCloseCode(code: number | undefined): number {
  if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) return code;
  return 1000;
}

/** 关闭原因矫正：ws 限 123 字节，超长按码点截断（for..of 不切代理对，不产生坏 UTF-8） */
function sanitizeCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined || Buffer.byteLength(reason, 'utf8') <= 123) return reason;
  let out = '';
  let bytes = 0;
  for (const ch of reason) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (bytes + len > 123) break;
    out += ch;
    bytes += len;
  }
  return out;
}

/** 浏览器 WS upgrade 入口（非保留路径） */
export function handleBrowserWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  browserWss: WebSocketServer,
  ctx: ProxyContext,
): void {
  // 裸 socket error 消化（线上事故修复）：http.Server 'upgrade' 交出的 socket 上
  // Node 不保留任何 error 监听（Node 26 实测 listenerCount('error')===0），
  // accept 等待窗/拒绝回写期间对端 RST 的 ECONNRESET 会以未处理 'error' 事件崩进程。
  // error 之后必随 close，通道清理由下方既有 close 处理器完成，此处仅消化 + 记日志。
  // 必须在会话检查之前挂上：401/502 拒绝回写（writeRawResponse）落在已 RST 连接上同样异步报错。
  socket.on('error', (err: Error) => {
    ctx.logger.warn('浏览器 WS 裸 socket 错误（对端断开/RST）', { error: err.message });
  });

  // cookie 会话检查：WS 握手无法 302，401 拒绝
  const uuid = readSessionCookie(req.headers.cookie);
  const session = uuid ? ctx.sessions.get(uuid) : undefined;
  if (!session) {
    writeRawResponse(socket, 401, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('unauthorized'));
    return;
  }
  const tunnel = ctx.tunnels.get(session.hostname);
  if (!tunnel) {
    writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('tunnel offline'));
    return;
  }

  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const headers = normalizeHeaders(req.headers);
  headers['authorization'] = `Bearer ${session.token}`;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie === undefined) delete headers['cookie'];
  else headers['cookie'] = cookie;
  const remote = req.socket.remoteAddress;
  if (remote) {
    const existing = headers['x-forwarded-for'];
    const first = Array.isArray(existing) ? existing.join(', ') : existing;
    headers['x-forwarded-for'] = first ? `${first}, ${remote}` : remote;
  }
  delete headers['host'];

  let browserWs: WebSocket | null = null;
  let finished = false;
  let acceptTimer: NodeJS.Timeout | null = null;
  const finish = (fn: () => void): void => {
    if (finished) return;
    finished = true;
    if (acceptTimer) clearTimeout(acceptTimer);
    tunnel.unregister(channelId);
    fn();
  };

  const channel: PendingChannel = {
    kind: 'ws',
    onControl: (frame: ControlFrame) => {
      if (frame.type === 'ws.accept') {
        // 子协议回选校验（第三轮修订）：不属于 ws.open.protocols 即断通道
        if (frame.protocol !== undefined && !protocols.includes(frame.protocol)) {
          ctx.logger.warn('客户端回选子协议非法，断通道', { channelId, protocol: frame.protocol });
          finish(() => {
            tunnel.sendControl({ type: 'channel.close', channelId, reason: 'invalid subprotocol' });
            socket.destroy();
          });
          return;
        }
        if (acceptTimer) clearTimeout(acceptTimer);
        acceptTimer = null;
        // 回显客户端选定的子协议：改写请求头后由 handleProtocols 回选
        if (frame.protocol !== undefined) req.headers['sec-websocket-protocol'] = frame.protocol;
        else delete req.headers['sec-websocket-protocol'];
        browserWss.handleUpgrade(req, socket, head, (ws) => {
          browserWs = ws;
          wireBrowserWs(ws);
        });
        return;
      }
      if (frame.type === 'ws.reject') {
        // 客户端鉴权拒绝/upstream 失败：响应原样回浏览器
        finish(() => writeRawResponse(socket, frame.status, frame.headers ?? {}, Buffer.from(frame.body ?? '')));
        return;
      }
      if (frame.type === 'channel.error') {
        ctx.logger.error('WS 通道级错误（客户端回报）', { channelId, message: frame.message });
        // accept 前 browserWs 未建立：必须处置裸 socket（回 502），否则 finish 清超时器后浏览器永久悬挂（审查修复 Important 2）
        finish(() => {
          if (browserWs) browserWs.close(1011, 'upstream error');
          else writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('upstream error'));
        });
        return;
      }
      if (frame.type === 'channel.close') {
        // 客户端（upstream）主动关闭：同码透传浏览器（非法码/超长 reason 矫正后透传，防 ws.close 同步抛）。
        // accept 前 browserWs 未建立：与 channel.error 同构——必须处置裸 socket（回 502），
        // 否则 finish 清超时器后浏览器永久悬挂（审查修复轮 2；onTunnelDown 的 accept 前 502 为同范式）
        finish(() => {
          if (browserWs) {
            browserWs.close(sanitizeCloseCode(frame.code), sanitizeCloseReason(frame.reason));
          } else {
            writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('upstream closed'));
          }
        });
      }
    },
    onData: (header: DataHeader, payload: Buffer) => {
      if (header.kind === 'ws.message' && browserWs) {
        // 对端 CLOSING 窗口 send 防御消化（前序经验）：ws 8 此时静默丢弃不抛，try/catch 兜底防版本差异
        try {
          browserWs.send(payload, { binary: header.dataType === 'binary' });
        } catch (err) {
          ctx.logger.debug('浏览器 WS send 失败（连接关闭中），消息丢弃', {
            channelId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    onTunnelDown: () => {
      finish(() => {
        if (browserWs) browserWs.close(1011, 'tunnel down');
        else writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('tunnel offline'));
      });
    },
  };

  /** accept 后的浏览器侧接线：消息进隧道、关闭透传 */
  const wireBrowserWs = (ws: WebSocket): void => {
    ws.on('message', (data, isBinary) => {
      if (finished) return;
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const header: DataHeader = { channelId, kind: 'ws.message', dataType: isBinary ? 'binary' : 'text' };
      // 边界带护栏（线上丢帧根因修复）：消息过了 browserWss 的 maxPayload（100MiB），
      // 但隧道帧加 ≈60B 头后可能超对端 100MiB，对端收帧即杀整条隧道（全通道丢帧）；
      // 超限按通道级失败（spec §7 通道级）：本通道 1009 关闭，隧道与其他通道无感
      if (exceedsMaxDataFrame(header, payload)) {
        ctx.logger.warn('WS 消息超隧道帧上限，通道级关闭', { channelId, bytes: payload.length });
        finish(() => {
          tunnel.sendControl({ type: 'channel.close', channelId, reason: 'message too large' });
          ws.close(1009, 'message too large');
        });
        return;
      }
      if (!tunnel.sendData(header, payload)) {
        ws.pause();
        void tunnel.waitDrain().then(() => ws.resume());
      }
    });
    ws.on('close', (code) => {
      // 1005/1006 归一化（前序经验）：保留字不可上帧，收到即"无码/异常"，透传时省略 code
      const forwardCode = code === 1005 || code === 1006 ? undefined : code;
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, code: forwardCode }));
    });
    ws.on('error', (err) => {
      ctx.logger.error('浏览器 WS 错误', { channelId, error: err.message });
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser error' }));
    });
  };

  const channelId = tunnel.register(channel);
  tunnel.sendControl({ type: 'ws.open', channelId, url: req.url ?? '/', headers: stripHopByHop(headers), protocols });
  // 日志只记 pathname：查询串是常见 token 携带位，任何级别不得打印完整 req.url（ws.open 帧仍带完整 url）
  ctx.logger.info('WS 升级入口', { channelId, url: safePathname(req.url) ?? '/', hostname: session.hostname });

  // 等 ws.accept 超时
  acceptTimer = setTimeout(() => {
    ctx.logger.warn('等 ws.accept 超时', { channelId });
    finish(() => {
      tunnel.sendControl({ type: 'channel.close', channelId, reason: 'accept timeout' });
      writeRawResponse(socket, 504, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('gateway timeout'));
    });
  }, ctx.headTimeoutMs);

  // 浏览器在 accept 前断开
  socket.on('close', () => {
    if (!finished && !browserWs) {
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser aborted before accept' }));
    }
  });
}
