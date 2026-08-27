/**
 * TCP 透传代理服务器（spec §4.3）。
 * 入站连接先过连接准入令牌桶（FIFO 排队等待，close 自动取消），准入后对接 target 并双向节流透传。
 * HTTP 与 WS 均为 TCP 字节流，天然透传。裸 socket 一律先挂 error 消化监听
 * （对齐 server 包裸 socket 事故修复模式：未处理 error 会崩进程）。
 */

import net from 'node:net';

import { BandwidthLimiter, ConnectionLimiter } from './rate-limiter';
import { ThrottleStream } from './throttle';

export interface ProxyLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ProxyServerOptions {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  maxConnectionsPerSecond: number;
  maxBytesPerSecond: number;
  logger?: ProxyLogger | undefined;
}

/** 静默 logger（缺省）：库用法/测试不传 logger 时不喷控制台 */
const noopLogger: ProxyLogger = { info: () => {}, warn: () => {}, error: () => {} };

export class ProxyServer {
  private readonly connectionLimiter: ConnectionLimiter;
  private readonly bandwidth: BandwidthLimiter;
  private readonly logger: ProxyLogger;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: ProxyServerOptions) {
    this.connectionLimiter = new ConnectionLimiter(options.maxConnectionsPerSecond);
    this.bandwidth = new BandwidthLimiter(options.maxBytesPerSecond);
    this.logger = options.logger ?? noopLogger;
  }

  /** 启动监听；返回实际端口（传 0 时取随机端口，供测试） */
  listen(): Promise<number> {
    if (this.server) throw new Error('ProxyServer.listen() 不可重复调用');
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(this.options.listenPort, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : this.options.listenPort);
      });
    });
  }

  /** 关停：停止 accept，销毁全部在途与排队连接，停止限流器定时器 */
  close(): Promise<void> {
    this.connectionLimiter.close();
    this.bandwidth.close();
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  private onConnection(client: net.Socket): void {
    this.track(client);
    // 裸 socket error 消化：排队/准入窗内对端 RST 不得以未处理 error 崩进程
    client.on('error', (err) => this.logger.warn('客户端 socket 错误', { error: err.message }));
    void this.connectionLimiter.acquire(client).then(() => this.admit(client));
  }

  private admit(client: net.Socket): void {
    if (client.destroyed) return; // 排队后已断开的时序兜底
    const { targetHost, targetPort } = this.options;
    const target = net.connect({ host: targetHost, port: targetPort });
    this.track(target);
    target.on('error', (err) => {
      this.logger.warn('目标连接失败/错误', { error: err.message, target: `${targetHost}:${targetPort}` });
      client.destroy();
    });
    // 异常（RST/拒连）才摧毁对端；优雅关闭（FIN）交给 pipe 自然结束
    client.on('error', () => {
      if (!target.destroyed) target.destroy();
    });
    // 截断修复：一侧 close 时不得 destroy/end 另一侧——对端 FIN 后其 readable 自然结束，
    // 节流队列中尚未交付的字节随 pipe 排空后本侧才收到 end——destroy/end 会把队列尾包直接丢弃
    // （线上复现：服务端 keep-alive 空闲关闭时，响应经节流排队的尾包被截断）。
    client.pipe(new ThrottleStream(this.bandwidth)).pipe(target);
    target.pipe(new ThrottleStream(this.bandwidth)).pipe(client);
    this.logger.info('连接准入', { remote: client.remoteAddress, target: `${targetHost}:${targetPort}` });
  }
}
