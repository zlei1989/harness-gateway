/**
 * Connection 连接管理测试 —— hello 握手 / 连接超时 / 4409 / 自动重连 / 心跳死连接 / 主动关闭。
 * 注意：全部用内存 MockGateway（随机端口）真实走 WS，不用假定时器，避免脆弱时序断言。
 */

import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';

import { Connection } from './connection';
import { type ControlFrame, type DataHeader, decodeControl, encodeControl, encodeData } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 内存模拟网关：自动应答 hello/ping，记录收到的控制帧 */
class MockGateway {
  wss = new WebSocketServer({ port: 0 });
  sockets: WsWebSocket[] = [];
  received: ControlFrame[] = [];
  /** 测试旋钮：收到 hello 后的行为 */
  helloAction: 'ack' | 'close4409' | 'ignore' = 'ack';
  /** 测试旋钮：hello.ack 延迟毫秒数（0 = 立即），用于构造"迟到的 ack"竞态 */
  ackDelayMs = 0;
  /** 测试旋钮：是否应答 ping（false = 模拟对端永不回 pong 的静默链路） */
  answerPings = true;

  constructor() {
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      // 连接关闭后从存活列表移除（sockets 语义 = 当前存活隧道，供 close 用例断言）
      ws.on('close', () => {
        const i = this.sockets.indexOf(ws);
        if (i >= 0) this.sockets.splice(i, 1);
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // 数据帧在用例外处理
        const frame = decodeControl(String(data));
        this.received.push(frame);
        if (frame.type === 'hello' && this.helloAction === 'ack') {
          const reply = () => ws.send(encodeControl({ type: 'hello.ack', tunnelId: 'tid-1' }));
          if (this.ackDelayMs > 0) setTimeout(reply, this.ackDelayMs);
          else reply();
        }
        if (frame.type === 'hello' && this.helloAction === 'close4409') ws.close(4409, 'hostname conflict');
        if (frame.type === 'ping' && this.answerPings) ws.send(encodeControl({ type: 'pong' }));
      });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }

  /** 主动断开当前所有隧道连接 */
  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets = [];
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const OPTS = {
  hello: { hostname: 'pc-a', defaultPath: '/' },
  heartbeatIntervalMs: 60,
  connectTimeoutMs: 300,
  reconnect: { baseDelayMs: 20, maxDelayMs: 80, maxRetries: Infinity },
  logger: nullLogger,
};

function makeHandlers() {
  const calls = { control: [] as ControlFrame[], data: [] as DataHeader[], disconnected: 0 };
  return {
    calls,
    handlers: {
      onControl: (f: ControlFrame) => calls.control.push(f),
      onData: (h: DataHeader) => calls.data.push(h),
      onDisconnected: () => { calls.disconnected += 1; },
    },
  };
}

describe('Connection', () => {
  it('hello 握手：连接后首帧为 hello（首连不带 tunnelId），收到 ack 后 ready 并 resolve，记下分配的 tunnelId', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    expect(conn.ready).toBe(true);
    expect(gw.received[0]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/', flowControl: true } });
    expect(conn.tunnelId).toBe('tid-1'); // ack 下发的 tunnelId 已记忆
    await conn.close();
    await gw.close();
  });

  it('connect 超时：端口不可达时 connectTimeoutMs 后 reject', async () => {
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: 'ws://127.0.0.1:1/__gateway__/tunnel', ...OPTS }, handlers);
    conn.on('error', () => {});
    await expect(conn.connect()).rejects.toThrow(/connect timeout/);
  });

  it('4409 hostname 冲突：connect 立即 reject 且不重连', async () => {
    const gw = new MockGateway();
    gw.helloAction = 'close4409';
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await expect(conn.connect()).rejects.toThrow(/4409/);
    await new Promise((r) => setTimeout(r, 200));
    expect(gw.sockets.length + gw.received.length).toBeLessThanOrEqual(1 + 1); // 只连过 1 次
    await gw.close();
  });

  it('断线自动重连：drop 后 disconnected → 重连成功再 connected，重连 hello 回带上次 tunnelId 请求复用', async () => {
    const gw = new MockGateway();
    const { handlers, calls } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    const events: string[] = [];
    conn.on('connected', () => events.push('connected'));
    conn.on('disconnected', () => events.push('disconnected'));
    await conn.connect();
    gw.dropAll();
    await new Promise<void>((resolve) => conn.once('connected', resolve));
    expect(events).toEqual(['connected', 'disconnected', 'connected']);
    expect(calls.disconnected).toBe(1);
    // 第二次 hello 携带 ack 记忆的 tunnelId（服务端空闲即复用，浏览器老会话随之恢复）
    const hellos = gw.received.filter((f) => f.type === 'hello');
    expect(hellos).toHaveLength(2);
    expect(hellos[1]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/', flowControl: true, tunnelId: 'tid-1' } });
    await conn.close();
    await gw.close();
  });

  // 线上 1006 杀连接观测（中间件 synthesized close）：断开时必须留下 code/reason/readyMs 诊断日志，
  // 否则"非必现、大概率"的中间件杀连接在生产日志里无节律可分析
  it('断开诊断日志：已就绪会话断开时记 code/reason/readyMs', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const warns: { msg: string; meta?: unknown }[] = [];
    const logger = {
      debug() {}, info() {},
      warn(msg: string, meta?: unknown) { warns.push({ msg, meta }); },
      error() {},
    } as unknown as import('./logger').Logger;
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS, logger }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    expect(conn.ready).toBe(true);
    await new Promise((r) => setTimeout(r, 60)); // 拉开 readyMs 使可断言 >0
    gw.sockets[0]?.close(1011, 'upstream boom');
    await new Promise((r) => setTimeout(r, 100));
    const entry = warns.find((w) => w.msg === '隧道连接断开');
    expect(entry).toBeDefined();
    expect(entry?.meta).toMatchObject({ code: 1011, reason: 'upstream boom' });
    expect((entry?.meta as { readyMs?: number }).readyMs ?? 0).toBeGreaterThan(0);
    await conn.close();
    await gw.close();
  });

  it('心跳死连接检测：对端静默超过 3 个周期 → 主动断开并重连', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 网关侧停止一切 outbound（不应答 ping、不发任何帧）
    gw.sockets[0]?.pause();
    await new Promise<void>((resolve) => conn.once('connected', resolve)); // 重连成功
    expect(conn.ready).toBe(true);
    await conn.close();
    await gw.close();
  });

  // 对端彻底静默（不回 pong）即使出站仍有积压也必须判死——防"拥塞豁免"过度矫正成永不判死
  it('心跳判死：对端静默且出站缓冲积压停滞 → 判死断开重连', async () => {
    const gw = new MockGateway();
    gw.answerPings = false;
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 网关暂停读取后垫 4MiB：内核缓冲吸满后出站积压，且永无 pong（静默）
    gw.sockets[0]?.pause();
    conn.sendData({ channelId: 999, kind: 'http.body' }, Buffer.alloc(4 * 1024 * 1024));
    await new Promise<void>((resolve) => conn.once('connected', resolve)); // 判死后重连成功
    expect(conn.ready).toBe(true);
    gw.sockets.forEach((ws) => ws.resume()); // 放行 close 握手，避免 5s 强制 terminate 等待
    await conn.close();
    await gw.close();
  });

  it('close()：主动关闭后不重连', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    await conn.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(gw.sockets.length).toBe(0);
    await gw.close();
  });

  it('竞态：connect 超时后迟到的 hello.ack 不得置 ready、不得 emit connected', async () => {
    const gw = new MockGateway();
    gw.ackDelayMs = 400; // ack 晚于 connectTimeoutMs(300) 到达
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    let connected = 0;
    conn.on('connected', () => { connected += 1; });
    await expect(conn.connect()).rejects.toThrow(/connect timeout/);
    await new Promise((r) => setTimeout(r, 300)); // 等迟到的 ack 送达（此刻连接已被超时分支关闭）
    expect(conn.ready).toBe(false);
    expect(connected).toBe(0);
    await conn.close();
    await gw.close();
  });

  it('竞态：close() 进行中迟到的 hello.ack 不得置 ready、不得 emit connected', async () => {
    const gw = new MockGateway();
    gw.ackDelayMs = 300;
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    let connected = 0;
    conn.on('connected', () => { connected += 1; });
    const pending = conn.connect();
    pending.catch(() => {}); // 预期被 close() reject，先挂 catch 防未处理告警
    // 等 hello 已送达网关（open 已完成），再挂起网关使 close 握手停滞，客户端停留在 CLOSING
    await vi.waitFor(() => { expect(gw.received.length).toBeGreaterThan(0); });
    gw.sockets[0]?.pause();
    const closing = conn.close();
    await new Promise((r) => setTimeout(r, 500)); // 迟到的 ack 在 CLOSING 期间送达
    expect(conn.ready).toBe(false);
    expect(connected).toBe(0);
    await closing;
    await expect(pending).rejects.toThrow(/closed by caller/);
    await gw.close();
    // 第三参 10s：网关挂起后 close() 走 CLOSE_FORCE_MS(5s) 强制 terminate，超出 vitest 默认 5s 测试超时
  }, 10_000);

  it('onDisconnected：connect 从未成功（端口不可达）时断开不得回调', async () => {
    const { handlers, calls } = makeHandlers();
    const conn = new Connection({ gatewayUrl: 'ws://127.0.0.1:1/__gateway__/tunnel', ...OPTS }, handlers);
    conn.on('error', () => {});
    await expect(conn.connect()).rejects.toThrow(/connect timeout/);
    expect(calls.disconnected).toBe(0); // 未建立过会话，不存在在途通道，不得回调
    await conn.close();
  });

  it('通道控制帧回调同步抛异常：记 ERROR 且隧道保持存活（不升级为 1002 协议错误）', async () => {
    const gw = new MockGateway();
    const errors: string[] = [];
    const logger = { ...nullLogger, error: (m: string) => { errors.push(m); } };
    const { calls } = makeHandlers();
    // onControl 遇 channel.close 同步抛错（模拟通道层 bug）
    const handlers = {
      onControl: (f: ControlFrame) => { if (f.type === 'channel.close') throw new Error('boom'); calls.control.push(f); },
      onData: () => {},
      onDisconnected: () => { calls.disconnected += 1; },
    };
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS, logger }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 捕获网关侧 close 码：CLOSING 窗口内 ready/sockets 尚未更新会造成时序假绿，必须以真实 close 事件为准
    let closeCode: number | null = null;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    gw.sockets[0]?.send(encodeControl({ type: 'channel.close', channelId: 1 }));
    await new Promise((r) => setTimeout(r, 300)); // 窗口远超回环 close 握手耗时（修复前 1002 握手几毫秒内完成）
    expect(errors.length).toBeGreaterThan(0); // 通道级 ERROR 日志
    expect(closeCode).toBeNull(); // 隧道未收到任何关闭
    expect(calls.disconnected).toBe(0);
    // 后续帧仍正常路由（隧道功能完好）
    gw.sockets[0]?.send(encodeControl({ type: 'channel.error', channelId: 1, message: 'x' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.control.some((f) => f.type === 'channel.error')).toBe(true);
    await conn.close();
    await gw.close();
  });

  it('通道数据帧回调同步抛异常：记 ERROR 且隧道保持存活', async () => {
    const gw = new MockGateway();
    const errors: string[] = [];
    const logger = { ...nullLogger, error: (m: string) => { errors.push(m); } };
    const { calls } = makeHandlers();
    const handlers = {
      onControl: (f: ControlFrame) => calls.control.push(f),
      onData: (h: DataHeader) => { calls.data.push(h); throw new Error('boom'); },
      onDisconnected: () => { calls.disconnected += 1; },
    };
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS, logger }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    let closeCode: number | null = null;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    gw.sockets[0]?.send(encodeData({ channelId: 1, kind: 'ws.message' }, Buffer.from('x')));
    await new Promise((r) => setTimeout(r, 300));
    expect(errors.length).toBeGreaterThan(0);
    expect(calls.data).toHaveLength(1); // 帧已送达回调
    expect(closeCode).toBeNull(); // 隧道未收到任何关闭
    expect(calls.disconnected).toBe(0);
    await conn.close();
    await gw.close();
  });

  it('坏控制帧降级为丢帧：WARN、隧道存活、后续帧正常路由、日志不回显帧原文（token 红线）', async () => {
    const gw = new MockGateway();
    const warns: string[] = [];
    const errors: string[] = [];
    const capture = (m: string, c?: Record<string, unknown>) => m + ' ' + JSON.stringify(c);
    const logger = {
      ...nullLogger,
      warn: (m: string, c?: Record<string, unknown>) => { warns.push(capture(m, c)); },
      error: (m: string, c?: Record<string, unknown>) => { errors.push(capture(m, c)); },
    };
    const { handlers, calls } = makeHandlers();
    // 心跳拉长到 10s：测试窗口内无 ping/pong 干扰坏帧计数断言
    const conn = new Connection(
      { gatewayUrl: gw.url, ...OPTS, heartbeatIntervalMs: 10_000, logger }, handlers,
    );
    conn.on('error', () => {});
    await conn.connect();
    let closeCode: number | null = null;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    // 模拟含 token 的坏帧（JSON 非法）：http.open 帧可携带 authorization 头
    gw.sockets[0]?.send('{"type":"http.open","headers":{"authorization":"Bearer secret-token-xyz"}},broken');
    await new Promise((r) => setTimeout(r, 300)); // 窗口远超回环 close 握手耗时
    expect(closeCode).toBeNull(); // 隧道未收到任何关闭
    expect(calls.disconnected).toBe(0);
    expect(warns.length).toBeGreaterThan(0); // 单帧降级为 WARN
    expect(errors).toHaveLength(0); // 单帧不升级 ERROR
    // 日志（含上下文）不得回显帧原文（token 红线，ProtocolError 契约保证）
    expect(warns.join('\n') + errors.join('\n')).not.toContain('secret-token-xyz');
    // 后续帧仍正常路由（隧道功能完好）
    gw.sockets[0]?.send(encodeControl({ type: 'channel.error', channelId: 1, message: 'x' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.control.some((f) => f.type === 'channel.error')).toBe(true);
    await conn.close();
    await gw.close();
  });

  it('坏二进制数据帧同样降级为丢帧，隧道存活且后续数据帧正常路由', async () => {
    const gw = new MockGateway();
    const { handlers, calls } = makeHandlers();
    const conn = new Connection(
      { gatewayUrl: gw.url, ...OPTS, heartbeatIntervalMs: 10_000 }, handlers,
    );
    conn.on('error', () => {});
    await conn.connect();
    let closeCode: number | null = null;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    // 头长越界的坏数据帧（声明 1024 字节头，实际无负载）
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(1024, 0);
    gw.sockets[0]?.send(bad);
    await new Promise((r) => setTimeout(r, 300));
    expect(closeCode).toBeNull();
    expect(calls.disconnected).toBe(0);
    // 后续数据帧正常路由
    gw.sockets[0]?.send(encodeData({ channelId: 7, kind: 'ws.message' }, Buffer.from('ok')));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.data.some((h) => h.channelId === 7)).toBe(true);
    await conn.close();
    await gw.close();
  });

  it('连续坏帧达预算（5）升级为隧道级协议错误：前 4 帧 WARN，第 5 帧 ERROR + 1002 断开，升级后后续坏帧静默', async () => {
    const gw = new MockGateway();
    const warns: string[] = [];
    const errors: string[] = [];
    const logger = {
      ...nullLogger,
      warn: (m: string) => { warns.push(m); },
      error: (m: string) => { errors.push(m); },
    };
    const { handlers } = makeHandlers();
    const conn = new Connection(
      { gatewayUrl: gw.url, ...OPTS, heartbeatIntervalMs: 10_000, logger }, handlers,
    );
    conn.on('error', () => {});
    await conn.connect();
    let closeCode = 0;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    const disconnected = new Promise<void>((resolve) => conn.once('disconnected', resolve));
    // 7 帧：第 5 帧升级后，close 握手窗口内到达的第 6/7 帧不得再放大 ERROR 日志
    for (let i = 0; i < 7; i++) gw.sockets[0]?.send(`bad-frame-${i}`);
    await disconnected;
    // 客户端先感知 close，网关侧 close 事件略晚到达，用 waitFor 消除时序窗口
    await vi.waitFor(() => { expect(closeCode).toBe(1002); });
    expect(warns.filter((m) => m.includes('坏帧'))).toHaveLength(4); // 预算内逐帧 WARN（断连诊断 WARN 不算）
    expect(errors).toHaveLength(1); // 仅升级瞬间一条 ERROR（latch 防日志洪泛）
    await conn.close();
    await gw.close();
  });

  it('成功解码的帧重置连续坏帧计数：间歇坏帧（4 坏 + 1 好 + 4 坏）不升级', async () => {
    const gw = new MockGateway();
    const { handlers, calls } = makeHandlers();
    const conn = new Connection(
      { gatewayUrl: gw.url, ...OPTS, heartbeatIntervalMs: 10_000 }, handlers,
    );
    conn.on('error', () => {});
    await conn.connect();
    let closeCode: number | null = null;
    gw.sockets[0]?.on('close', (code) => { closeCode = code; });
    const sock = gw.sockets[0];
    // 若无重置，两批累计 8 帧早已超预算（5）；中间的好帧必须清零计数
    for (let i = 0; i < 4; i++) sock?.send(`bad-${i}`);
    sock?.send(encodeControl({ type: 'channel.error', channelId: 1, message: 'x' }));
    for (let i = 0; i < 4; i++) sock?.send(`bad2-${i}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(closeCode).toBeNull();
    expect(calls.disconnected).toBe(0);
    expect(calls.control.some((f) => f.type === 'channel.error')).toBe(true); // 好帧已路由
    await conn.close();
    await gw.close();
  });
});

// 端到端流量窗口（tunnel.ack）：在途量超窗暂停生产、ack 推进恢复、老服务端无 ack 回退本地水位
describe('tunnel.ack 端到端流量窗口', () => {
  /** 造 3MiB 数据帧把在途量顶过 2MiB 高窗口（单帧 < 100MiB 上限） */
  const bigPayload = (): Buffer => Buffer.alloc(3 * 1024 * 1024);

  it('收到 tunnel.ack 前（老服务端）：sendData 不受流量窗口限制，ack 帧不上抛通道层', async () => {
    const gw = new MockGateway();
    const { handlers, calls } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 老服务端不回 ack：3MiB 在途也不触发流量窗口（仅本地水位生效，localhost 下不触发）
    expect(conn.sendData({ channelId: 1, kind: 'http.body' }, bigPayload())).toBe(true);
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 0 })); // ack 帧由连接层消化
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.control).toHaveLength(0); // tunnel.ack 不上抛
    await conn.close();
    await gw.close();
  });

  it('激活后在途量超窗口 → sendData 返回 false；ack 推进到滞回线内 → waitDrain 唤醒', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 激活流量窗口（等价服务端已回执 0 字节起步）；无速率样本时按最小窗口 256KiB
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    // 在途 3MiB > 256KiB 最小窗口 → 背压
    expect(conn.sendData({ channelId: 1, kind: 'http.body' }, bigPayload())).toBe(false);
    // ack 未推进：waitDrain 不得唤醒（轮询确认在途量仍在滞回线之上）
    let drained = false;
    void conn.waitDrain().then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(drained).toBe(false);
    // ack 推进到在途量归零（≤ 窗口 1/4 滞回线）→ 唤醒恢复生产
    const frameLen = 3 * 1024 * 1024 + 4 + JSON.stringify({ channelId: 1, kind: 'http.body' }).length;
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: frameLen }));
    await vi.waitFor(() => { expect(drained).toBe(true); });
    await conn.close();
    await gw.close();
  });

  it('窗口随 ack 实测速率自适应放宽：快链路下在途量超限最小窗口也不背压', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 两次推进 1MiB、间隔 ~100ms → 实测速率 ≈10MiB/s → 窗口放宽到 4MiB 上限
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 0 }));
    await new Promise((r) => setTimeout(r, 100));
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 1024 * 1024 }));
    await new Promise((r) => setTimeout(r, 50));
    // 在途 3MiB：超最小窗口 256KiB 但低于自适应窗口 4MiB → 不背压
    expect(conn.sendData({ channelId: 1, kind: 'http.body' }, bigPayload())).toBe(true);
    await conn.close();
    await gw.close();
  });

  it('ack 字节数单调取大：乱序/回退的 ack 不得抬高水位口径', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 10 * 1024 * 1024 }));
    await new Promise((r) => setTimeout(r, 50));
    gw.sockets[0]?.send(encodeControl({ type: 'tunnel.ack', bytes: 1024 })); // 回退值：必须忽略
    await new Promise((r) => setTimeout(r, 50));
    // ack 口径仍是 10MiB：3MiB 在途 - 10MiB ack < 0 → 不超窗
    expect(conn.sendData({ channelId: 1, kind: 'http.body' }, bigPayload())).toBe(true);
    await conn.close();
    await gw.close();
  });
});
