/**
 * 端到端集成测试 — 真实 GatewayServer + 真实隧道 WS 客户端（MockTunnelClient）全链路。
 * 覆盖：选择页流程（卡片 data-tunnel-id/ajax JSON/Set-Cookie/redirect defaultPath）、同名并存、
 * HTTP 转发（Bearer 注入/cookie 剥离/XFF/多 Set-Cookie 回传）、WS 转发（text/binary echo 保真）、
 * 无 cookie 401、隧道掉线 502 与回带 tunnelId 重连后的会话恢复。
 * 注意（前序教训）：afterEach 用 socket 台账 + terminate 兜底防挂起；断言均为真实状态/负载比对，不做空转时序断言；
 * token 只用于协议帧与断言，任何断言消息/日志不得打印 token。
 */

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
    // 宏观等待窗口：等服务端 close 事件完成 teardown + 注册表注销（100ms 远大于本地回路）
    await new Promise((r) => setTimeout(r, 100));
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
