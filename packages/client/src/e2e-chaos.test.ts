/**
 * A 组建连期故障场景（spec §7）— 真实 Client + chaos-proxy + 最小 hello 网关。
 * 断言错误日志内容（M0 修复后的诊断可见性在库层同样成立）与退避重连收敛。
 */
import { type ChaosProxy, createChaosProxy } from 'chaos-proxy';
import { afterEach, describe, expect, it } from 'vitest';
import { type WebSocket, WebSocketServer } from 'ws';

import { Client } from './client';

import type { LogLevel } from './logger';

interface LogEntry { level: LogLevel; message: string; context?: Record<string, unknown> }

/** 日志捕获：断言 err.stack/错误码可见性的载体 */
function captureLog(): { entries: LogEntry[]; logger: import('./logger').Logger } {
  const entries: LogEntry[] = [];
  const push = (level: LogLevel) => (message: string, context?: Record<string, unknown>): void => {
    entries.push({ level, message, context });
  };
  return { entries, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } };
}

/** 条件轮询（禁固定 sleep）：到点不达即失败并带现场 */
async function waitFor(fn: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (fn()) return;
  throw new Error(`waitFor 超时: ${label}`);
}

/** 最小 hello 网关：hello → ack + ping → pong（供 S1/S2 的最终收敛）；port 缺省 0（ephemeral） */
class HelloGateway {
  private wss: WebSocketServer;
  private sockets = new Set<WebSocket>();
  readonly listening: Promise<void>;
  constructor(port = 0) {
    this.wss = new WebSocketServer({ port });
    this.listening = new Promise<void>((r) => this.wss.on('listening', r));
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'hello.ack', tunnelId: 'tid-a' }));
        else if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
  }
  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}`;
  }
  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return addr.port;
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const clients: Client[] = [];
const gateways: HelloGateway[] = [];
const proxies: ChaosProxy[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const p of proxies.splice(0)) await p.close();
  for (const g of gateways.splice(0)) await g.close();
});

function makeClient(gatewayUrl: string, logger: import('./logger').Logger): Client {
  const client = new Client({
    upstreamUrl: 'http://127.0.0.1:1', // A 组不开通道，upstream 不参与
    gatewayUrl,
    hostname: 'pc-chaos',
    logger,
    heartbeatIntervalMs: 300,
    connectTimeoutMs: 8000,
    reconnect: { baseDelayMs: 100, maxDelayMs: 500 },
  });
  client.on('error', () => undefined); // EventEmitter 语义：error 必须挂监听
  clients.push(client);
  return client;
}

describe('A 组：建连期故障', () => {
  it('S1：对端不可达（ECONNREFUSED）→ 退避重试；服务恢复后 connected；日志含错误码', async () => {
    // 拿一个"必拒"端口：先监听再关闭（loopback 下被抢注概率可忽略）
    const probe = new HelloGateway();
    await probe.listening;
    const port = probe.port;
    await probe.close();
    const { entries, logger } = captureLog();
    const client = makeClient(`ws://127.0.0.1:${port}/__gateway__/tunnel`, logger);
    const connected = new Promise<void>((r) => client.on('connected', r));
    void client.connect().catch(() => undefined);
    await waitFor(() => entries.filter((e) => e.message === '隧道重连中').length >= 2, 5000, '退避重试 ≥2 次');
    await waitFor(
      () => entries.some((e) => /ECONNREFUSED/.test(String(e.context?.['error'] ?? ''))),
      1000, 'ECONNREFUSED 诊断可见',
    );
    // 服务恢复：同端口起真网关 → connectTimeoutMs(8s) 内恢复即成功
    const gw = new HelloGateway(port);
    gateways.push(gw);
    await gw.listening;
    await connected;
  }, 15_000);

  it('S2：反代 502 → error 日志含 Unexpected server response: 502；清除后自愈 connected', async () => {
    const gw = new HelloGateway();
    gateways.push(gw);
    await gw.listening;
    const proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: gw.port });
    proxies.push(proxy);
    const proxyPort = await proxy.listen();
    proxy.rejectUpgradeWith(502);
    const { entries, logger } = captureLog();
    const client = makeClient(`ws://127.0.0.1:${proxyPort}/__gateway__/tunnel`, logger);
    const connected = new Promise<void>((r) => client.on('connected', r));
    void client.connect().catch(() => undefined);
    await waitFor(
      () => entries.some((e) => e.level === 'error' && String(e.context?.['error'] ?? '').includes('Unexpected server response: 502')),
      5000, '502 诊断可见',
    );
    proxy.clearRejectUpgrade();
    await connected; // 退避后自愈
  });

  it('S3：域名不存在（ENOTFOUND/EAI_AGAIN）→ 诊断明确、connectTimeout reject、进程不崩', async () => {
    const { entries, logger } = captureLog();
    const client = makeClient('ws://nonexistent.invalid/__gateway__/tunnel', logger);
    await expect(client.connect()).rejects.toThrow('connect timeout');
    await waitFor(
      () => entries.some((e) => /ENOTFOUND|EAI_AGAIN/.test(String(e.context?.['error'] ?? ''))),
      1000, 'DNS 错误码可见',
    );
  }, 15_000); // connectTimeoutMs=8000 才 reject，须高于 vitest 默认 5s 超时（同 S1）
});
