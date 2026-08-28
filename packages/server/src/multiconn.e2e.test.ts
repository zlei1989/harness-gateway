/**
 * 多连接真机 e2e：真实 GatewayServer + 真实 gateway-client Client + 真实 upstream http 三段全链路。
 * 覆盖：4 leg 条带化下 8MiB 大文件下载/上传字节完整性（i % 251 模式字节逐字节比对）、
 * connections:1 legacy 回归、整组重连恢复（服务端杀一条 attach leg → 组重建 → 会话不丢）。
 * 会话建立复用 e2e.test.ts 范本：POST /__gateway__/select（客户端未配 token，探测走全放行路径）。
 * 注意：token 不进日志/断言消息；afterEach 收 client/server/upstream 防句柄悬挂。
 */

import { createHash } from 'node:crypto';
import http from 'node:http';

import { Client } from 'gateway-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { GatewayServer } from './server';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;
const clientLogger = nullLogger as unknown as import('gateway-client').Logger;

/** 8MiB 模式字节：第 i 字节 = i % 251（质数周期，错位/重排必被发现） */
const BIG_BYTES = 8 * 1024 * 1024;
const bigPattern = ((): Buffer => {
  const buf = Buffer.alloc(BIG_BYTES);
  for (let i = 0; i < buf.length; i++) buf[i] = i % 251;
  return buf;
})();
const bigSha256 = createHash('sha256').update(bigPattern).digest('hex');

let server: GatewayServer | null = null;
let upstream: http.Server | null = null;
let port = 0;
let upstreamPort = 0;
const clients: Client[] = [];

const tunnelUrl = (): string => `ws://127.0.0.1:${port}/__gateway__/tunnel`;
const base = (): string => `http://127.0.0.1:${port}`;

/** 真实 upstream：GET /big 回 8MiB 模式字节；POST /upload 收集体节回 sha256 供比对 */
function createUpstream(): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bigPattern.length });
      res.end(bigPattern);
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

beforeEach(async () => {
  upstream = createUpstream();
  upstreamPort = await new Promise<number>((resolve) => {
    upstream!.listen(0, '127.0.0.1', () => {
      const addr = upstream!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
  server = new GatewayServer({ port: 0, headTimeoutMs: 2000, helloTimeoutMs: 500, logger: nullLogger });
  port = await server.listen();
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await server?.close();
  server = null;
  if (upstream) {
    upstream.closeAllConnections?.(); // 客户端 keep-alive 池残留连接不阻断 close 回调
    await new Promise<void>((r) => upstream!.close(() => r()));
    upstream = null;
  }
});

/** 启动真实 Client（未配 token：选择页探测全放行）；primary 就绪即返回 */
async function startClient(connections?: number): Promise<Client> {
  const client = new Client({
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    gatewayUrl: tunnelUrl(),
    hostname: 'pc-e',
    ...(connections === undefined ? {} : { connections }),
    logger: clientLogger,
  });
  // EventEmitter 语义：'error' 必须挂监听（整组重连用例会真实触发瞬时 ws 错误）
  client.on('error', () => undefined);
  clients.push(client);
  await client.connect();
  return client;
}

/** 等条带化 attach leg 全部就绪（primary 就绪后 attach 在后台进行） */
async function waitLegs(client: Client, n: number): Promise<void> {
  await vi.waitFor(() => expect(client.legCount).toBe(n), { timeout: 10_000, interval: 20 });
}

/** 走完选择页 ajax 流程建会话（无 token 配置时探测全放行），返回可用 cookie */
async function establishSession(tunnelId: string): Promise<string> {
  const res = await fetch(`${base()}/__gateway__/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `tunnelId=${tunnelId}&token=`,
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('gateway_sid=');
  return cookie;
}

/** 浏览器侧下载 /big，返回完整响应体 */
async function downloadBig(cookie: string): Promise<Buffer> {
  const res = await fetch(`${base()}/big`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

/** 服务端注册表私有视图（测试态断言/故障注入用；legs 为 TunnelSession 私有字段的运行态形态） */
interface SessionView {
  legCount: number;
  legs: Array<{ ws: { terminate(): void } }>;
}
function serverSession(tunnelId: string): SessionView {
  const registry = (server as unknown as { tunnels: { get(id: string): SessionView | undefined } }).tunnels;
  const session = registry.get(tunnelId);
  if (!session) throw new Error('session missing');
  return session;
}

describe('多连接真机 e2e', () => {
  it('4 leg 条带化：8MiB 下载逐字节完整（upstream → client → server → 浏览器侧）', { timeout: 30_000 }, async () => {
    const client = await startClient(); // 默认 connections=4
    await waitLegs(client, 4);
    const tunnelId = client.tunnelId ?? '';
    expect(serverSession(tunnelId).legCount).toBe(4); // 服务端同见 4 leg
    const cookie = await establishSession(tunnelId);
    const body = await downloadBig(cookie);
    expect(body.length).toBe(BIG_BYTES);
    expect(body.equals(bigPattern)).toBe(true); // 逐字节一致
  });

  it('4 leg 条带化：8MiB 上传逐字节完整（浏览器侧 → server → client → upstream）', { timeout: 30_000 }, async () => {
    const client = await startClient();
    await waitLegs(client, 4);
    const cookie = await establishSession(client.tunnelId ?? '');
    const res = await fetch(`${base()}/upload`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      body: bigPattern,
    });
    expect(res.status).toBe(200);
    // upstream 实收字节数 + sha256 比对（哈希相等即逐字节一致）
    expect(await res.json()).toEqual({ bytes: BIG_BYTES, sha256: bigSha256 });
  });

  it('connections:1 legacy 回归：单连接下同一下载逐字节完整', { timeout: 30_000 }, async () => {
    const client = await startClient(1);
    expect(client.legCount).toBe(1);
    expect(serverSession(client.tunnelId ?? '').legCount).toBe(1);
    const cookie = await establishSession(client.tunnelId ?? '');
    const body = await downloadBig(cookie);
    expect(body.equals(bigPattern)).toBe(true);
  });

  it('整组重连恢复：服务端杀一条 attach leg → 组重建回 4 leg，老会话 cookie 仍可用', { timeout: 30_000 }, async () => {
    const client = await startClient();
    await waitLegs(client, 4);
    const tunnelId = client.tunnelId ?? '';
    const cookie = await establishSession(tunnelId);
    // 故障注入：服务端 terminate 一条 attach leg（legs[0]=primary 不动）
    const legs = serverSession(tunnelId).legs;
    const victim = legs[1];
    if (!victim) throw new Error('attach leg missing');
    victim.ws.terminate();
    // 任一 leg 断 = 整组 teardown（spec §4.4）：primary 内建重连带 tunnelId 回带复用，
    // attach leg 重新挂满。先等断开真实发生（terminate 的 close 帧异步到达，
    // 立即等 legCount===4 会被断开前的旧值骗过），再等重建回 4
    await vi.waitFor(() => expect(client.legCount).toBeLessThan(4), { timeout: 10_000, interval: 20 });
    await waitLegs(client, 4);
    // 服务端注册表同步确认（ack 先于注册返回，双保险防竞态）
    await vi.waitFor(() => expect(serverSession(tunnelId).legCount).toBe(4), { timeout: 10_000, interval: 20 });
    expect(client.tunnelId).toBe(tunnelId); // tunnelId 复用 → 浏览器会话保留
    const body = await downloadBig(cookie); // 老 cookie 免重新选择
    expect(body.equals(bigPattern)).toBe(true);
  });
});
