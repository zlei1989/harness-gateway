/**
 * B/C/F 组会话期故障场景（spec §7）— 真实 Client ⇄ chaos-proxy ⇄ 真实 GatewayServer ⇄ 真实 upstream。
 * 断言契约：断连日志 code 可见（M0 在库层的对应面）；tunnelId 复用 cookie 免重登；
 * 在途通道 502 一次是正确语义；判死/自愈边界精确。
 * 适配说明：
 * - multiconn 合并后默认 4 连接走 TunnelGroup；本组场景锁定连接层韧性需单 leg 确定性，
 *   故 startStack 显式 connections: 1（纯 legacy 单连接，心跳/判死/重连/tunnelId 语义不变）。
 * - Client 无 ready getter：就绪等待改为日志捕获中 '隧道就绪' 计数递增（readyCount）。
 * - graceMs（服务端隧道恢复宽限）透传 GatewayServerOptions.tunnelRestoreGraceMs（Task 15 落地，F 组使用）。
 */
import { createServer, type Server } from 'node:http';

import { type ChaosProxy, createChaosProxy } from 'chaos-proxy';
import { Client } from 'gateway-client';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { GatewayServer } from './server';

import type { Logger } from './logger';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

interface LogEntry { level: string; message: string; context?: Record<string, unknown> }

function captureLog(): { entries: LogEntry[]; logger: Logger } {
  const entries: LogEntry[] = [];
  const push = (level: string) => (message: string, context?: Record<string, unknown>): void => {
    entries.push({ level, message, context });
  };
  return { entries, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } as Logger };
}

async function waitFor(fn: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (fn()) return;
  throw new Error(`waitFor 超时: ${label}`);
}

interface Stack {
  server: GatewayServer;
  proxy: ChaosProxy;
  client: Client;
  upstream: Server;
  /** upstream 上的 WS echo（S19；noServer 挂 upgrade，与 client e2e.test.ts 同范式） */
  upstreamWss: WebSocketServer;
  serverPort: number;
  tunnelId: string;
  cookie: string;
  entries: LogEntry[];
}

const stacks: Stack[] = [];

/** 一键起全栈：upstream（echo + /file?bytes=N）→ GatewayServer → chaos-proxy → 真实 Client（token good-token） */
async function startStack(opts: {
  heartbeatIntervalMs?: number; graceMs?: number; serverTtlMs?: number;
} = {}): Promise<Stack> {
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/file')) {
      const url = new URL(req.url, 'http://x');
      const bytes = Number(url.searchParams.get('bytes') ?? '1024');
      // headDelayMs：S5 需要"隧道断时 head 尚未回浏览器"的确定性窗口（在途通道 502 语义）；
      // 缺省 0 立即下发，不影响其它场景。隧道断开后通道中止会销毁本响应，写前须判 destroyed。
      const headDelayMs = Number(url.searchParams.get('headDelayMs') ?? '0');
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes) });
        let sent = 0;
        const chunk = Buffer.alloc(64 * 1024, 1);
        const writeMore = (): void => {
          while (sent < bytes) {
            const n = Math.min(chunk.length, bytes - sent);
            sent += n;
            if (!res.write(chunk.subarray(0, n))) { res.once('drain', writeMore); return; }
          }
          res.end();
        };
        writeMore();
      }, headDelayMs);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res);
  });
  // upstream WS echo（S19）：noServer + upgrade 处理 echo（与 client e2e.test.ts 同范式）
  const upstreamWss = new WebSocketServer({ noServer: true });
  upstreamWss.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  upstream.on('upgrade', (req, socket, head) => {
    upstreamWss.handleUpgrade(req, socket, head, (ws) => upstreamWss.emit('connection', ws, req));
  });
  // 早抛清理窗：stacks.push 前的 listen 任一步抛错，已开资源无人关
  // → catch 兜底就地清理；registered 之后抛错（connect/select 在 push 后）由 afterEach 清理（避免双关）
  let registered = false;
  let server: GatewayServer | undefined;
  let proxy: ChaosProxy | undefined;
  try {
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamAddr = upstream.address();
    if (typeof upstreamAddr === 'string' || !upstreamAddr) throw new Error('no addr');

    const { entries, logger } = captureLog();
    server = new GatewayServer({
      port: 0, headTimeoutMs: 10_000, helloTimeoutMs: 2000, logger: nullLogger,
      ...(opts.serverTtlMs !== undefined ? { browserSessionTtlMs: opts.serverTtlMs } : {}),
      // 瞬断宽限（F 组 S18/S19 使用）；缺省走服务端默认 30s
      ...(opts.graceMs !== undefined ? { tunnelRestoreGraceMs: opts.graceMs } : {}),
    });
    const serverPort = await server.listen();

    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: serverPort });
    const proxyPort = await proxy.listen();

    const client = new Client({
      upstreamUrl: `http://127.0.0.1:${upstreamAddr.port}`,
      gatewayUrl: `ws://127.0.0.1:${proxyPort}/__gateway__/tunnel`,
      hostname: 'pc-chaos',
      token: 'good-token',
      logger,
      connections: 1, // 单 leg 确定性：multiconn 默认 4 走 TunnelGroup，本组锁定连接层语义
      heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 300,
      connectTimeoutMs: 10_000,
      reconnect: { baseDelayMs: 100, maxDelayMs: 500 },
    });
    client.on('error', () => undefined);
    client.on('fatal', () => undefined);
    const stack: Stack = {
      server, proxy, client, upstream, upstreamWss, serverPort,
      tunnelId: '', cookie: '', entries,
    };
    stacks.push(stack); // 先入台账再 proceed：connect/select 抛错由 afterEach 兜底
    registered = true;
    await client.connect();
    stack.tunnelId = client.tunnelId ?? '';
    expect(stack.tunnelId).not.toBe('');

    const res = await fetch(`http://127.0.0.1:${serverPort}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tunnelId=${stack.tunnelId}&token=good-token`,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    stack.cookie = res.headers.get('set-cookie') ?? '';
    return stack;
  } catch (err) {
    if (!registered) {
      await proxy?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      upstreamWss.close();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
    throw err;
  }
}

/** 幂等收尾：client → proxy → server → upstream（全局约束的确定性顺序）；
 *  每步 catch：单个子资源 close reject 不得中断后续清理 */
async function stopStack(s: Stack): Promise<void> {
  await s.client.close().catch(() => undefined);
  await s.proxy.close().catch(() => undefined);
  await s.server.close().catch(() => undefined);
  // upgraded 的 WS socket 不受 upstream http server close 管理：先 terminate 再关，防 close 回调悬挂
  for (const c of s.upstreamWss.clients) c.terminate();
  s.upstreamWss.close();
  await new Promise<void>((r) => s.upstream.close(() => r()));
}

afterEach(async () => {
  for (const s of stacks.splice(0)) await stopStack(s);
});

const fetchApp = (s: Stack, path = '/api/x', init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.serverPort}${path}`, {
    ...init,
    headers: { cookie: s.cookie, ...(init?.headers ?? {}) },
  });

const disconnectedCount = (s: Stack): number =>
  s.entries.filter((e) => e.message === '隧道连接断开').length;

/** Client 无 ready getter：以日志捕获中 '隧道就绪' 条目计数判定建连/重连就绪 */
const readyCount = (s: Stack): number =>
  s.entries.filter((e) => e.message === '隧道就绪').length;

describe('B 组：会话期传输故障', () => {
  it('S4：空闲断链 → 自动重连 + tunnelId 复用 + 老 cookie 免重登 + 断开日志 code=1006', async () => {
    const s = await startStack();
    const tid = s.tunnelId;
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开日志');
    await waitFor(
      () => readyCount(s) >= 2 && s.entries.some((e) => e.message === '隧道就绪' && e.context?.['tunnelId'] === tid),
      5000, 'tunnelId 复用重连',
    );
    const res = await fetchApp(s);
    expect(res.status).toBe(200);
    const disc = s.entries.find((e) => e.message === '隧道连接断开');
    expect(disc?.context?.['code']).toBe(1006); // RST → 无 close 帧
  });

  it('S5：大流量中断链 → 在途请求 502 一次；重连后新请求正常；客户端通道表清空', async () => {
    const s = await startStack();
    // headDelayMs 撑开"head 未回浏览器"窗口：loopback 下 5MB 百毫秒内即传完，
    // 不定 head 延迟则 destroyAll 时请求早已完结，"在途"前提不成立（实测诊断 status=200 body 完整）
    const pending = fetchApp(s, '/file?bytes=5242880&headDelayMs=5000'); // 5MB 下载在途（head 未下发）
    // 等通道真实建立（客户端通道表登记）再断链——条件轮询替代固定 sleep
    await waitFor(
      () => (s.client as unknown as { channels: Map<number, unknown> }).channels.size >= 1,
      3000, '在途通道建立',
    );
    s.proxy.destroyAll();
    const res = await pending.catch(() => null);
    expect(res === null || res.status === 502).toBe(true); // 在途失败一次（正确语义）
    await waitFor(() => readyCount(s) >= 2, 5000, '重连就绪');
    const after = await fetchApp(s, '/file?bytes=1024');
    expect(after.status).toBe(200);
    expect((s.client as unknown as { channels: Map<number, unknown> }).channels.size).toBe(0); // 无泄漏
  });

  it('S6：静默黑洞（半开）→ 判死窗口内 terminate + 自动重连', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 }); // 判死 ≈900ms
    s.proxy.blackhole('both');
    await waitFor(() => s.entries.some((e) => e.message === '心跳超时，判定死连接'), 3000, '心跳判死');
    await waitFor(() => disconnectedCount(s) >= 1, 3000, '断开');
    s.proxy.heal(); // 重连需要通路
    await waitFor(() => readyCount(s) >= 2, 5000, '判死后重连');
    expect((await fetchApp(s)).status).toBe(200);
  });

  it('S7：黑洞在判死窗口内 heal → 不重连、会话无损', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.blackhole('both');
    await new Promise((r) => setTimeout(r, 400)); // < 900ms 判死窗
    s.proxy.heal();
    await new Promise((r) => setTimeout(r, 1000)); // 观察一个判死周期
    expect(disconnectedCount(s)).toBe(0); // 无断开：黑洞短于判死窗可自愈
    expect((await fetchApp(s)).status).toBe(200);
  });
});

describe('B 组：空闲回收 vs 心跳续命', () => {
  it('S8：空闲回收(2s)慢于心跳(300ms) → 存活 ≥6s 零断开', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.setIdleTimeout(2000);
    await new Promise((r) => setTimeout(r, 6000));
    expect(disconnectedCount(s)).toBe(0);
    s.proxy.setIdleTimeout(0); // 收尾不再杀
    expect((await fetchApp(s)).status).toBe(200);
  }, 15_000);

  it('S9：空闲回收(3s)快于心跳(10s) → 每轮回收自动重连 ≥2 周期，cookie 始终可用', async () => {
    const s = await startStack({ heartbeatIntervalMs: 10_000 });
    s.proxy.setIdleTimeout(3000);
    await waitFor(() => disconnectedCount(s) >= 2, 20_000, '两次回收重连');
    s.proxy.setIdleTimeout(0);
    // 末轮重连就绪：每次断开应对应一次重连就绪（首连 1 次 + 每轮回收重连 1 次）
    await waitFor(() => readyCount(s) >= disconnectedCount(s) + 1, 5000, '末轮重连就绪');
    expect((await fetchApp(s)).status).toBe(200);
  }, 30_000);
});

describe('C 组：链路品质劣化', () => {
  it('S10：高 RTT(150ms±50) 下 5MB 下载 → headTimeout 不触发、不判死、字节完整', async () => {
    const s = await startStack({ heartbeatIntervalMs: 1000 });
    s.proxy.setLatency(150, 50);
    const res = await fetchApp(s, '/file?bytes=5242880');
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(5242880);
    expect(disconnectedCount(s)).toBe(0);
  }, 60_000);

  it('S11：限速 128KB/s 上传 1MB → 背压有界 + ack 活性保心跳不判死', async () => {
    const s = await startStack({ heartbeatIntervalMs: 2000 }); // 判死 6s
    s.proxy.setThrottle(128 * 1024);
    const started = Date.now();
    const res = await fetchApp(s, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024, 2),
    });
    expect(res.status).toBe(200);
    // fetch 在响应头到达时即 resolve：必须消费完整 body 再计时，否则测到的是 time-to-headers
    // （upstream echo 在首个限速 chunk 到达即冲刷响应头），限速生效无从证明
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1024 * 1024);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000); // ≈8s 证明限速生效
    expect(disconnectedCount(s)).toBe(0); // tunnel.ack 入站活性兜底（线上断连根因修复的回归锁）
  }, 30_000);

  it('S12：flappy(1s)×15 重连风暴 → 每次恢复 connected、无 fatal、稳态定时器单例', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.flappy(1000);
    await waitFor(() => disconnectedCount(s) >= 15, 25_000, '15 次断开重连');
    s.proxy.stopFlappy();
    // 末次重连就绪（Client 无 ready getter：readyCount 日志计数形态，首连 1 次 + 每次重连 1 次）
    await waitFor(() => readyCount(s) >= disconnectedCount(s), 5000, '末次重连就绪');
    await new Promise((r) => setTimeout(r, 1000)); // 稳态观察窗
    expect(s.entries.some((e) => e.message === '重连次数耗尽，停止重试')).toBe(false); // 无终态
    // connections:1 下 Client.connection 即单 Connection（已核实字段结构）：稳态不变量直接反射
    const conn = s.client as unknown as { connection: { heartbeatTimer: unknown; reconnectTimer: unknown } };
    expect(conn.connection.heartbeatTimer).not.toBeNull(); // 心跳在跑
    expect(conn.connection.reconnectTimer).toBeNull(); // 无残留重连定时器
    expect((await fetchApp(s)).status).toBe(200);
  }, 40_000);
});

describe('D 组：协议健壮性', () => {
  it('S13：hello 后 4 坏帧隧道存活（ping 有 pong），第 5 坏帧触发 1002 断开', async () => {
    const s = await startStack(); // 仅借用 server；本用例直连不走 proxy/client
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${s.serverPort}/__gateway__/tunnel`);
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', client: { hostname: 'evil', defaultPath: '/' } }));
    await new Promise<void>((resolve) => {
      ws.on('message', function onMsg(raw) {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'hello.ack') { ws.removeListener('message', onMsg); resolve(); }
      });
    });
    const bad = Buffer.from([0xff, 0x00, 0x01]); // 非协议二进制帧
    for (let i = 0; i < 4; i++) ws.send(bad);
    // 4 帧未超预算：ping 应有 pong（隧道存活）
    const pong = new Promise<void>((resolve) => {
      ws.on('message', function onMsg(raw) {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'pong') { ws.removeListener('message', onMsg); resolve(); }
      });
    });
    ws.send(JSON.stringify({ type: 'ping' }));
    await pong;
    // 第 5 帧超预算 → 1002。注意预算是"连续"语义：成功解码的 ping 已重置连续坏帧计数
    // （tunnel.ts 路由阶段成功解码即清零，单测锁定间歇坏帧不升级），
    // 故超预算验证须再起一轮连续 5 坏帧，由该轮第 5 帧触发断开
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    for (let i = 0; i < 5; i++) ws.send(bad);
    expect(await closed).toBe(1002);
  });
});

describe('F 组：瞬断宽限', () => {
  it('S18a：grace 8s 内重连（≈1s）→ 断连期 HTTP 请求挂起后透明完成', async () => {
    const s = await startStack({ graceMs: 8000 });
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const started = Date.now();
    const res = await fetchApp(s); // 离线窗口内发出：应挂起而非 502
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(8000);
    await res.text();
  }, 15_000);

  it('S18b：重连被阻断（rejectUpgrade）→ 宽限耗尽 502', async () => {
    const s = await startStack({ graceMs: 1000 });
    s.proxy.destroyAll();
    s.proxy.rejectUpgradeWith(502); // 客户端重连全部失败
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const res = await fetchApp(s);
    expect(res.status).toBe(502);
    s.proxy.clearRejectUpgrade(); // 收尾让 client 能重连，afterEach 干净
  }, 15_000);

  it('S19：断连期 WS upgrade 挂起 → 恢复后完成握手并 echo', async () => {
    const s = await startStack({ graceMs: 8000 });
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const ws = new WebSocket(`ws://127.0.0.1:${s.serverPort}/socket`, { headers: { cookie: s.cookie } });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await opened; // 挂起期间客户端自动重连成功 → upgrade 完成
    const echoed = new Promise<string>((resolve) => {
      ws.on('message', (raw) => resolve(String(raw)));
      ws.send('grace-ok');
    });
    expect(await echoed).toBe('grace-ok');
    ws.terminate();
  }, 15_000);
});
