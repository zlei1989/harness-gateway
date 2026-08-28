/**
 * GatewayServer 主类 — 单端口装配：HTTP 请求与 WS upgrade 按路径分发（spec §4）。
 * 保留命名空间 /__gateway__/：tunnelPath 只接受 WS upgrade（GET 404）、selectPath 选择页、其余前缀路径 404。
 * upgrade 分发沿用 packages/web ws-gateway.ts 的 noServer 范式；浏览器侧 wss 配 handleProtocols 支持子协议回显。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { WebSocketServer } from 'ws';

import { BrowserSessionStore, DEFAULT_SESSION_TTL_MS } from './browser-session';
import { createOriginMatcher, DEFAULT_CORS_ORIGINS } from './cors';
import { handleBrowserHttp, type ProxyContext } from './http-proxy';
import { createDefaultLogger, type Logger } from './logger';
import { MAX_PAYLOAD_BYTES } from './protocol';
import { handleSelectGet, handleSelectPost } from './select-page';
import { TunnelRegistry } from './session';
import { attachTunnelHandler } from './tunnel';
import { safePathname } from './url';
import { handleBrowserWs } from './ws-proxy';

import type { Duplex } from 'node:stream';

export interface GatewayServerOptions {
  port: number;
  tunnelPath?: string;
  selectPath?: string;
  helloTimeoutMs?: number;
  headTimeoutMs?: number;
  /**
   * 隧道 WS 开启 permessage-deflate（跨机房/跨境部署建议开启）：
   * 压缩隧道帧负载（≥1KB 才压缩，SSE 小帧不受影响），显著降低高 RTT 低带宽链路上的传输时间，
   * 代价是两端少量 CPU。客户端 ws 默认发起协商，服务端开启即生效。
   */
  tunnelPerMessageDeflate?: boolean;
  /**
   * 浏览器侧 HTTP keep-alive 空闲超时（毫秒，须为正整数）。
   * 高 RTT 链路下每条新建 TCP+TLS 是多次完整往返：调大空闲超时让浏览器连接跨页面间隙复用，
   * 减少重握手。headersTimeout 自动抬到该值之上（Node 要求 headers > keepAlive）。
   */
  keepAliveTimeoutMs?: number;
  /** CORS 允许名单（'*' 全放行，'*.jd.com' 匹配本体及子域）；默认 DEFAULT_CORS_ORIGINS */
  corsOrigins?: string[];
  /** 浏览器会话生存期（毫秒，须为正整数；cookie Max-Age 同源）。默认 7 天 */
  browserSessionTtlMs?: number;
  /** 浏览器会话快照路径（缺省 = 纯内存）；明文 JSON + 0600，重启恢复 */
  sessionStorePath?: string;
  /**
   * 瞬断宽限（毫秒，须为非负整数；默认 30_000）：隧道离线时新到的浏览器请求挂起等重连，
   * 宽限内恢复则透明转发，耗尽才 502；0 = 即时 502 旧行为。宽限只保新请求，在途通道仍立即失败。
   */
  tunnelRestoreGraceMs?: number;
  logger?: Logger;
}

const RESERVED_PREFIX = '/__gateway__/';

/** headersTimeout 兜底抬升量：必须严格大于 keepAliveTimeout（Node 运行时校验） */
const HEADERS_TIMEOUT_MARGIN_MS = 5_000;

export class GatewayServer {
  private readonly options: Required<Omit<GatewayServerOptions, 'logger' | 'sessionStorePath'>>
    & Pick<GatewayServerOptions, 'sessionStorePath'>;
  private readonly logger: Logger;
  private readonly tunnels = new TunnelRegistry();
  private readonly sessions: BrowserSessionStore;
  private httpServer: Server | null = null;
  private browserWss: WebSocketServer | null = null;

  constructor(options: GatewayServerOptions) {
    // 配置非法 = 进程级错误：构造即抛错
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error('GatewayServerOptions.port 必须是 0-65535 的整数');
    }
    if (options.keepAliveTimeoutMs !== undefined
      && (!Number.isInteger(options.keepAliveTimeoutMs) || options.keepAliveTimeoutMs <= 0)) {
      throw new Error('GatewayServerOptions.keepAliveTimeoutMs 必须是正整数毫秒值');
    }
    if (options.browserSessionTtlMs !== undefined
      && (!Number.isInteger(options.browserSessionTtlMs) || options.browserSessionTtlMs <= 0)) {
      throw new Error('GatewayServerOptions.browserSessionTtlMs 必须是正整数毫秒值');
    }
    if (options.tunnelRestoreGraceMs !== undefined
      && (!Number.isInteger(options.tunnelRestoreGraceMs) || options.tunnelRestoreGraceMs < 0)) {
      throw new Error('GatewayServerOptions.tunnelRestoreGraceMs 必须是非负整数毫秒值');
    }
    this.logger = options.logger ?? createDefaultLogger();
    this.options = {
      port: options.port,
      tunnelPath: options.tunnelPath ?? '/__gateway__/tunnel',
      selectPath: options.selectPath ?? '/__gateway__/select',
      helloTimeoutMs: options.helloTimeoutMs ?? 15_000,
      headTimeoutMs: options.headTimeoutMs ?? 120_000,
      tunnelPerMessageDeflate: options.tunnelPerMessageDeflate ?? false,
      keepAliveTimeoutMs: options.keepAliveTimeoutMs ?? 5_000,
      corsOrigins: options.corsOrigins ?? DEFAULT_CORS_ORIGINS,
      browserSessionTtlMs: options.browserSessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      sessionStorePath: options.sessionStorePath,
      tunnelRestoreGraceMs: options.tunnelRestoreGraceMs ?? 30_000,
    };
    // 保留命名空间校验：分发逻辑只在 /__gateway__/ 前缀块内匹配 tunnelPath/selectPath，
    // 前缀外路径永远不会命中（302 会自指循环），构造即拒绝
    for (const key of ['tunnelPath', 'selectPath'] as const) {
      if (!this.options[key].startsWith(RESERVED_PREFIX)) {
        throw new Error(`GatewayServerOptions.${key} 必须以 ${RESERVED_PREFIX} 开头（当前: ${this.options[key]}）`);
      }
    }
    this.sessions = new BrowserSessionStore(
      { ttlMs: this.options.browserSessionTtlMs, persistPath: this.options.sessionStorePath },
      this.logger,
    );
  }

  /** 启动监听；返回实际绑定端口（port: 0 时用于测试） */
  listen(): Promise<number> {
    const { tunnelPath, selectPath, helloTimeoutMs, headTimeoutMs, corsOrigins, tunnelRestoreGraceMs } = this.options;
    const keepAliveTimeoutMs = this.options.keepAliveTimeoutMs;
    const proxyCtx: ProxyContext = {
      tunnels: this.tunnels,
      sessions: this.sessions,
      selectPath,
      headTimeoutMs,
      tunnelRestoreGraceMs,
      logger: this.logger,
      corsAllowOrigin: createOriginMatcher(corsOrigins),
    };

    // keepAliveTimeout 面向高 RTT 链路调大浏览器连接复用窗口；headersTimeout 必须严格大于
    // keepAliveTimeout（Node 运行时约束），显式抬到其上加余量，避免两者相等时连接被提前砍
    this.httpServer = createServer({
      keepAliveTimeout: keepAliveTimeoutMs,
      headersTimeout: Math.max(60_000, keepAliveTimeoutMs + HEADERS_TIMEOUT_MARGIN_MS),
    }, (req: IncomingMessage, res: ServerResponse) => {
      // 畸形 request-target 防线：new URL 抛错不得上溢为 uncaughtException（单请求 DoS），回 400
      const pathname = safePathname(req.url);
      if (pathname === null) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
        return;
      }
      // 保留命名空间：隧道 GET 404 / 选择页 / 其余前缀路径 404（不转发，spec §4 自审补丁）
      if (pathname.startsWith(RESERVED_PREFIX)) {
        if (pathname === selectPath && req.method === 'GET') {
          handleSelectGet(res, this.tunnels);
          return;
        }
        if (pathname === selectPath && req.method === 'POST') {
          void handleSelectPost(req, res, { ...proxyCtx }).catch((err: unknown) => {
            this.logger.error('选择页 POST 处理异常', { error: err instanceof Error ? err.stack : String(err) });
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      // async 化后（瞬断宽限等待）异常兜底：不得上溢为 unhandledRejection
      void handleBrowserHttp(req, res, proxyCtx).catch((err: unknown) => {
        this.logger.error('浏览器 HTTP 处理异常', { error: err instanceof Error ? err.stack : String(err) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });

    // 隧道 WS 接入（只处理 tunnelPath，其余路径交还）
    attachTunnelHandler(this.httpServer, {
      tunnels: this.tunnels,
      tunnelPath,
      helloTimeoutMs,
      tunnelPerMessageDeflate: this.options.tunnelPerMessageDeflate,
      logger: this.logger,
    });

    // 浏览器 WS：handleProtocols 回选改写后的唯一协议（ws-proxy 在 handleUpgrade 前改写请求头）
    // 挂为实例字段：close() 须 terminate 全部浏览器客户端，否则 upgrade 过的 socket 使关闭悬挂；
    // maxPayload 显式对齐隧道帧上限契约（原为 ws 隐式默认 100MiB）：
    // 超 100MiB 的浏览器消息由本端 1009 杀本通道（通道级），边界带由 ws-proxy 发送护栏拦截
    this.browserWss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => [...protocols][0] ?? false,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    const browserWss = this.browserWss;
    this.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // 同 HTTP 路径防线：upgrade 回调中抛错同样崩进程，直接销毁 socket（无响应可写）
      const pathname = safePathname(req.url);
      if (pathname === null) {
        socket.destroy();
        return;
      }
      if (pathname === tunnelPath) return; // 已被隧道处理器接管
      if (pathname.startsWith(RESERVED_PREFIX)) {
        socket.destroy(); // 保留命名空间不转发
        return;
      }
      // async 化后（瞬断宽限等待）异常兜底：不得上溢为 unhandledRejection
      void handleBrowserWs(req, socket, head, browserWss, proxyCtx).catch((err: unknown) => {
        this.logger.error('浏览器 WS 处理异常', { error: err instanceof Error ? err.stack : String(err) });
        socket.destroy();
      });
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.options.port, () => {
        const addr = this.httpServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.options.port;
        this.logger.info('网关就绪', { port });
        resolve(port);
      });
    });
  }

  /**
   * 优雅关闭：逐隧道 close（关底层 ws + 在途通道失败）→ terminate 浏览器 WS →
   * closeAllConnections 兜底残余 keep-alive → 关 HTTP 服务。
   * 注意：upgrade 过的 socket 不受 http.Server.close 等待管理，不主动断开则回调永不触发。
   */
  async close(): Promise<void> {
    this.tunnels.closeAll(); // spec §3「关所有隧道」：teardownAll 不关底层 ws，必须 closeAll
    if (this.browserWss) {
      for (const client of this.browserWss.clients) client.terminate();
      this.browserWss = null;
    }
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.(); // 兜底：残余 keep-alive HTTP 连接同样阻断 close 回调
      server.close(() => resolve());
    });
  }
}
