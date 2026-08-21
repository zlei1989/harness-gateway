/**
 * HttpChannel 测试 — 真实 upstream http server + 假 Connection 验证桥接行为。
 * 覆盖：GET/POST 转发、Host 重写、鉴权拒绝、auth-check 短路、多值响应头保真、
 * upstream 不可达 502、聚合背压 pause/resume、网关取消中止。
 */

import { createServer, type RequestListener, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { HttpChannel } from './http-channel';

import type { AuthDecision, AuthRequest } from './authorize';
import type { Connection } from './connection';
import type { ControlFrame, DataHeader, HttpOpenFrame } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假 Connection：记录发出的帧；sendData 可被测试控制返回 false 一次；
 *  tunnelDown 模拟隧道 'error'→'close' 竞态窗：ws 已非 OPEN，sendControl/sendData 抛 'tunnel not ready' */
class FakeConnection {
  controls: ControlFrame[] = [];
  data: { header: DataHeader; payload: Buffer }[] = [];
  failNextSend = false;
  tunnelDown = false;
  private drainResolve: (() => void) | null = null;

  sendControl(frame: ControlFrame): void {
    if (this.tunnelDown) throw new Error('tunnel not ready');
    this.controls.push(frame);
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (this.tunnelDown) throw new Error('tunnel not ready');
    this.data.push({ header, payload });
    if (this.failNextSend) { this.failNextSend = false; return false; }
    return true;
  }
  waitDrain(): Promise<void> {
    return new Promise((r) => { this.drainResolve = r; });
  }
  drain(): void { this.drainResolve?.(); }
  asConnection(): Connection { return this as unknown as Connection; }
}

const ALLOW = async (_req: AuthRequest): Promise<AuthDecision> => ({
  allowed: true, status: 200, headers: {}, body: Buffer.alloc(0),
});

function makeOpen(overrides: Partial<HttpOpenFrame> = {}): HttpOpenFrame {
  return { type: 'http.open', channelId: 1, method: 'GET', url: '/api/x?y=1', headers: { host: 'gateway.example', accept: 'application/json' }, ...overrides };
}

/** 起真实 upstream http server，handler 由用例定制 */
// 注意：brief 原版 `Parameters<typeof createServer>[0]` 解析到最后一个重载（ServerOptions）
// 而非 RequestListener，导致全部 handler 站点类型检查失败；此处直接标注 RequestListener，语义等价
function startUpstream(handler: RequestListener): Promise<{
  server: Server; url: URL; hits: { body: Buffer; headers: Record<string, unknown> }[];
}> {
  const hits: { body: Buffer; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ body: Buffer.concat(chunks), headers: req.headers });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve({ server, url: new URL(`http://127.0.0.1:${addr.port}`), hits });
    });
  });
}

let cleanup: Server | null = null;
// 注意：brief 原版 `cleanup?.close(cb)` 在 cleanup 为 null（本用例不启动 server）时 Promise 永不
// resolve 导致 afterEach 挂起超时；此处改为仅在有 server 时等待关闭，语义不变
afterEach(async () => {
  const server = cleanup;
  cleanup = null;
  if (server) await new Promise((r) => server.close(() => r(null)));
});

describe('HttpChannel', () => {
  it('GET 转发：Host 重写为 upstream、剥 host 原值、空体收尾、响应头/体帧序正确', async () => {
    const up = await startUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd(); // 空体规则：无 body 也必须 end 收尾
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.headers['host']).toBe(`127.0.0.1:${up.url.port}`);
    const head = conn.controls.find((f) => f.type === 'http.head');
    expect(head).toMatchObject({ status: 200 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    expect(Buffer.concat(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload)).toString()).toBe('hello');
  });

  it('浏览器 Origin 重写为 upstream origin（与 Host 重写同语义，上游同源/反 DNS 重绑定围栏可过）', async () => {
    // 线上事故回归（DSH /api 403）：浏览器 Origin 描述的是浏览器↔网关的关系，
    // Host 已重定为 upstream，原样透传 Origin 会被 isTrustedApiRequest 式围栏判跨源拒绝
    const up = await startUpstream((_req, res) => res.end('ok'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1,
      open: makeOpen({ headers: { host: 'gateway.example', origin: 'http://pc-local:3081' } }),
      upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.headers['host']).toBe(`127.0.0.1:${up.url.port}`);
    expect(up.hits[0]?.headers['origin']).toBe(up.url.origin);
  });

  it('浏览器无 Origin → 不伪造，upstream 收到的请求仍无 Origin', async () => {
    const up = await startUpstream((_req, res) => res.end('ok'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.headers['origin']).toBeUndefined();
  });

  it('POST 大 body 流式透传到 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('ok'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen({ method: 'POST', url: '/upload' }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    const part = Buffer.alloc(64 * 1024, 65);
    ch.onBody(part);
    ch.onBody(part);
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.body.length).toBe(128 * 1024);
  });

  it('鉴权拒绝：回自定义响应帧，不打 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('x'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const deny = async (): Promise<AuthDecision> => ({ allowed: false, status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('no') });
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: deny, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'http.head', status: 403 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    expect(up.hits).toHaveLength(0);
  });

  it('auth-check 短路：放行回 204 且不打 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('x'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1, open: makeOpen({ url: '/__gateway__/auth-check' }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'http.head', status: 204 });
    expect(up.hits).toHaveLength(0);
  });

  it('多值响应头：upstream 的多个 Set-Cookie 以数组透传', async () => {
    const up = await startUpstream((_req, res) => { res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] }); res.end('x'); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    const head = conn.controls.find((f) => f.type === 'http.head');
    expect(head && 'headers' in head && head.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('SSRF 防护：absolute-form 绝对 URL 脱离 upstream origin → 403 拒绝，不打 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('x'));
    cleanup = up.server;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new HttpChannel({
      // 绝对 URL（端口不同于 upstream，origin 必不同；用 127.0.0.1:1 保证修复前快速 ECONNREFUSED 而非超时）
      id: 1, open: makeOpen({ url: 'http://127.0.0.1:1/evil' }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => { done += 1; },
    });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'http.head', status: 403 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    expect(done).toBe(1); // 通道已结束
    await new Promise((r) => setTimeout(r, 50)); // 留窗口抓住"修复前仍拨 upstream"的迟到请求
    expect(up.hits).toHaveLength(0);
  });

  it('upstream 不可达：回 502 + 固定文案 body（不回显 err.message 内网细节）', async () => {
    const conn = new FakeConnection();
    const dead = new URL('http://127.0.0.1:1');
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: dead, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.controls.find((f) => f.type === 'http.head')).toMatchObject({ status: 502 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    // 502 体为固定文案：err.message 含内网地址/端口，回显会泄露给浏览器侧
    const body = Buffer.concat(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload)).toString();
    expect(body).toBe('Bad Gateway');
    expect(body).not.toContain('ECONNREFUSED');
  });

  it('背压：sendData 返回 false 时暂停 upstream 流，drain 后恢复', async () => {
    const body = 'x'.repeat(4096);
    const up = await startUpstream((_req, res) => { res.writeHead(200); res.end(body); });
    cleanup = up.server;
    const conn = new FakeConnection();
    conn.failNextSend = true;
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 30));
    conn.drain();
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload)).toString()).toBe(body);
  });

  it('网关取消（onPeerClose）：中止 upstream 请求，不再发帧', async () => {
    const up = await startUpstream((_req, res) => { setTimeout(() => res.end('late'), 200); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    ch.onPeerClose({ type: 'channel.close', channelId: 1 });
    await new Promise((r) => setTimeout(r, 250));
    expect(conn.data.filter((d) => d.header.kind === 'http.body')).toHaveLength(0);
  });

  // 线上崩溃回归：隧道收到非法 close 帧（code 1006）→ ws 'error'→'close' 竞态窗内
  // upstream 响应到达 → onUpstreamResponse 调 sendControl 抛 'tunnel not ready' →
  // 异常穿透 ClientRequest 'response' 监听器成为 uncaughtException 崩进程。
  // 期望：通道级消化（abort + done），绝不外抛。
  it('隧道断开竞态：响应到达时隧道已断 → 不外抛，通道静默中止（线上崩溃回归）', async () => {
    const up = await startUpstream((_req, res) => { res.writeHead(200); res.end('late-ok'); });
    cleanup = up.server;
    const conn = new FakeConnection();
    conn.tunnelDown = true; // 响应到达前隧道已进入断开窗口
    let done = 0;
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => { done += 1; },
    });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(1);
    expect(conn.controls.find((f) => f.type === 'http.head')).toBeUndefined();
  });

  it('流式回传中途隧道断开：后续 body 帧发送失败不外抛，通道中止', async () => {
    let sendSecond: (() => void) | null = null;
    const up = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('chunk1');
      sendSecond = () => { res.write('chunk2'); res.end(); };
    });
    cleanup = up.server;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new HttpChannel({
      id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(),
      authorize: ALLOW, logger: nullLogger, onDone: () => { done += 1; },
    });
    await ch.start();
    ch.onBodyEnd();
    // 等第一块送达（head + chunk1 已发出）
    for (let i = 0; i < 100 && !conn.data.some((d) => d.header.kind === 'http.body'); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload.toString())).toEqual(['chunk1']);
    conn.tunnelDown = true; // 第二块到达时隧道已断
    sendSecond!();
    await new Promise((r) => setTimeout(r, 100));
    expect(done).toBe(1);
  });
});
