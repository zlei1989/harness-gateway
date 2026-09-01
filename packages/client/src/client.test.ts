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
  /**
   * 模拟线上中间盒 synthesized 的非法 close 帧（code 1006 是 RFC 保留字，ws 库自身发不出）：
   * 绕过 ws 直接往裸 socket 写 close 帧（FIN|opcode 0x8，2 字节负载 0x03EE=1006），
   * 客户端 ws 收帧即抛 "Invalid WebSocket frame: invalid status code 1006"（线上报错原文）
   */
  sendIllegalCloseFrame(): void {
    (this.ws as unknown as { _socket: import('node:net').Socket } | null)?._socket
      .write(Buffer.from([0x88, 0x02, 0x03, 0xee]));
  }
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
    // 条件轮询替代固定 sleep：负载下固定 30ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (!gw.received.some((f) => f.type === 'channel.error' && f.channelId === 9)
      && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
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

  it('指纹分级：中间盒非法 close 帧（1006 上线）记 WARN 归因而非 ERROR，隧道自动重连且 hello 回带 tunnelId', async () => {
    const gw = new MiniGateway();
    const logs: Array<{ level: string; message: string }> = [];
    const capture = (level: string) => (message: string): void => {
      logs.push({ level, message });
    };
    const client = new Client({
      ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url,
      logger: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') },
    });
    client.on('error', () => {});
    await client.connect();
    gw.sendIllegalCloseFrame();
    // 内建重连自动恢复：第二次 hello 回带 tunnelId 请求复用（服务端空闲即保住浏览器会话）
    await vi.waitFor(() => {
      expect(gw.received.filter((f) => f.type === 'hello')).toHaveLength(2);
    }, { timeout: 5000 });
    expect(gw.received.filter((f) => f.type === 'hello')[1]?.client.tunnelId).toBe('tid-mini-1');
    // 指纹归因：WARN 留证、不归 ERROR；'error' 事件语义不变（监听方仍收到）
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('非法 close 帧'))).toBe(true);
    expect(logs.some((l) => l.message === '隧道连接错误')).toBe(false);
    await client.close();
    await gw.close();
  });

  // 线上噪音降噪：attach leg/单连接的"重连耗尽"终态经 'fatal' 由外层落 error 态，
  // 'error' 事件的日志降 debug（事件本身仍上抛，监听契约不变）
  it('重连耗尽降噪：error 事件日志降 debug，终态经 fatal 由外层处理', async () => {
    const gw = new MiniGateway();
    const logs: Array<{ level: string; message: string }> = [];
    const capture = (level: string) => (message: string): void => {
      logs.push({ level, message });
    };
    const client = new Client({
      ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url,
      reconnect: { maxRetries: 0 }, // 已就绪会话被杀后首个重连即耗尽
      logger: { debug: capture('debug'), info: capture('info'), warn: capture('warn'), error: capture('error') },
    });
    client.on('error', () => {});
    const fatals: Error[] = [];
    client.on('fatal', (err: Error) => fatals.push(err));
    await client.connect();
    gw.sendIllegalCloseFrame(); // 中间盒合成 1006 close 帧 → 断 → 重连耗尽
    await vi.waitFor(() => expect(fatals).toHaveLength(1), { timeout: 5000 });
    expect(logs.some((l) => l.level === 'debug' && l.message === '重连次数耗尽（终态由外层/组语义处理）')).toBe(true);
    expect(logs.some((l) => l.level === 'error' && l.message === '隧道连接错误')).toBe(false);
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
