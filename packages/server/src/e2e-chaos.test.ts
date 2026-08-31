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
import { type ClientRequest, createServer, request, type Server } from 'node:http';

import { type ChaosProxy, createChaosProxy } from 'chaos-proxy';
import { Client } from 'gateway-client';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { GatewayServer } from './server';

import type { Logger } from './logger';

interface LogEntry {
  level: string;
  message: string;
  context?: Record<string, unknown>;
  /** 距捕获器创建的毫秒偏移（S20 时序归因用） */
  at?: number;
}

function captureLog(): { entries: LogEntry[]; logger: Logger } {
  const entries: LogEntry[] = [];
  const t0 = Date.now();
  const push = (level: string) => (message: string, context?: Record<string, unknown>): void => {
    entries.push({ level, message, context, at: Date.now() - t0 });
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
  /** 服务端日志捕获（S20 断言 browser-aborted/200 两类终态用；其余用例不读） */
  serverEntries?: LogEntry[];
}

const stacks: Stack[] = [];

/** 一键起全栈：upstream（echo + /file?bytes=N）→ GatewayServer → chaos-proxy → 真实 Client（token good-token） */
async function startStack(opts: {
  heartbeatIntervalMs?: number; graceMs?: number; serverTtlMs?: number;
} = {}): Promise<Stack> {
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/complex')) {
      // 复杂内容响应（S23）：分块 NDJSON——多块、块间小延迟、变长多字节 payload，
      // 无 content-length（chunked 流式），与并发 WS 双线流量交错竞争同一隧道
      const url = new URL(req.url, 'http://x');
      const parts = Number(url.searchParams.get('parts') ?? '30');
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      let i = 0;
      const writePart = (): void => {
        if (res.destroyed) return;
        if (i >= parts) { res.end(); return; }
        const pad = '░'.repeat(100 + (i % 7) * 50);
        res.write(`${JSON.stringify({ i, len: pad.length, pad })}\n`);
        i += 1;
        setTimeout(writePart, 10);
      };
      writePart();
      return;
    }
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
    const { entries: serverEntries, logger: serverLogger } = captureLog();
    server = new GatewayServer({
      port: 0, headTimeoutMs: 10_000, helloTimeoutMs: 2000, logger: serverLogger,
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
    stack.serverEntries = serverEntries;
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
    // 不定 head 延迟则 destroyAll 时请求早已完结，"在途"前提不成立（实测诊断 status=200 body 完整）。
    // 注意：S21 起"head 未回的无体幂等请求"在宽限内改为重放（移动端降级），不再 502；
    // 本用例锁定"在途失败一次"语义，故用 POST（非幂等/带 body，不在重放面）
    const pending = fetchApp(s, '/file?bytes=5242880&headDelayMs=5000', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64, 7),
    });
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

  it('S21：在途幂等请求（head 未下发）遇隧道瞬断 → 宽限内原样重放，浏览器无感拿到 200', async () => {
    const s = await startStack({ graceMs: 8000 });
    // headDelayMs 撑开"head 未回"窗口：请求在途时隧道断开（重放只发生在未向浏览器写字节前）
    const pending = fetchApp(s, '/file?bytes=1024&headDelayMs=1500');
    await waitFor(() => (s.serverEntries ?? []).some((e) => e.message === '请求入口'), 3000, '请求入口');
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1024);
    // 重放路径证据（区别于 S18a 的"离线期新请求挂起"：本请求在途被断后重放）
    expect((s.serverEntries ?? []).some((e) => e.message === '隧道断开，幂等请求挂起待重放')).toBe(true);
    expect((s.serverEntries ?? []).some((e) => e.message === '隧道已恢复，重放幂等请求')).toBe(true);
  }, 15_000);

  it('S21b：head 已下发（流式进行中）遇断不重放——已发字节无法撤回，保持原截断语义', async () => {
    const s = await startStack({ graceMs: 8000 });
    s.proxy.setThrottle(256 * 1024); // 限速保证 destroy 时 body 仍在途（5MB ≈ 20s）
    const pending = fetchApp(s, '/file?bytes=5242880');
    const res = await pending; // fetch 在响应头到达即 resolve：head 已下发给"浏览器"
    expect(res.status).toBe(200);
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    await expect(res.arrayBuffer()).rejects.toThrow(); // 截断：content-length 不符
    expect((s.serverEntries ?? []).some((e) => e.message === '隧道断开，幂等请求挂起待重放')).toBe(false);
  }, 15_000);

  it('S21c：带体 POST 遇断不重放（非幂等/有 body 不在重放面）→ 502 一次', async () => {
    const s = await startStack({ graceMs: 8000 });
    const pending = fetchApp(s, '/file?bytes=1024&headDelayMs=1500', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64, 3),
    });
    await waitFor(() => (s.serverEntries ?? []).some((e) => e.message === '请求入口'), 3000, '请求入口');
    s.proxy.destroyAll();
    const res = await pending;
    expect(res.status).toBe(502);
    expect((s.serverEntries ?? []).some((e) => e.message === '隧道断开，幂等请求挂起待重放')).toBe(false);
  }, 15_000);

  it('S21d：重连被阻断（rejectUpgrade）→ 重放等待耗尽宽限才 502', async () => {
    const s = await startStack({ graceMs: 1000 });
    const pending = fetchApp(s, '/file?bytes=1024&headDelayMs=5000'); // head 迟迟不回，断时在重放窗内
    await waitFor(() => (s.serverEntries ?? []).some((e) => e.message === '请求入口'), 3000, '请求入口');
    s.proxy.destroyAll();
    s.proxy.rejectUpgradeWith(502); // 客户端重连全部失败
    const res = await pending;
    expect(res.status).toBe(502);
    // 证明走了"重放等待→耗尽"路径而非立即 502（立即 502 是未实现重放的旧行为）
    expect((s.serverEntries ?? []).some((e) => e.message === '隧道断开，幂等请求挂起待重放')).toBe(true);
    s.proxy.clearRejectUpgrade(); // 收尾让 client 能重连，afterEach 干净
  }, 15_000);

  it('S21e：重放等待期间浏览器断开 → 放弃重放（browser-aborted），不写 502、无泄漏', async () => {
    const s = await startStack({ graceMs: 8000 });
    const ctrl = new AbortController();
    const pending = fetchApp(s, '/file?bytes=1024&headDelayMs=5000', { signal: ctrl.signal });
    await waitFor(() => (s.serverEntries ?? []).some((e) => e.message === '请求入口'), 3000, '请求入口');
    s.proxy.destroyAll();
    // 等重放挂起日志出现后再断浏览器（确保命中 browserGone 竞速分支）
    await waitFor(
      () => (s.serverEntries ?? []).some((e) => e.message === '隧道断开，幂等请求挂起待重放'),
      3000, '重放挂起',
    );
    ctrl.abort();
    await expect(pending).rejects.toThrow();
    await waitFor(
      () => (s.serverEntries ?? [])
        .some((e) => e.message === '请求完成' && e.context?.['status'] === 'browser-aborted'),
      3000, 'browser-aborted 终态',
    );
  }, 15_000);
});

describe('G 组：浏览器中止风暴（线上 1006 判别实验）', () => {
  // 判别命题：浏览器侧中止（手机断网/锁屏/关页面的 socket 级 abort）只会通道级取消，
  // 绝不升级为隧道级事件（断开/重连/协议错误）——若本用例失败，则"浏览器行为杀死隧道"
  // 成立，线上 1006 排查方向从中间盒收回本仓库；通过则支撑"两个独立断连面"模型。
  //
  // 场景：限流链路下浏览器 10 并发下载，在途立即中止 5，幸存 5 必须字节完整。
  // 三个参数红线（均被实测失败锁定，偏离即被无关机制误杀，勿随意改回）：
  // ① 限流用 per-conn（默认）而非 shared——shared 的预算分配是 c2s 优先，隧道满载时
  //   s2c（ack/控制帧）会被饿死到零字节（chaos-proxy 实现 artifact，非真实链路语义）；
  //   connections:1 单隧道连接下 per-conn 语义与"链路限速"一致，且控制帧有独立预算。
  // ② heartbeatIntervalMs 1000（判死窗 3s）必须大于服务端 tunnel.ack ~1s 回执节拍
  //   （session.ts：128KiB 节拍 + 1s 兜底）——默认 300ms（判死 900ms）会在持续受限
  //   下载中误判死（S10/S11 同理调大）。
  // ③ 受害者用 headDelayMs=600 压住响应起点，中止发生在"通道已建立、响应尚未产出"窗口——
  //   实测若在途受害者已开始回 body：其 chunk（64KB）会在隧道 c2s 单流内插队到后续通道 head
  //   之前形成队头团块，把幸存者 head 推迟 ~8-10s，踩中本文件加速值 headTimeoutMs=10s
  //   （生产默认 120s 无此问题）→ 假 504。先登记后中止，受害者零字节过线，时序确定。
  it('S20：限流 10 并发中止 5 → 幸存 5 完整返回，隧道零断开零错误、通道无泄漏', async () => {
    const s = await startStack({ heartbeatIntervalMs: 1000 }); // 判死窗 3s > 服务端 ack ~1s 节拍（红线②）
    // 64KB/s per-conn（connections:1 单隧道连接，双向各自预算；红线①：不用 shared）
    s.proxy.setThrottle(64 * 1024);

    const SURVIVOR_BYTES = 32 * 1024;
    const VICTIM_BYTES = 192 * 1024; // 值不影响时序（headDelay 内零字节过线），仅标识大下载形态
    interface RawResult { status: number; bytes: number }
    interface RawHandle {
      req: ClientRequest;
      state: { status: number | null; bytes: number };
      done: Promise<RawResult>;
    }
    /** 裸 http.request + agent:false：每请求独立 TCP（浏览器多连接形态），单请求 abort 不串扰同池 socket */
    const fire = (path: string): RawHandle => {
      const state: RawHandle['state'] = { status: null, bytes: 0 };
      const req = request({
        host: '127.0.0.1', port: s.serverPort, path,
        headers: { cookie: s.cookie }, agent: false,
      });
      const done = new Promise<RawResult>((resolve, reject) => {
        req.on('response', (res) => {
          state.status = res.statusCode ?? 0;
          res.on('data', (c: Buffer) => { state.bytes += c.length; });
          res.on('end', () => resolve({ status: state.status ?? 0, bytes: state.bytes }));
          res.on('error', reject);
        });
        req.on('error', reject);
      });
      req.end();
      return { state, req, done };
    };

    // 10 并发同刻发出：5 条受害者（600ms 后才起流的大下载）+ 5 条幸存者（快速小 body）
    const victims = Array.from({ length: 5 }, () =>
      fire(`/file?bytes=${VICTIM_BYTES}&headDelayMs=600`));
    const survivors = Array.from({ length: 5 }, () => fire(`/file?bytes=${SURVIVOR_BYTES}`));
    const started = Date.now();

    // 等 10 条通道全部在服务端登记（= 请求已真实穿越隧道在途），再立即 socket 级中止受害者——
    // "浏览器立即断掉"的确定性形态；隧道 s2c 单流 FIFO 保证每通道 open 先于 close 到达客户端，
    // 客户端通道必然已建立，channel.close → destroyUpstream 闭环无竞态（早于此时刻 destroy
    // 可能抢在请求字节发出前，通道从未存在，场景退化）
    await waitFor(
      () => (s.serverEntries ?? []).filter((e) => e.message === '请求入口').length >= 10,
      5000, '10 条通道在服务端登记',
    );
    for (const v of victims) v.req.destroy(); // 对齐浏览器关页面/断网/锁屏的中止形态

    // 被中止者：必须以失败告终，且中止点在响应返回之前（headDelay 窗口内，确定性成立）
    const victimOutcomes = await Promise.all(victims.map((v) =>
      v.done.then(() => 'completed' as const).catch(() => 'aborted' as const)));
    expect(victimOutcomes).toEqual(['aborted', 'aborted', 'aborted', 'aborted', 'aborted']);
    for (const v of victims) expect(v.state.status).toBeNull();

    // 幸存者：状态 + 字节数双重完整
    const results = await Promise.all(survivors.map((x) => x.done));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.bytes).toBe(SURVIVOR_BYTES);
    }
    // 限速生效证明：幸存流量 160KB @64KB/s 地板 2.5s；限速失效时 loopback 百毫秒内完结
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);

    // 判别核心断言：中止风暴不得升级为隧道级事件——零断开、零重连、零隧道错误日志
    expect(disconnectedCount(s)).toBe(0);
    expect(readyCount(s)).toBe(1); // 仅首连，无重连
    expect(s.entries.filter(
      (e) => e.message === '隧道连接错误' || e.message === '隧道协议错误，断开重连',
    )).toHaveLength(0);

    // 服务端两类终态证据：幸存 5×200、中止 5×browser-aborted（channel.close 取消语义真实到达服务端）
    await waitFor(
      () => (s.serverEntries ?? []).filter((e) => e.message === '请求完成').length >= 10,
      15_000, '10 条通道全部到达终态',
    );
    const finals = (s.serverEntries ?? []).filter((e) => e.message === '请求完成');
    expect(finals.filter((e) => e.context?.['status'] === 200)).toHaveLength(5);
    expect(finals.filter((e) => e.context?.['status'] === 'browser-aborted')).toHaveLength(5);

    // 客户端通道表归零（中止通道 channel.close → destroyUpstream + done 闭环；迟到帧安全丢弃）
    await waitFor(
      () => (s.client as unknown as { channels: Map<number, unknown> }).channels.size === 0,
      10_000, '通道表清空',
    );
    // 隧道健康终检：风暴后全新请求照常
    expect((await fetchApp(s)).status).toBe(200);
  }, 30_000);
});

describe('H 组：并发稳定性（浏览器多链路混载）', () => {
  /** 经网关开一条浏览器 WS 到上游 echo（cookie 会话 + /socket 路径，同 S19 范式） */
  const openBrowserWs = async (s: Stack): Promise<WebSocket> => {
    const ws = new WebSocket(`ws://127.0.0.1:${s.serverPort}/socket`, { headers: { cookie: s.cookie } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return ws;
  };

  /** 双线持续收发：每连接多轮 ping-pong（文本/二进制混发、64B~12KB 混排、轮间小间隔保持持续在途），回码全等校验 */
  const runEchoRounds = async (ws: WebSocket, idx: number, rounds: number): Promise<string[]> => {
    const errors: string[] = [];
    for (let r = 0; r < rounds; r++) {
      const text = r % 2 === 0;
      const size = 64 + ((r + idx) % 4) * 4096;
      const msg = text ? '中'.repeat(size) : Buffer.alloc(size, (r * 7 + idx) % 256);
      const echoed = await new Promise<Buffer | string>((resolve, reject) => {
        const onMsg = (data: unknown, isBinary: boolean): void => {
          cleanup();
          resolve(isBinary ? Buffer.from(data as ArrayBuffer) : String(data));
        };
        const onErr = (err: Error): void => { cleanup(); reject(err); };
        const cleanup = (): void => { ws.off('message', onMsg); ws.off('error', onErr); };
        ws.on('message', onMsg);
        ws.on('error', onErr);
        try {
          ws.send(text ? msg : (msg as Buffer), { binary: !text });
        } catch (err) { cleanup(); reject(err as Error); }
      });
      const ok = text ? echoed === msg : (echoed as Buffer).equals(msg as Buffer);
      if (!ok) errors.push(`ws#${idx} r${r} echo mismatch`);
      await new Promise((r) => setTimeout(r, 25));
    }
    return errors;
  };

  /** 稳定性公共断言：隧道零断开、零重连、零错误级日志 */
  const assertStable = (s: Stack): void => {
    expect(disconnectedCount(s)).toBe(0);
    expect(readyCount(s)).toBe(1); // 仅首连，无重连
    expect(s.entries.filter((e) => e.level === 'error')).toHaveLength(0);
  };

  it('S22：10 并发浏览器 WS 双线持续收发 → 全链路稳定（零断开零错误、消息全等回、通道无泄漏）', async () => {
    const s = await startStack();
    const COUNT = 10;
    const ROUNDS = 20;
    const sockets = await Promise.all(Array.from({ length: COUNT }, () => openBrowserWs(s)));

    // 10 条连接并行、每连接 20 轮串行 ping-pong：轮内等待回码（双线必经隧道往返），轮间 25ms 保持持续在途
    const errorGroups = await Promise.all(sockets.map((ws, idx) => runEchoRounds(ws, idx, ROUNDS)));
    expect(errorGroups.flat()).toEqual([]);

    assertStable(s);
    // 全部关闭 → 通道级清理闭环（channel.close → 客户端 destroyUpstream + done → 通道表归零）
    for (const ws of sockets) ws.close();
    await waitFor(
      () => (s.client as unknown as { channels: Map<number, unknown> }).channels.size === 0,
      5000, '通道表清空',
    );
    // 隧道健康终检：风暴后全新请求照常
    expect((await fetchApp(s)).status).toBe(200);
  }, 20_000);

  it('S23：10 并发浏览器 WS + 10 并发 HTTP（共 20 链路）→ WS 双线持续、HTTP 复杂内容完整，全链路稳定', async () => {
    const s = await startStack();
    const COUNT = 10;
    // HTTP 组：/complex 分块 NDJSON（30 段 × 10ms、变长多字节 payload、chunked 流式）——复杂内容
    const httpPending = Array.from({ length: COUNT }, () => fetchApp(s, '/complex?parts=30'));
    // WS 组：10 条双线 ping-pong，与 HTTP 流式交错竞争同一隧道（并发混载才是本用例命题）
    const sockets = await Promise.all(Array.from({ length: COUNT }, () => openBrowserWs(s)));
    const wsRounds = Promise.all(sockets.map((ws, idx) => runEchoRounds(ws, idx, 20)));

    // HTTP 断言：状态 + content-type + NDJSON 段数/字段/多字节 payload 确定性校验
    const httpResults = await Promise.all(httpPending);
    for (const res of httpResults) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('application/x-ndjson');
      const lines = (await res.text()).split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(30);
      lines.forEach((line, i) => {
        const part = JSON.parse(line) as { i: number; len: number; pad: string };
        expect(part.i).toBe(i);
        expect(part.len).toBe(100 + (i % 7) * 50);
        expect(part.pad).toBe('░'.repeat(part.len));
      });
    }

    // WS 断言 + 稳定性公共断言
    expect((await wsRounds).flat()).toEqual([]);
    assertStable(s);
    // 全部关闭 → 通道级清理闭环
    for (const ws of sockets) ws.close();
    await waitFor(
      () => (s.client as unknown as { channels: Map<number, unknown> }).channels.size === 0,
      5000, '通道表清空',
    );
    expect((await fetchApp(s)).status).toBe(200);
  }, 20_000);
});
