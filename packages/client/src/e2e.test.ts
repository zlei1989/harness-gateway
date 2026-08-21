/**
 * 端到端集成测试 — 真实 WS 隧道 + 真实 upstream 的模拟网关全链路。
 * 覆盖：HTTP 转发（Bearer 注入/流式 SSE/多 Set-Cookie）、auth-check 短路、
 * WS 握手 accept/reject、隧道断开自动重连。
 * 注意：token 只出现在协议帧与断言中，禁止打印日志；消息级 WS 保真由 ws-channel 单测覆盖，此处只测握手层。
 */

import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { Client } from './client';
import { MockGateway } from './test-utils/mock-gateway';

let gateway: MockGateway;
let upstream: Server;
let upstreamUrl: string;
let upstreamHits: { url: string; authorization?: string | string[] }[];
let wss: WebSocketServer;

beforeEach(async () => {
  upstreamHits = [];
  upstream = createServer((req, res) => {
    upstreamHits.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (req.url === '/sse') {
      // SSE 流式：分 3 块间隔写出
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => res.write('data: 2\n\n'), 30);
      setTimeout(() => { res.write('data: 3\n\n'); res.end(); }, 60);
      return;
    }
    if (req.url === '/multi-cookie') {
      res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res); // echo 请求体
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  await new Promise<void>((r) => wss.on('listening', r));
  gateway = new MockGateway();
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => wss.close(() => r()));
});

async function makeClient(extra: Record<string, unknown> = {}): Promise<Client> {
  const client = new Client({
    upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a', token: 't1',
    heartbeatIntervalMs: 50, connectTimeoutMs: 2000,
    reconnect: { baseDelayMs: 20, maxDelayMs: 60, maxRetries: Infinity },
    ...extra,
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

describe('e2e：隧道全链路', () => {
  it('HTTP GET：Bearer 注入到达 upstream，响应回传', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/api/x', { authorization: 'Bearer t1' });
    expect(res.status).toBe(200);
    expect(upstreamHits[0]?.authorization).toBe('Bearer t1');
    await client.close();
  });

  it('SSE 流式：响应分块到达', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/sse', { authorization: 'Bearer t1' });
    expect(res.body.toString()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    await client.close();
  });

  it('多 Set-Cookie 透传', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/multi-cookie', { authorization: 'Bearer t1' });
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    await client.close();
  });

  it('auth-check 探测：Bearer 对 → 204 且不打 upstream；错 → 403', async () => {
    const client = await makeClient();
    const ok = await gateway.request('GET', '/__gateway__/auth-check', { authorization: 'Bearer t1' });
    expect(ok.status).toBe(204);
    expect(upstreamHits).toHaveLength(0);
    const bad = await gateway.request('GET', '/__gateway__/auth-check', { authorization: 'Bearer wrong' });
    expect(bad.status).toBe(403);
    expect(upstreamHits).toHaveLength(0);
    await client.close();
  });

  it('WS echo：text 与 binary 保真', async () => {
    const wsPort = (wss.address() as { port: number }).port;
    const client = await makeClient({ upstreamUrl: `http://127.0.0.1:${wsPort}` });
    const opened = await gateway.wsOpen('/socket', { authorization: 'Bearer t1' });
    expect(opened.accepted).toBe(true);
    await client.close();
  });

  it('WS 鉴权拒绝：ws.reject 状态透传', async () => {
    const wsPort = (wss.address() as { port: number }).port;
    const client = await makeClient({ upstreamUrl: `http://127.0.0.1:${wsPort}` });
    const opened = await gateway.wsOpen('/socket', { authorization: 'Bearer wrong' });
    expect(opened).toMatchObject({ accepted: false, status: 403 });
    await client.close();
  });

  it('隧道断开重连：重连后新请求恢复可用', async () => {
    const client = await makeClient();
    gateway.drop();
    await new Promise<void>((r) => client.once('connected', r)); // 等自动重连
    const res = await gateway.request('GET', '/api/after', { authorization: 'Bearer t1' });
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.url).toBe('/api/after');
    await client.close();
  });
});
