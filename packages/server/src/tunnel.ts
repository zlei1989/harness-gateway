/**
 * 隧道接入 — tunnelPath 的 WS upgrade、hello 握手、hostname 唯一性仲裁。
 * 关闭码约定：4409 = hostname 冲突（客户端进程级错误，不重连，无需防互踢）；
 * 4408 = hello 超时；握手后才收 hello，超时前到达的其他帧一律按协议错误断开。
 * 已就绪后坏帧降级（spec §8 帧级）：单条畸形帧 WARN + 丢弃，连续 5 帧才按隧道级
 * 协议错误 1002 断开（与客户端 connection.ts 对称，防双向协议失配时空转挂死）。
 * 注意：沿用仓库 ws-gateway.ts 范式——先 handleUpgrade 完成握手，再 close(code) 透传业务关闭码。
 * 安全红线：hello 帧可能携带 token（预留字段），日志不得打印 hello 帧内容（仅记 hostname/错误摘要）。
 */

import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { decodeControl, decodeData, encodeControl, MAX_PAYLOAD_BYTES, ProtocolError } from './protocol';
import { TunnelRegistry, TunnelSession } from './session';
import { safePathname } from './url';

import type { Logger } from './logger';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface TunnelContext {
  tunnels: TunnelRegistry;
  /** 隧道接入保留路径（默认 /__gateway__/tunnel） */
  tunnelPath: string;
  helloTimeoutMs: number;
  logger: Logger;
}

/** RawData 统一转 Buffer */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 把隧道 upgrade 处理器挂到 http.Server（只处理 tunnelPath，其余路径交还其他监听者） */
export function attachTunnelHandler(server: Server, ctx: TunnelContext): WebSocketServer {
  // maxPayload 显式对齐隧道帧上限契约（原为 ws 隐式默认 100MiB）：
  // 双端发送护栏保证隧道帧不超限，此处是对协议失配的显式声明
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // 畸形 request-target 防线：回调内 new URL 抛错即 uncaughtException 崩进程，销毁 socket 处置
    const pathname = safePathname(req.url);
    if (pathname === null) {
      socket.destroy();
      return;
    }
    if (pathname !== ctx.tunnelPath) return; // 非本网关路径：交还
    wss.handleUpgrade(req, socket, head, (ws) => onTunnelConnection(ws, ctx));
  });

  return wss;
}

/** 坏帧降级预算（与客户端 connection.ts 对称）：连续 N 帧解码失败才升级为隧道级协议错误断开 */
const MAX_CONSECUTIVE_BAD_FRAMES = 5;

/** 隧道连接生命周期：等 hello → 仲裁 → 登记 → 帧路由 → 断开清理 */
function onTunnelConnection(ws: WebSocket, ctx: TunnelContext): void {
  let session: TunnelSession | null = null;
  /** 连续坏帧计数：成功解码任意帧即清零（仅就绪后路由阶段使用） */
  let consecutiveBadFrames = 0;
  /** 坏帧升级 latch：升级为 1002 后 close 握手窗内到达的坏帧静默丢弃（防 ERROR 日志洪泛） */
  let badFrameEscalated = false;

  // hello 超时：握手后 helloTimeoutMs 内未收到合法 hello
  const helloTimer = setTimeout(() => {
    ctx.logger.warn('hello 超时，断开隧道', { remote: ws.url });
    ws.close(4408, 'hello timeout');
  }, ctx.helloTimeoutMs);

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    const buf = toBuffer(raw);
    if (!session) {
      // 首条消息必须是 hello 控制帧
      if (isBinary) {
        ws.close(1002, 'protocol error');
        return;
      }
      let hostname: string;
      let defaultPath: string;
      try {
        const frame = decodeControl(buf.toString('utf8'));
        if (frame.type !== 'hello') throw new ProtocolError(`首帧非 hello: ${frame.type}`);
        hostname = frame.client.hostname;
        defaultPath = frame.client.defaultPath;
        if (!hostname) throw new ProtocolError('hello.hostname 为空');
      } catch (err) {
        // 仅记错误摘要（ProtocolError 消息不含帧原文，防泄 token）
        ctx.logger.error('隧道首帧协议错误', { error: err instanceof Error ? err.message : String(err) });
        ws.close(1002, 'protocol error');
        return;
      }
      clearTimeout(helloTimer);
      // hostname 唯一性仲裁：先握手再 4409 关闭（仓库范式，业务关闭码可透传）
      if (ctx.tunnels.has(hostname)) {
        ctx.logger.warn('hostname 冲突，拒绝接入', { hostname });
        ws.close(4409, 'hostname conflict');
        return;
      }
      session = new TunnelSession(ws, { hostname, defaultPath }, ctx.logger, (s) => {
        ctx.tunnels.delete(s.hostname, s); // 身份校验防重连竞态
        ctx.logger.info('隧道断开', { hostname: s.hostname });
      });
      ctx.tunnels.set(hostname, session);
      ws.send(encodeControl({ type: 'hello.ack' }));
      ctx.logger.info('隧道接入', { hostname });
      return;
    }
    // 已就绪：帧路由
    try {
      if (isBinary) {
        const { header, payload } = decodeData(buf);
        consecutiveBadFrames = 0; // 成功解码即重置连续坏帧计数
        session.handleData(header, payload);
      } else {
        const frame = decodeControl(buf.toString('utf8'));
        consecutiveBadFrames = 0;
        session.handleControl(frame);
      }
    } catch (err) {
      if (err instanceof ProtocolError) {
        // 坏帧降级（帧级，spec §8）：单条畸形帧 WARN + 丢弃——隧道跑在 WS 消息分帧之上，
        // 每条 WS 消息就是一个完整隧道帧，坏消息不会造成帧边界错位，丢弃不影响在途通道；
        // 连续超预算 = 系统性损坏/协议版本不匹配，才按隧道级协议错误断开；
        // 升级后置 latch，close 握手窗内到达的后续坏帧静默丢弃（防 ERROR 日志洪泛）。
        // 日志安全：ProtocolError 消息只含非内容诊断（protocol.ts 契约保证不回显帧原文）。
        if (badFrameEscalated) return;
        consecutiveBadFrames += 1;
        if (consecutiveBadFrames >= MAX_CONSECUTIVE_BAD_FRAMES) {
          badFrameEscalated = true;
          ctx.logger.error('隧道协议错误，断开', { hostname: session?.hostname, error: err instanceof Error ? err.stack : String(err) });
          ws.close(1002, 'protocol error');
        } else {
          ctx.logger.warn('坏帧丢弃（隧道保持存活）', {
            hostname: session?.hostname,
            consecutive: consecutiveBadFrames,
            budget: MAX_CONSECUTIVE_BAD_FRAMES,
            error: err.message,
          });
        }
      } else {
        // 路由层异常（如 pong 回写时连接正关闭）：消化不关隧道，close 事件随后自清
        ctx.logger.error('隧道帧路由异常已消化', { hostname: session?.hostname, error: err instanceof Error ? err.stack : String(err) });
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    session?.teardown();
  });

  ws.on('error', (err) => {
    ctx.logger.error('隧道连接错误', { hostname: session?.hostname, error: err.stack ?? err.message });
    // close 事件随后触发清理
  });
}
