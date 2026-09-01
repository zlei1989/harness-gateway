/**
 * Client 主类 — 装配 Connection 与通道表，对外暴露生命周期与事件。
 * 公开 API 语义见 spec §3；配置非法 = 进程级错误，构造即抛错。
 * 注意：EventEmitter 语义下 'error' 事件必须挂监听，调用方未挂时由 CLI 兜底（见 cli.ts）。
 */

import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

import { type AuthDecision, type AuthorizationHook, type AuthRequest, runAuthorization } from './authorize';
import { type CodedError, Connection, ERR_RECONNECT_EXHAUSTED, type ReconnectOptions } from './connection';
import { HttpChannel } from './http-channel';
import { createDefaultLogger, type Logger } from './logger';
import { Resequencer } from './resequencer';
import { TunnelGroup } from './tunnel-group';
import { WsChannel } from './ws-channel';

import type { ChannelErrorFrame, ControlFrame, DataHeader } from './protocol';

export interface ClientOptions {
  /** 应用服务地址（http/https） */
  upstreamUrl: string;
  /** 网关隧道端点（ws/wss） */
  gatewayUrl: string;
  /** 选择页展示名（可重复；路由身份由服务端分配的 tunnelId 承担） */
  hostname: string;
  /** 本机接入令牌：配置后未提供 authorization 时启用内置 Bearer 校验 */
  token?: string;
  /** 用户选择成功后浏览器跳转路径，默认 '/' */
  defaultPath?: string;
  /** Express 中间件风格鉴权钩子；选择页探测（/__gateway__/auth-check）也走此钩子 */
  authorization?: AuthorizationHook;
  /**
   * 压缩传输：为 upstream 未压缩的可压缩响应代做端到端压缩（br/gzip，按浏览器
   * Accept-Encoding 协商），显著降低大文本响应（日志/代码 bundle）的隧道传输量。默认关闭。
   */
  compress?: boolean;
  reconnect?: Partial<ReconnectOptions>;
  heartbeatIntervalMs?: number;
  /** 心跳判死宽容度（可选，默认 3，见 connection.ts ConnectionOptions.heartbeatMaxMissed） */
  heartbeatMaxMissed?: number;
  authTimeoutMs?: number;
  connectTimeoutMs?: number;
  /**
   * 隧道连接数（spec §8）：默认 4，clamp [1,16]。>1 时建 TunnelGroup 条带化传输；
   * 1 = 纯 legacy 单连接（连 multiConn 协商都不发）。老服务端自动降级单连接。
   */
  connections?: number;
  /**
   * 隧道 WS permessage-deflate 开关：false = 客户端不提议压缩（排查中间盒误杀压缩帧 /
   * 降低 CPU 用）。缺省 = ws 库默认（提议压缩；服务端不协商则不生效）。
   */
  perMessageDeflate?: boolean;
  logger?: Logger;
}

type AnyChannel = HttpChannel | WsChannel;

/**
 * 优雅关闭的拒收窗口：closing 期间到达的新 open 需回 channel.error，
 * 而 RFC 6455 下 close 帧之后的数据对端必须忽略（ws 在 CLOSING 态 send 静默丢弃，实证），
 * 故回执必须先于隧道 close 帧发出——先拒收一小段时间再关隧道（spec §3：拒收新 open → 关闭隧道）。
 */
const CLOSING_DRAIN_MS = 50;

export class Client extends EventEmitter {
  private readonly connection: Connection | TunnelGroup;
  private readonly resequencer: Resequencer;
  private readonly connectionCount: number;
  private readonly channels = new Map<number, AnyChannel>();
  private readonly upstream: URL;
  /**
   * upstream keep-alive 连接池：高 RTT 链路下每条新建 TCP 都是一次完整握手往返，
   * 连接复用把 upstream 侧连接成本从"每请求一次"降为"首次一次"。
   * 实例协议与 upstream 严格对应（https upstream 用 https.Agent），随 close() 销毁。
   */
  private readonly agent: http.Agent;
  private readonly authorize: (req: AuthRequest) => Promise<AuthDecision>;
  private readonly logger: Logger;
  /** 压缩传输开关（HttpChannel 压缩协商总闸） */
  private readonly compress: boolean;
  private closing = false;

  constructor(options: ClientOptions) {
    super();
    // 配置非法 = 进程级错误（spec §7）：构造即抛错
    if (!options.upstreamUrl) throw new Error('ClientOptions.upstreamUrl 必填');
    if (!options.gatewayUrl) throw new Error('ClientOptions.gatewayUrl 必填');
    if (!options.hostname) throw new Error('ClientOptions.hostname 必填');
    this.upstream = new URL(options.upstreamUrl);
    if (this.upstream.protocol !== 'http:' && this.upstream.protocol !== 'https:') {
      throw new Error('ClientOptions.upstreamUrl 必须是 http/https');
    }
    // 显式 Agent（Node 20+ 全局 Agent 虽默认 keep-alive，但为全局共享且无人销毁）：
    // 独立连接池可随 Client 生命周期收走，不与其他组件互相干扰。
    // timeout 4000：空闲池内 socket 4s 自毁——先于 upstream（Node 默认 keepAliveTimeout 5s）
    // 关闭，从源头减少"复用到已被对端关闭的陈旧 socket"竞态（http-channel 的一次性重试兜底残余）；
    // 在途请求不受此 timeout 影响（仅触发 ClientRequest 'timeout' 事件，不销毁，已实测 Node 26）
    this.agent = this.upstream.protocol === 'https:'
      ? new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, timeout: 4000 })
      : new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, timeout: 4000 });
    const gateway = new URL(options.gatewayUrl);
    if (gateway.protocol !== 'ws:' && gateway.protocol !== 'wss:') {
      throw new Error('ClientOptions.gatewayUrl 必须是 ws/wss');
    }

    this.logger = options.logger ?? createDefaultLogger();
    this.compress = options.compress ?? false;
    const authTimeoutMs = options.authTimeoutMs ?? 30_000;
    // 默认 Bearer 装配下沉在 runAuthorization 内：无钩子且有 token → 内置校验；有钩子 → 钩子为准
    this.authorize = (req) =>
      runAuthorization(options.authorization, req, {
        token: options.token,
        timeoutMs: authTimeoutMs,
      });

    // 多连接装配（spec §8）：==1 走纯 legacy 单 Connection；>1 建 TunnelGroup 条带化。
    // connections clamp [1,16]，NaN/非有限值按默认 4。
    const raw = options.connections ?? 4;
    this.connectionCount = Number.isFinite(raw) ? Math.min(16, Math.max(1, Math.floor(raw))) : 4;
    const connOpts = {
      gatewayUrl: options.gatewayUrl,
      hello: { hostname: options.hostname, defaultPath: options.defaultPath ?? '/' },
      perMessageDeflate: options.perMessageDeflate,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
      // 判死宽容度原样透传：undefined 时 Connection 回落缺省 3（判死窗 = 间隔 × 3）
      heartbeatMaxMissed: options.heartbeatMaxMissed,
      connectTimeoutMs: options.connectTimeoutMs ?? 60_000,
      reconnect: {
        baseDelayMs: options.reconnect?.baseDelayMs ?? 1000,
        maxDelayMs: options.reconnect?.maxDelayMs ?? 30_000,
        maxRetries: options.reconnect?.maxRetries ?? Infinity,
        churnThresholdMs: options.reconnect?.churnThresholdMs,
      },
      logger: this.logger,
    };
    const handlers = {
      onControl: (frame: ControlFrame) => this.ingestControl(frame),
      onData: (header: DataHeader, payload: Buffer) => this.ingestData(header, payload),
      onDisconnected: () => this.abortAllChannels(),
    };
    this.connection = this.connectionCount === 1
      ? new Connection(connOpts, handlers)
      : new TunnelGroup({ ...connOpts, connections: this.connectionCount }, handlers);
    // 接收端重排序（spec §6）：多连接条带化帧可能跨 leg 乱序到达，按 seq 重排后再分发；
    // 缓冲超限 = 对端行为异常，整组重连（断腿=整组重建前提下由重连归零 seq 空间自愈）
    this.resequencer = new Resequencer({
      logger: this.logger,
      onOverflow: (channelId) => {
        this.logger.error('重排序缓冲超限，整组重连', { channelId });
        this.connection.forceReconnect();
      },
    });
    this.connection.on('error', (err: Error) => {
      // 指纹分级（线上 1006 排查）：收到携带 RFC 6455 保留码的非法 close 帧 = 帧由路径上的
      // 中间盒/LB 合成（本仓库双端基于 ws 库，Sender 物理上拒绝发送保留码帧）——属"他杀"
      // 确证而非本仓库故障；连接由 Connection 内建重连自动收敛，记 WARN 归因留证，
      // 不按通用隧道故障记 ERROR 误导排查方向（现象无变化：断连重连本就由此驱动）
      if (isSynthesizedCloseKill(err)) {
        this.logger.warn('收到中间盒合成的非法 close 帧，隧道由内建重连恢复', { error: err.message });
      } else if ((err as CodedError).code === ERR_RECONNECT_EXHAUSTED) {
        // 重连耗尽：primary/单连接的终态经 'fatal' 由外层落 error 态，attach leg 由
        // TunnelGroup 组语义接管——'error' 事件仍上抛（监听契约不变），仅日志降 debug
        this.logger.debug('重连次数耗尽（终态由外层/组语义处理）', { error: err.message });
      } else {
        this.logger.error('隧道连接错误', { error: err.stack ?? err.message });
      }
      this.emit('error', err);
    });
    // 终态失败透传（不再重连：4409 / 重连耗尽）；瞬时 ws 错误只走 'error'，由重连收敛
    this.connection.on('fatal', (err: Error) => this.emit('fatal', err));
    this.connection.on('connected', () => this.emit('connected'));
    this.connection.on('disconnected', () => this.emit('disconnected'));
  }

  /** 建立隧道（首连失败内部退避重试，connectTimeoutMs/4409 才 reject） */
  connect(): Promise<void> {
    return this.connection.connect();
  }

  /** 服务端分配的 tunnelId（hello.ack 后可用）；用户据此拼 select?tunnelId= 深链 */
  get tunnelId(): string | undefined {
    return this.connection.tunnelId;
  }

  /** 当前就绪 leg 数（多连接观测/e2e 断言用；单连接恒 1） */
  get legCount(): number {
    return this.connection instanceof TunnelGroup ? this.connection.readyLegCount : 1;
  }

  /** 优雅关闭：拒收新 open（回执窗口）→ 关隧道（服务端随即注销 hostname）→ 中止在途通道 → 收走连接池 */
  async close(): Promise<void> {
    this.closing = true;
    // 窗口期内 Connection 仍正常路由帧：新 open 走到 openHttp/openWs 的 closing 分支回 channel.error
    await new Promise((resolve) => setTimeout(resolve, CLOSING_DRAIN_MS));
    // 注意：Connection.close() 主动关闭不会触发 onDisconnected（先清 readyState），
    // 在途通道必须由本类自行中止，不能依赖断开回调
    await this.connection.close();
    this.abortAllChannels();
    // 销毁 upstream 连接池：空闲 keep-alive socket 不得泄漏到 Client 生命周期之外
    this.agent.destroy();
  }

  /** 控制帧 ingest 入口：带 seq 的通道级帧（多连接条带化）进 Resequencer 重排，其余直通分发 */
  private ingestControl(frame: ControlFrame): void {
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    const seq = 'seq' in frame ? frame.seq : undefined;
    if (channelId !== undefined && typeof seq === 'number') {
      this.resequencer.feed(channelId, seq, { kind: 'control', frame }, (item) => {
        if (item.kind === 'control') this.dispatchControl(item.frame);
      });
      return;
    }
    this.dispatchControl(frame);
  }

  /** 数据帧 ingest 入口：带 seq 的帧进 Resequencer 重排，其余直通分发 */
  private ingestData(header: DataHeader, payload: Buffer): void {
    if (typeof header.seq === 'number') {
      this.resequencer.feed(header.channelId, header.seq, { kind: 'data', header, payload }, (item) => {
        if (item.kind === 'data') this.dispatchData(item.header, item.payload);
      });
      return;
    }
    this.dispatchData(header, payload);
  }

  /** 控制帧路由：hello.ack/ping/pong 已被 Connection 消化 */
  private dispatchControl(frame: ControlFrame): void {
    switch (frame.type) {
      case 'http.open': {
        this.openHttp(frame);
        break;
      }
      case 'ws.open': {
        this.openWs(frame);
        break;
      }
      case 'channel.close': {
        this.channels.get(frame.channelId)?.onPeerClose(frame);
        break;
      }
      case 'channel.error': {
        this.channels.get(frame.channelId)?.abort();
        break;
      }
      default: {
        // http.head/ws.accept/hello 等客户端不应收到的帧：协议级异常由 Connection 判不了类型合法性，记 WARN 丢弃
        this.logger.warn('收到未预期控制帧，丢弃', { type: frame.type });
      }
    }
  }

  /** 数据帧路由：未知 channelId 丢弃（对端已关闭的迟到帧属正常竞态） */
  private dispatchData(header: DataHeader, payload: Buffer): void {
    const channel = this.channels.get(header.channelId);
    if (!channel) {
      this.logger.debug('未知通道数据帧，丢弃', { channelId: header.channelId, kind: header.kind });
      return;
    }
    if (header.kind === 'http.body' && channel instanceof HttpChannel) channel.onBody(payload);
    else if (header.kind === 'http.body.end' && channel instanceof HttpChannel) channel.onBodyEnd();
    else if (header.kind === 'ws.message' && channel instanceof WsChannel) channel.onMessage(header.dataType ?? 'binary', payload);
    else this.logger.warn('数据帧与通道类型不匹配', { channelId: header.channelId, kind: header.kind });
  }

  private openHttp(frame: Extract<ControlFrame, { type: 'http.open' }>): void {
    if (this.closing) {
      this.connection.sendControl({ type: 'channel.error', channelId: frame.channelId, message: 'client closing' });
      return;
    }
    const channel = new HttpChannel({
      id: frame.channelId, open: frame, upstream: this.upstream,
      connection: this.connection, authorize: this.authorize, logger: this.logger,
      agent: this.agent, compress: this.compress,
      onDone: (id) => { this.channels.delete(id); this.resequencer.dropChannel(id); },
    });
    this.channels.set(frame.channelId, channel);
    void channel.start().catch((err: unknown) => {
      this.logger.error('HTTP 通道启动异常', { channelId: frame.channelId, error: err instanceof Error ? err.stack : String(err) });
      channel.abort();
    });
  }

  private openWs(frame: Extract<ControlFrame, { type: 'ws.open' }>): void {
    if (this.closing) {
      this.connection.sendControl({ type: 'channel.error', channelId: frame.channelId, message: 'client closing' });
      return;
    }
    const channel = new WsChannel({
      id: frame.channelId, open: frame, upstream: this.upstream,
      connection: this.connection, authorize: this.authorize, logger: this.logger,
      onDone: (id) => { this.channels.delete(id); this.resequencer.dropChannel(id); },
    });
    this.channels.set(frame.channelId, channel);
    void channel.start().catch((err: unknown) => {
      this.logger.error('WS 通道启动异常', { channelId: frame.channelId, error: err instanceof Error ? err.stack : String(err) });
      channel.abort();
    });
  }

  /** 中止全部在途通道（隧道断开/close 时调用）；先快照再遍历，与 done() 回调内删 map 并发安全 */
  private abortAllChannels(): void {
    const all = [...this.channels.values()];
    this.channels.clear();
    for (const channel of all) channel.abort();
    this.resequencer.reset(); // channelId 空间随隧道重建归零，重排序状态一并清空
  }
}

// ChannelErrorFrame 仅用于类型完备性（dispatchControl switch 内联收窄）
export type { ChannelErrorFrame };

/**
 * 中间盒杀连接指纹：ws Receiver 解析到携带 RFC 6455 保留状态码（如 1006）的 close 帧时
 * 抛 RangeError "Invalid WebSocket frame: invalid status code N"。保留码按规范永不上线，
 * 且 ws 库 Sender.close() 校验拒绝发送——收到即证明帧由路径上的中间盒/LB 合成注入
 * （服务端基于 ws，物理上不可能是发送方）。仅作日志分级判定，不改变任何连接行为。
 */
export function isSynthesizedCloseKill(err: Error): boolean {
  return err instanceof RangeError && /invalid status code/i.test(err.message);
}
