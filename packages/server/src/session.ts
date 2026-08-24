/**
 * TunnelSession（单条隧道连接的通道表）与 TunnelRegistry（tunnelId → 隧道注册表）。
 * 注意：channelId 会话内递增，隧道重建后编号空间重置（旧通道已全部 teardown）；
 * registry.delete 校验 session 身份，防止"旧隧道断开事件"误删"新隧道"的重连竞态。
 * tunnelId 是隧道路由唯一身份（服务端分配的 uuid，可经 hello 回带复用）；hostname 纯展示名、可重复。
 */

import { type ControlFrame, type DataHeader, encodeControl, encodeData } from './protocol';

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

export class TunnelSession implements TunnelHandle {
  /** 服务端分配的隧道标识（uuid；hello 回带复用时为回带值） */
  readonly tunnelId: string;
  readonly hostname: string;
  readonly defaultPath: string;
  private nextChannelId = 1;
  private readonly channels = new Map<number, PendingChannel>();
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private down = false;

  constructor(
    private readonly ws: WebSocket,
    info: { tunnelId: string; hostname: string; defaultPath: string },
    private readonly logger: Logger,
    private readonly onDown: (session: TunnelSession) => void,
  ) {
    this.tunnelId = info.tunnelId;
    this.hostname = info.hostname;
    this.defaultPath = info.defaultPath;
  }

  register(channel: PendingChannel): number {
    const channelId = this.nextChannelId++;
    this.channels.set(channelId, channel);
    return channelId;
  }

  unregister(channelId: number): void {
    this.channels.delete(channelId);
  }

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

  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 控制帧入口（tunnel.ts 路由调用）：ping/pong 本层消化，其余按 channelId 分发 */
  handleControl(frame: ControlFrame): void {
    if (frame.type === 'ping') {
      this.ws.send(encodeControl({ type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    if (channelId === undefined) {
      this.logger.warn('隧道收到无 channelId 控制帧，丢弃', { type: frame.type });
      return;
    }
    this.callChannel(channelId, () => {
      this.channels.get(channelId)?.onControl(frame);
    });
  }

  handleData(header: DataHeader, payload: Buffer): void {
    this.callChannel(header.channelId, () => {
      this.channels.get(header.channelId)?.onData(header, payload);
    });
  }

  /** 隧道断开：全部通道失败 + 唤醒悬挂的 waitDrain + 通知注册表注销（幂等） */
  teardown(): void {
    if (this.down) return;
    this.down = true;
    const all = [...this.channels.entries()];
    this.channels.clear();
    // 通道级隔离：单通道 onTunnelDown 异常不影响其余通道与 onDown（否则 registry 泄漏死会话）
    for (const [channelId, channel] of all) {
      this.callChannel(channelId, () => channel.onTunnelDown());
    }
    // 唤醒悬挂的 drainWaiters：隧道已断，调用方醒来后走 onTunnelDown 已失败路径，不得永久悬挂
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) waiter();
    this.onDown(this);
  }

  /** 服务端主动关闭（server.close） */
  close(): void {
    this.ws.close(1000, 'server shutdown');
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

export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelSession>();

  get(tunnelId: string): TunnelSession | undefined {
    return this.tunnels.get(tunnelId);
  }

  has(tunnelId: string): boolean {
    return this.tunnels.has(tunnelId);
  }

  set(tunnelId: string, session: TunnelSession): void {
    this.tunnels.set(tunnelId, session);
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

  teardownAll(): void {
    for (const session of [...this.tunnels.values()]) session.teardown();
    this.tunnels.clear();
  }

  /**
   * 服务端关停（spec §3「关所有隧道」）：逐隧道 session.close()——关闭底层 ws 并 teardown 在途通道。
   * 注意与 teardownAll 的区别：teardown 只失败通道不关底层 socket，
   * upgrade 过的 socket 存活会使 http.Server.close 回调永不触发（优雅关停悬挂）。
   */
  closeAll(): void {
    for (const session of [...this.tunnels.values()]) session.close();
    this.tunnels.clear();
  }
}
