/**
 * 内存模拟网关 — 讲隧道协议的 ws 服务端，供 e2e 测试驱动客户端。
 * 提供 request()/wsOpen() 两个浏览器侧模拟入口；autoAck 控制 hello 应答。
 * 多连接旋钮（Task 4）：multiConnAck 在 hello.ack 附带协商上限；attachOk 应答 attach 加入既有隧道；
 * closeOnHello 仅拒 attach（primary 放行）；连接存数组 conns，数据帧按连接记账供条带化断言。
 * 注意：仅供本包测试；token 等敏感头只出现在协议帧内，禁止打印。
 */

import { type WebSocket, WebSocketServer } from 'ws';

import { createConsoleLogger } from '../logger';
import {
  type ControlFrame, type DataHeader, decodeControl, decodeData, encodeControl, encodeData,
  type HeadersJson, type HelloFrame,
} from '../protocol';
import { Resequencer } from '../resequencer';

export interface TunnelResponse {
  status: number;
  headers: HeadersJson;
  body: Buffer;
}

export class MockGateway {
  private wss = new WebSocketServer({ port: 0 });
  /** 全部存活 ws 连接（首条 = primary）；对端 close 即移除 */
  private conns: WebSocket[] = [];
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
  /** 数据帧按连接记账（条带化断言用） */
  private perConnData = new Map<WebSocket, Buffer[]>();
  /** 数据帧 seq 台账：channelId → 跨连接到达序 seq 列表（undefined = 帧未带 seq，单连接模式） */
  private dataSeqs = new Map<number, Array<number | undefined>>();
  /**
   * 入站重排序（镜像真实服务端 Task 7 行为）：多连接条带化下同一 (channelId, 方向) 的帧
   * 可能跨 leg 乱序到达，按 seq 重排后再分发；无 seq 帧（legacy）直通。
   * 通道态按 mock 内单调递增的 channelId 惰性建/弃，测试生命周期内有界，不做主动清理。
   */
  private readonly reseq = new Resequencer({
    logger: createConsoleLogger('error'),
    onOverflow: () => this.drop(), // 缓冲超限 = 对端行为异常：断开全部连接迫使整组重建
  });
  connectionCount = 0;

  // ---- 多连接旋钮（Task 4）----
  /** hello.ack 附带的多连接上限；undefined = 老服务端（JSON 序列化丢键，ack 形态不变） */
  multiConnAck: { max: number } | undefined;
  /** 仅拒 attach：attach hello 直接以该码关闭（4410 场景）；primary hello 放行 */
  closeOnHello: number | undefined;
  /** 与 closeOnHello 对称的 primary 旋钮：非 attach 的 hello 以该码关闭（如重连后 4409 终态场景） */
  closePrimaryCode: number | undefined;
  /** true 时 attach hello 回同一 tunnelId 的 ack（加入既有隧道组） */
  attachOk = false;
  /** attach hello.ack 延迟毫秒数（0 = 立即）：把 attach leg 钉在"已连上未就绪"窗（跨代重建竞态用） */
  attachAckDelayMs = 0;
  /** 最后一个 hello 帧（协商断言用） */
  lastHello: HelloFrame | null = null;
  /** attach hello 计数（重试/降级断言用） */
  attachHelloCount = 0;

  constructor() {
    this.wss.on('connection', (ws) => {
      this.connectionCount += 1;
      this.conns.push(ws);
      ws.on('message', (raw, isBinary) =>
        this.onMessage(ws, Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), isBinary));
      ws.on('close', () => {
        const i = this.conns.indexOf(ws);
        if (i >= 0) this.conns.splice(i, 1);
      });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }

  /** 浏览器侧模拟入口固定走首条（primary）连接 */
  private get primaryWs(): WebSocket | null {
    return this.conns[0] ?? null;
  }

  private onMessage(ws: WebSocket, buf: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      const frame = decodeControl(buf.toString('utf8'));
      const channelId = 'channelId' in frame ? frame.channelId : undefined;
      const seq = 'seq' in frame ? frame.seq : undefined;
      if (channelId !== undefined && typeof seq === 'number') {
        this.reseq.feed(channelId, seq, { kind: 'control', frame }, (item) => {
          if (item.kind === 'control') this.handleControl(ws, item.frame);
        });
        return;
      }
      this.handleControl(ws, frame);
      return;
    }
    const { header, payload } = decodeData(buf);
    // 数据帧按连接记账 + seq 台账（条带化断言用，按到达序记录，重排之前先记；undefined = 帧未带 seq）
    const list = this.perConnData.get(ws) ?? [];
    list.push(payload);
    this.perConnData.set(ws, list);
    const seqs = this.dataSeqs.get(header.channelId) ?? [];
    seqs.push(header.seq);
    this.dataSeqs.set(header.channelId, seqs);
    if (typeof header.seq === 'number') {
      this.reseq.feed(header.channelId, header.seq, { kind: 'data', header, payload }, (item) => {
        if (item.kind === 'data') this.handleData(item.header, item.payload);
      });
      return;
    }
    this.handleData(header, payload);
  }

  /** 控制帧分发（重排后按序到达；hello/ping 等隧道级帧直通到这里） */
  private handleControl(ws: WebSocket, frame: ControlFrame): void {
    if (frame.type === 'hello') {
      this.lastHello = frame;
      if (frame.client.attach === true) {
        this.attachHelloCount += 1;
        // closeOnHello 仅拒 attach（primary 不带 attach 故放行，否则 primary 也连不上）
        if (this.closeOnHello !== undefined) {
          ws.close(this.closeOnHello, 'mock reject');
          return;
        }
        if (this.attachOk) {
          // attach 成功：回带同一 tunnelId（加入既有隧道组）
          const reply = () => ws.send(encodeControl({
            type: 'hello.ack',
            tunnelId: frame.client.tunnelId ?? 'tid-mock-1',
            multiConn: this.multiConnAck,
          }));
          if (this.attachAckDelayMs > 0) setTimeout(reply, this.attachAckDelayMs);
          else reply();
          return;
        }
      } else {
        // 新 primary 会话：客户端 seq 空间随隧道重建归零，重排序状态一并清空
        this.reseq.reset();
      }
      // closePrimaryCode 拒非 attach 的 hello（如重连后 4409 终态）；attach 分支上面已 return/放行
      if (frame.client.attach !== true && this.closePrimaryCode !== undefined) {
        ws.close(this.closePrimaryCode, 'mock reject primary');
        return;
      }
      ws.send(encodeControl({ type: 'hello.ack', tunnelId: 'tid-mock-1', multiConn: this.multiConnAck }));
      return;
    }
    if (frame.type === 'ping') ws.send(encodeControl({ type: 'pong' }));
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
  }

  /** 数据帧业务分发（重排后按序到达） */
  private handleData(header: DataHeader, payload: Buffer): void {
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
      const ws = this.primaryWs;
      if (!ws) { reject(new Error('no tunnel')); return; }
      this.pending.set(channelId, { resolve, chunks: [] });
      ws.send(encodeControl({ type: 'http.open', channelId, method, url, headers }));
      if (body) ws.send(encodeData({ channelId, kind: 'http.body' }, body));
      ws.send(encodeData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
    });
  }

  /** 模拟浏览器 WS 握手：发 ws.open，等 accept/reject（resolve 带 channelId 供发消息/收回声） */
  wsOpen(
    url: string, headers: HeadersJson, protocols: string[] = [],
  ): Promise<{ accepted: boolean; status?: number; body?: string; channelId: number }> {
    const channelId = this.nextChannelId++;
    return new Promise((resolve, reject) => {
      const ws = this.primaryWs;
      if (!ws) { reject(new Error('no tunnel')); return; }
      this.wsPending.set(channelId, { resolve });
      ws.send(encodeControl({ type: 'ws.open', channelId, url, headers, protocols }));
    });
  }

  /** 对当前连接上指定通道发一条 ws.message（仅 echo 场景用） */
  sendWsMessage(channelId: number, dataType: 'text' | 'binary', payload: Buffer): void {
    this.primaryWs?.send(encodeData({ channelId, kind: 'ws.message', dataType }, payload));
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

  /** 各连接累计收到的数据帧字节数：key = 连接序号（conns 下标），仅含收过数据的连接 */
  perConnDataSizes(): Map<number, number> {
    const sizes = new Map<number, number>();
    for (const [ws, chunks] of this.perConnData) {
      const idx = this.conns.indexOf(ws);
      if (idx < 0) continue; // 已断开连接不记账（序号以存活连接为准）
      sizes.set(idx, chunks.reduce((n, b) => n + b.length, 0));
    }
    return sizes;
  }

  /** 跨连接聚合指定通道的数据帧 seq（仅数字项升序返回，供单调性断言） */
  allDataSeqs(channelId: number): number[] {
    return (this.dataSeqs.get(channelId) ?? [])
      .filter((s): s is number => typeof s === 'number')
      .sort((a, b) => a - b);
  }

  /** 指定通道数据帧 seq 台账原样（按到达序，含 undefined = 未带 seq 的帧），供单连接模式断言 */
  allDataSeqsRaw(channelId: number): Array<number | undefined> {
    return [...(this.dataSeqs.get(channelId) ?? [])];
  }

  /** 随机断一条非首连接（attach leg 断开场景）；不足 2 条连接时无操作 */
  dropOneConnection(): void {
    if (this.conns.length < 2) return;
    const idx = 1 + Math.floor(Math.random() * (this.conns.length - 1));
    this.conns[idx]?.terminate();
  }

  /** 只断首条（primary）连接：整组重建触发点（跨代重建竞态场景） */
  dropPrimary(): void {
    this.conns[0]?.terminate();
  }

  /** 断开隧道（模拟网关宕机/断线）：断开全部连接 */
  drop(): void {
    for (const ws of this.conns) ws.terminate();
  }

  async close(): Promise<void> {
    this.drop();
    // 回声台账清理：悬挂 waiter 由其自带 2s 超时拒绝，台账不随实例泄漏出测试
    this.wsMsgQueues.clear();
    this.wsMsgWaiters.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
