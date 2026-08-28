/**
 * WS 通道 — 隧道 ws.message 帧 ↔ upstream ws 连接的双向透传。
 * 生命周期（spec §5.2）：握手时鉴权一次；upstream scheme 由 upstreamUrl 推导（http→ws，https→wss）；
 * 关闭码/原因双向透传；ws.reject 的 body 仅文本（控制帧无二进制体）。
 * 注意：握手协议头（sec-websocket-key/version/extensions）由 ws 库自行生成，转发会破坏握手，必须剔除。
 */

import WebSocket from 'ws';

import { type AuthDecision, type AuthRequest, buildAuthRequest } from './authorize';
import {
  type ChannelCloseFrame, type DataHeader, exceedsMaxDataFrame, MAX_PAYLOAD_BYTES,
  normalizeHeaders, stripHopByHop, type WsOpenFrame,
} from './protocol';

import type { TunnelSender } from './connection';
import type { Logger } from './logger';

export interface WsChannelParams {
  id: number;
  open: WsOpenFrame;
  upstream: URL;
  connection: TunnelSender;
  authorize: (req: AuthRequest) => Promise<AuthDecision>;
  logger: Logger;
  onDone: (id: number) => void;
}

/** ws RawData 统一转 Buffer */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WsChannel {
  private upstream: WebSocket | null = null;
  /** upstream 握手完成前到达的浏览器消息暂存；accept 后置 null 直发 */
  private pending: Array<{ dataType: 'text' | 'binary'; payload: Buffer }> | null = [];
  private accepted = false;
  private finished = false;

  constructor(private readonly params: WsChannelParams) {}

  /** 入口：握手鉴权 → 连 upstream ws。只调用一次 */
  async start(): Promise<void> {
    const { open, authorize, connection, upstream } = this.params;
    const decision = await authorize(buildAuthRequest(open, true));
    if (this.finished) return;

    if (!decision.allowed) {
      // 鉴权拒绝：body 转文本（ws.reject 无二进制体），服务端原样回浏览器
      this.trySend(() => connection.sendControl({
        type: 'ws.reject', channelId: this.params.id,
        status: decision.status, headers: decision.headers, body: decision.body.toString('utf8'),
      }));
      this.done();
      return;
    }

    const wsBase = new URL(upstream);
    wsBase.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
    const target = new URL(open.url, wsBase);
    // SSRF 防护：absolute-form URL（如 ws://169.254.169.254/）会脱离 upstream origin，
    // 借隧道对内网发起 WS 连接；origin 不符按握手前错误路径 ws.reject 拒绝，不拨 upstream。
    // 日志只记 channelId：URL 查询串可能携带敏感参数，不进日志。
    if (target.origin !== wsBase.origin) {
      this.params.logger.warn('拒绝跨 origin 的绝对 URL 请求', { channelId: this.params.id });
      this.trySend(() => connection.sendControl({ type: 'ws.reject', channelId: this.params.id, status: 403, body: 'Forbidden' }));
      this.done();
      return;
    }

    const headers = stripHopByHop(normalizeHeaders(open.headers));
    delete headers['host'];
    // Origin 与 Host 同语义重定（同 DSH /api 403 事故面：浏览器在 WS 握手同样携带 Origin，
    // 上游同源围栏 Origin.host !== Host.host 即拒绝握手）；缺失不伪造。
    // 注意取 upstream.origin（http/https）而非 wsBase.origin：Origin 头只允许 http(s) 方案
    if (headers['origin'] !== undefined) headers['origin'] = upstream.origin;
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];
    // sec-websocket-protocol 由构造参数 open.protocols 统一协商；透传浏览器侧原值会与参数重复/冲突
    delete headers['sec-websocket-protocol'];

    // maxPayload 显式对齐隧道帧上限契约（原为 ws 隐式默认 100MiB）：
    // 超 100MiB 的消息由本端 1009 杀本通道（通道级），边界带由下方发送护栏拦截
    const ws = new WebSocket(target, open.protocols, { headers, maxPayload: MAX_PAYLOAD_BYTES });
    this.upstream = ws;

    ws.on('open', () => {
      if (this.finished) return;
      this.accepted = true;
      // 回选子协议透传（服务端校验其属于 ws.open.protocols，不符断通道）
      if (!this.trySend(() => connection.sendControl({ type: 'ws.accept', channelId: this.params.id, protocol: ws.protocol || undefined }))) return;
      const pending = this.pending;
      this.pending = null;
      for (const m of pending ?? []) ws.send(m.payload, { binary: m.dataType === 'binary' });
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.finished) return;
      const payload = toBuffer(data);
      const header: DataHeader = { channelId: this.params.id, kind: 'ws.message', dataType: isBinary ? 'binary' : 'text' };
      // 边界带护栏（线上丢帧根因修复，与服务端 ws-proxy 对称）：消息过了本端 maxPayload，
      // 但隧道帧加 ≈60B 头后可能超服务端 100MiB，服务端收帧即以 1009 杀整条隧道（全通道丢帧）；
      // 超限按通道级失败（spec §7 通道级）：upstream 与本通道关闭，隧道与其他通道无感
      if (exceedsMaxDataFrame(header, payload)) {
        this.params.logger.warn('WS 消息超隧道帧上限，通道级关闭', { channelId: this.params.id, bytes: payload.length });
        this.trySend(() => connection.sendControl({
          type: 'channel.close', channelId: this.params.id, reason: 'message too large',
        }));
        ws.close(1009, 'message too large');
        this.done();
        return;
      }
      let ok = true;
      if (!this.trySend(() => {
        ok = connection.sendData(header, payload);
      })) return;
      if (!ok) {
        ws.pause();
        void connection.waitDrain().then(() => { if (!this.finished) ws.resume(); });
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      // upstream 主动关闭 → 客户端→网关方向的 channel.close（双向语义，第三轮修订）
      if (!this.finished) {
        this.trySend(() => connection.sendControl({ type: 'channel.close', channelId: this.params.id, code, reason: reason.toString() }));
      }
      this.done();
    });

    ws.on('error', (err: Error) => {
      if (this.finished) return;
      if (!this.accepted) {
        // 握手失败（含 unexpected-response）：统一 502
        this.params.logger.warn('upstream ws 握手失败', { channelId: this.params.id, error: err.message });
        this.trySend(() => connection.sendControl({ type: 'ws.reject', channelId: this.params.id, status: 502, body: 'bad gateway' }));
      } else {
        this.params.logger.error('WS 通道异常', { channelId: this.params.id, error: err.stack ?? err.message });
        this.trySend(() => connection.sendControl({ type: 'channel.error', channelId: this.params.id, message: err.message }));
      }
      this.done();
    });
  }

  /** 网关侧浏览器消息：upstream 未就绪先排队 */
  onMessage(dataType: 'text' | 'binary', payload: Buffer): void {
    if (this.finished) return;
    if (this.pending) {
      this.pending.push({ dataType, payload });
      return;
    }
    try {
      this.upstream?.send(payload, { binary: dataType === 'binary' });
    } catch (err) {
      // upstream 处于 CONNECTING/CLOSING 窗口时 ws.send 同步抛：通道级消化
      // （ERROR 日志 + 回 channel.error 并结束本通道），不外抛升级为隧道级协议错误。
      // 不主动 terminate：真实场景下 send 抛错意味着 upstream 正在关闭，close 事件随后自清。
      this.params.logger.error('WS 通道消息转发失败', { channelId: this.params.id, error: err instanceof Error ? err.stack : String(err) });
      this.trySend(() => this.params.connection.sendControl({
        type: 'channel.error', channelId: this.params.id,
        message: err instanceof Error ? err.message : String(err),
      }));
      this.done();
    }
  }

  /** 网关侧关闭：同码透传给 upstream（非法 code/超长 reason 先矫正，防 ws.close 抛 RangeError） */
  onPeerClose(frame: ChannelCloseFrame): void {
    if (this.finished) return;
    // RFC 6455：合法 close code 仅 1000 或 3000-4999；网关侧传非法值时替换为默认 1000
    const c = frame.code;
    const code = c !== undefined && (c === 1000 || (c >= 3000 && c <= 4999)) ? c : 1000;
    // reason 上限 123 字节（close 帧控制帧负载约束）：超长逐字符截断，避免截断多字节字符产生非法 UTF-8
    let reason = frame.reason;
    if (reason !== undefined) {
      while (Buffer.byteLength(reason, 'utf8') > 123) reason = reason.slice(0, -1);
    }
    this.upstream?.close(code, reason);
    this.done();
  }

  /** 隧道断开 / Client close：本地中止 */
  abort(): void {
    this.upstream?.terminate();
    this.done();
  }

  /**
   * 隧道发送兜底（线上崩溃修复，与 HttpChannel.trySend 同范式）：隧道 ws 的
   * 'error'→'close' 竞态窗内（如收到非法 close 帧后）Connection.sendControl/sendData
   * 抛 'tunnel not ready'；本通道的 upstream 事件回调（open/message/close/error）由
   * 事件循环独立调度，无法与该窗口同步，异常外溢即 uncaughtException 崩进程。
   * 发送失败 = 隧道已断、通道不可交付：消化异常 + 中止本通道（幂等）。
   */
  private trySend(send: () => void): boolean {
    try {
      send();
      return true;
    } catch (err) {
      this.params.logger.warn('隧道断开竞态：发送失败，中止本通道', {
        channelId: this.params.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.abort();
      return false;
    }
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.params.onDone(this.params.id);
  }
}
