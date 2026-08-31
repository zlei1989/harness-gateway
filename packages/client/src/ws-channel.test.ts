/**
 * WsChannel 测试 — 真实 upstream ws echo server + 假 Connection 验证桥接行为。
 * 覆盖：握手回选子协议透传、文本/二进制双向保真、鉴权拒绝不打 upstream、
 * upstream 拒绝握手 502、upstream 主动关闭码透传、握手前消息排队 flush。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { WsChannel } from './ws-channel';

import type { AuthDecision } from './authorize';
import type { Connection } from './connection';
import type { ControlFrame, DataHeader, WsOpenFrame } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

class FakeConnection {
  controls: ControlFrame[] = [];
  data: { header: DataHeader; payload: Buffer }[] = [];
  /** 模拟隧道 'error'→'close' 竞态窗：ws 已非 OPEN，sendControl/sendData 抛 'tunnel not ready' */
  tunnelDown = false;
  sendControl(frame: ControlFrame): void {
    if (this.tunnelDown) throw new Error('tunnel not ready');
    this.controls.push(frame);
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (this.tunnelDown) throw new Error('tunnel not ready');
    this.data.push({ header, payload });
    return true;
  }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  asConnection(): Connection { return this as unknown as Connection; }
}

const ALLOW = async (): Promise<AuthDecision> => ({
  allowed: true, status: 200, headers: {}, body: Buffer.alloc(0),
});

function makeOpen(overrides: Partial<WsOpenFrame> = {}): WsOpenFrame {
  return { type: 'ws.open', channelId: 1, url: '/ws', headers: {}, protocols: ['chat'], ...overrides };
}

/** upstream ws echo server：可选选定子协议；记录连接数、握手请求头、对端关闭码/原因 */
function startUpstreamEcho(selectProtocol?: string): Promise<{
  wss: WebSocketServer; url: URL; conns: number;
  headers: Record<string, unknown>[]; closes: { code: number; reason: Buffer }[];
}> {
  const state = { conns: 0 };
  const headers: Record<string, unknown>[] = [];
  const closes: { code: number; reason: Buffer }[] = [];
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: selectProtocol
      ? (protocols) => (protocols.has(selectProtocol) ? selectProtocol : false)
      : undefined,
  });
  wss.on('connection', (ws, req) => {
    state.conns += 1;
    headers.push(req.headers);
    ws.on('close', (code, reason) => closes.push({ code, reason }));
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      // 注意：brief 原版 `resolve({ ..., conns: state.conns, ...state })` 重复指定 conns
      // 触发 TS2783 类型错误；此处去掉冗余前置字段，仅保留 ...state，语义等价
      if (typeof addr === 'object' && addr) resolve({ wss, url: new URL(`http://127.0.0.1:${addr.port}`), ...state, headers, closes });
    });
  });
}

let cleanup: WebSocketServer | null = null;
// 注意：brief 原版仅 `cleanup?.close(cb)`；ws@8.21 内置 http server 的 close() 不再主动终止
// 已连接客户端，有存活连接时回调永不触发导致 afterEach 挂起（参考 Task 4 同类基建修复）；
// 此处先 terminate 全部客户端再 close，语义不变（测试收尾清理）
afterEach(async () => {
  const wss = cleanup;
  cleanup = null;
  if (!wss) return;
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((r) => { wss.close(() => r()); });
});

describe('WsChannel', () => {
  it('握手成功：回 ws.accept 且回选子协议透传', async () => {
    const up = await startUpstreamEcho('chat');
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen(), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'ws.accept') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.controls.find((f) => f.type === 'ws.accept')).toMatchObject({ type: 'ws.accept', protocol: 'chat' });
  });

  it('文本与二进制消息双向保真（echo）', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => {},
    });
    await ch.start();
    await new Promise((r) => setTimeout(r, 50));
    ch.onMessage('text', Buffer.from('hi'));
    ch.onMessage('binary', Buffer.from([0x01, 0x02]));
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (conn.data.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const kinds = conn.data.map((d) => d.header.dataType);
    expect(kinds).toEqual(['text', 'binary']);
    expect(conn.data[0]?.payload.toString()).toBe('hi');
    expect(conn.data[1]?.payload).toEqual(Buffer.from([0x01, 0x02]));
  });

  it('握手 Origin 重写为 upstream origin（浏览器在 WS 握手同样带 Origin，同 403 事故面）', async () => {
    const up = await startUpstreamEcho('chat');
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1,
      open: makeOpen({ headers: { origin: 'http://pc-local:9000' } }),
      upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'ws.accept') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.controls.find((f) => f.type === 'ws.accept')).toBeDefined();
    expect(up.headers[0]?.['origin']).toBe(up.url.origin);
  });

  it('鉴权拒绝：ws.reject 携带自定义状态与文本 body，不打 upstream', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const deny = async (): Promise<AuthDecision> => ({ allowed: false, status: 403, headers: {}, body: Buffer.from('denied') });
    const ch = new WsChannel({
      id: 1, open: makeOpen(), upstream: up.url,
      connection: conn.asConnection(), authorize: deny, logger: nullLogger,
      onDone: () => {},
    });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'ws.reject', status: 403, body: 'denied' });
    // 注意：start() 恢复于微任务，而（退化实现下的）upstream 异步拨号注册进 wss.clients 需宏任务窗口；
    // 无此等待则 clients.size 恒为 0 造成时序空转（修复循环第 1 轮变异实验证明必须等待才真实变红）
    await new Promise((r) => setTimeout(r, 50));
    // 注意（R7 修复）：brief 原版断言 `up.conns` 是 listening 时刻的值快照（恒 0），空转；
    // 改为断言 wss.clients.size 实时连接数，能真实抓住"鉴权拒绝仍拨 upstream"的回归
    expect(up.wss.clients.size).toBe(0);
  });

  it('upstream 拒绝握手（子协议不匹配）→ ws.reject 502', async () => {
    const up = await startUpstreamEcho('only-this');
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen({ protocols: ['other'] }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 100ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'ws.reject') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.controls.find((f) => f.type === 'ws.reject')).toMatchObject({ status: 502 });
  });

  it('upstream 主动关闭：channel.close 携带 code/reason 回网关', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 upstream 客户端入列 wss.clients，close 动作才有效
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    for (const ws of up.wss.clients) ws.close(1001, 'going away');
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'channel.close') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.controls.find((f) => f.type === 'channel.close')).toMatchObject({ type: 'channel.close', code: 1001 });
  });

  it('握手完成前到达的 ws.message 排队，accept 后按序 flush', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => {},
    });
    void ch.start(); // 不等待：模拟消息先于 accept 到达
    ch.onMessage('text', Buffer.from('early'));
    // 条件轮询替代固定 sleep：负载下固定 80ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (conn.data.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.data[0]?.payload.toString()).toBe('early');
  });

  it('SSRF 防护：absolute-form 绝对 URL 脱离 upstream origin → ws.reject 403，不拨 upstream', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new WsChannel({
      // 绝对 URL（端口 1 与 upstream 不同 origin；修复前会真实拨号并快速 ECONNREFUSED → 502，可与 403 区分）
      id: 1, open: makeOpen({ url: 'ws://127.0.0.1:1/', protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => { done += 1; },
    });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'ws.reject', status: 403 });
    expect(done).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(up.wss.clients.size).toBe(0);
  });

  it('转发头剔除 sec-websocket-protocol：伪造头不得透传（与 protocols 构造参数冲突）', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    // protocols 为空时 ws 库自身不会生成该头，upstream 若看到即来自转发伪造头
    const ch = new WsChannel({
      id: 1, open: makeOpen({ headers: { 'sec-websocket-protocol': 'forged' }, protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'ws.accept') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(conn.controls.find((f) => f.type === 'ws.accept')).toBeDefined();
    expect(up.headers[0]?.['sec-websocket-protocol']).toBeUndefined();
  });

  it('onMessage 直发路径 upstream send 同步抛（CLOSING 窗口）：通道级消化，不外抛', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const errors: string[] = [];
    const logger = { debug() {}, info() {}, warn() {}, error(m: string) { errors.push(m); } };
    let done = 0;
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger, onDone: () => { done += 1; },
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 accept 完成（pending 已置 null，onMessage 走直发路径）
    const deadline = Date.now() + 5000;
    while (!conn.controls.some((f) => f.type === 'ws.accept') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // 模拟 CLOSING/CONNECTING 窗口：ws 在非 OPEN 态 send 会同步抛（真实 ws 代码路径）
    const upstreamWs = (ch as unknown as { upstream: { _readyState: number } }).upstream;
    upstreamWs._readyState = 0; // CONNECTING
    expect(() => ch.onMessage('text', Buffer.from('late'))).not.toThrow();
    expect(errors.length).toBeGreaterThan(0); // 通道级 ERROR 日志
    expect(done).toBe(1); // 通道中止
  });

  it('边界带 upstream 消息（过 maxPayload 但隧道帧超限）→ 通道级关闭：消息不入隧道，upstream 收 1009，channel.close 回网关', async () => {
    // 线上丢帧根因回归：100MiB-32 的消息过了客户端 upstream ws 的 maxPayload（100MiB），
    // 但隧道帧加 ≈60B 头后超 100MiB，服务端收帧即以 1009 杀整条隧道（全通道丢帧）；
    // 期望发送侧护栏把超限降级为通道级失败：本通道关闭，隧道无感
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => { done += 1; },
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 accept 完成（upstream 客户端已入列 wss.clients）
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const upstreamWs = [...up.wss.clients][0]!;
    upstreamWs.send(Buffer.alloc(100 * 1024 * 1024 - 32));
    // 大消息接收 + 关闭握手需要时间，轮询等通道收尾（防固定 sleep 抖动）
    const deadline = Date.now() + 20000;
    while (up.closes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // RED 判据：超尺寸消息不得进入隧道（修复前 FakeConnection 会收到它）
    expect(conn.data.length).toBe(0);
    expect(conn.controls.find((f) => f.type === 'channel.close'))
      .toMatchObject({ type: 'channel.close', channelId: 1, reason: 'message too large' });
    expect(done).toBe(1);
    expect(up.closes[0]?.code).toBe(1009);
    expect(up.closes[0]?.reason.toString()).toBe('message too large');
  }, 30000);

  it('onPeerClose 非法 close code（1005）：替换为 1000 透传，不抛 RangeError', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 upstream 已连上（close 动作才能透传到 up.closes）
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => ch.onPeerClose({ type: 'channel.close', channelId: 1, code: 1005, reason: 'x' })).not.toThrow();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (up.closes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(up.closes[0]?.code).toBe(1000); // 非法码被替换为默认 1000
  });

  it('onPeerClose 超长 reason（>123 字节）：截断后透传，不抛 RangeError', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {},
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 upstream 已连上（close 动作才能透传到 up.closes）
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(() => ch.onPeerClose({ type: 'channel.close', channelId: 1, code: 3000, reason: 'x'.repeat(200) })).not.toThrow();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (up.closes.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(up.closes[0]?.code).toBe(3000); // 合法码原样透传
    expect(up.closes[0]?.reason.length).toBeLessThanOrEqual(123); // reason 截断到 123 字节内
  });

  // 与 HttpChannel 同源的线上崩溃回归：隧道 'error'→'close' 竞态窗内 upstream 侧
  // 事件回调调 connection.sendData/sendControl 抛 'tunnel not ready'，穿透 ws 库
  // 'message'/'close' 监听器即 uncaughtException 崩进程。期望：通道级消化 + 中止。
  it('隧道断开竞态：upstream 消息送达时隧道已断 → sendData 失败不外抛，通道中止', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => { done += 1; },
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 等 upstream 客户端入列（accept 完成），再置隧道断——保证消息确实走上 echo 路径
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    conn.tunnelDown = true;
    ch.onMessage('text', Buffer.from('ping')); // 浏览器→upstream 方向仍通，触发 echo 回传
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (done === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(done).toBe(1);
  });

  it('隧道断开竞态：upstream 主动关闭时隧道已断 → channel.close 发送失败不外抛，通道中止', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    let done = 0;
    const ch = new WsChannel({
      id: 1, open: makeOpen({ protocols: [] }), upstream: up.url,
      connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger,
      onDone: () => { done += 1; },
    });
    await ch.start();
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）；
    // 必须等 upstream 客户端入列再 close——若未连上，clients 为空、无人触发 close，
    // done 永不翻转（close 驱动路径的唯一收敛源），负载下即 5s 超时假失败
    const upDeadline = Date.now() + 5000;
    while (up.wss.clients.size === 0 && Date.now() < upDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    conn.tunnelDown = true;
    for (const ws of up.wss.clients) ws.close(1001, 'going away');
    // 条件轮询替代固定 sleep：负载下固定 50ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (done === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(done).toBe(1);
  });
});
