/**
 * 内存模拟网关 — 讲隧道协议的 ws 服务端，供 e2e 测试驱动客户端。
 * 提供 request()/wsOpen() 两个浏览器侧模拟入口；autoAck 控制 hello 应答。
 * 注意：仅供本包测试；token 等敏感头只出现在协议帧内，禁止打印。
 */

import { type WebSocket, WebSocketServer } from 'ws';

// 注意：brief 原版导入了 ControlFrame/DataHeader 两个类型但实际未引用，strict noUnusedLocals 下移除
import {
  decodeControl, decodeData, encodeControl, encodeData,
  type HeadersJson,
} from '../protocol';

export interface TunnelResponse {
  status: number;
  headers: HeadersJson;
  body: Buffer;
}

export class MockGateway {
  private wss = new WebSocketServer({ port: 0 });
  private ws: WebSocket | null = null;
  private nextChannelId = 1;
  private pending = new Map<number, {
    resolve: (r: TunnelResponse) => void;
    chunks: Buffer[];
    head?: { status: number; headers: HeadersJson };
  }>();
  private wsPending = new Map<number, {
    resolve: (v: { accepted: boolean; status?: number; body?: string; channelId: number }) => void;
  }>();
  /** ws.message 回声暂存：nextWsMessage 注册等待前先到的帧按序排队 */
  private wsMsgQueues = new Map<number, Array<{ dataType: 'text' | 'binary'; payload: Buffer }>>();
  private wsMsgWaiters = new Map<number, Array<(m: { dataType: 'text' | 'binary'; payload: Buffer }) => void>>();
  connectionCount = 0;

  constructor() {
    this.wss.on('connection', (ws) => {
      this.connectionCount += 1;
      this.ws = ws;
      ws.on('message', (raw, isBinary) =>
        this.onMessage(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), isBinary));
      ws.on('close', () => { if (this.ws === ws) this.ws = null; });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }

  private onMessage(buf: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      const frame = decodeControl(buf.toString('utf8'));
      if (frame.type === 'hello') this.ws?.send(encodeControl({ type: 'hello.ack', tunnelId: 'tid-mock-1' }));
      else if (frame.type === 'ping') this.ws?.send(encodeControl({ type: 'pong' }));
      else if (frame.type === 'http.head') {
        const p = this.pending.get(frame.channelId);
        if (p) p.head = { status: frame.status, headers: frame.headers };
      } else if (frame.type === 'ws.accept') {
        const p = this.wsPending.get(frame.channelId);
        if (p) p.resolve({ accepted: true, channelId: frame.channelId });
        this.wsPending.delete(frame.channelId);
      } else if (frame.type === 'ws.reject') {
        const p = this.wsPending.get(frame.channelId);
        if (p) {
          p.resolve({
            accepted: false, status: frame.status, body: frame.body, channelId: frame.channelId,
          });
        }
        this.wsPending.delete(frame.channelId);
      }
      return;
    }
    const { header, payload } = decodeData(buf);
    if (header.kind === 'ws.message') {
      // WS 通道回声：有等待方直接交付，否则按通道排队（保序）
      const m = { dataType: header.dataType ?? ('binary' as const), payload };
      const waiters = this.wsMsgWaiters.get(header.channelId);
      if (waiters && waiters.length > 0) {
        waiters.shift()?.(m);
      } else {
        const q = this.wsMsgQueues.get(header.channelId) ?? [];
        q.push(m);
        this.wsMsgQueues.set(header.channelId, q);
      }
      return;
    }
    const p = this.pending.get(header.channelId);
    if (!p) return;
    if (header.kind === 'http.body') p.chunks.push(payload);
    if (header.kind === 'http.body.end' && p.head) {
      this.pending.delete(header.channelId);
      p.resolve({
        status: p.head.status, headers: p.head.headers, body: Buffer.concat(p.chunks),
      });
    }
  }

  /** 模拟浏览器 HTTP 请求：发 http.open + body，等客户端回完整响应 */
  request(
    method: string, url: string, headers: HeadersJson, body?: Buffer,
  ): Promise<TunnelResponse> {
    const channelId = this.nextChannelId++;
    return new Promise((resolve, reject) => {
      if (!this.ws) { reject(new Error('no tunnel')); return; }
      this.pending.set(channelId, { resolve, chunks: [] });
      this.ws.send(encodeControl({ type: 'http.open', channelId, method, url, headers }));
      if (body) this.ws.send(encodeData({ channelId, kind: 'http.body' }, body));
      this.ws.send(encodeData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
    });
  }

  /** 模拟浏览器 WS 握手：发 ws.open，等 accept/reject（resolve 带 channelId 供发消息/收回声） */
  wsOpen(
    url: string, headers: HeadersJson, protocols: string[] = [],
  ): Promise<{ accepted: boolean; status?: number; body?: string; channelId: number }> {
    const channelId = this.nextChannelId++;
    return new Promise((resolve, reject) => {
      if (!this.ws) { reject(new Error('no tunnel')); return; }
      this.wsPending.set(channelId, { resolve });
      this.ws.send(encodeControl({ type: 'ws.open', channelId, url, headers, protocols }));
    });
  }

  /** 对当前连接上指定通道发一条 ws.message（仅 echo 场景用） */
  sendWsMessage(channelId: number, dataType: 'text' | 'binary', payload: Buffer): void {
    this.ws?.send(encodeData({ channelId, kind: 'ws.message', dataType }, payload));
  }

  /** 等指定通道的下一条 ws.message 回声（客户端→网关方向，按到达顺序交付）；2s 未到即拒绝（防回归时挂到 vitest 默认超时、报错不可读） */
  nextWsMessage(channelId: number): Promise<{ dataType: 'text' | 'binary'; payload: Buffer }> {
    const q = this.wsMsgQueues.get(channelId);
    if (q && q.length > 0) return Promise.resolve(q.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`nextWsMessage 超时（channelId=${channelId}）`)), 2000,
      );
      const waiters = this.wsMsgWaiters.get(channelId) ?? [];
      waiters.push((m) => { clearTimeout(timer); resolve(m); });
      this.wsMsgWaiters.set(channelId, waiters);
    });
  }

  /** 断开隧道（模拟网关宕机/断线） */
  drop(): void {
    this.ws?.terminate();
  }

  async close(): Promise<void> {
    this.drop();
    // 回声台账清理：悬挂 waiter 由其自带 2s 超时拒绝，台账不随实例泄漏出测试
    this.wsMsgQueues.clear();
    this.wsMsgWaiters.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
