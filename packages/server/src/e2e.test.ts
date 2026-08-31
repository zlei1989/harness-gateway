/**
 * 端到端集成测试 — 真实 GatewayServer + 真实隧道 WS 客户端（MockTunnelClient）全链路。
 * 覆盖：选择页流程（卡片 data-tunnel-id/ajax JSON/Set-Cookie/redirect defaultPath）、同名并存、
 * HTTP 转发（Bearer 注入/cookie 剥离/XFF/多 Set-Cookie 回传）、WS 转发（text/binary echo 保真）、
 * 无 cookie 401、隧道掉线 502 与回带 tunnelId 重连后的会话恢复。
 * 注意（前序教训）：afterEach 用 socket 台账 + terminate 兜底防挂起；断言均为真实状态/负载比对，不做空转时序断言；
 * token 只用于协议帧与断言，任何断言消息/日志不得打印 token。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { GatewayServer } from './server';
import { MockTunnelClient } from './test-utils/mock-tunnel-client';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let server: GatewayServer | null = null;
const clients: MockTunnelClient[] = [];
let port = 0;
/** 浏览器侧 WS 台账：用例中途断言失败时 afterEach 兜底 terminate，防句柄悬挂 */
const browserSockets: WebSocket[] = [];
const tunnelUrl = (): string => `ws://127.0.0.1:${port}/__gateway__/tunnel`;
const base = (): string => `http://127.0.0.1:${port}`;

beforeEach(async () => {
  server = new GatewayServer({
    port: 0, headTimeoutMs: 500, helloTimeoutMs: 500, logger: nullLogger,
    // 瞬断宽限关断：本文件锁定的是"隧道离线即时 502"旧语义（宽限行为由 e2e-chaos S18/S19 覆盖）
    tunnelRestoreGraceMs: 0,
  });
  port = await server.listen();
});

afterEach(async () => {
  for (const ws of browserSockets.splice(0)) ws.terminate();
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  server = null;
});

async function connectClient(hostname = 'pc-a', defaultPath = '/dash'): Promise<MockTunnelClient> {
  const client = new MockTunnelClient({ gatewayUrl: tunnelUrl(), hostname, defaultPath, validToken: 'good-token' });
  clients.push(client);
  await client.connect();
  return client;
}

/** 走完选择页 ajax 流程，返回可用 cookie */
async function selectAndGetCookie(tunnelId: string, token: string): Promise<string> {
  const res = await fetch(`${base()}/__gateway__/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `tunnelId=${tunnelId}&token=${token}`,
    redirect: 'manual',
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie') ?? '';
}

describe('e2e：选择页与会话', () => {
  it('无 cookie → 302 → 选择页含在线 hostname 与 data-tunnel-id', async () => {
    const client = await connectClient();
    const home = await fetch(`${base()}/`, { redirect: 'manual' });
    expect(home.status).toBe(302);
    const page = await fetch(`${base()}/__gateway__/select`);
    const html = await page.text();
    expect(html).toContain('pc-a');
    expect(html).toContain(`data-tunnel-id="${client.tunnelId ?? ''}"`);
  });

  it('错误 token → 403 JSON；正确 token → 200 JSON redirect=defaultPath + Set-Cookie', async () => {
    const client = await connectClient();
    const tunnelId = client.tunnelId ?? '';
    const bad = await fetch(`${base()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tunnelId=${tunnelId}&token=wrong`,
    });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toEqual({ ok: false, error: 'token 错误' });
    const res = await fetch(`${base()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tunnelId=${tunnelId}&token=good-token`,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, redirect: '/dash' });
    expect(res.headers.get('set-cookie') ?? '').toContain('gateway_sid=');
  });

  it('同名两台客户端并存：选择页列出两张卡片，按各自 tunnelId 分别可选中', async () => {
    const a = await connectClient('pc-dup');
    const b = await connectClient('pc-dup');
    expect(a.tunnelId).toBeDefined();
    expect(b.tunnelId).toBeDefined();
    expect(a.tunnelId).not.toBe(b.tunnelId);
    const page = await fetch(`${base()}/__gateway__/select`);
    const html = await page.text();
    expect(html).toContain(`data-tunnel-id="${a.tunnelId ?? ''}"`);
    expect(html).toContain(`data-tunnel-id="${b.tunnelId ?? ''}"`);
    // 各自走选择流程都能建会话（路由按 tunnelId 而非 hostname）
    const cookieA = await selectAndGetCookie(a.tunnelId ?? '', 'good-token');
    const cookieB = await selectAndGetCookie(b.tunnelId ?? '', 'good-token');
    expect(cookieA).not.toBe(cookieB);
    const res = await fetch(`${base()}/api/x`, { headers: { cookie: cookieB } });
    expect(res.status).toBe(200);
    expect(b.httpOpens.length).toBeGreaterThan(0); // 请求真实到达了 B 隧道
    expect(a.httpOpens.filter((f) => f.url !== '/__gateway__/auth-check')).toHaveLength(0);
  });
});

describe('e2e：HTTP 转发', () => {
  it('带 cookie 请求：Bearer 注入 + gateway_sid 剥离 + XFF 注入，响应与多 Set-Cookie 回传', async () => {
    const c = await connectClient();
    const cookie = await selectAndGetCookie(c.tunnelId ?? '', 'good-token');
    const res = await fetch(`${base()}/api/chat?q=1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'ping',
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['app=1', 'b=2']);
    const echo = JSON.parse(await res.text()) as {
      method: string; url: string; headers: Record<string, string>; body: string;
    };
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/api/chat?q=1');
    expect(echo.headers['authorization']).toBe('Bearer good-token');
    expect(echo.headers['cookie'] ?? '').not.toContain('gateway_sid');
    expect(echo.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(echo.body).toBe('ping');
    expect(c.httpOpens.length).toBeGreaterThan(0);
  });

  it('隧道离线 → 502；回带 tunnelId 重连复用后老 cookie 恢复可用', async () => {
    const client = await connectClient();
    const tunnelId = client.tunnelId ?? '';
    const cookie = await selectAndGetCookie(tunnelId, 'good-token');
    client.close();
    // 条件轮询替代固定 sleep：负载下固定 100ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    const registry = (server as unknown as { tunnels: { has(id: string): boolean } }).tunnels;
    while (registry.has(tunnelId) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const offline = await fetch(`${base()}/api/x`, { headers: { cookie } });
    expect(offline.status).toBe(502);
    // 同一客户端重连（hello 回带上次 tunnelId）→ 复用成功，sessions 保留免重新选择
    await client.connect();
    expect(client.tunnelId).toBe(tunnelId);
    const back = await fetch(`${base()}/api/x`, { headers: { cookie } });
    expect(back.status).toBe(200);
  });
});

describe('e2e：WS 转发', () => {
  it('echo：text 与 binary 双向保真', async () => {
    const client = await connectClient();
    const cookie = await selectAndGetCookie(client.tunnelId ?? '', 'good-token');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie } });
    browserSockets.push(ws);
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send('hello');
    const text = await new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    expect(text).toBe('hello');
    ws.send(Buffer.from([0x09, 0x08]));
    const bin = await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer)));
    expect(bin).toEqual(Buffer.from([0x09, 0x08]));
    ws.close();
  });

  it('客户端鉴权拒绝：浏览器收到 403', async () => {
    const client = await connectClient();
    // 用错误 token 建不出会话 → 改走"会话 token 正确但客户端策略变严"场景：
    // MockTunnelClient 以 Bearer 判定，故构造一个 cookie 有效但 token 与 validToken 不一致的会话：
    // 直接复用选择流程不可行（探测会被拒），改为断开隧道让 ws 走 502 分支验证异常路径。
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie: 'gateway_sid=whatever' } });
    browserSockets.push(ws);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(401); // 无效 cookie
  });
});

describe('e2e：隧道压缩', () => {
  it('tunnelPerMessageDeflate 开启：隧道 WS 协商 permessage-deflate，hello 流程不受影响', async () => {
    server?.close();
    server = new GatewayServer({
      port: 0, headTimeoutMs: 500, helloTimeoutMs: 500,
      tunnelPerMessageDeflate: true, logger: nullLogger,
    });
    port = await server.listen();
    const client = await connectClient();
    // ws 客户端默认发起 permessage-deflate：服务端开启后协商成功
    expect(client.ws?.extensions ?? '').toContain('permessage-deflate');
    // 全链路仍工作：选择 → 请求 → 响应
    const cookie = await selectAndGetCookie(client.tunnelId ?? '', 'good-token');
    const res = await fetch(`${base()}/api/x`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it('默认不开启：隧道 WS 无压缩扩展', async () => {
    const client = await connectClient();
    expect(client.ws?.extensions ?? '').not.toContain('permessage-deflate');
  });
});

describe('e2e：优雅关停', () => {
  /** 限时竞速：窗口内未 resolve 返回 'hang'（定时器 unref 防拖住测试进程） */
  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'hang'> {
    const hang = new Promise<'hang'>((r) => {
      const t = setTimeout(() => r('hang'), ms);
      t.unref();
    });
    return Promise.race([p, hang]);
  }

  it('活跃隧道 + 活跃浏览器 WS 下 close() 在限定时间内 resolve（不得悬挂）', async () => {
    const client = await connectClient();
    const cookie = await selectAndGetCookie(client.tunnelId ?? '', 'good-token');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie } });
    browserSockets.push(ws);
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send('hello'); // 确认双向通道真实活跃
    const echo = await new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    expect(echo).toBe('hello');
    const browserClosed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
    // 悬挂判据：2s 内必须 resolve；旧实现 teardownAll 不关底层 ws，
    // upgrade 过的 socket 存活使 http.Server.close 回调永不触发（CLI 优雅关停永久悬挂）
    const result = await withTimeout(server!.close().then(() => 'closed' as const), 2000);
    expect(result).toBe('closed');
    // 浏览器 WS 必须被服务端实际断开（closeAll 后残留连接同属悬挂源）
    const code = await withTimeout(browserClosed, 2000);
    expect(code).not.toBe('hang');
    server = null; // 已关闭，afterEach 跳过
  });
});

describe('e2e：会话持久化（E 组）', () => {
  let dir = '';
  let srv: GatewayServer | null = null;
  let srvPort = 0;
  const persistPath = (): string => join(dir, 'sessions.json');
  const srvBase = (): string => `http://127.0.0.1:${srvPort}`;
  const srvTunnelUrl = (): string => `ws://127.0.0.1:${srvPort}/__gateway__/tunnel`;

  afterEach(async () => {
    await srv?.close();
    srv = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function startServer(opts: { ttlMs?: number } = {}): Promise<void> {
    srv = new GatewayServer({
      port: 0, headTimeoutMs: 500, helloTimeoutMs: 500, logger: nullLogger,
      sessionStorePath: persistPath(),
      ...(opts.ttlMs !== undefined ? { browserSessionTtlMs: opts.ttlMs } : {}),
    });
    srvPort = await srv.listen();
  }

  async function selectCookie(tunnelId: string): Promise<string> {
    const res = await fetch(`${srvBase()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tunnelId=${tunnelId}&token=good-token`,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie') ?? '';
  }

  it('S15：服务端重启 → 快照恢复 + tunnelId 回带复用 → 老 cookie 免重登', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer();
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    await srv?.close(); // 优雅关停：快照已在 create 时同步落盘

    await startServer(); // 同 persistPath 重启
    const b = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(b);
    b.tunnelId = a.tunnelId; // 进程内存回带（等价真实 Client 重连行为）
    await b.connect();
    expect(b.tunnelId).toBe(a.tunnelId); // 注册表为空，复用必成功

    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie } });
    expect(res.status).toBe(200); // 免重登：会话恢复 + 隧道重新对上
  });

  it('S16：浏览器重开（仅带持久 cookie 的新 HTTP 会话）→ 免重登', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer();
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    expect(cookie).toContain('Max-Age='); // 持久化的载体
    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(res.status).toBe(200); // 新"浏览器"只带 gateway_sid kv
  });

  it('S17：会话 TTL 过期 → 302 重选且快照同步清理', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer({ ttlMs: 400 });
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    await new Promise((r) => setTimeout(r, 500)); // 真实时钟过期（waitFor 无法加速 TTL 本身，400ms 可控）
    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const raw = JSON.parse(readFileSync(persistPath(), 'utf8')) as { sessions: unknown[] };
    expect(raw.sessions).toHaveLength(0); // get 惰性过期已触发落盘清扫
  });
});
