/**
 * TunnelSession（一条逻辑隧道的通道表，多 leg 化）与 TunnelRegistry（tunnelId → 隧道注册表）。
 * 注意：channelId 会话内递增，隧道重建后编号空间重置（旧通道已全部 teardown）；
 * registry.delete 校验 session 身份，防止"旧隧道断开事件"误删"新隧道"的重连竞态。
 * tunnelId 是隧道路由唯一身份（服务端分配的 uuid，可经 hello 回带复用）；hostname 纯展示名、可重复。
 *
 * 多连接（spec §4）：一条 TunnelSession 持 N 条 TunnelLeg（legs[0] = primary）。
 * striped 模式（协商成功的隧道组）：发送侧通道级帧打 seq（每 (channelId, server→client) 从 0 递增）
 * 后按可用容量加权选 leg；入站带 seq 的帧经 Resequencer 重排后按序分发（spec §6）。
 * 任一 leg 断 = 整组 teardown（spec §4.4）。legacy 会话（striped=false）不发 seq、只走 legs[0]，
 * 行为与单连接逐字节一致。
 */

import { type ControlFrame, type DataHeader, encodeControl, encodeData } from './protocol';
import { Resequencer } from './resequencer';

import type { Logger } from './logger';
import type WebSocket from 'ws';

/** 一条挂靠在隧道上的待响应通道（http-proxy/ws-proxy/select 探测实现） */
export interface PendingChannel {
  kind: 'http' | 'ws';
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 隧道断开：通道不可迁移，实现方按 502/断开语义失败 */
  onTunnelDown(): void;
}

/** proxy 模块依赖的隧道最小接口（测试注入假实现） */
export interface TunnelHandle {
  readonly hostname: string;
  register(channel: PendingChannel): number;
  unregister(channelId: number): void;
  sendControl(frame: ControlFrame): void;
  sendData(header: DataHeader, payload: Buffer): boolean;
  waitDrain(): Promise<void>;
}

// 聚合背压水位（与客户端 Connection 对称）
const HIGH_WATER_BYTES = 16 * 1024 * 1024;
const LOW_WATER_BYTES = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 100;
/**
 * tunnel.ack 回执节拍：每收到 ACK_EVERY_BYTES 数据帧字节回一次累计值，不足节拍时
 * ACK_FLUSH_MS 兜底回执（在途量尾数永不回执会让客户端流量窗口滞回线死锁：生产方等在
 * 窗口 1/4 处，服务端却因不足 128KiB 不再回执）。
 * 128KiB 节拍 + 1s 兜底保证最劣 50KB/s 链路下 ack 间隔 ≈1s ≪ 客户端心跳判死窗（90s），
 * 下载方向（服务端→客户端静默）由此获得规律入站活性，心跳判死不被拥塞蒙蔽（线上断连根因修复）
 */
const ACK_EVERY_BYTES = 128 * 1024;
const ACK_FLUSH_MS = 1000;

/**
 * 隧道的一条物理连接（leg）：send 封装、HIGH/LOW 水位与 drain 轮询、
 * ack 节拍 noteDataReceived/flushAck/scheduleAckFlush——逻辑自原 TunnelSession 逐字搬移，
 * 作用于自己的 ws（per-leg 记账与客户端 per-leg 在途记账同口径）。
 */
export class TunnelLeg {
  private dataBytesReceived = 0;
  private lastAckSentBytes = 0;
  private ackFlushTimer: NodeJS.Timeout | null = null;
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly ws: WebSocket,
    private readonly flowAck: boolean,
    _logger: Logger, // 预留：per-leg 诊断（现 ack/背压路径无日志点，保持与构造契约一致）
  ) {}

  sendControl(frame: ControlFrame): void {
    this.ws.send(encodeControl(frame));
  }

  sendData(header: DataHeader, payload: Buffer): boolean {
    this.ws.send(encodeData(header, payload));
    if (this.ws.bufferedAmount > HIGH_WATER_BYTES) {
      this.startDrainPoll();
      return false;
    }
    return true;
  }

  availableCapacity(): number {
    return Math.max(0, HIGH_WATER_BYTES - this.ws.bufferedAmount);
  }

  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 数据帧接收记账：flowAck 门控 + 128KiB 节拍 + 1s 兜底（与现 session 版逐字同逻辑，作用于本 leg） */
  noteDataReceived(frameBytes: number): void {
    if (!this.flowAck) return;
    this.dataBytesReceived += frameBytes;
    if (this.dataBytesReceived - this.lastAckSentBytes >= ACK_EVERY_BYTES) {
      this.flushAck();
    } else {
      this.scheduleAckFlush();
    }
  }

  close(): void {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer);
      this.ackFlushTimer = null;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) waiter();
    this.ws.close(1000, 'tunnel teardown');
  }

  private flushAck(): void {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer);
      this.ackFlushTimer = null;
    }
    if (this.dataBytesReceived === this.lastAckSentBytes) return;
    this.lastAckSentBytes = this.dataBytesReceived;
    try {
      this.sendControl({ type: 'tunnel.ack', bytes: this.dataBytesReceived });
    } catch {
      // ws 关闭窗内 send 抛错：隧道将断，ack 失去意义，close 事件随后自清
    }
  }

  private scheduleAckFlush(): void {
    if (this.ackFlushTimer) return;
    this.ackFlushTimer = setTimeout(() => {
      this.ackFlushTimer = null;
      this.flushAck();
    }, ACK_FLUSH_MS);
    this.ackFlushTimer.unref();
  }

  private startDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.ws.bufferedAmount > LOW_WATER_BYTES) return;
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (this.drainWaiters.length === 0 && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, DRAIN_POLL_MS);
  }
}

export class TunnelSession implements TunnelHandle {
  /** 服务端分配的隧道标识（uuid；hello 回带复用时为回带值） */
  readonly tunnelId: string;
  readonly hostname: string;
  readonly defaultPath: string;
  /** 客户端 hello 声明支持 tunnel.ack 端到端流量窗口时才回执（老客户端未声明不回，防未知帧坏帧预算误杀） */
  private readonly flowAck: boolean;
  /** 多连接条带化模式（协商成功的隧道组）；false = legacy 单连接语义（不发 seq、只走 legs[0]） */
  readonly striped: boolean;
  /** 本组允许的最大 leg 数（hello 协商结果；legacy = 1） */
  readonly maxLegs: number;
  private nextChannelId = 1;
  private readonly channels = new Map<number, PendingChannel>();
  /** legs[0] = primary；attach 的后续连接依次入列 */
  private readonly legs: TunnelLeg[] = [];
  /** server→client 方向每通道下一个 seq（striped 模式使用） */
  private readonly sendSeq = new Map<number, number>();
  /** 入站重排序（spec §6）：仅带 seq 的帧经过 */
  private readonly resequencer: Resequencer;
  private down = false;

  constructor(
    ws: WebSocket,
    info: { tunnelId: string; hostname: string; defaultPath: string; flowAck?: boolean; striped?: boolean; maxLegs?: number },
    private readonly logger: Logger,
    private readonly onDown: (session: TunnelSession) => void,
  ) {
    this.tunnelId = info.tunnelId;
    this.hostname = info.hostname;
    this.defaultPath = info.defaultPath;
    this.flowAck = info.flowAck === true;
    this.striped = info.striped === true;
    this.maxLegs = info.maxLegs ?? 1;
    this.legs.push(new TunnelLeg(ws, this.flowAck, logger));
    this.resequencer = new Resequencer({
      logger,
      onOverflow: (channelId) => {
        // 通道缓冲超限 = 对端行为异常：按隧道组级协议错误处置（teardown + 全 leg 1002）
        logger.error('重排序通道缓冲超限，整组 teardown', { tunnelId: this.tunnelId, channelId });
        this.teardown();
        for (const leg of this.legs) leg.ws.close(1002, 'protocol error');
      },
    });
  }

  get primaryLeg(): TunnelLeg {
    return this.legs[0] as TunnelLeg; // legs 恒非空（构造即入 primary）
  }

  get legCount(): number {
    return this.legs.length;
  }

  /** attach 连接入列（attach 握手路由在 tunnel.ts，Task 8 接入） */
  attachLeg(ws: WebSocket): TunnelLeg {
    const leg = new TunnelLeg(ws, this.flowAck, this.logger);
    this.legs.push(leg);
    return leg;
  }

  /** 任一 leg 断 = 整组 teardown（spec §4.4；幂等由 down latch 保证） */
  legDown(leg: TunnelLeg): void {
    this.logger.warn('隧道 leg 断开，整组 teardown', { tunnelId: this.tunnelId, legIndex: this.legs.indexOf(leg) });
    this.teardown();
  }

  register(channel: PendingChannel): number {
    const channelId = this.nextChannelId++;
    this.channels.set(channelId, channel);
    return channelId;
  }

  unregister(channelId: number): void {
    this.channels.delete(channelId);
    this.resequencer.dropChannel(channelId);
  }

  sendControl(frame: ControlFrame): void {
    if (!this.striped || !('channelId' in frame)) {
      this.primaryLeg.sendControl(frame);
      return;
    }
    (this.legs[this.pickLeg()] as TunnelLeg).sendControl({ ...frame, seq: this.nextSeq(frame.channelId) });
  }

  sendData(header: DataHeader, payload: Buffer): boolean {
    if (!this.striped) return this.primaryLeg.sendData(header, payload);
    const leg = this.legs[this.pickLeg()] as TunnelLeg;
    leg.sendData({ ...header, seq: this.nextSeq(header.channelId) }, payload);
    return leg.availableCapacity() > 0;
  }

  /** 任一 leg 回落即唤醒（调用方 pause/resume 语义不变） */
  waitDrain(): Promise<void> {
    return Promise.race(this.legs.map((l) => l.waitDrain())).then(() => undefined);
  }

  /**
   * 控制帧入口（tunnel.ts 路由调用，leg = 帧到达的连接）：
   * ping/pong 本层消化（回执走到达 leg），带 seq 的通道帧经 Resequencer 重排，其余按 channelId 分发
   */
  handleControl(frame: ControlFrame, leg: TunnelLeg): void {
    if (frame.type === 'ping') { leg.sendControl({ type: 'pong' }); return; }
    if (frame.type === 'pong') return;
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    if (channelId === undefined) {
      this.logger.warn('隧道收到无 channelId 控制帧，丢弃', { type: frame.type });
      return;
    }
    const seq = 'seq' in frame ? frame.seq : undefined;
    if (typeof seq === 'number') {
      this.resequencer.feed(channelId, seq, { kind: 'control', frame }, (item) => {
        if (item.kind === 'control') this.dispatchControl(item.frame);
      });
      return;
    }
    this.dispatchControl(frame);
  }

  /**
   * 数据帧入口（tunnel.ts 在解码成功后调用，frameBytes 含 4 字节头长 + JSON 头 + 负载）：
   * ack 记账按收到 leg（与客户端 per-leg 在途记账同口径）；带 seq 经 Resequencer 重排后分发
   */
  handleData(header: DataHeader, payload: Buffer, leg: TunnelLeg, frameBytes: number): void {
    leg.noteDataReceived(frameBytes);
    if (typeof header.seq === 'number') {
      this.resequencer.feed(header.channelId, header.seq, { kind: 'data', header, payload }, (item) => {
        if (item.kind === 'data') this.dispatchData(item.header, item.payload);
      });
      return;
    }
    this.dispatchData(header, payload);
  }

  /** 通道控制帧分发（channelId 已由 handleControl 保证存在） */
  private dispatchControl(frame: ControlFrame): void {
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    if (channelId === undefined) return; // 调用方已保证，防御
    this.callChannel(channelId, () => {
      this.channels.get(channelId)?.onControl(frame);
    });
  }

  private dispatchData(header: DataHeader, payload: Buffer): void {
    this.callChannel(header.channelId, () => {
      this.channels.get(header.channelId)?.onData(header, payload);
    });
  }

  /** 隧道断开：全部通道失败 + 全 leg 关停（唤醒悬挂 waitDrain、关底层 ws）+ 通知注册表注销（幂等） */
  teardown(): void {
    if (this.down) return;
    this.down = true;
    this.resequencer.reset();
    const all = [...this.channels.entries()];
    this.channels.clear();
    // 通道级隔离：单通道 onTunnelDown 异常不影响其余通道与 onDown（否则 registry 泄漏死会话）
    for (const [channelId, channel] of all) {
      this.callChannel(channelId, () => channel.onTunnelDown());
    }
    // 全 leg 清 timer、唤醒悬挂的 drainWaiters、关闭底层 ws（已关的幂等）：
    // 隧道已断，调用方醒来后走 onTunnelDown 已失败路径，不得永久悬挂
    for (const leg of this.legs) leg.close();
    this.onDown(this);
  }

  /** 服务端主动关闭（server.close） */
  close(): void {
    this.primaryLeg.ws.close(1000, 'server shutdown');
    this.teardown();
  }

  /**
   * 通道回调异常隔离（参照客户端 Connection.callChannelHandler 模式）：
   * try/catch 消化 + ERROR 日志（堆栈 + channelId 上下文，不含帧内容防泄 token），
   * 单通道异常不影响其余通道分发与 teardown/onDown 流程。
   */
  private callChannel(channelId: number, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.logger.error('通道回调异常已消化', {
        channelId,
        stack: err instanceof Error ? err.stack : String(err),
      });
    }
  }

  /** server→client 方向每通道下一个 seq（同客户端 TunnelGroup.nextSeq） */
  private nextSeq(channelId: number): number {
    const n = this.sendSeq.get(channelId) ?? 0;
    this.sendSeq.set(channelId, n + 1);
    return n;
  }

  /** 加权选 leg：可用容量最高者下标（打平取先） */
  private pickLeg(): number {
    let best = 0;
    let bestCap = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < this.legs.length; i++) {
      const cap = (this.legs[i] as TunnelLeg).availableCapacity();
      if (cap > bestCap) {
        best = i;
        bestCap = cap;
      }
    }
    return best;
  }
}

export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelSession>();
  private readonly attachWaiters = new Set<{
    tunnelId: string;
    timer: NodeJS.Timeout;
    resolve: (s: TunnelSession | null) => void;
  }>();

  get(tunnelId: string): TunnelSession | undefined {
    return this.tunnels.get(tunnelId);
  }

  has(tunnelId: string): boolean {
    return this.tunnels.has(tunnelId);
  }

  /**
   * 等待隧道上线（瞬断宽限）：已在立即返回；超时 resolve null；
   * teardownAll/closeAll 全部唤醒 null（服务端关停不得悬挂浏览器请求）
   */
  waitFor(tunnelId: string, timeoutMs: number): Promise<TunnelSession | null> {
    const existing = this.tunnels.get(tunnelId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter = {
        tunnelId,
        timer: setTimeout(() => {
          this.attachWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
        resolve,
      };
      waiter.timer.unref();
      this.attachWaiters.add(waiter);
    });
  }

  set(tunnelId: string, session: TunnelSession): void {
    this.tunnels.set(tunnelId, session);
    for (const w of [...this.attachWaiters]) {
      if (w.tunnelId !== tunnelId) continue;
      clearTimeout(w.timer);
      this.attachWaiters.delete(w);
      w.resolve(session);
    }
  }

  /** 仅当映射仍指向该 session 才删除——防"旧隧道断开"误删"新隧道"的竞态 */
  delete(tunnelId: string, session: TunnelSession): void {
    if (this.tunnels.get(tunnelId) === session) this.tunnels.delete(tunnelId);
  }

  /** 选择页数据源：当前在线电脑列表（hostname 可重复，卡片以 tunnelId 区分） */
  list(): { tunnelId: string; hostname: string; defaultPath: string }[] {
    return [...this.tunnels.values()].map((s) => ({
      tunnelId: s.tunnelId,
      hostname: s.hostname,
      defaultPath: s.defaultPath,
    }));
  }

  /** 关停唤醒：等待方一律 null（走 502 快失败，不悬挂） */
  private failAllWaiters(): void {
    for (const w of [...this.attachWaiters]) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.attachWaiters.clear();
  }

  teardownAll(): void {
    this.failAllWaiters();
    for (const session of [...this.tunnels.values()]) session.teardown();
    this.tunnels.clear();
  }

  /**
   * 服务端关停（spec §3「关所有隧道」）：逐隧道 session.close()——关闭底层 ws 并 teardown 在途通道。
   * 注意与 teardownAll 的区别：teardown 关底层 ws 用的是 leg 关停码（1000 'tunnel teardown'），
   * close 先用 'server shutdown' 显式关闭 primary ws，关停语义更清晰。
   */
  closeAll(): void {
    this.failAllWaiters();
    for (const session of [...this.tunnels.values()]) session.close();
    this.tunnels.clear();
  }
}
