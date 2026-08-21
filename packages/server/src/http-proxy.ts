/**
 * 浏览器 HTTP ↔ 隧道通道桥接（spec §7.1）。
 * headers 三处加工：①注入 Authorization: Bearer（覆盖浏览器原值）②剥离 gateway_sid ③注入/追加 X-Forwarded-For。
 * 注意：等 http.head 有 headTimeoutMs 超时；收到 head 后不再设总超时（SSE/流式）；
 * 浏览器中途断开 → channel.close 取消通道；隧道断开 → 在途通道 502。
 * CORS 允许名单：预检短路 204；响应反射命中名单的 Origin，上游 access-control-* 一律清除。
 */

import { type BrowserSessionStore, readSessionCookie, stripSessionCookie } from './browser-session';
import { type ControlFrame, type DataHeader, type HeadersJson, normalizeHeaders, stripHopByHop } from './protocol';
import { safePathname } from './url';

import type { Logger } from './logger';
import type { PendingChannel, TunnelRegistry } from './session';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ProxyContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  selectPath: string;
  headTimeoutMs: number;
  logger: Logger;
  /** CORS 允许名单判定（见 cors.ts）；名单外 Origin 不附 CORS 头，浏览器自行拦截 */
  corsAllowOrigin: (origin: string) => boolean;
}

/** headers 三处加工：Bearer 注入 / gateway_sid 剥离 / XFF 追加，再剥逐跳头 */
function prepareForwardHeaders(req: IncomingMessage, token: string): HeadersJson {
  const headers = normalizeHeaders(req.headers);
  headers['authorization'] = `Bearer ${token}`;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie === undefined) delete headers['cookie'];
  else headers['cookie'] = cookie;
  const remote = req.socket.remoteAddress;
  if (remote) {
    const existing = headers['x-forwarded-for'];
    const first = Array.isArray(existing) ? existing.join(', ') : existing;
    headers['x-forwarded-for'] = first ? `${first}, ${remote}` : remote;
  }
  delete headers['host']; // Host 由客户端按 upstream 重写（spec 已确认）
  return stripHopByHop(headers);
}

/**
 * CORS 允许名单模式（默认 *.7qbjs.com / *.jd.com，HARNESS_CORS_ORIGINS 可配，'*' 全放行）：
 * 命中名单的 Origin 反射并允许凭据（Allow-Origin 不能用 * —— 与 Allow-Credentials 组合时浏览器拒绝）。
 * 预检短路 204；响应统一清掉上游 access-control-*（防双值冲突/防绕过名单），命中名单再合入反射头。
 */
function corsHeaders(
  req: IncomingMessage,
  allow: (origin: string) => boolean,
): Record<string, string> | null {
  const origin = req.headers.origin;
  if (!origin || !allow(origin)) return null;
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': '*',
  };
}

/** 预检（带 Origin + ACRM 的 OPTIONS）且 Origin 命中名单才短路：不进会话检查/转发，204 放行 */
function handlePreflight(req: IncomingMessage, res: ServerResponse, ctx: ProxyContext): boolean {
  const origin = req.headers.origin;
  if (req.method !== 'OPTIONS' || !origin || !req.headers['access-control-request-method']) return false;
  const cors = corsHeaders(req, ctx.corsAllowOrigin);
  if (!cors) return false; // 名单外 Origin：走正常链路，响应无 CORS 头
  res.writeHead(204, {
    ...cors,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
    // 反射浏览器声明的自定头 → 等效放行所有请求头（credentials 模式下 * 按字面处理，必须反射）
    'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
    'access-control-max-age': '600',
    vary: 'Origin, Access-Control-Request-Headers',
  });
  res.end();
  return true;
}

/** 响应头合入 CORS：无条件清上游 access-control-*（名单外 Origin 不得借上游头绕过），命中名单再反射 */
function withCors(headers: HeadersJson, cors: Record<string, string> | null): HeadersJson {
  const out = stripHopByHop(headers);
  for (const key of Object.keys(out)) {
    if (key.startsWith('access-control-')) delete out[key];
  }
  if (!cors) return out;
  Object.assign(out, cors);
  const vary = out['vary'];
  out['vary'] = typeof vary === 'string' && vary.length > 0
    ? (vary.toLowerCase().includes('origin') ? vary : `${vary}, Origin`)
    : 'Origin';
  return out;
}

/** 浏览器 HTTP 请求入口（非保留路径） */
export function handleBrowserHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): void {
  if (handlePreflight(req, res, ctx)) return;
  const cors = corsHeaders(req, ctx.corsAllowOrigin);
  // cookie 会话检查：无/失效 → 302 选择页
  const uuid = readSessionCookie(req.headers.cookie);
  const session = uuid ? ctx.sessions.get(uuid) : undefined;
  if (!session) {
    res.writeHead(302, { location: ctx.selectPath, ...cors });
    res.end();
    return;
  }
  const tunnel = ctx.tunnels.get(session.hostname);
  if (!tunnel) {
    ctx.logger.warn('隧道离线', { hostname: session.hostname });
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
    res.end('tunnel offline');
    return;
  }

  let finished = false;
  let headTimer: NodeJS.Timeout | null = null;
  const finish = (fn: () => void): void => {
    if (finished) return;
    finished = true;
    if (headTimer) clearTimeout(headTimer);
    tunnel.unregister(channelId);
    fn();
  };

  const channel: PendingChannel = {
    kind: 'http',
    onControl: (frame: ControlFrame) => {
      if (frame.type === 'http.head') {
        finishHeaders(frame.status, frame.headers);
      } else if (frame.type === 'channel.error') {
        ctx.logger.error('通道级错误（客户端回报）', { channelId, message: frame.message });
        finish(() => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
          res.end();
        });
      } else if (frame.type === 'channel.close') {
        finish(() => res.end());
      }
    },
    onData: (header: DataHeader, payload: Buffer) => {
      if (header.kind === 'http.body') {
        if (!res.write(payload)) {
          // 浏览器侧写缓冲背压：暂停读取由整体 WS bufferedAmount 兜底（v1 不做逐通道背压，spec §4.3）
        }
      } else if (header.kind === 'http.body.end') {
        finish(() => res.end());
      }
    },
    onTunnelDown: () => {
      finish(() => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
        res.end();
      });
    },
  };

  const finishHeaders = (status: number, headers: HeadersJson): void => {
    if (headTimer) clearTimeout(headTimer);
    headTimer = null;
    if (finished) return;
    // 响应头剥逐跳头、清上游 access-control-* 后合入 CORS 反射头（set-cookie 数组 Node 原生支持）
    res.writeHead(status, withCors(headers, cors) as Record<string, string | string[]>);
    // SSE 关键：Node 会把响应头缓冲到首个 body 块才发，首事件前长间隙会让浏览器 fetch 悬挂；
    // flushHeaders 立即下发状态行+头，head 到达即可被浏览器观察（配合"收到 head 后无总超时"）
    res.flushHeaders();
  };

  const channelId = tunnel.register(channel);

  tunnel.sendControl({
    type: 'http.open',
    channelId,
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    headers: prepareForwardHeaders(req, session.token),
  });
  // 日志只记 pathname：查询串是常见 token 携带位，任何级别不得打印完整 req.url（转发帧仍带完整 url）
  ctx.logger.info('请求入口', { channelId, method: req.method, url: safePathname(req.url) ?? '/', hostname: session.hostname });

  // 请求体流式透传；空体规则：end 事件必发空载 http.body.end
  req.on('data', (chunk: Buffer) => {
    if (!finished) tunnel.sendData({ channelId, kind: 'http.body' }, chunk);
  });
  req.on('end', () => {
    if (!finished) tunnel.sendData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
  });

  // 浏览器中途断开 → 取消通道。
  // 注意：必须挂在 res 上——Node ≥16 起 req(IncomingMessage) 在请求正常收完后也会发 'close'，
  // 挂 req 会把每个完整请求误判为中止；res 的 'close' 仍只表示底层连接关闭，writableEnded 区分正常结束
  res.on('close', () => {
    if (!finished && !res.writableEnded) {
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser aborted' }));
    }
  });

  // 等 http.head 超时（收到 head 后不再设总超时，支持 SSE）
  headTimer = setTimeout(() => {
    ctx.logger.warn('等 http.head 超时', { channelId });
    finish(() => {
      tunnel.sendControl({ type: 'channel.close', channelId, reason: 'head timeout' });
      if (!res.headersSent) res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8', ...cors });
      res.end('gateway timeout');
    });
  }, ctx.headTimeoutMs);
}
