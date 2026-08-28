/**
 * Client 主类测试 — 配置校验（进程级错误）与隧道帧路由。
 * 用最小模拟网关（ack hello、记录帧、可主动发 open）验证真实 WS 行为。
 */

import { createServer, type Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

import { Client } from './client';
import { type ControlFrame, decodeControl, encodeControl } from './protocol';
import { MockGateway } from './test-utils/mock-gateway';

/** 最小模拟网关：ack hello、记录帧、可主动发 open */
class MiniGateway {
  wss = new WebSocketServer({ port: 0 });
  ws: WsWebSocket | null = null;
  received: ControlFrame[] = [];
  constructor() {
    this.wss.on('connection', (ws) => {
      this.ws = ws;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeControl(String(data));
        this.received.push(frame);
        if (frame.type === 'hello') ws.send(encodeControl({ type: 'hello.ack', tunnelId: 'tid-mini-1' }));
        if (frame.type === 'ping') ws.send(encodeControl({ type: 'pong' }));
      });
    });
  }
  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }
  send(frame: ControlFrame): void { this.ws?.send(encodeControl(frame)); }
  async close(): Promise<void> {
    this.ws?.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const BASE = { hostname: 'pc-a', heartbeatIntervalMs: 10_000, connectTimeoutMs: 2000, connections: 1 };

describe('Client 配置校验（进程级错误）', () => {
  it('缺 upstreamUrl / gatewayUrl / hostname → 构造即抛错', () => {
    expect(() => new Client({ ...BASE, upstreamUrl: '', gatewayUrl: 'ws://x' } as never)).toThrow(/upstreamUrl/);
    expect(() => new Client({ ...BASE, upstreamUrl: 'http://x', gatewayUrl: '' } as never)).toThrow(/gatewayUrl/);
    expect(() => new Client({ upstreamUrl: 'http://x', gatewayUrl: 'ws://x', hostname: '' })).toThrow(/hostname/);
  });

  it('URL 非法 → 抛错', () => {
    expect(() => new Client({ upstreamUrl: 'not-a-url', gatewayUrl: 'ws://x', hostname: 'a' })).toThrow();
    expect(() => new Client({ upstreamUrl: 'http://x', gatewayUrl: 'http://x', hostname: 'a' })).toThrow(/ws/);
  });
});

describe('Client 生命周期与帧路由', () => {
  it('connect 后网关收到 hello（hostname + defaultPath 默认值）', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    expect(gw.received[0]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/', flowControl: true } });
    await client.close();
    await gw.close();
  });

  it('closing 后收到新 open → 回 channel.error 且不建通道', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    const closing = client.close();
    gw.send({ type: 'http.open', channelId: 9, method: 'GET', url: '/', headers: {} });
    await closing;
    await new Promise((r) => setTimeout(r, 30));
    expect(gw.received.some((f) => f.type === 'channel.error' && f.channelId === 9)).toBe(true);
    await gw.close();
  });

  it('未知 channelId 的数据帧被丢弃不抛错', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    gw.send({ type: 'channel.close', channelId: 999 });
    await new Promise((r) => setTimeout(r, 30));
    await client.close();
    await gw.close();
  });
});

describe('Client 多连接装配（connections + legCount）', () => {
  let gateway: MockGateway;
  let upstream: Server;
  let upstreamUrl: string;

  beforeEach(async () => {
    // echo upstream：原样回写请求体（字节一致性断言用）
    upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      req.pipe(res);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const addr = upstream.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    upstreamUrl = `http://127.0.0.1:${addr.port}`;
    gateway = new MockGateway();
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  it('connections 缺省 = 4：对 multiConn 网关建组，legCount 达到 4', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a' });
    client.on('error', () => undefined);
    await client.connect();
    await vi.waitFor(() => expect(client.legCount).toBe(4));
    await client.close();
  });

  it('connections: 1 = 纯 legacy：hello 不声明 multiConn', async () => {
    const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a', connections: 1 });
    client.on('error', () => undefined);
    await client.connect();
    expect(client.legCount).toBe(1);
    expect(gateway.lastHello?.client.multiConn).toBeUndefined();
    await client.close();
  });

  it('多连接下帧完整性与顺序：大 echo 体经 4 leg 条带化后字节一致', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a' });
    client.on('error', () => undefined);
    await client.connect();
    await vi.waitFor(() => expect(client.legCount).toBe(4));
    const body = Buffer.alloc(2 * 1024 * 1024);
    for (let i = 0; i < body.length; i++) body[i] = i % 251; // 可校验模式
    const res = await gateway.request('POST', '/', {}, body); // upstream echo
    expect(res.body.equals(body)).toBe(true);
    await client.close();
  });
});
