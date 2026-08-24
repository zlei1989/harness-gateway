/**
 * 网关隧道连接管理 — hello 握手、自动重连（指数退避+抖动）、应用层心跳、聚合背压。
 * 语义（spec §6）：connect() 首连失败按退避持续重试，connectTimeoutMs 内未就绪则 reject；
 * 4409 = 进程级错误（旧版服务端 hostname 冲突，现行服务端同名并存不发出），connect() 立即 reject 且不重连。
 * tunnelId 复用：进程内存记住最近一次 hello.ack 的 tunnelId，重连 hello 回带请求复用
 * （服务端空闲即复用，浏览器老会话随之恢复）；ack 以服务端最终决定为准更新本地记忆。
 * 注意：hello.ack/ping/pong 在本层消化，不上抛；'error' 事件必须被外层监听（EventEmitter 语义）。
 */

import { EventEmitter } from 'node:events';

import WebSocket from 'ws';

import {
  type ControlFrame, type DataHeader, decodeControl, decodeData,
  encodeControl, encodeData, MAX_PAYLOAD_BYTES,
} from './protocol';

import type { Logger } from './logger';

export interface ReconnectOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface ConnectionOptions {
  gatewayUrl: string;
  hello: { hostname: string; defaultPath: string };
  heartbeatIntervalMs: number;
  connectTimeoutMs: number;
  reconnect: ReconnectOptions;
  logger: Logger;
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
/** close() 时对端不配合关闭的强制 terminate 等待 */
const CLOSE_FORCE_MS = 5000;
/** 心跳判死：连续 N 个心跳周期无任何入站消息判定死连接（默认 30s 周期 × 3 = 90s，容忍链路瞬时 stall） */
const DEAD_AFTER_MISSED_HEARTBEATS = 3;
/** 坏帧降级预算（spec §7 帧级）：连续 N 帧解码失败才升级为隧道级协议错误断开 */
const MAX_CONSECUTIVE_BAD_FRAMES = 5;

/** ws RawData 统一转 Buffer（Buffer/ArrayBuffer/Buffer[] 三态） */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private readyState = false;
  private closing = false;
  private attempts = 0;
  private lastActivityAt = 0;
  /** 最近一次 hello.ack 就绪时刻（0 = 未就绪），断开诊断日志的 readyMs 基准 */
  private readyAt = 0;
  /** 最近一次 ack 分配的 tunnelId：重连时经 hello 回带请求复用；进程内存态，重启即遗忘 */
  private lastTunnelId: string | undefined;
  /** 连续坏帧计数：成功解码任意帧即清零；新连接尝试从零开始 */
  private consecutiveBadFrames = 0;
  /** 坏帧升级 latch：升级为隧道级断开后，close 握手窗内到达的坏帧静默丢弃（防 ERROR 日志洪泛） */
  private badFrameEscalated = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly handlers: ConnectionHandlers,
  ) {
    super();
  }

  /** 隧道是否就绪（已收到 hello.ack） */
  get ready(): boolean {
    return this.readyState;
  }

  /** 服务端分配的 tunnelId（未就绪过为 undefined） */
  get tunnelId(): string | undefined {
    return this.lastTunnelId;
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
    this.ws.send(encodeControl(frame));
  }

  /** 发送数据帧；返回 false = 超聚合高水位，调用方应暂停生产并 waitDrain() 后恢复 */
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tunnel not ready');
    this.ws.send(encodeData(header, payload));
    if (this.ws.bufferedAmount > HIGH_WATER_BYTES) {
      this.startDrainPoll();
      return false;
    }
    return true;
  }

  /** 等聚合发送缓冲回落到低水位以下 */
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
    this.connectReject?.(new Error('connection closed by caller'));
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
    // 对端发送护栏保证隧道帧不超限，此处是对协议失配的显式声明
    const ws = new WebSocket(this.opts.gatewayUrl, { maxPayload: MAX_PAYLOAD_BYTES });
    this.ws = ws;
    this.consecutiveBadFrames = 0;
    this.badFrameEscalated = false;

    ws.on('open', () => {
      // 过期/关闭守卫：closing 中或已被更新尝试取代的旧 ws，不得再发 hello
      if (this.closing || this.ws !== ws) return;
      this.lastActivityAt = Date.now();
      // 首帧必须是 hello（spec §4.1：连接建立后首帧发送，不含 token）；
      // 重连回带上次 tunnelId 请求复用（服务端空闲即保留浏览器会话，首连无此字段）
      const client = this.lastTunnelId
        ? { ...this.opts.hello, tunnelId: this.lastTunnelId }
        : this.opts.hello;
      ws.send(encodeControl({ type: 'hello', client }));
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      // 过期/关闭守卫：closing 中或旧 ws 迟到的帧（如超时/close 后迟到的 hello.ack）一律丢弃
      if (this.closing || this.ws !== ws) return;
      this.lastActivityAt = Date.now(); // 任何入站消息都算活跃（心跳判死依据）
      if (isBinary) {
        let decoded: { header: DataHeader; payload: Buffer };
        try {
          decoded = decodeData(toBuffer(data));
        } catch (err) {
          this.onBadFrame(ws, err);
          return;
        }
        this.consecutiveBadFrames = 0; // 成功解码即重置连续坏帧计数
        this.callChannelHandler(() => this.handlers.onData(decoded.header, decoded.payload));
        return;
      }
      let frame: ControlFrame;
      try {
        frame = decodeControl(toBuffer(data).toString('utf8'));
      } catch (err) {
        this.onBadFrame(ws, err);
        return;
      }
      this.consecutiveBadFrames = 0;
      this.handleControl(frame);
    });

    // 旧 ws 的迟到 close 不得触发断开回调/重连（当前会话已被新尝试取代）
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      this.handleClose(code, reason);
    });
    // 'error' 之后必有 'close'，重连逻辑集中在 handleClose
    ws.on('error', (err: Error) => this.emit('error', err));
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
      this.ws?.send(encodeControl({ type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;
    this.callChannelHandler(() => this.handlers.onControl(frame));
  }

  /** 关闭处理：4409 进程级不重连；其余按退避重连（closing 时不重连） */
  private handleClose(code: number, reason: Buffer): void {
    const wasReady = this.readyState;
    this.readyState = false;
    this.stopHeartbeat();
    // 仅在曾建立会话（收到过 hello.ack）的断开才回调/发事件：
    // 从未 ready 的连接失败（如首连重试）不存在在途通道，上层无需中止
    if (wasReady) {
      // 断开诊断（线上中间件 synthesized 1006 close 杀连接的观测点）：
      // code/reason 区分对端正常关闭(1000)/协议错误(1002)/异常断链(1006)，readyMs 给出存活节律
      this.opts.logger.warn('隧道连接断开', {
        code,
        reason: reason.toString() || undefined,
        readyMs: this.readyAt > 0 ? Date.now() - this.readyAt : undefined,
      });
      this.readyAt = 0;
      this.handlers.onDisconnected();
      this.emit('disconnected');
    }
    if (this.closing) return;
    if (code === 4409) {
      const err = new Error('hostname conflict (4409): 同名客户端已在线');
      this.opts.logger.error('hostname 冲突，不再重连', { hostname: this.opts.hello.hostname });
      if (this.connectReject) this.connectReject(err);
      else this.emit('error', err);
      return;
    }
    this.scheduleReconnect();
  }

  /** 退避重连：base * 2^attempts 封顶 max，加 ±50% 抖动；maxRetries 耗尽按场景 reject 或报错停止 */
  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.attempts >= this.opts.reconnect.maxRetries) {
      const err = new Error(`reconnect exhausted after ${this.attempts} attempts`);
      if (this.connectReject) {
        this.connectReject(err);
      } else {
        this.opts.logger.warn('重连次数耗尽，停止重试', { attempts: this.attempts });
        this.emit('error', err);
      }
      return;
    }
    const { baseDelayMs, maxDelayMs } = this.opts.reconnect;
    const exp = Math.min(baseDelayMs * 2 ** this.attempts, maxDelayMs);
    const delay = exp * (0.5 + Math.random() * 0.5);
    this.attempts += 1;
    this.opts.logger.info('隧道重连中', { attempts: this.attempts, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.attempt(), delay);
  }

  /** 应用层心跳：每周期发 ping；连续 DEAD_AFTER_MISSED_HEARTBEATS 个周期无任何入站判死，terminate 触发重连 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastActivityAt;
      if (silentMs > DEAD_AFTER_MISSED_HEARTBEATS * this.opts.heartbeatIntervalMs) {
        this.opts.logger.warn('心跳超时，判定死连接', { silentMs });
        this.ws?.terminate();
        return;
      }
      try {
        this.ws?.send(encodeControl({ type: 'ping' }));
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

  /** 背压轮询：缓冲低于低水位时唤醒全部等待方；无等待方即停 */
  private startDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      const amount = this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws.bufferedAmount : 0;
      if (amount > LOW_WATER_BYTES) return;
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (this.drainWaiters.length === 0 && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, DRAIN_POLL_MS);
  }
}
