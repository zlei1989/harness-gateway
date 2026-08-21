/**
 * 隧道接入（tunnel.ts）测试 — hello 握手、hostname 仲裁、超时与断开清理。
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

async function setup(helloTimeoutMs = 200): Promise<TunnelRegistry> {
  const tunnels = new TunnelRegistry();
  httpServer = createServer();
  httpServer.on('connection', (s) => {
    serverSockets.add(s);
    s.on('close', () => serverSockets.delete(s));
  });
  attachTunnelHandler(httpServer, { tunnels, tunnelPath: '/__gateway__/tunnel', helloTimeoutMs, logger: nullLogger });
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

function sendHello(ws: WebSocket, hostname: string, defaultPath = '/'): void {
  ws.send(encodeControl({ type: 'hello', client: { hostname, defaultPath } }));
}

describe('隧道接入', () => {
  it('hello → ack，hostname 登记在线列表', async () => {
    const tunnels = await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    sendHello(ws, 'pc-a', '/dash');
    const ack = await new Promise<ControlFrame>((r) => ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
    expect(ack).toEqual({ type: 'hello.ack' });
    expect(tunnels.list()).toEqual([{ hostname: 'pc-a', defaultPath: '/dash' }]);
    ws.close();
  });

  it('hostname 冲突：后连者被 4409 关闭，先连者不受影响', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    sendHello(ws1, 'pc-a');
    await new Promise((r) => ws1.once('message', r));

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    sendHello(ws2, 'pc-a');
    const close = await new Promise<number>((r) => ws2.on('close', (code) => r(code)));
    expect(close).toBe(4409);
    expect(tunnels.get('pc-a')).toBeDefined(); // 先连者仍在
    ws1.close();
  });

  it('hello 超时：连接被关闭且不入册', async () => {
    const tunnels = await setup(100);
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4408);
    expect(tunnels.list()).toHaveLength(0);
  });

  it('隧道断开：hostname 注销；同名重连可恢复', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    sendHello(ws1, 'pc-a');
    await new Promise((r) => ws1.once('message', r));
    ws1.terminate();
    // 宏任务窗口：等服务端 close 事件完成注销
    await new Promise((r) => setTimeout(r, 50));
    expect(tunnels.has('pc-a')).toBe(false);

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    sendHello(ws2, 'pc-a');
    await new Promise((r) => ws2.once('message', r));
    expect(tunnels.has('pc-a')).toBe(true);
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
});
