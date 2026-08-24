/**
 * Client 主类 — 装配 Connection 与通道表，对外暴露生命周期与事件。
 * 公开 API 语义见 spec §3；配置非法 = 进程级错误，构造即抛错。
 * 注意：EventEmitter 语义下 'error' 事件必须挂监听，调用方未挂时由 CLI 兜底（见 cli.ts）。
 */

import { EventEmitter } from 'node:events';

import { type AuthDecision, type AuthorizationHook, type AuthRequest, runAuthorization } from './authorize';
import { Connection, type ReconnectOptions } from './connection';
import { HttpChannel } from './http-channel';
import { createDefaultLogger, type Logger } from './logger';
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
  reconnect?: Partial<ReconnectOptions>;
  heartbeatIntervalMs?: number;
  authTimeoutMs?: number;
  connectTimeoutMs?: number;
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
  private readonly connection: Connection;
  private readonly channels = new Map<number, AnyChannel>();
  private readonly upstream: URL;
  private readonly authorize: (req: AuthRequest) => Promise<AuthDecision>;
  private readonly logger: Logger;
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
    const gateway = new URL(options.gatewayUrl);
    if (gateway.protocol !== 'ws:' && gateway.protocol !== 'wss:') {
      throw new Error('ClientOptions.gatewayUrl 必须是 ws/wss');
    }

    this.logger = options.logger ?? createDefaultLogger();
    const authTimeoutMs = options.authTimeoutMs ?? 30_000;
    // 默认 Bearer 装配下沉在 runAuthorization 内：无钩子且有 token → 内置校验；有钩子 → 钩子为准
    this.authorize = (req) =>
      runAuthorization(options.authorization, req, {
        token: options.token,
        timeoutMs: authTimeoutMs,
      });

    this.connection = new Connection(
      {
        gatewayUrl: options.gatewayUrl,
        hello: { hostname: options.hostname, defaultPath: options.defaultPath ?? '/' },
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
        connectTimeoutMs: options.connectTimeoutMs ?? 60_000,
        reconnect: {
          baseDelayMs: options.reconnect?.baseDelayMs ?? 1000,
          maxDelayMs: options.reconnect?.maxDelayMs ?? 30_000,
          maxRetries: options.reconnect?.maxRetries ?? Infinity,
        },
        logger: this.logger,
      },
      {
        onControl: (frame) => this.onControl(frame),
        onData: (header, payload) => this.onData(header, payload),
        onDisconnected: () => this.abortAllChannels(),
      },
    );
    this.connection.on('error', (err: Error) => {
      this.logger.error('隧道连接错误', { error: err.stack ?? err.message });
      this.emit('error', err);
    });
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

  /** 优雅关闭：拒收新 open（回执窗口）→ 关隧道（服务端随即注销 hostname）→ 中止在途通道 */
  async close(): Promise<void> {
    this.closing = true;
    // 窗口期内 Connection 仍正常路由帧：新 open 走到 openHttp/openWs 的 closing 分支回 channel.error
    await new Promise((resolve) => setTimeout(resolve, CLOSING_DRAIN_MS));
    // 注意：Connection.close() 主动关闭不会触发 onDisconnected（先清 readyState），
    // 在途通道必须由本类自行中止，不能依赖断开回调
    await this.connection.close();
    this.abortAllChannels();
  }

  /** 控制帧路由：hello.ack/ping/pong 已被 Connection 消化 */
  private onControl(frame: ControlFrame): void {
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
  private onData(header: DataHeader, payload: Buffer): void {
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
      onDone: (id) => this.channels.delete(id),
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
      onDone: (id) => this.channels.delete(id),
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
  }
}

// ChannelErrorFrame 仅用于类型完备性（onControl switch 内联收窄）
export type { ChannelErrorFrame };
