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
    // 条件轮询替代固定 sleep：负载下固定 200ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while ((g.readyLegCount === 0 || gateway.connectionCount === 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
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

  // 跨代幽灵重试回归：重建收掉 CONNECTING 中的 attach leg 时，其 connect() 以
  // 'connection closed by caller' 拒绝——不得误排退避重试：旧代幽灵会覆盖新代槽位、
  // 留下孤儿连接（线上多代风暴期多余 attach 握手/孤儿 leg 的根因）
  it('重建收掉 CONNECTING 中的 attach leg：不产生跨代幽灵重试，组收敛到目标 leg 数', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    gateway.attachAckDelayMs = 300; // 把 attach leg 钉在"已连上未就绪"窗（hello 已发、ack 未回）
    const g = makeGroup(2);
    await g.connect(); // primary 就绪；attach 后台 CONNECTING
    await vi.waitFor(() => expect(gateway.connectionCount).toBe(2)); // attach 已连上（未 ack）
    gateway.dropPrimary(); // 整组重建：closeAttachLegs 主动关掉 CONNECTING 的 attach leg
    await vi.waitFor(() => expect(g.readyLegCount).toBe(2), { timeout: 5000 }); // 重建收敛
    await new Promise((r) => setTimeout(r, 400)); // 幽灵重试窗口（baseDelayMs 50）已过
    expect(gateway.attachHelloCount).toBe(2); // 首代 1 + 重建代 1，无幽灵 hello
    expect(gateway.connectionCount).toBe(4); // 各代 primary+attach 各 2，无孤儿连接
  });

  // attach leg 终态错误（maxRetries:0 → 重连耗尽）由组语义接管（整组重建/槽位降级），
  // 不得经 'error' 上抛让 Client 记 ERROR 噪音——线上"重连次数耗尽"刷屏的降噪回归锁
  it('attach leg 重连耗尽：error 事件不上抛（组语义接管），组整组重建恢复', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const g = makeGroup(2);
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(2));
    const errors: Array<Error & { code?: string }> = [];
    g.on('error', (err: Error) => errors.push(err as Error & { code?: string }));
    gateway.dropOneConnection(); // 断 attach leg → 该 leg maxRetries=0 立即耗尽（终态码错误）
    await vi.waitFor(() => expect(g.readyLegCount).toBe(2), { timeout: 5000 }); // 整组重建
    expect(errors.some((e) => e.code === 'ERR_RECONNECT_EXHAUSTED')).toBe(false);
  });
});
