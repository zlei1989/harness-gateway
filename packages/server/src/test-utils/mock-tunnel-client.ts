/**
 * 内存模拟隧道客户端 — 讲隧道协议的 ws 客户端，供 e2e 测试驱动服务端。
 * 行为旋钮：auth-check 按 token 判定 204/403；业务请求回显 method/url/headers/body；ws.open 接受并 echo。
 * 注意：仅供本包测试使用，不进公共 API；token 只参与协议帧判定，任何日志/异常都不得打印。
 */

import WebSocket from 'ws';

import {
  type ControlFrame, type DataHeader, decodeControl, decodeData,
  encodeControl, encodeData, type HeadersJson,
} from '../protocol';

export interface MockTunnelClientOptions {
  gatewayUrl: string;
  hostname: string;
  defaultPath?: string;
  /** 合法 token（auth-check 探测判定用） */
  validToken: string;
}

export class MockTunnelClient {
  /** 服务端转发来的业务请求记录（断言 Bearer 注入/cookie 剥离/XFF 用） */
  httpOpens: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  /** 最近一次 hello.ack 分到的 tunnelId（模拟真实客户端：重连时经 hello 回带请求复用） */
  tunnelId: string | undefined;
  ws: WebSocket | null = null;
  private bodies = new Map<number, Buffer[]>();

  constructor(private readonly opts: MockTunnelClientOptions) {}

  /** 连接 + hello（有记忆则回带 tunnelId）；ack 后 resolve */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.gatewayUrl);
      this.ws = ws;
      ws.on('open', () => {
        const client = this.tunnelId
          ? { hostname: this.opts.hostname, defaultPath: this.opts.defaultPath ?? '/', tunnelId: this.tunnelId }
          : { hostname: this.opts.hostname, defaultPath: this.opts.defaultPath ?? '/' };
        ws.send(encodeControl({ type: 'hello', client }));
      });
      ws.on('message', (raw, isBinary) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (isBinary) {
          const { header, payload } = decodeData(buf);
          this.onData(header, payload);
          return;
        }
        const frame = decodeControl(buf.toString('utf8'));
        if (frame.type === 'hello.ack') {
          this.tunnelId = frame.tunnelId; // 以服务端最终决定为准
          resolve();
        } else this.onControl(frame);
      });
      ws.on('error', reject);
    });
  }

  private sendControl(frame: ControlFrame): void {
    this.ws?.send(encodeControl(frame));
  }

  private onControl(frame: ControlFrame): void {
    if (frame.type === 'ping') {
      this.sendControl({ type: 'pong' });
      return;
    }
    if (frame.type === 'http.open') {
      this.recordOpen(frame);
      this.bodies.set(frame.channelId, []);
      return;
    }
    if (frame.type === 'ws.open') {
      // 鉴权模拟：Bearer 不符 → reject 403；符 → accept 并等 echo
      const ok = frame.headers['authorization'] === `Bearer ${this.opts.validToken}`;
      if (!ok) {
        this.sendControl({ type: 'ws.reject', channelId: frame.channelId, status: 403, body: 'denied by client' });
        return;
      }
      this.sendControl({ type: 'ws.accept', channelId: frame.channelId, protocol: frame.protocols[0] });
      return;
    }
  }

  private onData(header: DataHeader, payload: Buffer): void {
    if (header.kind === 'http.body') {
      this.bodies.get(header.channelId)?.push(payload);
      return;
    }
    if (header.kind === 'http.body.end') {
      const chunks = this.bodies.get(header.channelId) ?? [];
      // auth-check 探测模拟：按 token 判定
      const auth = (this.lastHeaders ?? {})['authorization'];
      if ((this.lastUrl ?? '') === '/__gateway__/auth-check') {
        this.sendControl({ type: 'http.head', channelId: header.channelId, status: auth === `Bearer ${this.opts.validToken}` ? 204 : 403, headers: {} });
        this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
        return;
      }
      // 业务请求：回显 method/url/headers/body 为 JSON 响应（模拟 upstream）
      const echo = JSON.stringify({
        method: this.lastMethod, url: this.lastUrl, headers: this.lastHeaders,
        body: Buffer.concat(chunks).toString(),
      });
      this.sendControl({ type: 'http.head', channelId: header.channelId, status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['app=1', 'b=2'] } });
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body' }, Buffer.from(echo)));
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
      return;
    }
    if (header.kind === 'ws.message') {
      // echo 回浏览器
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'ws.message', dataType: header.dataType }, payload));
    }
  }

  // http.open 的 method/url/headers 暂存（body.end 时拼装回显）
  private lastMethod: string | undefined;
  private lastUrl: string | undefined;
  private lastHeaders: HeadersJson | undefined;

  /** 记录 http.open 帧（httpOpens 供断言；last* 供回显拼装） */
  private recordOpen(frame: Extract<ControlFrame, { type: 'http.open' }>): void {
    this.httpOpens.push(frame);
    this.lastMethod = frame.method;
    this.lastUrl = frame.url;
    this.lastHeaders = frame.headers;
  }

  close(): void {
    this.ws?.terminate();
  }
}
