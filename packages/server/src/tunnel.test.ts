/**
 * 隧道接入（tunnel.ts）测试 — hello 握手、tunnelId 分配与复用、同名并存、超时与断开清理。
 * 注意（测试基建）：
 * - ws@8.21.2 客户端 close 不自动 terminate，且 http.Server.close 会等悬挂连接，
 *   故统一在 afterEach 先 terminate 所有客户端再 close server，防止挂起；
 * - 时序断言（断开清理）需留出宏任务窗口（setTimeout）。
 */

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { type ControlFrame, encodeControl } from './protocol';
import { TunnelRegistry } from './session';
import { attachTunnelHandler } from './tunnel';

import type { Duplex } from 'node:stream';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let httpServer: Server | null = null;
let port = 0;
/** 本用例产生的全部客户端连接，afterEach 统一 terminate 防挂起 */
const clients: WebSocket[] = [];
/** 服务端侧 socket 台账：upgrade 交还路径的悬挂 socket 不被 server.close 回收，需手动销毁 */
const serverSockets = new Set<Duplex>();

afterEach(async () => {
  // 先销毁全部客户端 socket：ws close 不保证 terminate，挂着会让 server.close 回调不来
  for (const ws of clients.splice(0)) ws.terminate();
  // 再销毁服务端侧残留 socket（如非隧道路径 upgrade 交还后的悬挂连接）
  for (const s of serverSockets) s.destroy();
  await new Promise<void>((r) => (httpServer ? httpServer.close(() => r()) : r()));
  httpServer = null;
});

async function setup(helloTimeoutMs = 200, logger: import('./logger').Logger = nullLogger): Promise<TunnelRegistry> {
  const tunnels = new TunnelRegistry();
  httpServer = createServer();
  httpServer.on('connection', (s) => {
    serverSockets.add(s);
    s.on('close', () => serverSockets.delete(s));
  });
  attachTunnelHandler(httpServer, { tunnels, tunnelPath: '/__gateway__/tunnel', helloTimeoutMs, logger });
  await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', r));
  const addr = httpServer.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  port = addr.port;
  return tunnels;
}

function connectWs(path = '/__gateway__/tunnel'): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  clients.push(ws);
  return ws;
}

function sendHello(ws: WebSocket, hostname: string, defaultPath = '/', tunnelId?: string): void {
  const client = tunnelId === undefined
    ? { hostname, defaultPath }
    : { hostname, defaultPath, tunnelId };
  ws.send(encodeControl({ type: 'hello', client }));
}

/** 发 hello 并等 ack，返回服务端决定的 tunnelId */
async function helloAck(ws: WebSocket, hostname: string, defaultPath = '/', tunnelId?: string): Promise<string> {
  sendHello(ws, hostname, defaultPath, tunnelId);
  const ack = await new Promise<ControlFrame>((r) => ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
  if (ack.type !== 'hello.ack') throw new Error(`expected hello.ack, got ${ack.type}`);
  return ack.tunnelId;
}

describe('隧道接入', () => {
  it('hello → ack 携带服务端分配的 tunnelId（uuid），登记在线列表', async () => {
    const tunnels = await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const tunnelId = await helloAck(ws, 'pc-a', '/dash');
    expect(tunnelId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(tunnels.list()).toEqual([{ tunnelId, hostname: 'pc-a', defaultPath: '/dash' }]);
    ws.close();
  });

  it('同名并存：两条同名隧道各分不同 tunnelId 同时在线（不再有 4409 仲裁）', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    const id1 = await helloAck(ws1, 'pc-a');

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    const id2 = await helloAck(ws2, 'pc-a');

    expect(id1).not.toBe(id2);
    expect(tunnels.list().map((s) => s.hostname)).toEqual(['pc-a', 'pc-a']);
    ws1.close();
    ws2.close();
  });

  it('重连回带空闲 tunnelId → 复用同一 id（浏览器老会话随之恢复）', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    const id1 = await helloAck(ws1, 'pc-a');
    ws1.terminate();
    // 宏任务窗口：等服务端 close 事件完成注销
    await new Promise((r) => setTimeout(r, 50));
    expect(tunnels.has(id1)).toBe(false);

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    const id2 = await helloAck(ws2, 'pc-a', '/', id1);
    expect(id2).toBe(id1);
    expect(tunnels.has(id1)).toBe(true);
    ws2.close();
  });

  it('回带的 tunnelId 被在线隧道占用 → 分配新 id（不互踢，先连者不受影响）', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    const id1 = await helloAck(ws1, 'pc-a');

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    const id2 = await helloAck(ws2, 'pc-b', '/', id1);
    expect(id2).not.toBe(id1); // 占用即新分配
    expect(tunnels.get(id1)).toBeDefined(); // 先连者仍在
    expect(tunnels.list()).toHaveLength(2);
    ws1.close();
    ws2.close();
  });

  it('回带非法形态的 tunnelId → 忽略并分配新 uuid', async () => {
    await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const id = await helloAck(ws, 'pc-a', '/', 'not-a-uuid');
    expect(id).not.toBe('not-a-uuid');
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    ws.close();
  });

  it('hello 超时：连接被关闭且不入册', async () => {
    const tunnels = await setup(100);
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4408);
    expect(tunnels.list()).toHaveLength(0);
  });

  it('隧道断开：tunnelId 注销；回带重连可恢复', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    const id = await helloAck(ws1, 'pc-a');
    ws1.terminate();
    // 宏任务窗口：等服务端 close 事件完成注销
    await new Promise((r) => setTimeout(r, 50));
    expect(tunnels.has(id)).toBe(false);

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    await helloAck(ws2, 'pc-a', '/', id);
    expect(tunnels.has(id)).toBe(true);
    ws2.close();
  });

  it('非隧道路径的 upgrade 不被本网关处理（交还其他监听者）', async () => {
    await setup();
    const ws = connectWs('/other');
    const code = await new Promise<number | 'error'>((resolve) => {
      ws.on('error', () => resolve('error')); // 无处理器时 socket 挂起或被销毁
      ws.on('close', (c) => resolve(c));
      setTimeout(() => resolve(408), 300); // 挂起也算"未处理"
    });
    // 关键断言：隧道处理器没有接管它（若被误接管，客户端会收到 4408 hello 超时关闭码）
    expect(code).not.toBe(4408);
  });

  it('已就绪后坏帧降级为丢帧：隧道存活、tunnelId 在册、后续帧正常路由', async () => {
    const tunnels = await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const id = await helloAck(ws, 'pc-a');
    // 文本坏帧 + 二进制坏帧（头长越界）各一
    ws.send('garbage-not-json');
    const badBin = Buffer.alloc(4);
    badBin.writeUInt32BE(4096, 0);
    ws.send(badBin);
    // 窗口远超回环 close 握手耗时：若被降级前实现关闭，close 事件早已到达
    const closed = await Promise.race([
      new Promise<number>((r) => ws.on('close', (c) => r(c))),
      new Promise<null>((r) => setTimeout(() => r(null), 300)),
    ]);
    expect(closed).toBeNull();
    expect(tunnels.has(id)).toBe(true);
    // 后续控制帧正常路由：ping → pong
    ws.send(encodeControl({ type: 'ping' }));
    const pong = await new Promise<ControlFrame>((r) =>
      ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
    expect(pong).toEqual({ type: 'pong' });
    ws.close();
  });

  it('连续坏帧达预算（5）升级为 1002 断开并注销 tunnelId：前 4 帧仅 WARN，升级后后续坏帧静默', async () => {
    const warns: string[] = [];
    const errors: string[] = [];
    const logger = {
      ...nullLogger,
      warn: (m: string) => { warns.push(m); },
      error: (m: string) => { errors.push(m); },
    };
    const tunnels = await setup(200, logger);
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const id = await helloAck(ws, 'pc-a');
    // 7 帧：第 5 帧升级后，close 握手窗口内到达的第 6/7 帧不得再放大 ERROR 日志
    for (let i = 0; i < 7; i++) ws.send(`bad-${i}`);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(1002);
    await new Promise((r) => setTimeout(r, 50)); // 等 close 事件完成注销
    expect(tunnels.has(id)).toBe(false);
    expect(warns.filter((m) => m.includes('坏帧'))).toHaveLength(4); // 预算内逐帧 WARN
    expect(errors).toHaveLength(1); // 仅升级瞬间一条 ERROR（latch 防日志洪泛）
  });

  it('成功解码的帧重置连续坏帧计数：间歇坏帧（4 坏 + 1 好 + 4 坏）不升级', async () => {
    const tunnels = await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const id = await helloAck(ws, 'pc-a');
    // 若无重置，两批累计 8 帧早已超预算（5）；中间的好帧必须清零计数
    for (let i = 0; i < 4; i++) ws.send(`bad-${i}`);
    ws.send(encodeControl({ type: 'ping' }));
    for (let i = 0; i < 4; i++) ws.send(`bad2-${i}`);
    const pong = await new Promise<ControlFrame>((r) =>
      ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
    expect(pong).toEqual({ type: 'pong' }); // 好帧已路由（重置发生在其解码成功时）
    const closed = await Promise.race([
      new Promise<number>((r) => ws.on('close', (c) => r(c))),
      new Promise<null>((r) => setTimeout(() => r(null), 300)),
    ]);
    expect(closed).toBeNull();
    expect(tunnels.has(id)).toBe(true);
    ws.close();
  });

  it('路由层异常（非 ProtocolError）消化不关隧道：记 ERROR 后隧道功能完好', async () => {
    const errors: string[] = [];
    const logger = { ...nullLogger, error: (m: string) => { errors.push(m); } };
    const tunnels = await setup(200, logger);
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const id = await helloAck(ws, 'pc-a');
    // 诱导路由层抛普通 Error（如 pong 回写竞态的同类）：实例级替换 handleControl
    const session = tunnels.get(id);
    if (!session) throw new Error('session missing');
    const original = session.handleControl;
    Object.assign(session, {
      handleControl: () => { throw new Error('boom'); },
    });
    ws.send(encodeControl({ type: 'ping' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.some((m) => m.includes('路由异常'))).toBe(true);
    // 隧道未被关闭：恢复正常路由后 ping → pong 证明功能完好
    Object.assign(session, { handleControl: original });
    ws.send(encodeControl({ type: 'ping' }));
    const pong = await new Promise<ControlFrame>((r) =>
      ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
    expect(pong).toEqual({ type: 'pong' });
    expect(tunnels.has(id)).toBe(true);
    ws.close();
  });
});
