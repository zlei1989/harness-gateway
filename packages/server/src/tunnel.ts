/**
 * 隧道接入 — tunnelPath 的 WS upgrade、hello 握手、tunnelId 分配与复用。
 * tunnelId 是隧道路由唯一身份：服务端分配 uuid 并经 hello.ack 下发；客户端重连时在 hello
 * 回带上次 tunnelId，空闲即复用（浏览器会话随之恢复），被占用/非法则新分配（不互踢——
 * 无隧道认证现状下避免互踢面，僵尸连接场景由重新登录兜底）。
 * hostname 为纯展示名、同名并存，不再有 4409 同名仲裁。
 * 关闭码约定：4408 = hello 超时；4410 = attach 拒绝（目标不存在/非 striped 会话/组满，spec §3.2）；
 * 握手后才收 hello，超时前到达的其他帧一律按协议错误断开。
 * 已就绪后坏帧降级（spec §8 帧级）：单条畸形帧 WARN + 丢弃，连续 5 帧才按隧道级
 * 协议错误 1002 断开（与客户端 connection.ts 对称，防双向协议失配时空转挂死）。
 * 注意：沿用仓库 ws-gateway.ts 范式——先 handleUpgrade 完成握手，再 close(code) 透传业务关闭码。
 * 安全红线：hello 帧可能携带 token（预留字段），日志不得打印 hello 帧内容（仅记 hostname/tunnelId/错误摘要）。
 */

import { randomUUID } from 'node:crypto';

import { type RawData, type WebSocket, WebSocketServer } from 'ws';

import { ATTACH_REJECT_CODE, decodeControl, decodeData, encodeControl, MAX_PAYLOAD_BYTES, ProtocolError } from './protocol';
import { type TunnelLeg, TunnelRegistry, TunnelSession } from './session';
import { safePathname } from './url';

import type { Logger } from './logger';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

export interface TunnelContext {
  tunnels: TunnelRegistry;
  /** 隧道接入保留路径（默认 /__gateway__/tunnel） */
  tunnelPath: string;
  helloTimeoutMs: number;
  /** 隧道 WS permessage-deflate 开关：跨机房/跨境部署建议开启（压缩 ≥1KB 帧，降低高 RTT 链路传输时间） */
  tunnelPerMessageDeflate?: boolean;
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
  // 双端发送护栏保证隧道帧不超限，此处是对协议失配的显式声明。
  // perMessageDeflate 开启时协商压缩：threshold 1KB 使 SSE 小帧原样透传，仅压缩大帧
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    ...(ctx.tunnelPerMessageDeflate ? { perMessageDeflate: { threshold: 1024 } } : {}),
  });

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

/** 单隧道组最大 leg 数（multiConn 协商上限，spec §3.1） */
export const MAX_LEGS_PER_TUNNEL = 16;

/** 回带 tunnelId 的合法形态（randomUUID v4 形状）；不符一律视为未回带，分配新 id */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 决定隧道 tunnelId：回带值形态合法且当前无在线隧道占用 → 复用（浏览器老会话随之恢复）；
 * 否则分配新 randomUUID——被占用不互踢（无隧道认证现状下避免互踢面，僵尸连接由重新登录兜底）
 */
function resolveTunnelId(requested: string | undefined, tunnels: TunnelRegistry): string {
  const reusable = requested !== undefined && UUID_SHAPE.test(requested) && !tunnels.has(requested);
  return reusable ? requested : randomUUID();
}

/** 隧道连接生命周期：等 hello → 定 tunnelId → 登记 → 帧路由 → 断开清理 */
function onTunnelConnection(ws: WebSocket, ctx: TunnelContext): void {
  let session: TunnelSession | null = null;
  /** 本连接对应的 leg（primary 或 attach 入组）；随 session 一同赋值，帧路由按到达 leg 记账/回执 */
  let activeLeg: TunnelLeg | null = null;
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
    if (!session || !activeLeg) {
      // 首条消息必须是 hello 控制帧
      if (isBinary) {
        ws.close(1002, 'protocol error');
        return;
      }
      let hostname: string;
      let defaultPath: string;
      let requestedId: string | undefined;
      let flowAck = false;
      let attach = false;
      let multiConnCount: number | undefined;
      try {
        const frame = decodeControl(buf.toString('utf8'));
        if (frame.type !== 'hello') throw new ProtocolError(`首帧非 hello: ${frame.type}`);
        hostname = frame.client.hostname;
        defaultPath = frame.client.defaultPath;
        requestedId = frame.client.tunnelId; // 重连复用回带 / attach 目标（可缺省）
        flowAck = frame.client.flowControl === true; // 端到端流量窗口能力声明（可缺省 = 不支持）
        attach = frame.client.attach === true; // attach 握手：加入既有 striped 隧道组
        multiConnCount = frame.client.multiConn?.count; // 多连接协商声明（可缺省 = legacy）
        if (!hostname) throw new ProtocolError('hello.hostname 为空');
      } catch (err) {
        // 仅记错误摘要（ProtocolError 消息不含帧原文，防泄 token）
        ctx.logger.error('隧道首帧协议错误', { error: err instanceof Error ? err.message : String(err) });
        ws.close(1002, 'protocol error');
        return;
      }
      // attach 路：加入既有 striped 会话；任何一项不符 → 4410（spec §3.2）
      if (attach) {
        const target = requestedId !== undefined && UUID_SHAPE.test(requestedId) ? ctx.tunnels.get(requestedId) : undefined;
        if (target === undefined || !target.striped || target.legCount >= target.maxLegs) {
          clearTimeout(helloTimer);
          ctx.logger.warn('attach 拒绝', { tunnelId: requestedId });
          ws.close(ATTACH_REJECT_CODE, 'attach rejected');
          return;
        }
        clearTimeout(helloTimer);
        const leg = target.attachLeg(ws);
        ws.send(encodeControl({ type: 'hello.ack', tunnelId: target.tunnelId, multiConn: { max: target.maxLegs } }));
        ctx.logger.info('隧道 attach 接入', { hostname: target.hostname, tunnelId: target.tunnelId, legs: target.legCount });
        session = target; // 后续 message/close 统一走下方已就绪路由（带 leg）
        activeLeg = leg;
        return;
      }
      // primary 路：新建隧道（声明 multiConn.count >= 2 协商为 striped 组，否则 legacy 单连接语义）
      clearTimeout(helloTimer);
      const tunnelId = resolveTunnelId(requestedId, ctx.tunnels);
      const striped = typeof multiConnCount === 'number' && multiConnCount >= 2;
      // striped 已保证 multiConnCount 为 number（TS 无法穿透布尔变量收窄，此处显式断言）
      const maxLegs = striped ? Math.min(Math.floor(multiConnCount as number), MAX_LEGS_PER_TUNNEL) : 1;
      const info = { tunnelId, hostname, defaultPath, flowAck, striped, maxLegs };
      session = new TunnelSession(ws, info, ctx.logger, (s) => {
        ctx.tunnels.delete(s.tunnelId, s); // 身份校验防重连竞态
        ctx.logger.info('隧道断开', { hostname: s.hostname, tunnelId: s.tunnelId });
      });
      ctx.tunnels.set(tunnelId, session);
      activeLeg = session.primaryLeg;
      ws.send(encodeControl(striped
        ? { type: 'hello.ack', tunnelId, multiConn: { max: maxLegs } }
        : { type: 'hello.ack', tunnelId }));
      ctx.logger.info('隧道接入', { hostname, tunnelId, reused: tunnelId === requestedId });
      return;
    }
    // 已就绪：帧路由（按到达 leg 记账/回执）
    try {
      if (isBinary) {
        const { header, payload } = decodeData(buf);
        consecutiveBadFrames = 0; // 成功解码即重置连续坏帧计数
        // ack 流量回执记账在 handleData 内按到达 leg 进行（含帧头，与客户端发送记账同口径）
        session.handleData(header, payload, activeLeg, buf.length);
      } else {
        const frame = decodeControl(buf.toString('utf8'));
        consecutiveBadFrames = 0;
        session.handleControl(frame, activeLeg);
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
    if (session && activeLeg) session.legDown(activeLeg); // legDown 幂等：整组 teardown 一次
    else session?.teardown(); // 理论不可达（activeLeg 必随 session 同设），防御保留
  });

  ws.on('error', (err) => {
    ctx.logger.error('隧道连接错误', { hostname: session?.hostname, error: err.stack ?? err.message });
    // close 事件随后触发清理
  });
}
