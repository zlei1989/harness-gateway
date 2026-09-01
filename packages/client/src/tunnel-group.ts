/**
 * 隧道组（spec §4）：N 条 Connection（leg）组成一条逻辑隧道。
 * leg 0 = primary（正常 hello 声明 multiConn.count），其余 attach（回带 tunnelId + attach: true）。
 * 发送侧：通道级帧同步打 seq（每 (channelId, client→server) 从 0 递增）后按可用容量加权选 leg；
 * 全满返回 false，任一 leg 回落 waitDrain 唤醒——通道层背压语义与单连一致。
 * 断连语义：任一已就绪 leg 断 = 整组 teardown（其余 leg close + primary forceReconnect），
 * onDisconnected 只经 primary 单点上抛；primary 重连成功后重建 attach leg。
 * attach 失败（4410/超时）不杀整组：槽位按退避重试 ≤3 次，耗尽降级到下次整组重连。
 * 接收侧不重排：各 leg 帧原样上抛（可能乱序），由 Client 持有的 Resequencer 重排（spec §6）。
 */

import { EventEmitter } from 'node:events';

import {
  type CodedError, Connection, ERR_ATTACH_REJECTED, ERR_CLOSED_BY_CALLER, ERR_HOSTNAME_CONFLICT,
  ERR_RECONNECT_EXHAUSTED, type ReconnectOptions, type TunnelSender,
} from './connection';

import type { Logger } from './logger';
import type { ControlFrame, DataHeader } from './protocol';

export interface TunnelGroupOptions {
  gatewayUrl: string;
  hello: { hostname: string; defaultPath: string };
  /** 目标总连接数（含 primary，≥2 才会建组；Client 在 ==1 时直接用 Connection） */
  connections: number;
  heartbeatIntervalMs: number;
  /** 心跳判死宽容度透传（可选，默认 3，见 connection.ts ConnectionOptions.heartbeatMaxMissed） */
  heartbeatMaxMissed?: number;
  connectTimeoutMs: number;
  reconnect: ReconnectOptions;
  logger: Logger;
}

export interface TunnelGroupHandlers {
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 整组断开（含重连中的断开）：单点上抛，Client 据此中止在途通道 */
  onDisconnected(): void;
}

/** attach 槽位重试上限（spec §4.4：耗尽降级到下次整组重连） */
const MAX_ATTACH_ATTEMPTS = 3;
/** attach 单次连接超时：比首连短，避免拖慢降级判定 */
const ATTACH_CONNECT_TIMEOUT_MS = 30_000;

export class TunnelGroup extends EventEmitter implements TunnelSender {
  private readonly primary: Connection;
  /** attach 槽位表（下标即槽位号）；null = 未建立/已降级 */
  private readonly attachLegs: Array<Connection | null> = [];
  private readonly attachTimers = new Map<number, NodeJS.Timeout>();
  /** client→server 方向每通道下一个 seq */
  private readonly sendSeq = new Map<number, number>();
  private closing = false;
  private disconnected = false;
  /** 组级重建 latch：重建启动 → primary 重新就绪前，其余 leg 的断事件折叠（防多腿同断/交错断叠加重建） */
  private rebuilding = false;
  /** 隧道代际（primary 每次就绪 +1）：attach 重试定时器跨代失效（防旧代幽灵 leg 覆盖新代槽位） */
  private generation = 0;

  constructor(
    private readonly opts: TunnelGroupOptions,
    private readonly handlers: TunnelGroupHandlers,
  ) {
    super();
    this.primary = this.newLeg(false, undefined);
    // onDisconnected 单点上抛：仅 primary 驱动（attach leg 断 → forceReconnect 间接触发同一路径）
    this.primary.on('connected', () => {
      this.generation += 1;
      this.rebuilding = false;
      this.disconnected = false;
      this.emit('connected');
      this.spawnAttachLegs();
    });
    this.primary.on('disconnected', () => {
      this.disconnected = true;
      this.sendSeq.clear(); // channelId 空间随隧道重建归零
      this.closeAttachLegs();
      this.emit('disconnected');
      this.handlers.onDisconnected();
    });
  }

  get ready(): boolean {
    return this.primary.ready;
  }

  get tunnelId(): string | undefined {
    return this.primary.tunnelId;
  }

  /** 当前已就绪 leg 数（e2e/日志观测用） */
  get readyLegCount(): number {
    return this.allLegs().filter((l) => l.ready).length;
  }

  /** 建立隧道：primary 就绪即 resolve（attach 在后台进行，不阻塞可用性） */
  connect(): Promise<void> {
    this.closing = false;
    return this.primary.connect();
  }

  /** 通道级帧：协商成功才打 seq（spec §3.3）+ 加权选 leg；隧道级帧（不该出现）走 primary */
  sendControl(frame: ControlFrame): void {
    if (!('channelId' in frame)) {
      this.primary.sendControl(frame);
      return;
    }
    const leg = this.pickLeg();
    if (leg === null) throw new Error('tunnel not ready');
    // 协商门控：仅服务端 ack 带 multiConn 的隧道组才带 seq；单连接模式帧原样发出
    const striped = this.primary.serverMaxLegs !== undefined;
    leg.sendControl(striped ? { ...frame, seq: this.nextSeq(frame.channelId) } : frame);
  }

  /** 数据帧：协商成功才打 seq + 加权选 leg；所有 ready leg 全满返回 false（帧仍发出，由调用方 pause 收敛） */
  sendData(header: DataHeader, payload: Buffer): boolean {
    const pick = this.pickLegWithCapacity();
    if (pick === null) throw new Error('tunnel not ready');
    // 协商门控：仅协商成功的隧道组才打 seq（serverMaxLegs 随每次 hello.ack 更新，跨重连语义正确）
    const striped = this.primary.serverMaxLegs !== undefined;
    pick.leg.sendData(striped ? { ...header, seq: this.nextSeq(header.channelId) } : header, payload);
    return pick.capacity > 0;
  }

  /** 任一 leg 回落即唤醒（调用方 pause/resume 语义不变） */
  waitDrain(): Promise<void> {
    const legs = this.allLegs().filter((l) => l.ready);
    if (legs.length === 0) return Promise.resolve();
    return Promise.race(legs.map((l) => l.waitDrain())).then(() => undefined);
  }

  /** Resequencer 溢出等组级协议错误处置：整组重连（置重建 latch，窗口内其余 leg 断事件折叠） */
  forceReconnect(): void {
    this.rebuilding = true;
    this.closeAttachLegs();
    this.primary.forceReconnect();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const t of this.attachTimers.values()) clearTimeout(t);
    this.attachTimers.clear();
    await Promise.all([this.primary.close(), ...this.allLegs().slice(1).map((l) => l.close())]);
  }

  // ---- 内部 ----

  private nextSeq(channelId: number): number {
    const n = this.sendSeq.get(channelId) ?? 0;
    this.sendSeq.set(channelId, n + 1);
    return n;
  }

  private allLegs(): Connection[] {
    return [this.primary, ...this.attachLegs.filter((l): l is Connection => l !== null)];
  }

  /** 加权选 leg：可用容量最高者（打平取先）；无 ready leg 返回 null */
  private pickLegWithCapacity(): { leg: Connection; capacity: number } | null {
    let best: Connection | null = null;
    let bestCap = Number.NEGATIVE_INFINITY;
    for (const leg of this.allLegs()) {
      if (!leg.ready) continue;
      const cap = leg.availableCapacity();
      if (cap > bestCap) {
        best = leg;
        bestCap = cap;
      }
    }
    return best === null ? null : { leg: best, capacity: bestCap };
  }

  private pickLeg(): Connection | null {
    return this.pickLegWithCapacity()?.leg ?? null;
  }

  /** 构造一条 leg；attach 用 primary 当前 tunnelId 作种子、禁内建重连（生命周期由组管） */
  private newLeg(attach: boolean, tunnelId: string | undefined): Connection {
    const leg = new Connection(
      {
        gatewayUrl: this.opts.gatewayUrl,
        hello: attach
          ? { ...this.opts.hello, attach: true, initialTunnelId: tunnelId }
          : { ...this.opts.hello, multiConn: { count: this.opts.connections } },
        role: attach ? 'attach' : 'primary', // 断开日志角色字段 + 终态错误日志分级依据
        heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
        heartbeatMaxMissed: this.opts.heartbeatMaxMissed,
        connectTimeoutMs: attach ? ATTACH_CONNECT_TIMEOUT_MS : this.opts.connectTimeoutMs,
        reconnect: attach
          ? { ...this.opts.reconnect, maxRetries: 0 }
          : this.opts.reconnect,
        logger: this.opts.logger,
      },
      {
        onControl: (f) => this.handlers.onControl(f),
        onData: (h, p) => this.handlers.onData(h, p),
        onDisconnected: () => { if (attach) this.onAttachLegDown(); },
      },
    );
    // EventEmitter 语义：'error' 必须挂监听。attach leg 的终态错误（4410/重连耗尽）
    // 由组语义接管（重试/槽位降级/整组重建），不上抛防 Client 记 ERROR 噪音；
    // 瞬时 ws 错误（中间盒非法帧等）上抛供 Client 统一指纹分级
    leg.on('error', (err: Error) => {
      const code = (err as CodedError).code;
      if (code === ERR_ATTACH_REJECTED || code === ERR_RECONNECT_EXHAUSTED
        || code === ERR_HOSTNAME_CONFLICT) return;
      this.emit('error', err);
    });
    if (attach) {
      // attach leg（maxRetries:0）终态由组语义覆盖（整组重建/槽位降级），吞掉防噪音，
      // 不让 Client 误落 error 态；仅留 debug 诊断
      leg.on('fatal', (err: Error) =>
        this.opts.logger.debug('attach leg 终态失败，由组语义处理', { message: err.message }));
    } else {
      // primary 终态失败（已就绪后 4409 / 重连耗尽）上抛：组不再重连，由 Client 落 error 态
      leg.on('fatal', (err: Error) => this.emit('fatal', err));
    }
    return leg;
  }

  /** primary 就绪后按协商结果补 leg；老服务端（无 multiConn）静默单 leg */
  private spawnAttachLegs(): void {
    if (this.closing) return;
    const max = this.primary.serverMaxLegs;
    const tid = this.primary.tunnelId;
    if (max === undefined || tid === undefined) {
      this.opts.logger.info('服务端不支持多连接，单连接运行', { hostname: this.opts.hello.hostname });
      return;
    }
    const target = Math.min(this.opts.connections, max);
    for (let slot = 0; slot < target - 1; slot++) {
      if (this.attachLegs[slot] == null) this.startAttach(slot, tid, 0);
    }
  }

  private startAttach(slot: number, tunnelId: string, attemptNo: number): void {
    if (this.closing || this.disconnected) return;
    const leg = this.newLeg(true, tunnelId);
    this.attachLegs[slot] = leg;
    leg.connect().catch((err: unknown) => {
      if (this.attachLegs[slot] === leg) this.attachLegs[slot] = null;
      // 主动关闭（整组重建/close 收尾）≠ 连接失败：槽位由新代 spawnAttachLegs 重新填充，
      // 不再排退避重试——否则旧代幽灵重试会覆盖新代槽位、留下孤儿连接（线上多代风暴根因之一）
      if ((err as CodedError).code === ERR_CLOSED_BY_CALLER) return;
      if (this.closing || this.primary.tunnelId !== tunnelId) return; // 组已换隧道，等下轮 spawn
      if (attemptNo + 1 >= MAX_ATTACH_ATTEMPTS) {
        this.opts.logger.warn('attach 重试耗尽，该槽位降级到下次整组重连', { slot, attempts: attemptNo + 1 });
        return;
      }
      const delay = this.opts.reconnect.baseDelayMs * 2 ** attemptNo;
      const gen = this.generation;
      const timer = setTimeout(() => {
        this.attachTimers.delete(slot);
        if (this.generation !== gen) return; // 跨代重试：组已重建，槽位由新代接管
        this.startAttach(slot, tunnelId, attemptNo + 1);
      }, Math.min(delay, this.opts.reconnect.maxDelayMs));
      this.attachTimers.set(slot, timer);
    });
  }

  /** 已就绪 attach leg 断 = 整组断（spec §4.4）：收其余 leg，primary forceReconnect 驱动重连；
   *  重建 latch 已置时折叠（组已在重建，本 leg 由 closeAttachLegs 收掉，防多重重建） */
  private onAttachLegDown(): void {
    if (this.closing || this.disconnected || this.rebuilding) return;
    this.opts.logger.warn('attach leg 断开，整组重建');
    this.forceReconnect();
  }

  private closeAttachLegs(): void {
    for (const t of this.attachTimers.values()) clearTimeout(t);
    this.attachTimers.clear();
    const legs = this.attachLegs.splice(0);
    for (const leg of legs) {
      if (leg === null) continue;
      leg.close().catch(() => undefined);
    }
  }
}
