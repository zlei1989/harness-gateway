/**
 * GatewayServer 主类测试 — 真实端口（port: 0）验证流量分发与生命周期。
 * 注意：用例按保留命名空间 / 非法配置 / upgrade 分发 / close 后拒绝连接分组；
 * 选择页断言依赖 select-page 内置 HTML 标题文案（'选择要连接的电脑'）。
 */

import { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { GatewayServer } from './server';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let server: GatewayServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe('GatewayServer 流量分发', () => {
  it('保留命名空间：隧道 GET 404、未知 /__gateway__/ 路径 404、选择页 200、其余无 cookie 302', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const tunnelGet = await fetch(`${base}/__gateway__/tunnel`, { redirect: 'manual' });
    expect(tunnelGet.status).toBe(404);

    const unknownReserved = await fetch(`${base}/__gateway__/anything`, { redirect: 'manual' });
    expect(unknownReserved.status).toBe(404);

    const select = await fetch(`${base}/__gateway__/select`);
    expect(select.status).toBe(200);
    expect(await select.text()).toContain('选择要连接的电脑');

    const proxied = await fetch(`${base}/api/chat`, { redirect: 'manual' });
    expect(proxied.status).toBe(302);
    expect(proxied.headers.get('location')).toBe('/__gateway__/select');
  });

  it('配置非法：端口缺省/非法值 → 构造抛错', () => {
    expect(() => new GatewayServer({ port: Number.NaN, logger: nullLogger })).toThrow(/port/);
  });

  it('配置非法：tunnelPath/selectPath 不在 /__gateway__/ 前缀内 → 构造抛错', () => {
    // 前缀外路径无法被保留命名空间分发命中（302 会自指循环），构造即拒绝
    expect(() => new GatewayServer({ port: 0, selectPath: '/select', logger: nullLogger })).toThrow(/selectPath/);
    expect(() => new GatewayServer({ port: 0, tunnelPath: '/tunnel', logger: nullLogger })).toThrow(/tunnelPath/);
  });

  it('配置非法：keepAliveTimeoutMs 非正整数 → 构造抛错', () => {
    const bad = (v: number) => () =>
      new GatewayServer({ port: 0, keepAliveTimeoutMs: v, logger: nullLogger });
    expect(bad(0)).toThrow(/keepAliveTimeoutMs/);
    expect(bad(-1)).toThrow(/keepAliveTimeoutMs/);
    expect(bad(1.5)).toThrow(/keepAliveTimeoutMs/);
  });

  it('browserSessionTtlMs 非法（0/负数/非整数）构造抛错', () => {
    for (const v of [0, -1, 1.5]) {
      expect(() => new GatewayServer({ port: 0, browserSessionTtlMs: v, logger: nullLogger }))
        .toThrow('GatewayServerOptions.browserSessionTtlMs 必须是正整数毫秒值');
    }
  });

  it('tunnelRestoreGraceMs 非法（负数/非整数）构造抛错；0 合法（= 即时 502 旧行为）', () => {
    for (const v of [-1, 1.5, Number.NaN]) {
      expect(() => new GatewayServer({ port: 0, tunnelRestoreGraceMs: v, logger: nullLogger }))
        .toThrow('GatewayServerOptions.tunnelRestoreGraceMs 必须是非负整数毫秒值');
    }
    expect(() => new GatewayServer({ port: 0, tunnelRestoreGraceMs: 0, logger: nullLogger })).not.toThrow();
  });

  it('keepAliveTimeoutMs 透传 http.Server：headersTimeout 自动抬到其上（Node 要求 headers > keepAlive）', async () => {
    server = new GatewayServer({ port: 0, keepAliveTimeoutMs: 65_000, logger: nullLogger });
    await server.listen();
    const httpServer = (server as unknown as { httpServer: import('node:http').Server }).httpServer;
    expect(httpServer.keepAliveTimeout).toBe(65_000);
    expect(httpServer.headersTimeout).toBeGreaterThan(65_000);
  });

  it('close() 后再请求连接被拒', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/__gateway__/select`)).rejects.toThrow();
    server = null; // 已关闭，afterEach 跳过
  });
});

describe('GatewayServer upgrade 分发', () => {
  /** 发起一次 WS upgrade 并收集握手失败错误（ws 客户端在拒绝/重置时触发 error） */
  function wsUpgradeError(url: string): Promise<Error> {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      ws.on('error', (err) => resolve(err));
    });
  }

  it('保留命名空间（非 tunnelPath）的 WS upgrade → socket destroy，不走浏览器代理 401', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    const err = await wsUpgradeError(`ws://127.0.0.1:${port}/__gateway__/other`);
    // socket.destroy 无 HTTP 响应（连接重置/挂起）；若误分发到 handleBrowserWs 则会收到 401 状态行
    expect(err.message).not.toContain('401');
  });

  it('无 cookie 的浏览器 WS upgrade（普通路径）→ 401（ws-proxy 前置鉴权）', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    const err = await wsUpgradeError(`ws://127.0.0.1:${port}/api/realtime`);
    // ws-proxy 在原始 socket 上手写 401 响应，ws 客户端报 Unexpected server response: 401
    expect(err.message).toContain('401');
  });
});

describe('GatewayServer 畸形请求目标防护', () => {
  /**
   * 发送原始 HTTP 报文（可构造 llhttp 放行但 new URL 拒绝的畸形 request-target），
   * 收集原始响应至连接关闭。Connection: close 让服务端响应后主动关连接。
   */
  function rawRequest(port: number, raw: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.connect(port, '127.0.0.1', () => socket.write(raw));
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
  }

  it('畸形 req.url 的 HTTP 请求 → 400 且服务存活（不得 uncaughtException 崩进程）', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    // llhttp 放行绝对形式但不配对括号的 target；new URL('http://[::1') 抛 TypeError
    const raw = await rawRequest(port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    expect(raw).toContain('HTTP/1.1 400');
    // 进程存活判据：后续正常请求仍被服务
    const ok = await fetch(`http://127.0.0.1:${port}/__gateway__/select`);
    expect(ok.status).toBe(200);
  });

  it('畸形 req.url 的 WS upgrade → socket 销毁（无 HTTP 响应）且服务存活', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    const raw = await rawRequest(
      port,
      'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    // socket.destroy 直接 FIN：不得有任何 HTTP 响应字节（区别于 401/404 分支）
    expect(raw).toBe('');
    const ok = await fetch(`http://127.0.0.1:${port}/__gateway__/select`);
    expect(ok.status).toBe(200);
  });
});
