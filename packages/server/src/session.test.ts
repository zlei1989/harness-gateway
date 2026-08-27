/**
 * TunnelSession 与 TunnelRegistry 单元测试。
 * 注意：FakeWs 仅实现本层消费的 ws 子集（send/close/terminate/bufferedAmount + 事件），
 * 通过 asWs() 断言为 WebSocket 注入；nullLogger 屏蔽日志副作用。
 */

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { type PendingChannel, TunnelRegistry, TunnelSession } from './session';

import type { ControlFrame, DataHeader } from './protocol';
import type WebSocket from 'ws';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 记录 ERROR 日志的 logger：用于断言通道回调异常被消化（含堆栈） */
function makeLogger() {
  const errors: { message: string; context?: Record<string, unknown> }[] = [];
  const logger: import('./logger').Logger = {
    debug() {},
    info() {},
    warn() {},
    error: (message, context) => errors.push({ message, context }),
  };
  return { logger, errors };
}

/** 假 ws：记录发送内容，可触发事件 */
class FakeWs extends EventEmitter {
  sent: (string | Buffer)[] = [];
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  terminate(): void { this.closed = { code: 1006 }; }
  asWs(): WebSocket { return this as unknown as WebSocket; }
}

function makeChannel(kind: 'http' | 'ws' = 'http') {
  const calls = { control: [] as ControlFrame[], data: [] as DataHeader[], down: 0 };
  const channel: PendingChannel = {
    kind,
    onControl: (f) => calls.control.push(f),
    onData: (h) => calls.data.push(h),
    onTunnelDown: () => { calls.down += 1; },
  };
  return { channel, calls };
}

function makeSession(logger: import('./logger').Logger = nullLogger) {
  const ws = new FakeWs();
  const down: TunnelSession[] = [];
  const session = new TunnelSession(ws.asWs(), { tunnelId: 'tid-1', hostname: 'pc-a', defaultPath: '/home' }, logger, (s) => down.push(s));
  return { ws, session, down };
}

describe('TunnelSession', () => {
  it('register 递增分配 channelId，unregister 注销', () => {
    const { session } = makeSession();
    const a = makeChannel();
    expect(session.register(a.channel)).toBe(1);
    expect(session.register(makeChannel().channel)).toBe(2);
    session.unregister(1);
    session.handleControl({ type: 'http.head', channelId: 1, status: 200, headers: {} });
    expect(a.calls.control).toHaveLength(0); // 已注销不再路由
  });

  it('handleControl/handleData 按 channelId 路由', () => {
    const { session } = makeSession();
    const a = makeChannel();
    const id = session.register(a.channel);
    session.handleControl({ type: 'http.head', channelId: id, status: 200, headers: {} });
    session.handleData({ channelId: id, kind: 'http.body' }, Buffer.from('x'));
    expect(a.calls.control[0]).toMatchObject({ type: 'http.head', status: 200 });
    expect(a.calls.data[0]?.kind).toBe('http.body');
  });

  it('ping 自动回 pong，不上抛通道', () => {
    const { session, ws } = makeSession();
    session.handleControl({ type: 'ping' });
    expect(String(ws.sent[0])).toBe(JSON.stringify({ type: 'pong' }));
  });

  it('tunnel.ack 流量回执：声明 flowControl 后按 128KiB 节拍回累计字节；未声明不回执', () => {
    // 未声明 flowControl（老客户端）：任何数据量都不回执（防未知帧坏帧预算误杀对端）
    const { session, ws } = makeSession();
    session.noteDataReceived(200 * 1024);
    expect(ws.sent).toHaveLength(0);
    // 声明后：按 ACK_EVERY_BYTES(128KiB) 节拍回执累计字节数（含帧头口径，由 tunnel.ts 记账）
    const ws2 = new FakeWs();
    const s2 = new TunnelSession(
      ws2.asWs(), { tunnelId: 't-2', hostname: 'pc-b', defaultPath: '/', flowAck: true }, nullLogger, () => {},
    );
    s2.noteDataReceived(100 * 1024); // 不足 128KiB：不回
    expect(ws2.sent).toHaveLength(0);
    s2.noteDataReceived(50 * 1024); // 累计 150KiB ≥ 128KiB：回执累计值
    expect(ws2.sent).toHaveLength(1);
    expect(JSON.parse(String(ws2.sent[0]))).toEqual({ type: 'tunnel.ack', bytes: 150 * 1024 });
    s2.noteDataReceived(200 * 1024); // 距上次回执 200KiB ≥ 128KiB：再次回执
    expect(ws2.sent).toHaveLength(2);
    expect(JSON.parse(String(ws2.sent[1]))).toEqual({ type: 'tunnel.ack', bytes: 350 * 1024 });
  });

  it('tunnel.ack 兜底回执：不足 128KiB 的尾数在 1s 内补回（防客户端流量窗口滞回死锁）', async () => {
    const ws = new FakeWs();
    const s = new TunnelSession(
      ws.asWs(), { tunnelId: 't-3', hostname: 'pc-c', defaultPath: '/', flowAck: true }, nullLogger, () => {},
    );
    s.noteDataReceived(64 * 1024); // 不足节拍：不立即回执
    expect(ws.sent).toHaveLength(0);
    await vi.waitFor(() => { expect(ws.sent).toHaveLength(1); }, { timeout: 3000 }); // 兜底定时器补回
    expect(JSON.parse(String(ws.sent[0]))).toEqual({ type: 'tunnel.ack', bytes: 64 * 1024 });
    s.teardown();
  });

  it('teardown：全部通道 onTunnelDown + 触发 onDown 回调', () => {
    const { session, down } = makeSession();
    const a = makeChannel();
    const b = makeChannel('ws');
    session.register(a.channel);
    session.register(b.channel);
    session.teardown();
    expect(a.calls.down).toBe(1);
    expect(b.calls.down).toBe(1);
    expect(down).toHaveLength(1);
  });

  it('close() 主动关闭底层 ws', () => {
    const { session, ws } = makeSession();
    session.close();
    expect(ws.closed).toEqual({ code: 1000, reason: 'server shutdown' });
  });

  // ---- 背压（FakeWs.bufferedAmount 可写，真实驱动水位） ----

  it('sendData 超 HIGH 水位返回 false；降到 LOW 以下 waitDrain 唤醒、sendData 恢复 true', async () => {
    const { session, ws } = makeSession();
    const header: DataHeader = { channelId: 1, kind: 'http.body' };
    ws.bufferedAmount = 17 * 1024 * 1024; // > 16MB HIGH 水位
    expect(session.sendData(header, Buffer.from('x'))).toBe(false);
    let drained = false;
    const p = session.waitDrain().then(() => { drained = true; });
    // 等过至少一个轮询周期（100ms），水位仍高 → 悬挂
    await new Promise((r) => setTimeout(r, 150));
    expect(drained).toBe(false);
    ws.bufferedAmount = 0; // 降到 4MB LOW 水位以下
    await p; // 不唤醒则测试超时失败
    expect(drained).toBe(true);
    expect(session.sendData(header, Buffer.from('x'))).toBe(true);
  });

  it('teardown resolve 悬挂的 waitDrain（调用方醒来后走 onTunnelDown 已失败路径）', async () => {
    const { session, ws } = makeSession();
    ws.bufferedAmount = 17 * 1024 * 1024; // 高超水位，轮询永远等不到 drain
    expect(session.sendData({ channelId: 1, kind: 'http.body' }, Buffer.from('x'))).toBe(false);
    let drained = false;
    const p = session.waitDrain().then(() => { drained = true; });
    session.teardown();
    await p; // 修复前此处永久悬挂 → 测试超时失败
    expect(drained).toBe(true);
  });

  // ---- 通道回调异常隔离（ERROR 日志含堆栈，单通道异常不影响其余通道与 onDown） ----

  it('teardown 隔离 onTunnelDown 异常：其余通道仍收到通知且 onDown 执行', () => {
    const { logger, errors } = makeLogger();
    const { session, down } = makeSession(logger);
    const a = makeChannel();
    a.channel.onTunnelDown = () => { throw new Error('boom-a'); };
    const b = makeChannel('ws');
    session.register(a.channel);
    session.register(b.channel);
    session.teardown();
    expect(b.calls.down).toBe(1); // 异常通道之后的通道仍收到通知
    expect(down).toHaveLength(1); // onDown 不被阻断（registry 不泄漏死会话）
    expect(errors).toHaveLength(1);
    expect(String(errors[0]?.context?.stack)).toContain('boom-a');
  });

  it('handleControl/handleData 分发隔离通道异常：消化为 ERROR 日志，不上抛', () => {
    const { logger, errors } = makeLogger();
    const { session } = makeSession(logger);
    const a = makeChannel();
    a.channel.onControl = () => { throw new Error('boom-control'); };
    a.channel.onData = () => { throw new Error('boom-data'); };
    const id = session.register(a.channel);
    expect(() =>
      session.handleControl({ type: 'http.head', channelId: id, status: 200, headers: {} }),
    ).not.toThrow();
    expect(() =>
      session.handleData({ channelId: id, kind: 'http.body' }, Buffer.from('x')),
    ).not.toThrow();
    expect(errors).toHaveLength(2);
    expect(String(errors[0]?.context?.stack)).toContain('boom-control');
    expect(String(errors[1]?.context?.stack)).toContain('boom-data');
  });
});

describe('TunnelRegistry', () => {
  it('set/get/list/delete 以 tunnelId 为键（delete 校验 session 身份防重连竞态）', () => {
    const registry = new TunnelRegistry();
    const { session } = makeSession();
    expect(session.tunnelId).toBe('tid-1');
    registry.set('tid-1', session);
    expect(registry.get('tid-1')).toBe(session);
    expect(registry.list()).toEqual([{ tunnelId: 'tid-1', hostname: 'pc-a', defaultPath: '/home' }]);
    const other = makeSession().session;
    registry.delete('tid-1', other); // 身份不符，不删
    expect(registry.has('tid-1')).toBe(true);
    registry.delete('tid-1', session);
    expect(registry.has('tid-1')).toBe(false);
  });

  it('同名 hostname 的两条隧道并存（hostname 纯展示名，tunnelId 区分）', () => {
    const registry = new TunnelRegistry();
    const a = makeSession().session;
    const b = new TunnelSession(
      new FakeWs().asWs(), { tunnelId: 'tid-2', hostname: 'pc-a', defaultPath: '/' }, nullLogger, () => {},
    );
    registry.set('tid-1', a);
    registry.set('tid-2', b);
    expect(registry.list().map((s) => s.hostname)).toEqual(['pc-a', 'pc-a']);
    expect(registry.get('tid-2')).toBe(b);
  });
});
