/**
 * GatewayServer 主类 — 单端口装配：HTTP 请求与 WS upgrade 按路径分发（spec §4）。
 * 保留命名空间 /__gateway__/：tunnelPath 只接受 WS upgrade（GET 404）、selectPath 选择页、其余前缀路径 404。
 * upgrade 分发沿用 packages/web ws-gateway.ts 的 noServer 范式；浏览器侧 wss 配 handleProtocols 支持子协议回显。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { WebSocketServer } from 'ws';

import { BrowserSessionStore } from './browser-session';
import { createOriginMatcher, DEFAULT_CORS_ORIGINS } from './cors';
import { handleBrowserHttp, type ProxyContext } from './http-proxy';
import { createDefaultLogger, type Logger } from './logger';
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
  /** CORS 允许名单（'*' 全放行，'*.jd.com' 匹配本体及子域）；默认 DEFAULT_CORS_ORIGINS */
  corsOrigins?: string[];
  logger?: Logger;
}

const RESERVED_PREFIX = '/__gateway__/';

export class GatewayServer {
  private readonly options: Required<Omit<GatewayServerOptions, 'logger'>>;
  private readonly logger: Logger;
  private readonly tunnels = new TunnelRegistry();
  private readonly sessions = new BrowserSessionStore();
  private httpServer: Server | null = null;
  private browserWss: WebSocketServer | null = null;

  constructor(options: GatewayServerOptions) {
    // 配置非法 = 进程级错误：构造即抛错
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error('GatewayServerOptions.port 必须是 0-65535 的整数');
    }
    this.logger = options.logger ?? createDefaultLogger();
    this.options = {
      port: options.port,
      tunnelPath: options.tunnelPath ?? '/__gateway__/tunnel',
      selectPath: options.selectPath ?? '/__gateway__/select',
      helloTimeoutMs: options.helloTimeoutMs ?? 15_000,
      headTimeoutMs: options.headTimeoutMs ?? 120_000,
      corsOrigins: options.corsOrigins ?? DEFAULT_CORS_ORIGINS,
    };
    // 保留命名空间校验：分发逻辑只在 /__gateway__/ 前缀块内匹配 tunnelPath/selectPath，
    // 前缀外路径永远不会命中（302 会自指循环），构造即拒绝
    for (const key of ['tunnelPath', 'selectPath'] as const) {
      if (!this.options[key].startsWith(RESERVED_PREFIX)) {
        throw new Error(`GatewayServerOptions.${key} 必须以 ${RESERVED_PREFIX} 开头（当前: ${this.options[key]}）`);
      }
    }
  }

  /** 启动监听；返回实际绑定端口（port: 0 时用于测试） */
  listen(): Promise<number> {
    const { tunnelPath, selectPath, helloTimeoutMs, headTimeoutMs, corsOrigins } = this.options;
    const proxyCtx: ProxyContext = {
      tunnels: this.tunnels,
      sessions: this.sessions,
      selectPath,
      headTimeoutMs,
      logger: this.logger,
      corsAllowOrigin: createOriginMatcher(corsOrigins),
    };

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      handleBrowserHttp(req, res, proxyCtx);
    });

    // 隧道 WS 接入（只处理 tunnelPath，其余路径交还）
    attachTunnelHandler(this.httpServer, {
      tunnels: this.tunnels,
      tunnelPath,
      helloTimeoutMs,
      logger: this.logger,
    });

    // 浏览器 WS：handleProtocols 回选改写后的唯一协议（ws-proxy 在 handleUpgrade 前改写请求头）
    // 挂为实例字段：close() 须 terminate 全部浏览器客户端，否则 upgrade 过的 socket 使关闭悬挂
    this.browserWss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => [...protocols][0] ?? false,
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
      handleBrowserWs(req, socket, head, browserWss, proxyCtx);
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
