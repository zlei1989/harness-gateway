/**
 * Client 主类测试 — 配置校验（进程级错误）与隧道帧路由。
 * 用最小模拟网关（ack hello、记录帧、可主动发 open）验证真实 WS 行为。
 */

import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';

import { Client } from './client';
import { type ControlFrame, decodeControl, encodeControl } from './protocol';

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
        if (frame.type === 'hello') ws.send(encodeControl({ type: 'hello.ack' }));
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

const BASE = { hostname: 'pc-a', heartbeatIntervalMs: 10_000, connectTimeoutMs: 2000 };

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
    expect(gw.received[0]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } });
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
