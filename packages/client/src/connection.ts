/**
 * 网关隧道连接管理 — hello 握手、自动重连（指数退避+抖动）、应用层心跳、聚合背压 + 端到端流量窗口。
 * 语义（spec §6）：connect() 首连失败按退避持续重试，connectTimeoutMs 内未就绪则 reject；
 * 4409 = 进程级错误（旧版服务端 hostname 冲突，现行服务端同名并存不发出），connect() 立即 reject 且不重连。
 * tunnelId 复用：进程内存记住最近一次 hello.ack 的 tunnelId，重连 hello 回带请求复用
 * （服务端空闲即复用，浏览器老会话随之恢复）；ack 以服务端最终决定为准更新本地记忆。
 * 端到端流量窗口（spec §4.3）：hello 声明 flowControl，服务端按收到数据帧累计字节定期回 tunnel.ack；
 * 客户端以 dataBytesSent - dataBytesAcked 度量端到端在途量（内核/中间盒缓冲对应用不可见，
 * 本地 bufferedAmount 只是本机队列），超窗暂停生产。ack 同时为下载方向提供规律入站活性，
 * 心跳"静默判死"因此不会被限流拥塞蒙蔽（线上断连根因修复）。
 * 注意：hello.ack/ping/pong/tunnel.ack 在本层消化，不上抛；'error' 事件必须被外层监听（EventEmitter 语义）。
 * 错误语义分级（线上 1006 非法 close 帧误报修复）：
 * - 'error' = 诊断性事件：ws 级瞬时错误（中间件 synthesized 非法帧、网络抖动等），
 *   随后由 'close' 驱动内建重连自动收敛，外层不得据此判终态；
 * - 'fatal' = 终态失败：不再重连（已就绪后 4409 / 重连次数耗尽），外层应落 error 态；
 *   首连期的终态失败走 connect() reject（connectTimeoutMs / 4409），不发 'fatal'。
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import {
  ATTACH_REJECT_CODE, type ControlFrame, type DataHeader, decodeControl, decodeData,
  encodeControl, encodeData, MAX_PAYLOAD_BYTES,
} from './protocol';

import type { Logger } from './logger';

export interface ReconnectOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
  /**
   * 风暴退避阈值毫秒（可选，默认 5000）：已就绪连接在就绪后该时长内被杀 = 短命代（churn），
   * 重连不零延迟热循环，按连击数指数退避（封顶 maxDelayMs）拉断风暴；代寿命 ≥ 阈值 =
   * 健康链路被杀，立即重连（churn 连击归零）。0 = 关闭检测（恒立即重连）。
   */
  churnThresholdMs?: number;
}

export interface ConnectionOptions {
  gatewayUrl: string;
  hello: {
    hostname: string;
    defaultPath: string;
    /** 多连接协商：期望的总连接数（含本连接，≥2 才声明）；缺省 = 单连接（老行为） */
    multiConn?: { count: number };
    /** attach 握手：请求加入 initialTunnelId 指定的既有隧道组而非新建隧道 */
    attach?: boolean;
    /** attach leg 用：构造即植入的 tunnelId（primary 当前值），优先于进程记忆 */
    initialTunnelId?: string;
  };
  /**
   * 隧道 WS permessage-deflate 开关：false = 不提议压缩（排查中间盒误杀压缩帧/降低 CPU 用；
   * 服务端不协商时压缩本就不生效）。缺省 = ws 库默认（提议压缩）。
   */
  perMessageDeflate?: boolean;
  /**
   * 本连接在隧道组内的角色（TunnelGroup 装配 attach leg 时标记）：影响断开日志字段
   * 与终态错误（4410/重连耗尽）的日志级别——attach leg 由组语义接管，按 debug 降噪。
   */
  role?: 'primary' | 'attach';
  heartbeatIntervalMs: number;
  /**
   * 心跳判死宽容度（可选，默认 3）：连续该数量心跳周期完全静默（无任何入站帧，
   * 含 pong/tunnel.ack）才判死。判死窗 = heartbeatIntervalMs × 本值。
   * 非有限数/小于 1 视为未配置。链路长抖动被误判死时上调换取更慢的真死发现。
   */
  heartbeatMaxMissed?: number;
  connectTimeoutMs: number;
  reconnect: ReconnectOptions;
  logger: Logger;
}

/** 携带稳定错误码的错误（日志分级与组语义过滤用，不改变连接行为） */
export interface CodedError extends Error {
  code?: string;
}

/** 重连次数耗尽（primary 为终态；attach leg 由组语义接管降噪） */
export const ERR_RECONNECT_EXHAUSTED = 'ERR_RECONNECT_EXHAUSTED';
/** hostname 冲突（4409，老服务端终态） */
export const ERR_HOSTNAME_CONFLICT = 'ERR_HOSTNAME_CONFLICT';
/** attach 被拒（4410，目标不存在/已满/非多连接会话） */
export const ERR_ATTACH_REJECTED = 'ERR_ATTACH_REJECTED';
/** 主动关闭（close()/整组重建收尾）：供 TunnelGroup 区分"被关"与"连失败"，不排退避重试 */
export const ERR_CLOSED_BY_CALLER = 'ERR_CLOSED_BY_CALLER';

/**
 * 帧轨迹记录（环形缓冲）：断开时倾倒进诊断日志，区分"流量触发被杀"（死前刚发过大帧）
 * 与"空闲回收"（死前只有心跳）——中间盒杀连接场景的节律观测。
 */
interface FrameRecord {
  at: number;
  dir: 'tx' | 'rx';
  kind: string;
  len: number;
}

/** 帧轨迹环形缓冲上限：32 条足以覆盖"死前 1s 内"的突发形态，日志体积可控 */
const RECENT_FRAMES_MAX = 32;

/**
 * 握手被拒（unexpected-response）时允许打印值的响应头白名单：
 * 值仅限无敏感信息的头（防 Set-Cookie 泄浏览器会话 token）；其余头只记名字作中间盒指纹。
 */
const HANDSHAKE_RESPONSE_HEADER_ALLOWLIST = [
  'server', 'content-type', 'content-length', 'location', 'via', 'date', 'retry-after', 'x-cache',
];

/** 隧道发送面（TunnelGroup 条带化的 leg 抽象）：Connection 天然实现 */
export interface TunnelSender {
  sendControl(frame: ControlFrame): void;
  /** 返回 false = 应暂停生产并 waitDrain() 后恢复 */
  sendData(header: DataHeader, payload: Buffer): boolean;
  waitDrain(): Promise<void>;
}

/** 上行帧回调（hello.ack/ping/pong 已消化，不会出现在这里） */
export interface ConnectionHandlers {
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 已建立会话的隧道断开时触发（含重连中的断开；从未 ready 的连接失败不触发）：Client 用它中止在途通道 */
  onDisconnected(): void;
}

// 聚合背压水位（spec §4.3：v1 只尊重整体 WS bufferedAmount）
const HIGH_WATER_BYTES = 16 * 1024 * 1024;
const LOW_WATER_BYTES = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 100;
// 端到端流量窗口（tunnel.ack 驱动的在途量钳制，线上断连根因修复）：
// 窗口同时是"控制帧队头阻塞上限"——http.head 等控制帧排在数据帧之后，在途量 ÷ 共享带宽
// 就是控制帧的最坏延迟，必须 ≪ 服务端 headTimeoutMs（120s）；故窗口随 ack 实测速率自适应
// （目标 10s 在途），慢链路收紧、快链路放宽， clamp 在 [256KiB, 4MiB]
const FLOW_WINDOW_MIN_BYTES = 256 * 1024;
const FLOW_WINDOW_MAX_BYTES = 4 * 1024 * 1024;
const FLOW_TARGET_DELAY_MS = 10_000;
/** ack 速率采样的 EWMA 平滑系数（新样本权重） */
const FLOW_RATE_EWMA_ALPHA = 0.3;
/** close() 时对端不配合关闭的强制 terminate 等待 */
const CLOSE_FORCE_MS = 5000;
/**
 * 心跳判死缺省宽容度：连续 N 个心跳周期无任何入站消息判定死连接（默认 30s × 3 = 90s；
 * 大流量下的入站活性由 tunnel.ack 兜底，见文件头）。可经 heartbeatMaxMissed 覆盖。
 */
const DEAD_AFTER_MISSED_HEARTBEATS = 3;

/** 心跳判死宽容度取值：非有限数/小于 1 视为未配置，回落缺省（保证判死窗至少一个心跳周期） */
function resolveMaxMissed(configured: number | undefined): number {
  return configured !== undefined && Number.isFinite(configured) && configured >= 1
    ? configured : DEAD_AFTER_MISSED_HEARTBEATS;
}
/** 坏帧降级预算（spec §7 帧级）：连续 N 帧解码失败才升级为隧道级协议错误断开 */
const MAX_CONSECUTIVE_BAD_FRAMES = 5;
/** 短命代判定阈值（缺省）：就绪后 5s 内被杀 = 风暴期热循环，重连须退避防再被杀 */
const CHURN_GENERATION_MS = 5000;

/** ws RawData 统一转 Buffer（Buffer/ArrayBuffer/Buffer[] 三态） */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class Connection extends EventEmitter implements TunnelSender {
  private ws: WebSocket | null = null;
  private readyState = false;
  private closing = false;
  private attempts = 0;
  private lastActivityAt = 0;
  /** 最近一次 hello.ack 就绪时刻（0 = 未就绪），断开诊断日志的 readyMs 基准 */
  private readyAt = 0;
  /** 最近一次 ack 分配的 tunnelId：重连时经 hello 回带请求复用；进程内存态，重启即遗忘 */
  private lastTunnelId: string | undefined;
  /** 连续短命代计数（风暴退避指数底数；健康代存活 ≥ 阈值即归零） */
  private churnCount = 0;
  /** 连续坏帧计数：成功解码任意帧即清零；新连接尝试从零开始 */
  private consecutiveBadFrames = 0;
  /** 坏帧升级 latch：升级为隧道级断开后，close 握手窗内到达的坏帧静默丢弃（防 ERROR 日志洪泛） */
  private badFrameEscalated = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 断开诊断：最近帧环形缓冲（发送+接收），handleClose 倾倒（每次 attempt 清零） */
  private readonly recentFrames: FrameRecord[] = [];
  /** 握手协商结果（服务端回包 Sec-WebSocket-Extensions；'' = 未协商压缩） */
  private negotiatedExtensions = '';
  /** 最近一次 ping 发出时刻（pong 回程 RTT 观测；0 = 尚未发过） */
  private lastPingAt = 0;
  /** 最近一次 ping→pong 往返毫秒（断开日志的链路健康快照） */
  private lastPongRttMs: number | undefined;
  /** 已发送数据帧字节累计（端到端在途量 = dataBytesSent - dataBytesAcked） */
  private dataBytesSent = 0;
  /** 服务端 tunnel.ack 回执的数据帧字节累计（单调取大） */
  private dataBytesAcked = 0;
  /** 收到首个 tunnel.ack 才激活流量窗口：老服务端不回 ack = 不支持，回退本地水位背压 */
  private flowAckActive = false;
  /** ack 实测接收速率 EWMA（字节/秒）：自适应窗口的依据；0 = 尚无样本（按最小窗口） */
  private flowRateBps = 0;
  /** 最近一次用于速率采样的 ack 时刻与字节数 */
  private lastRateSampleAt = 0;
  private lastRateSampleBytes = 0;
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  /** hello.ack 协商出的服务端多连接上限；undefined = 老服务端不支持 */
  private serverMaxLegsValue: number | undefined;

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly handlers: ConnectionHandlers,
  ) {
    super();
    // attach leg 的种子 tunnelId：优先于进程记忆，首连 hello 即回带
    this.lastTunnelId = opts.hello.initialTunnelId;
  }

  /** 隧道是否就绪（已收到 hello.ack） */
  get ready(): boolean {
    return this.readyState;
  }

  /** 服务端分配的 tunnelId（未就绪过为 undefined） */
  get tunnelId(): string | undefined {
    return this.lastTunnelId;
  }

  /** hello.ack 协商出的服务端多连接上限；undefined = 老服务端不支持 */
  get serverMaxLegs(): number | undefined {
    return this.serverMaxLegsValue;
  }

  /** 可用容量分（加权条带化选 leg 依据）：min(端到端窗口剩余, 本地水位剩余)；未就绪/全满 ≤ 0 */
  availableCapacity(): number {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.readyState) return 0;
    const local = HIGH_WATER_BYTES - this.ws.bufferedAmount;
    if (!this.flowAckActive) return Math.max(0, local);
    const windowLeft = this.currentFlowWindow() - (this.dataBytesSent - this.dataBytesAcked);
    return Math.max(0, Math.min(local, windowLeft));
  }

  /** 整组重连触发点（TunnelGroup 用）：terminate 当前 ws 走既有 close→退避重连路径（closing 保持 false） */
  forceReconnect(): void {
    this.ws?.terminate();
  }

  /** 建立隧道：首连失败持续退避重试；connectTimeoutMs 未就绪 / 4409 → reject */
  connect(): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.closing = true;
        this.clearReconnectTimer();
        this.ws?.close();
        // 必须走 connectReject 统一清理（置空 resolve/reject 防二次 settle），而非直接 reject
        this.connectReject?.(new Error(`connect timeout after ${this.opts.connectTimeoutMs}ms`));
      }, this.opts.connectTimeoutMs);
      this.connectResolve = () => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (err) => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        reject(err);
      };
      this.attempt();
    });
  }

  /** 发送控制帧；未就绪抛错（调用方只应在 ready 后调用） */
  sendControl(frame: ControlFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tunnel not ready');
    const buf = encodeControl(frame);
    this.ws.send(buf);
    this.recordFrame('tx', frame.type, buf.length);
  }

  /**
   * 发送数据帧；返回 false = 应暂停生产并 waitDrain() 后恢复。两种背压：
   * ① 本地聚合水位（ws.bufferedAmount 超 HIGH_WATER_BYTES，防本机内存放大）；
   * ② 端到端流量窗口（flowAckActive 后在途量超 FLOW_WINDOW_HIGH_BYTES，
   *    钳制内核/中间盒不可见缓冲，保证 tunnel.ack 在心跳判死窗内可达）。
   */
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tunnel not ready');
    const encoded = encodeData(header, payload);
    this.dataBytesSent += encoded.length; // 端到端在途量记账（服务端按同口径累计回执）
    this.ws.send(encoded);
    this.recordFrame('tx', header.kind, encoded.length);
    if (this.ws.bufferedAmount > HIGH_WATER_BYTES || this.flowWindowExceeded()) {
      this.startDrainPoll();
      return false;
    }
    return true;
  }

  /** 端到端在途量（已发送未被 ack 的数据帧字节）是否超出当前自适应窗口 */
  private flowWindowExceeded(): boolean {
    const inFlight = this.dataBytesSent - this.dataBytesAcked;
    return this.flowAckActive && inFlight > this.currentFlowWindow();
  }

  /** 当前流量窗口：ack 实测速率 × 目标在途时长，clamp [FLOW_WINDOW_MIN_BYTES, FLOW_WINDOW_MAX_BYTES]；无样本按最小窗口 */
  private currentFlowWindow(): number {
    const target = (this.flowRateBps * FLOW_TARGET_DELAY_MS) / 1000;
    return Math.min(FLOW_WINDOW_MAX_BYTES, Math.max(FLOW_WINDOW_MIN_BYTES, target));
  }

  /** 等发送缓冲/在途量回落到恢复水位以下 */
  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 优雅关闭：停心跳/重连 → 关闭隧道 WS（在途通道由 Client 在 onDisconnected 中中止） */
  async close(): Promise<void> {
    this.closing = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    const closedErr = new Error('connection closed by caller') as CodedError;
    closedErr.code = ERR_CLOSED_BY_CALLER; // 供 TunnelGroup 区分"被关"与"连失败"（不排退避重试）
    this.connectReject?.(closedErr);
    const ws = this.ws;
    this.readyState = false;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        ws.terminate();
        resolve();
      }, CLOSE_FORCE_MS);
      ws.once('close', () => {
        clearTimeout(force);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000);
      }
    });
  }

  /** 发起一次连接尝试并接线全部事件 */
  private attempt(): void {
    // maxPayload 显式对齐隧道帧上限契约（原为 ws 隐式默认 100MiB）：
    // 对端发送护栏保证隧道帧不超限，此处是对协议失配的显式声明；
    // perMessageDeflate 缺省 true（ws 默认提议压缩，服务端不协商则不生效）
    const ws = new WebSocket(this.opts.gatewayUrl, {
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: this.opts.perMessageDeflate ?? true,
    });
    this.ws = ws;
    this.consecutiveBadFrames = 0;
    this.badFrameEscalated = false;
    this.dataBytesSent = 0;
    this.dataBytesAcked = 0;
    this.flowAckActive = false;
    this.flowRateBps = 0;
    this.lastRateSampleAt = 0;
    this.lastRateSampleBytes = 0;
    this.negotiatedExtensions = '';
    this.lastPingAt = 0;
    this.lastPongRttMs = undefined;
    this.recentFrames.length = 0;

    // 握手观测：服务端接受时的响应头（debug 级，记录压缩协商结果——Sec-WebSocket-Extensions
    // 是否回带 permessage-deflate，判定"中间盒误杀压缩帧"假设时第一眼要看它）
    ws.on('upgrade', (res) => {
      this.negotiatedExtensions = typeof res.headers['sec-websocket-extensions'] === 'string'
        ? res.headers['sec-websocket-extensions'] : '';
      this.opts.logger.debug('隧道握手完成', {
        role: this.opts.role ?? 'primary',
        statusCode: res.statusCode,
        extensions: this.negotiatedExtensions || undefined,
      });
    });
    // 握手被拒观测（线上 bad handshake 排查点）：非 101 响应 = 网关/中间盒改写升级。
    // 记录状态码 + 响应头名全集（中间盒注入头即指纹）；值仅白名单，防 Set-Cookie 泄 token。
    // ws 语义：挂了 unexpected-response 监听后库不再自动 abort（不 emit 'error'、不断 socket），
    // 此处手动复刻默认行为——emit 与库一致的错误 → 销毁握手连接 → close 事件驱动内建重连
    ws.on('unexpected-response', (req, res) => {
      const headerNames = Object.keys(res.headers);
      const safeValues: Record<string, string | string[] | undefined> = {};
      for (const name of HANDSHAKE_RESPONSE_HEADER_ALLOWLIST) {
        const v = res.headers[name];
        if (v !== undefined) safeValues[name] = v;
      }
      this.opts.logger.warn('隧道握手被拒（unexpected-response）', {
        role: this.opts.role ?? 'primary',
        path: req.path,
        statusCode: res.statusCode,
        headerNames,
        ...(Object.keys(safeValues).length > 0 ? { headers: safeValues } : {}),
      });
      const err = new Error(`Unexpected server response: ${res.statusCode}`);
      // 复刻 ws abortHandshake/emitErrorAndClose 的默认行为（见 node_modules ws/lib/websocket.js）：
      // ① 升级成功前 ws 不监听底层 socket，销毁 socket 不会触发 close 事件，必须显式 emitClose；
      // ② error 消息与库无监听时的自动 abort 口径一致（S2 断言依赖该原文）
      req.abort();
      if (req.socket && !req.socket.destroyed) req.socket.destroy();
      this.emit('error', err); // 走 Connection→Client 既有错误分级
      (ws as unknown as { emitClose: () => void }).emitClose(); // close(1006) → handleClose → 退避重连
    });

    ws.on('open', () => {
      // 过期/关闭守卫：closing 中或已被更新尝试取代的旧 ws，不得再发 hello
      if (this.closing || this.ws !== ws) return;
      this.lastActivityAt = Date.now();
      // 首帧必须是 hello（spec §4.1：连接建立后首帧发送，不含 token）；
      // 重连回带上次 tunnelId 请求复用（服务端空闲即保留浏览器会话，首连无此字段）；
      // flowControl 声明支持 tunnel.ack 端到端流量窗口（老服务端忽略该字段、不回 ack = 不支持）
      const client = {
        ...this.opts.hello, // hostname/defaultPath/multiConn/attach 一并下传
        flowControl: true,
        ...(this.lastTunnelId ? { tunnelId: this.lastTunnelId } : {}),
      };
      delete (client as { initialTunnelId?: string }).initialTunnelId; // 内部字段，不上线
      const hello = encodeControl({ type: 'hello', client });
      ws.send(hello);
      this.recordFrame('tx', 'hello', hello.length);
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // 过期/关闭守卫：closing 中或旧 ws 迟到的帧（如超时/close 后迟到的 hello.ack）一律丢弃
      if (this.closing || this.ws !== ws) return;
      this.lastActivityAt = Date.now(); // 任何入站消息都算活跃（心跳判死依据）
      const buf = toBuffer(data);
      if (isBinary) {
        let decoded: { header: DataHeader; payload: Buffer };
        try {
          decoded = decodeData(buf);
        } catch (err) {
          this.onBadFrame(ws, err);
          return;
        }
        this.consecutiveBadFrames = 0; // 成功解码即重置连续坏帧计数
        this.recordFrame('rx', decoded.header.kind, buf.length);
        this.callChannelHandler(() => this.handlers.onData(decoded.header, decoded.payload));
        return;
      }
      let frame: ControlFrame;
      try {
        frame = decodeControl(buf.toString('utf8'));
      } catch (err) {
        this.onBadFrame(ws, err);
        return;
      }
      this.consecutiveBadFrames = 0;
      this.recordFrame('rx', frame.type, buf.length);
      this.handleControl(frame);
    });

    // 旧 ws 的迟到 close 不得触发断开回调/重连（当前会话已被新尝试取代）
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      this.handleClose(code, reason);
    });
    // 'error' 之后必有 'close'，重连逻辑集中在 handleClose。
    // 主动关闭（closing）期间的 ws 级错误是预期现象——CONNECTING 态 close 触发的
    // abortHandshake 必发 "WebSocket was closed before the connection was established"——
    // 不得上抛污染 Client 错误分级（线上"隧道连接错误"误报修复）
    ws.on('error', (err: Error) => {
      if (this.closing) return;
      this.emit('error', err);
    });
  }

  /**
   * 坏帧降级（帧级，spec §7）：单条畸形帧 WARN + 丢弃，隧道与在途通道不受影响——
   * 隧道跑在 WS 消息分帧之上，每条 WS 消息就是一个完整隧道帧，坏消息不会造成
   * 流式协议那种帧边界错位，丢弃是安全的；可归属 channelId 的错误由通道层各自消化。
   * 连续 MAX_CONSECUTIVE_BAD_FRAMES 帧解码失败 = 系统性损坏/协议版本不匹配，
   * 升级为隧道级协议错误断开重连，避免双向协议失配时空转挂死；升级后置 latch，
   * close 握手窗内到达的后续坏帧静默丢弃（防 ERROR 日志洪泛）。
   * 握手期（hello.ack 前）同样适用本预算——首帧坏帧的兜底仍是超预算后的 1002 + 重连。
   * 日志安全：ProtocolError 消息只含非内容诊断（protocol.ts 契约保证不回显帧原文）。
   */
  private onBadFrame(ws: WebSocket, err: unknown): void {
    if (this.badFrameEscalated) return;
    this.consecutiveBadFrames += 1;
    if (this.consecutiveBadFrames >= MAX_CONSECUTIVE_BAD_FRAMES) {
      this.badFrameEscalated = true;
      this.onProtocolError(ws, err);
      return;
    }
    this.opts.logger.warn('坏帧丢弃（隧道保持存活）', {
      consecutive: this.consecutiveBadFrames,
      budget: MAX_CONSECUTIVE_BAD_FRAMES,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  /**
   * 隧道级协议错误（仅连续坏帧超预算时由 onBadFrame 触发）：ERROR 日志 + 1002 断开走重连。
   * 注意：错误消息只含非内容诊断（protocol.ts 保证不回显帧原文），本层只附加堆栈。
   */
  private onProtocolError(ws: WebSocket, err: unknown): void {
    this.opts.logger.error('隧道协议错误，断开重连', { error: err instanceof Error ? err.stack : String(err) });
    ws.close(1002, 'protocol error');
  }

  /**
   * 通道层回调（onControl/onData 路由到具体通道）的同步异常只做通道级消化：
   * 记 ERROR 后丢弃，绝不升级为隧道级协议错误误杀整条隧道（该通道的后续清理由其自身错误路径负责）。
   */
  private callChannelHandler(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.opts.logger.error('通道回调异常（通道级消化，隧道保持存活）', { error: err instanceof Error ? err.stack : String(err) });
    }
  }

  /** 控制帧分发：hello.ack/ping/pong 本层消化，其余上抛；closing 中一律丢弃 */
  private handleControl(frame: ControlFrame): void {
    if (this.closing) return;
    if (frame.type === 'hello.ack') {
      // 记忆服务端决定的 tunnelId（复用或新分配均以 ack 为准）；
      // typeof 守卫兼容旧版服务端空 ack（缺字段时保持 undefined，不参与回带）
      if (typeof frame.tunnelId === 'string' && frame.tunnelId.length > 0) {
        this.lastTunnelId = frame.tunnelId;
      }
      this.serverMaxLegsValue = frame.multiConn?.max;
      this.readyState = true;
      this.readyAt = Date.now();
      this.attempts = 0; // 重连成功后重置退避
      this.startHeartbeat();
      this.opts.logger.info('隧道就绪', { hostname: this.opts.hello.hostname, tunnelId: this.lastTunnelId });
      this.emit('connected');
      this.connectResolve?.();
      return;
    }
    if (frame.type === 'ping') {
      const pong = encodeControl({ type: 'pong' });
      this.ws?.send(pong);
      this.recordFrame('tx', 'pong', pong.length);
      return;
    }
    if (frame.type === 'pong') {
      // rx 已由 message 层记录帧轨迹；此处只补记链路健康快照（ping→pong RTT）
      if (this.lastPingAt > 0) this.lastPongRttMs = Date.now() - this.lastPingAt;
      return;
    }
    if (frame.type === 'tunnel.ack') {
      // 端到端流量回执：首个 ack 激活流量窗口（证明服务端支持）；bytes 单调取大防乱序回退
      this.flowAckActive = true;
      if (typeof frame.bytes === 'number' && frame.bytes >= 0) {
        // 速率采样（自适应窗口依据）：相邻两次推进的字节差 ÷ 时间差，EWMA 平滑；
        // 采样基线在首个 ack 即建立（含 bytes=0 的起步回执），否则首个样本永远缺失
        const now = Date.now();
        const advanced = this.lastRateSampleAt > 0 && now > this.lastRateSampleAt
          && frame.bytes > this.lastRateSampleBytes;
        if (advanced) {
          const elapsed = now - this.lastRateSampleAt;
          const sample = ((frame.bytes - this.lastRateSampleBytes) / elapsed) * 1000;
          this.flowRateBps = this.flowRateBps === 0
            ? sample
            : this.flowRateBps * (1 - FLOW_RATE_EWMA_ALPHA) + sample * FLOW_RATE_EWMA_ALPHA;
        }
        this.lastRateSampleAt = now;
        if (frame.bytes > this.lastRateSampleBytes) this.lastRateSampleBytes = frame.bytes;
        if (frame.bytes > this.dataBytesAcked) this.dataBytesAcked = frame.bytes;
      }
      return;
    }
    this.callChannelHandler(() => this.handlers.onControl(frame));
  }

  /** 帧轨迹记录（环形缓冲）：断开诊断倾倒用；超限丢最旧 */
  private recordFrame(dir: FrameRecord['dir'], kind: string, len: number): void {
    this.recentFrames.push({ at: Date.now(), dir, kind, len });
    if (this.recentFrames.length > RECENT_FRAMES_MAX) this.recentFrames.shift();
  }

  /** 关闭处理：4409/4410 终态不重连；其余按退避重连（closing 时不重连） */
  private handleClose(code: number, reason: Buffer): void {
    const wasReady = this.readyState;
    this.readyState = false;
    this.stopHeartbeat();
    // 短命代观测（风暴退避依据）：本次就绪会话的存活时长；未就绪断开为 undefined
    let generationMs: number | undefined;
    // 仅在曾建立会话（收到过 hello.ack）的断开才回调/发事件：
    // 从未 ready 的连接失败（如首连重试）不存在在途通道，上层无需中止
    if (wasReady) {
      // 断开诊断（线上中间件 synthesized 1006 close 杀连接的观测点）：
      // code/reason 区分对端正常关闭(1000)/协议错误(1002)/异常断链(1006)，readyMs 给出存活节律；
      // lastFrames 倾倒死前帧轨迹（区分流量触发 vs 空闲回收），inFlightBytes/bufferedAmount
      // 给出断前积压，extensions 记录压缩协商结果（中间盒误杀压缩帧假设的判定依据）
      const now = Date.now();
      const frames = this.recentFrames.map((f) => ({
        dir: f.dir, kind: f.kind, len: f.len, msAgo: now - f.at,
      }));
      this.opts.logger.warn('隧道连接断开', {
        code,
        reason: reason.toString() || undefined,
        readyMs: this.readyAt > 0 ? now - this.readyAt : undefined,
        role: this.opts.role ?? 'primary',
        tunnelId: this.lastTunnelId,
        extensions: this.negotiatedExtensions || undefined,
        inFlightBytes: this.dataBytesSent - this.dataBytesAcked,
        bufferedAmount: this.ws?.bufferedAmount ?? 0,
        silentMs: now - this.lastActivityAt,
        ...(this.lastPongRttMs !== undefined ? { lastPongRttMs: this.lastPongRttMs } : {}),
        ...(frames.length > 0 ? { lastFrames: frames } : {}),
      });
      generationMs = this.readyAt > 0 ? now - this.readyAt : undefined;
      this.readyAt = 0;
      this.handlers.onDisconnected();
      this.emit('disconnected');
    }
    if (this.closing) return;
    // 4409 = hostname 冲突（老服务端）；4410 = attach 拒绝（目标隧道不存在/已满/非多连接会话）；均为终态不重连
    if (code === 4409 || code === ATTACH_REJECT_CODE) {
      const err = new Error(code === 4409
        ? 'hostname conflict (4409): 同名客户端已在线'
        : 'attach rejected (4410): 目标隧道不存在/已满/非多连接会话') as CodedError;
      err.code = code === 4409 ? ERR_HOSTNAME_CONFLICT : ERR_ATTACH_REJECTED;
      const message = code === 4409 ? 'hostname 冲突，不再重连' : 'attach 被拒绝，不再重连';
      // attach leg 的 4410 由 TunnelGroup 重试/槽位降级语义接管，按 debug 降噪；
      // primary/单连接的终态保持 ERROR（外层据此落 error 态）
      const log = this.opts.role === 'attach' ? this.opts.logger.debug : this.opts.logger.error;
      log.call(this.opts.logger, message, { hostname: this.opts.hello.hostname });
      if (this.connectReject) this.connectReject(err);
      else {
        this.emit('error', err);
        this.emit('fatal', err); // 已就绪会话的终态失败：不重连，外层落 error 态
      }
      return;
    }
    this.scheduleReconnect(wasReady, generationMs);
  }

  /**
   * 重连调度：已就绪会话被杀后，健康代（存活 ≥ churnThresholdMs）立即重连一次（连接刚刚
   * 还健康，用户可见断窗压到 RTT 级）；短命代（就绪后很快被杀，风暴期热循环）按 churn 连击
   * 指数退避（封顶 max，±50% 抖动）拉断风暴；重连尝试自身失败（服务不可达）才按 base * 2^attempts
   * 退避防洪——防洪针对"连不上"与"连上就被杀"，不针对健康链路瞬断。maxRetries 耗尽按场景 reject 或报错停止
   */
  private scheduleReconnect(wasReady: boolean, generationMs?: number): void {
    if (this.closing) return;
    if (this.attempts >= this.opts.reconnect.maxRetries) {
      const err = new Error(`reconnect exhausted after ${this.attempts} attempts`) as CodedError;
      err.code = ERR_RECONNECT_EXHAUSTED; // 供外层/组语义降噪分级（attach leg 由 TunnelGroup 接管）
      if (this.connectReject) {
        this.connectReject(err);
      } else {
        const message = '重连次数耗尽，停止重试';
        const meta = {
          attempts: this.attempts,
          ...(this.opts.role ? { role: this.opts.role } : {}),
        };
        // attach leg（maxRetries:0）的重连预算由组语义接管：终态日志按 debug 降噪（线上风暴期刷屏修复）
        const log = this.opts.role === 'attach' ? this.opts.logger.debug : this.opts.logger.warn;
        log.call(this.opts.logger, message, meta);
        this.emit('error', err);
        this.emit('fatal', err); // 已就绪会话的终态失败：不再重试，外层落 error 态
      }
      return;
    }
    const { baseDelayMs, maxDelayMs } = this.opts.reconnect;
    let delay: number;
    if (wasReady) {
      const threshold = this.opts.reconnect.churnThresholdMs ?? CHURN_GENERATION_MS;
      const churn = threshold > 0 && generationMs !== undefined && generationMs < threshold;
      if (churn) {
        // 短命代被杀：零延迟重连只会被再杀（线上实测代寿命 0.2-1.4s 连续绞杀），
        // 按连击数指数退避拉断风暴；健康代存活 ≥ 阈值被杀仍是"连接刚刚还健康"，立即重试安全
        this.churnCount += 1;
        const exp = Math.min(baseDelayMs * 2 ** (this.churnCount - 1), maxDelayMs);
        delay = exp * (0.5 + Math.random() * 0.5);
      } else {
        this.churnCount = 0;
        delay = 0;
      }
    } else {
      const exp = Math.min(baseDelayMs * 2 ** this.attempts, maxDelayMs);
      delay = exp * (0.5 + Math.random() * 0.5);
    }
    this.attempts += 1;
    this.opts.logger.info('隧道重连中', { attempts: this.attempts, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => {
      // 触发即清引用：字段语义为"待触发的重连定时器"（与 TunnelGroup.attachTimers 回调内 delete 同构）；
      // fired 后残留引用会让稳态不变量（无残留重连定时器）失真——S12 重连风暴场景暴露
      this.reconnectTimer = null;
      this.attempt();
    }, delay);
  }

  /**
   * 应用层心跳：每周期发 ping；连续 DEAD_AFTER_MISSED_HEARTBEATS 个周期无任何入站判死，terminate 触发重连。
   * 大流量/限流链路下入站活性由 tunnel.ack 兜底（下载方向服务端→客户端本无流量，ack 随数据帧
   * 接收进度规律回执），"静默"重新等价于"真死"，无需对拥塞做启发式豁免（线上断连根因修复）。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const maxMissed = resolveMaxMissed(this.opts.heartbeatMaxMissed);
    this.heartbeatTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastActivityAt;
      const deadAfterMs = maxMissed * this.opts.heartbeatIntervalMs;
      if (silentMs > deadAfterMs) {
        this.opts.logger.warn('心跳超时，判定死连接', { silentMs, deadAfterMs, maxMissed });
        this.ws?.terminate();
        return;
      }
      try {
        const ping = encodeControl({ type: 'ping' });
        this.ws?.send(ping);
        this.lastPingAt = Date.now();
        this.recordFrame('tx', 'ping', ping.length);
      } catch {
        // 发送失败由 close 事件兜底走重连
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 背压轮询：本地缓冲低于低水位且在途量回到窗口 1/4 滞回线内时唤醒全部等待方；无等待方即停 */
  private startDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      const amount = this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws.bufferedAmount : 0;
      if (amount > LOW_WATER_BYTES) return;
      const inFlight = this.dataBytesSent - this.dataBytesAcked;
      if (this.flowAckActive && inFlight > this.currentFlowWindow() / 4) return;
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (this.drainWaiters.length === 0 && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, DRAIN_POLL_MS);
  }
}
