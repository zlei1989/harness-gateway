/**
 * 浏览器 HTTP ↔ 隧道通道桥接（spec §7.1）。
 * headers 三处加工：①注入 Authorization: Bearer（覆盖浏览器原值）②剥离 gateway_sid ③注入/追加 X-Forwarded-For。
 * 注意：等 http.head 有 headTimeoutMs 超时；收到 head 后不再设总超时（SSE/流式）；
 * 浏览器中途断开 → channel.close 取消通道。
 * 隧道断开 → 在途通道两条路（线上移动端超时降级）：
 * ① head 未下发且无请求体的幂等方法（GET/HEAD/OPTIONS）→ 宽限内挂起等重连、在新隧道上
 *   原样重放（每请求至多一次，浏览器仅感知慢响应而非 502）；
 * ② 其余（已流式/带 body/非幂等/重放后再断/宽限耗尽）→ 保持原 502 语义——已发字节无法撤回。
 * CORS 允许名单：预检短路 204；响应反射命中名单的 Origin，上游 access-control-* 一律清除。
 */

import { type BrowserSessionStore, readSessionCookie, stripSessionCookie } from './browser-session';
import { type ControlFrame, type DataHeader, type HeadersJson, normalizeHeaders, stripHopByHop } from './protocol';
import { safePathname } from './url';

import type { Logger } from './logger';
import type { PendingChannel, TunnelRegistry, TunnelSession } from './session';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ProxyContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  selectPath: string;
  headTimeoutMs: number;
  /** 瞬断宽限（毫秒）：隧道离线时新请求挂起等重连，耗尽才 502；0 = 即时 502 旧行为 */
  tunnelRestoreGraceMs: number;
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
export async function handleBrowserHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProxyContext,
): Promise<void> {
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
  let tunnel = ctx.tunnels.get(session.tunnelId);
  if (!tunnel && ctx.tunnelRestoreGraceMs > 0) {
    // 瞬断宽限（spec §8）：新请求挂起等重连（在途通道仍立即失败，语义不变）；
    // 等待期间浏览器断开则放弃等待（browserGone 竞速胜出 → 下方 writableEnded/destroyed 判走）
    ctx.logger.info('隧道离线，宽限等待重连', { hostname: session.hostname, graceMs: ctx.tunnelRestoreGraceMs });
    const browserGone = new Promise<null>((resolve) => res.once('close', () => resolve(null)));
    tunnel = (await Promise.race([
      ctx.tunnels.waitFor(session.tunnelId, ctx.tunnelRestoreGraceMs),
      browserGone,
    ])) ?? undefined;
    if (tunnel) ctx.logger.info('隧道已恢复，继续转发', { hostname: session.hostname });
  }
  if (!tunnel) {
    if (res.writableEnded || res.destroyed) return; // 宽限期间浏览器已走
    ctx.logger.warn('隧道离线', { hostname: session.hostname });
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
    res.end('tunnel offline');
    return;
  }

  let finished = false;
  let headTimer: NodeJS.Timeout | null = null;
  // 分段计时（归因慢请求：headMs = 隧道往返+upstream 首字节；totalMs - headMs ≈ body 流式传输耗时）
  const startedAt = Date.now();
  let headAt: number | null = null;
  let bodyBytes = 0;
  let finalStatus: number | string | null = null;
  /** 浏览器侧请求体已收尾（空体规则：GET 也在入口即发 end）：重放开新通道时须补发空载 http.body.end */
  let bodyEnded = false;
  /**
   * 幂等重放面（线上移动端超时降级）：仅"无请求体的幂等方法"可重放——带 body 的请求体重放有
   * 重复/丢失风险；head 已下发的响应无法撤回已发字节（在 onTunnelDown 按 headAt 判定）。
   * 每请求至多重放一次：连杀风暴由 502 兜底，防无限挂起。
   */
  const replayable = ['GET', 'HEAD', 'OPTIONS'].includes((req.method ?? 'GET').toUpperCase())
    && req.headers['content-length'] === undefined
    && req.headers['transfer-encoding'] === undefined;
  let replayed = false;
  /** 重放等待中标志：此期间 res 'close' 的 browser-aborted 常规路径让位给重放的 browserGone 竞速 */
  let replaying = false;
  /** 当前活跃通道（重放换代后指向新隧道的通道）；req/res 事件回调经它路由 */
  let active: { tunnel: TunnelSession; channelId: number } | null = null;
  const finish = (fn: () => void): void => {
    if (finished) return;
    finished = true;
    if (headTimer) clearTimeout(headTimer);
    active?.tunnel.unregister(active.channelId);
    fn();
    // 完成计时日志：url 只记 pathname（查询串是常见 token 携带位）；bodyBytes 供带宽归因
    ctx.logger.info('请求完成', {
      channelId: active?.channelId,
      method: req.method,
      url: safePathname(req.url) ?? '/',
      status: finalStatus,
      headMs: headAt === null ? null : headAt - startedAt,
      totalMs: Date.now() - startedAt,
      bodyBytes,
      hostname: session.hostname,
    });
  };

  /** 502 终态（隧道断/通道级错误/重放耗尽的公共落点） */
  const finish502 = (): void => {
    finalStatus = 502;
    finish(() => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
      res.end();
    });
  };

  /** 隧道断开时的在途通道处置：重放面内挂起等重连，面外保持原 502 语义 */
  const onActiveTunnelDown = (): void => {
    // 重放面外条件：已重放过 / 非重放面 / 无宽限 / head 已下发 / 浏览器已走
    const noReplay = replayed || !replayable || ctx.tunnelRestoreGraceMs <= 0
      || headAt !== null || res.destroyed;
    if (noReplay) {
      finish502();
      return;
    }
    replayed = true;
    replaying = true;
    if (headTimer) { clearTimeout(headTimer); headTimer = null; } // 重放等待由宽限时钟接管
    ctx.logger.info('隧道断开，幂等请求挂起待重放', {
      channelId: active?.channelId,
      method: req.method,
      url: safePathname(req.url) ?? '/',
      graceMs: ctx.tunnelRestoreGraceMs,
      hostname: session.hostname,
    });
    // 必须推迟到 teardown 同步段完成后再 waitFor：onTunnelDown 在 session.teardown 的通道循环里
    // 同步触发，此刻注册表仍持有将死会话、leg 尚未关闭——立即 waitFor 会瞬时 resolve 到旧会话，
    // 重放通道登记在尸体上（实测：重放 1ms 后"恢复"、head 永远不到、headTimeout 504）
    setImmediate(() => { void replayUntilRestore(); });
  };

  /** 重放等待：隧道恢复与浏览器断开竞速；恢复则新隧道上换代重开通道，耗尽/浏览器先走按对应终态收尾 */
  const replayUntilRestore = async (): Promise<void> => {
    const browserGone = new Promise<null>((resolve) => res.once('close', () => resolve(null)));
    const restored = await Promise.race([
      ctx.tunnels.waitFor(session.tunnelId, ctx.tunnelRestoreGraceMs),
      browserGone,
    ]);
    replaying = false;
    if (finished) return; // 等待期间被并行路径终结（防御）
    if (restored === null) {
      // 浏览器已走：无人收货，静默终结（不写 502）；宽限耗尽：浏览器还在等 → 502
      if (res.destroyed || res.writableEnded) {
        finalStatus = 'browser-aborted';
        finish(() => undefined);
        return;
      }
      finish502();
      return;
    }
    try {
      openChannel(restored, true);
    } catch {
      // 恢复瞬间再断的竞态（waitFor resolve 与 teardown 之间）：重放额度已用尽，落原 502 语义
      finish502();
    }
  };

  /** 在给定隧道上登记通道并下发 http.open（重放换代复用）；headTimer 随每次开通道重装 */
  const openChannel = (t: TunnelSession, isReplay: boolean): void => {
    const channel: PendingChannel = {
      kind: 'http',
      onControl: (frame: ControlFrame) => {
        if (frame.type === 'http.head') {
          finishHeaders(frame.status, frame.headers);
        } else if (frame.type === 'channel.error') {
          ctx.logger.error('通道级错误（客户端回报）', { channelId: active?.channelId, message: frame.message });
          finish502();
        } else if (frame.type === 'channel.close') {
          finish(() => res.end());
        }
      },
      onData: (header: DataHeader, payload: Buffer) => {
        if (header.kind === 'http.body') {
          bodyBytes += payload.length;
          if (!res.write(payload)) {
            // 浏览器侧写缓冲背压：暂停读取由整体 WS bufferedAmount 兜底（v1 不做逐通道背压，spec §4.3）
          }
        } else if (header.kind === 'http.body.end') {
          finish(() => res.end());
        }
      },
      onTunnelDown: () => onActiveTunnelDown(),
    };
    const channelId = t.register(channel);
    active = { tunnel: t, channelId };
    t.sendControl({
      type: 'http.open',
      channelId,
      method: req.method ?? 'GET',
      url: req.url ?? '/',
      headers: prepareForwardHeaders(req, session.token),
    });
    // 重放换代：浏览器请求体早已收尾（重放面 = 无体请求），补发空载 body.end 让客户端能 end upstream 请求
    if (isReplay && bodyEnded) t.sendData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
    // 日志只记 pathname：查询串是常见 token 携带位，任何级别不得打印完整 req.url（转发帧仍带完整 url）
    if (isReplay) {
      ctx.logger.info('隧道已恢复，重放幂等请求', { channelId, method: req.method, url: safePathname(req.url) ?? '/', hostname: session.hostname });
    } else {
      ctx.logger.info('请求入口', { channelId, method: req.method, url: safePathname(req.url) ?? '/', hostname: session.hostname });
    }
    // 等 http.head 超时（收到 head 后不再设总超时，支持 SSE）
    if (headTimer) clearTimeout(headTimer);
    headTimer = setTimeout(() => {
      ctx.logger.warn('等 http.head 超时', { channelId });
      finalStatus = 504;
      finish(() => {
        t.sendControl({ type: 'channel.close', channelId, reason: 'head timeout' });
        if (!res.headersSent) res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8', ...cors });
        res.end('gateway timeout');
      });
    }, ctx.headTimeoutMs);
  };

  const finishHeaders = (status: number, headers: HeadersJson): void => {
    if (headTimer) clearTimeout(headTimer);
    headTimer = null;
    if (finished) return;
    headAt = Date.now();
    finalStatus = status;
    // 响应头剥逐跳头、清上游 access-control-* 后合入 CORS 反射头（set-cookie 数组 Node 原生支持）
    res.writeHead(status, withCors(headers, cors) as Record<string, string | string[]>);
    // SSE 关键：Node 会把响应头缓冲到首个 body 块才发，首事件前长间隙会让浏览器 fetch 悬挂；
    // flushHeaders 立即下发状态行+头，head 到达即可被浏览器观察（配合"收到 head 后无总超时"）
    res.flushHeaders();
  };

  openChannel(tunnel, false);

  // 请求体流式透传；空体规则：end 事件必发空载 http.body.end。
  // 聚合背压（对称 ws-proxy 与客户端 http-channel，线上断连根因修复）：sendData 超聚合高水位
  // 即暂停读取浏览器请求体，waitDrain 回落到低水位后恢复；此前忽略返回值，大文件上传经限流
  // 隧道时服务端发送缓冲无界堆积（内存放大，且 pong 等控制帧被压在堆积之后加剧心跳饥饿）。
  // 无需 exceedsMaxDataFrame 护栏：chunk 来自 Node 流读取（≪100MiB），数学上不可能超隧道帧上限；
  // encodeData 的 PayloadTooLargeError 兜底防协议失配（WS 消息路径尺寸不受控，护栏在 ws-proxy）
  req.on('data', (chunk: Buffer) => {
    if (finished || active === null) return;
    const cur = active;
    if (!cur.tunnel.sendData({ channelId: cur.channelId, kind: 'http.body' }, chunk)) {
      req.pause();
      void cur.tunnel.waitDrain().then(() => { if (!finished) req.resume(); });
    }
  });
  req.on('end', () => {
    bodyEnded = true; // 重放换代时据此补发空载 body.end
    if (!finished && active !== null) {
      active.tunnel.sendData({ channelId: active.channelId, kind: 'http.body.end' }, Buffer.alloc(0));
    }
  });

  // 浏览器中途断开 → 取消通道。
  // 注意：必须挂在 res 上——Node ≥16 起 req(IncomingMessage) 在请求正常收完后也会发 'close'，
  // 挂 req 会把每个完整请求误判为中止；res 的 'close' 仍只表示底层连接关闭，writableEnded 区分正常结束。
  // 重放等待期（replaying）此处让位：浏览器断开由 replayUntilRestore 的 browserGone 竞速接管，
  // 避免向已死隧道补发 channel.close（ws 已 CLOSED，send 会抛错）
  res.on('close', () => {
    if (!finished && !res.writableEnded && !replaying) {
      finalStatus = 'browser-aborted';
      finish(() => active?.tunnel.sendControl({ type: 'channel.close', channelId: active.channelId, reason: 'browser aborted' }));
    }
  });
}
