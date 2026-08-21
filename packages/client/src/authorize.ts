/**
 * authorization 执行器 — Express 中间件风格钩子在隧道场景的适配层。
 * 语义（spec §3.1）：next() 放行；写 res 即拒绝（原样透传浏览器）；next(err)/同步抛异常/悬挂超时 → 403。
 * 注意：选择页探测（/__gateway__/auth-check）也走此执行器，自定义钩子必须兼容该路径。
 */

import type { HeadersJson, HttpOpenFrame, WsOpenFrame } from './protocol';

/** 鉴权请求的只读信息（HTTP 与 WS 握手共用） */
export interface AuthRequest {
  method: string;
  url: string;
  headers: HeadersJson;
  /** 浏览器真实 IP：服务端注入的 X-Forwarded-For 首项；缺省 null（不是隧道对端地址） */
  ip: string | null;
  isWebSocket: boolean;
}

/** 由 open 帧构造 AuthRequest（headers 在协议层已小写化） */
export function buildAuthRequest(
  open: HttpOpenFrame | WsOpenFrame,
  isWebSocket: boolean,
): AuthRequest {
  const xff = open.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const ip = first?.split(',')[0]?.trim() || null;
  return {
    method: 'method' in open ? open.method : 'GET',
    url: open.url,
    headers: open.headers,
    ip,
    isWebSocket,
  };
}

/** 钩子可写的最小响应对象：写 res（end）即视为拒绝，内容原样透传浏览器 */
export class AuthResponse {
  statusCode = 200;
  headers: HeadersJson = {};
  body: Buffer = Buffer.alloc(0);
  writableEnded = false;

  writeHead(status: number, headers?: HeadersJson): this {
    this.statusCode = status;
    if (headers) this.headers = { ...this.headers, ...headers };
    return this;
  }

  end(body?: string | Buffer): void {
    if (body !== undefined) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    }
    this.writableEnded = true;
  }
}

export type AuthorizationHook = (
  req: AuthRequest,
  res: AuthResponse,
  next: (err?: unknown) => void,
) => void;

/** 鉴权结论：allowed=false 时其余字段为拒绝响应 */
export interface AuthDecision {
  allowed: boolean;
  status: number;
  headers: HeadersJson;
  body: Buffer;
}

const ALLOW: AuthDecision = { allowed: true, status: 200, headers: {}, body: Buffer.alloc(0) };
const FORBIDDEN: AuthDecision = {
  allowed: false,
  status: 403,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: Buffer.from('forbidden'),
};

/** 执行鉴权：无钩子且有 token → 内置 Bearer 校验；都无 → 放行；有钩子 → 钩子为准 */
export function runAuthorization(
  hook: AuthorizationHook | undefined,
  req: AuthRequest,
  opts: { token?: string | undefined; timeoutMs: number },
): Promise<AuthDecision> {
  if (!hook) {
    if (opts.token === undefined) return Promise.resolve(ALLOW);
    return Promise.resolve(req.headers['authorization'] === `Bearer ${opts.token}` ? ALLOW : FORBIDDEN);
  }
  return new Promise<AuthDecision>((resolve) => {
    const res = new AuthResponse();
    let settled = false;
    const done = (decision: AuthDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };
    // 悬挂兜底：既不调 next 也不写 res，超时按拒绝处理
    const timer = setTimeout(() => done(FORBIDDEN), opts.timeoutMs);
    // 包装 end：先包装再调钩子，同步/异步写 res 都能即时捕获
    const origEnd = res.end.bind(res);
    res.end = (body?: string | Buffer): void => {
      origEnd(body);
      done({ allowed: false, status: res.statusCode, headers: res.headers, body: res.body });
    };
    const next = (err?: unknown): void => {
      done(err === undefined ? ALLOW : FORBIDDEN);
    };
    try {
      const returned = hook(req, res, next) as unknown;
      // 宽容处理 async 钩子：reject 视为拒绝（Express 风格不 await，但不应让进程崩）
      if (returned instanceof Promise) returned.catch(() => done(FORBIDDEN));
    } catch {
      done(FORBIDDEN);
    }
  });
}
