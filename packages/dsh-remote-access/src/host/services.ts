/**
 * Host 侧服务契约——本插件从 harness host 服务消费的精确 API 表面（type-only）。
 * 实现位于用户的 harness（dsh-base / dsh-web-app bundle）；
 * 插件在 inject 中声明，Cordis 保持纤程挂起直到 provider 激活。
 */

/** harness webserver 上的一条 HTTP 路由注册。 */
export interface WebRouteLike {
  kind: 'exact';
  path: string;
  handler(req: WebRequestLike, res: WebResponseLike): void;
}

export interface WebRequestLike {
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end' | 'close', cb: () => void): void;
}

export interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

/** harness web 服务器（ctx.webServer）。 */
export interface WebServerFace {
  register(route: WebRouteLike): () => void;
  port?: number;
}

/** harness connection 服务（ctx.connection）——HostConnectionHandle 中本插件消费的最小面。 */
export interface ConnectionFace {
  /** 给干净的 Web 应用 origin 附加本进程启动令牌（返回 .../?token=… 的启动 URL）。 */
  authenticatedUrl(baseUrl: string): string;
}
