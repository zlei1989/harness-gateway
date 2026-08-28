import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConsoleLogger } from './logger';
import { MockGateway } from './test-utils/mock-gateway';
import { TunnelGroup } from './tunnel-group';

const logger = createConsoleLogger('error');
let gateway: MockGateway;
let group: TunnelGroup | null = null;

beforeEach(() => { gateway = new MockGateway(); });
afterEach(async () => { await group?.close(); group = null; await gateway.close(); });

function makeGroup(connections: number, handlers: Partial<{ onControl: (f: never) => void; onData: () => void; onDisconnected: () => void }> = {}): TunnelGroup {
  group = new TunnelGroup(
    {
      gatewayUrl: gateway.url,
      hello: { hostname: 'pc-a', defaultPath: '/' },
      connections,
      heartbeatIntervalMs: 30_000,
      connectTimeoutMs: 5_000,
      reconnect: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 },
      logger,
    },
    { onControl: handlers.onControl ?? (() => undefined), onData: handlers.onData ?? (() => undefined), onDisconnected: handlers.onDisconnected ?? (() => undefined) },
  );
  group.on('error', () => undefined); // EventEmitter 语义：必须挂监听
  group.on('fatal', () => undefined);
  return group;
}

describe('TunnelGroup', () => {
  it('协商成功：primary 就绪后 attach 余下 leg，readyLegCount 达到目标', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const g = makeGroup(4);
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
    expect(gateway.connectionCount).toBe(4);
  });

  it('老服务端（ack 无 multiConn）：不发起 attach，单 leg 运行，帧不带 seq', async () => {
    const g = makeGroup(4);
    await g.connect();
    await new Promise((r) => setTimeout(r, 200));
    expect(g.readyLegCount).toBe(1);
    expect(gateway.connectionCount).toBe(1);
    // 协商失败降级单连接：任何帧都不带 seq（spec §3.3）
    for (let i = 0; i < 3; i++) g.sendData({ channelId: 1, kind: 'http.body' }, Buffer.alloc(1024));
    await vi.waitFor(() => expect(gateway.allDataSeqsRaw(1)).toHaveLength(3));
    expect(gateway.allDataSeqsRaw(1)).toEqual([undefined, undefined, undefined]);
  });

  it('attach 被 4410 拒绝：槽位退避重试 ≤3 次后降级，组保持可用', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.closeOnHello = 4410; // mock 实现仅拒 attach（frame.client.attach === true 才 close），primary 放行
    const g = makeGroup(3);
    await g.connect();
    // 每槽位 首试 + 2 次重试 = 上限 3 次；connections=3 → 2 个 attach 槽位并行 ⇒ 合计 6 次后双双降级
    await vi.waitFor(() => expect(gateway.attachHelloCount).toBe(6), { timeout: 5000 });
    expect(g.ready).toBe(true);
    expect(g.readyLegCount).toBe(1); // 降级运行
  });

  it('发送侧加权选 leg：帧散落到多条 leg，且带单调 seq', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const g = makeGroup(4);
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
    for (let i = 0; i < 8; i++) g.sendData({ channelId: 1, kind: 'http.body' }, Buffer.alloc(64 * 1024));
    // ws 发送异步到达，等 mock 侧按连接记账收齐再断言（perConnData: Map<WebSocket, Buffer[]>）
    await vi.waitFor(() => {
      const perConn = gateway.perConnDataSizes();
      expect(perConn.size).toBeGreaterThan(1); // 条带化生效
      const seqs = gateway.allDataSeqs(1); // 跨连接聚合 channelId=1 的 seq
      expect(seqs).toEqual([...Array(8).keys()]); // 0..7 单调
    });
  });

  it('primary 终态失败（重连后 4409）：组向 Client 上抛 fatal（由 Client 落 error 态）', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const g = makeGroup(2);
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(2));
    let fatalErr: Error | null = null;
    g.once('fatal', (err: Error) => { fatalErr = err; });
    gateway.closePrimaryCode = 4409; // 对称 closeOnHello 的 primary 旋钮：非 attach 的 hello 也以该码拒
    gateway.drop(); // 整组断开 → primary 退避重连 → 重连 hello 被 4409 拒 → 终态 fatal（不再重连）
    await vi.waitFor(() => expect(fatalErr).not.toBeNull(), { timeout: 5000 });
    expect(fatalErr!.message).toContain('4409');
  });

  it('整组断连语义：任一已就绪 leg 断 → onDisconnected → 整组重连恢复', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    let disconnected = 0;
    const g = makeGroup(4, { onDisconnected: () => { disconnected += 1; } });
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
    gateway.dropOneConnection(); // 随机断一条非首连接
    await vi.waitFor(() => expect(disconnected).toBe(1));
    await vi.waitFor(() => expect(g.readyLegCount).toBe(4)); // 整组重建
  });
});
