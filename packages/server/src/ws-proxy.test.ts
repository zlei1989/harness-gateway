import { createServer, type IncomingMessage, type Server } from 'node:http';
import { Duplex } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { BrowserSessionStore } from './browser-session';
import { type PendingChannel, TunnelRegistry } from './session';
import { handleBrowserWs, type ProxyContext } from './ws-proxy';

import type { ControlFrame, DataHeader } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假隧道：捕获 ws.open，测试驱动 accept/reject/message */
class FakeTunnel {
  readonly tunnelId = 'tid-1';
  readonly hostname = 'pc-a';
  openFrames: Extract<ControlFrame, { type: 'ws.open' }>[] = [];
  messages: { dataType?: string; payload: Buffer }[] = [];
  // brief 缺陷最小修复：channel.close 多数场景只带 reason 不带 code，需同时记录 channelId 才能断言"哪条通道被关"
  closes: { channelId: number; code?: number; reason?: string }[] = [];
  private channels = new Map<number, PendingChannel>();
  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'ws.open') this.openFrames.push(frame);
    if (frame.type === 'channel.close') this.closes.push({ channelId: frame.channelId, code: frame.code, reason: frame.reason });
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (header.kind === 'ws.message') this.messages.push({ dataType: header.dataType, payload });
    return true;
  }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  accept(channelId: number, protocol?: string): void {
    this.channels.get(channelId)?.onControl({ type: 'ws.accept', channelId, protocol });
  }
  reject(channelId: number, status: number, body: string): void {
    this.channels.get(channelId)?.onControl({ type: 'ws.reject', channelId, status, body });
  }
  pushMessage(channelId: number, dataType: 'text' | 'binary', payload: Buffer): void {
    this.channels.get(channelId)?.onData({ channelId, kind: 'ws.message', dataType }, payload);
  }
  closeChannel(channelId: number, code?: number): void {
    this.channels.get(channelId)?.onControl({ type: 'channel.close', channelId, code });
  }
  errorChannel(channelId: number, message: string): void {
    this.channels.get(channelId)?.onControl({ type: 'channel.error', channelId, message });
  }
}

/**
 * 假裸 socket：捕获写入数据，_final 标记 end() 优雅收尾。
 * 用于断言 writeRawResponse 走 socket.end（Node 保证 flush 后 FIN）而非 write+destroy（可能 RST 截断）。
 */
class FakeSocket extends Duplex {
  chunks: Buffer[] = [];
  finalized = false;
  _read(): void {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk);
    callback();
  }
  _final(callback: (error?: Error | null) => void): void {
    this.finalized = true;
    callback();
  }
}

let server: Server | null = null;
let browserWss: WebSocketServer | null = null;
let port = 0;
let sessions: BrowserSessionStore;
let tunnel: FakeTunnel;
/** 测试侧浏览器连接：afterEach 兜底 terminate，防 server.close 挂起 */
const browserClients = new Set<WebSocket>();

afterEach(async () => {
  // ws@8.21.2 noServer 模式下 close() 不会 terminate 已有客户端（源码确认），需手动兜底防 afterEach 挂起
  if (browserWss) for (const client of browserWss.clients) client.terminate();
  browserWss?.close();
  for (const ws of browserClients) ws.terminate();
  browserClients.clear();
  await new Promise<void>((r) => server ? server.close(() => r()) : r());
  server = null;
  browserWss = null;
});

/** 轮询等待条件成立：替代固定 sleep，消除 WS 握手到达时序抖动（brief 预警 reject 用例时序不稳） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup(logger: import('./logger').Logger = nullLogger): Promise<string> {
  tunnel = new FakeTunnel();
  const tunnels = new TunnelRegistry();
  (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('tid-1', tunnel);
  sessions = new BrowserSessionStore();
  const ctx: ProxyContext = { tunnels, sessions, selectPath: '/__gateway__/select', headTimeoutMs: 300, logger };
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  browserWss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => [...protocols][0] ?? false,
  });
  server.on('upgrade', (req, socket, head) => handleBrowserWs(req, socket, head, browserWss!, ctx));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  port = addr.port;
  return sessions.create('tid-1', 'pc-a', 'tok-user');
}

function connectBrowser(path: string, cookie?: string, protocols: string[] = []): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
    headers: cookie ? { cookie } : {},
  });
  browserClients.add(ws);
  ws.on('close', () => browserClients.delete(ws));
  return ws;
}

describe('handleBrowserWs', () => {
  it('无 cookie → HTTP 401 拒绝（WS 握手无法 302）', async () => {
    await setup();
    const ws = connectBrowser('/socket');
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(401);
  });

  it('有效会话 → ws.open 发出（Bearer 注入 + cookie 剥离 + XFF + 子协议透传）→ accept 后双向 echo', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket?a=1', `gateway_sid=${uuid}; app=keep`, ['chat']);
    // brief 缺陷最小修复：浏览器握手要等客户端回选后才完成，须先驱动 accept（回选 'chat'）再等 open
    await waitFor(() => tunnel.openFrames.length > 0);
    tunnel.accept(tunnel.openFrames[0]?.channelId ?? 0, 'chat');
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const open = tunnel.openFrames[0];
    expect(open?.url).toBe('/socket?a=1');
    expect(open?.headers['authorization']).toBe('Bearer tok-user');
    expect(open?.headers['cookie']).toBe('app=keep');
    expect(open?.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(open?.protocols).toEqual(['chat']);
    expect(ws.protocol).toBe('chat'); // 回选子协议透传到浏览器

    // 浏览器 → 隧道
    ws.send('hello');
    await new Promise((r) => setTimeout(r, 30));
    expect(tunnel.messages[0]).toMatchObject({ dataType: 'text' });
    expect(tunnel.messages[0]?.payload.toString()).toBe('hello');

    // 隧道 → 浏览器（二进制）
    tunnel.pushMessage(open!.channelId, 'binary', Buffer.from([0x01, 0x02]));
    const msg = await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer)));
    expect(msg).toEqual(Buffer.from([0x01, 0x02]));
    ws.close();
  });

  it('ws.reject → 浏览器收到原始 HTTP 响应（鉴权拒绝透传，含 body）', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    // brief 缺陷最小修复：此处不能 await——响应要等 reject 驱动后才到达，先 await 会死锁到 accept 超时
    const response = new Promise<IncomingMessage>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res));
      ws.on('error', reject);
    });
    // 等待 ws.open 到达后拒绝
    await waitFor(() => tunnel.openFrames.length > 0);
    tunnel.reject(tunnel.openFrames[0]?.channelId ?? 0, 403, 'denied by client');
    const res = await response;
    expect(res.statusCode).toBe(403);
    // body 精确断言：防"只透传状态行、丢 body"回归（审查 Important 3）
    const body = await new Promise<string>((resolve) => {
      let acc = '';
      res.on('data', (chunk: Buffer) => { acc += chunk.toString(); });
      res.on('end', () => resolve(acc));
    });
    expect(body).toBe('denied by client');
  });

  it('浏览器在 accept 前 RST（裸 socket error）→ 不崩进程，close 时清理通道', () => {
    // 线上事故回归：http.Server 'upgrade' 交出的裸 socket 有 0 个 error 监听（Node 26 实测探针），
    // accept 等待窗内对端 RST 的 ECONNRESET 以未处理 'error' 事件抛出 → 进程崩溃
    const tunnels = new TunnelRegistry();
    tunnel = new FakeTunnel();
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('tid-1', tunnel);
    const sessions2 = new BrowserSessionStore();
    const uuid = sessions2.create('tid-1', 'pc-a', 'tok-user');
    const ctx: ProxyContext = { tunnels, sessions: sessions2, selectPath: '/__gateway__/select', headTimeoutMs: 300, logger: nullLogger };
    const req = { headers: { cookie: `gateway_sid=${uuid}` }, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    const socket = new FakeSocket();
    handleBrowserWs(req, socket, Buffer.alloc(0), null as unknown as WebSocketServer, ctx);
    expect(tunnel.openFrames.length).toBe(1); // 通道已登记、ws.open 已发
    const rst = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => socket.emit('error', rst)).not.toThrow(); // RED 判据：无监听时 EventEmitter 同步抛
    // error 之后必随 close：既有 close 处理器完成通道清理
    socket.emit('close');
    expect(tunnel.closes.map((c) => c.channelId)).toContain(tunnel.openFrames[0]!.channelId);
  });

  it('401 拒绝回写后对端 RST（裸 socket error）→ 不崩进程', () => {
    // 同事故的另一触发面：writeRawResponse 的 socket.end 落在已 RST 连接上，异步 ECONNRESET
    const tunnels = new TunnelRegistry();
    const sessions2 = new BrowserSessionStore();
    const ctx: ProxyContext = { tunnels, sessions: sessions2, selectPath: '/__gateway__/select', headTimeoutMs: 300, logger: nullLogger };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    const socket = new FakeSocket();
    handleBrowserWs(req, socket, Buffer.alloc(0), null as unknown as WebSocketServer, ctx);
    expect(socket.finalized).toBe(true); // 401 已回写
    const rst = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(() => socket.emit('error', rst)).not.toThrow();
  });

  it('writeRawResponse 经 socket.end 一次性 flush（write+destroy 可能 RST 截断）', () => {
    // 假裸 socket 直连 401 路径：_final 仅在 end() 优雅收尾时触发，write+destroy 不触发
    const tunnels = new TunnelRegistry();
    const sessions2 = new BrowserSessionStore();
    const ctx: ProxyContext = { tunnels, sessions: sessions2, selectPath: '/__gateway__/select', headTimeoutMs: 300, logger: nullLogger };
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
    const socket = new FakeSocket();
    handleBrowserWs(req, socket, Buffer.alloc(0), null as unknown as WebSocketServer, ctx);
    expect(socket.finalized).toBe(true); // RED 判据：write+destroy 时 _final 不会被调用
    const raw = Buffer.concat(socket.chunks).toString();
    expect(raw).toContain('HTTP/1.1 401');
    expect(raw).toContain('unauthorized');
  });

  it('accept 前 channel.error → 浏览器 502（裸 socket 必须处置，不得悬挂）', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    ws.on('error', () => {}); // 服务端拒绝握手属预期，消化客户端 error
    const response = new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
    await waitFor(() => tunnel.openFrames.length > 0);
    tunnel.errorChannel(tunnel.openFrames[0]?.channelId ?? 0, 'upstream refused');
    // 悬挂探测：1s 内必须给出响应；旧实现 finish 清超时器后裸 socket 无处置，race 出 -1
    const hang = new Promise<number>((r) => setTimeout(() => r(-1), 1000));
    const status = await Promise.race([response, hang]);
    expect(status).toBe(502);
  });

  it('accept 前 channel.close → 浏览器 502（与 channel.error 同构悬挂，裸 socket 必须处置）', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    ws.on('error', () => {}); // 服务端拒绝握手属预期，消化客户端 error
    const response = new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    });
    await waitFor(() => tunnel.openFrames.length > 0);
    tunnel.closeChannel(tunnel.openFrames[0]?.channelId ?? 0, 1000);
    // 悬挂探测：1s 内必须给出响应；旧实现 finish 清超时器后裸 socket 无处置，race 出 -1
    const hang = new Promise<number>((r) => setTimeout(() => r(-1), 1000));
    const status = await Promise.race([response, hang]);
    expect(status).toBe(502);
  });

  it('隧道→浏览器关闭码按客户端口径矫正（仅 1000/3000-4999，1001→1000、4000 透传）', async () => {
    const uuid = await setup();
    // 第一段：1001 非法（客户端口径），矫正为 1000
    const ws1 = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await waitFor(() => tunnel.openFrames.length > 0);
    const id1 = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(id1);
    await new Promise<void>((r) => ws1.on('open', r));
    const closed1 = new Promise<number>((r) => ws1.on('close', (code) => r(code)));
    tunnel.closeChannel(id1, 1001);
    expect(await closed1).toBe(1000);
    // 第二段：4000 私有码合法，原样透传
    const ws2 = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await waitFor(() => tunnel.openFrames.length > 1);
    const id2 = tunnel.openFrames[1]?.channelId ?? 0;
    tunnel.accept(id2);
    await new Promise<void>((r) => ws2.on('open', r));
    const closed2 = new Promise<number>((r) => ws2.on('close', (code) => r(code)));
    tunnel.closeChannel(id2, 4000);
    expect(await closed2).toBe(4000);
  });

  it('回选子协议不属于 ws.open.protocols → 断通道', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`, ['chat']);
    ws.on('error', () => {}); // 服务端 destroy 裸 socket 属预期，提前消化客户端 error 防 uncaught
    await waitFor(() => tunnel.openFrames.length > 0);
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(channelId, 'not-offered'); // 非法回选
    await waitFor(() => tunnel.closes.length > 0);
    expect(tunnel.closes.some((c) => c.channelId === channelId)).toBe(true); // 通道被关闭
  });

  it('浏览器关闭 → channel.close 携带关闭码发给客户端', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await waitFor(() => tunnel.openFrames.length > 0);
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(channelId);
    await new Promise<void>((r) => ws.on('open', r));
    ws.close(1001, 'bye');
    await waitFor(() => tunnel.closes.length > 0);
    expect(tunnel.closes.map((c) => c.code)).toContain(1001);
  });

  it('等 ws.accept 超时 → 504 + channel.close', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(await status).toBe(504);
    ws.on('error', () => {});
  });

  it('边界带消息（过 browserWss 但隧道帧超限）→ 通道级 1009 关闭，消息不入隧道，同隧道其他通道不受影响', async () => {
    // 线上丢帧根因回归：100MiB-32 的消息过了 browserWss 默认 maxPayload（100MiB），
    // 但隧道帧加 ≈60B 头后超 100MiB，客户端收帧即杀整条隧道（全通道丢帧）；
    // 期望发送侧护栏把超限降级为通道级失败：本通道 1009，隧道与其他通道无感
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await waitFor(() => tunnel.openFrames.length > 0);
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(channelId);
    await new Promise<void>((r) => ws.on('open', r));

    const closed = new Promise<{ code: number; reason: Buffer }>((r) =>
      ws.on('close', (code, reason) => r({ code, reason })));
    ws.send(Buffer.alloc(100 * 1024 * 1024 - 32));
    const { code, reason } = await closed;
    expect(code).toBe(1009);
    expect(reason.toString()).toBe('message too large');
    // RED 判据：超尺寸消息不得进入隧道（修复前 FakeTunnel 会收到它）
    expect(tunnel.messages.length).toBe(0);
    expect(tunnel.closes.find((c) => c.channelId === channelId)?.reason).toBe('message too large');

    // 同隧道其他通道不受影响：新浏览器连接正常收发
    const ws2 = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await waitFor(() => tunnel.openFrames.length > 1);
    const id2 = tunnel.openFrames[1]?.channelId ?? 0;
    tunnel.accept(id2);
    await new Promise<void>((r) => ws2.on('open', r));
    ws2.send('still-alive');
    await waitFor(() => tunnel.messages.length > 0, 5000);
    expect(tunnel.messages[0]?.payload.toString()).toBe('still-alive');
    ws2.close();
  }, 30000);

  it('WS 升级入口日志只记 pathname：查询串（常见 token 携带位）不得入日志', async () => {
    const records: { message: string; context?: Record<string, unknown> }[] = [];
    const recordingLogger = {
      debug() {},
      info(message: string, context?: Record<string, unknown>) {
        records.push({ message, context });
      },
      warn() {},
      error() {},
    } as unknown as import('./logger').Logger;
    const uuid = await setup(recordingLogger);
    const ws = connectBrowser('/socket?token=secret-query&a=1', `gateway_sid=${uuid}`);
    ws.on('error', () => {}); // 不驱动 accept，300ms 后服务端 504 收尾属预期，消化客户端 error
    await waitFor(() => tunnel.openFrames.length > 0);
    // ws.open 帧仍携带完整 url（转发语义不变），仅日志脱敏
    expect(tunnel.openFrames[0]?.url).toBe('/socket?token=secret-query&a=1');
    const entry = records.find((r) => r.message === 'WS 升级入口');
    expect(entry).toBeDefined();
    expect(entry?.context?.['url']).toBe('/socket');
    expect(JSON.stringify(records)).not.toContain('secret-query');
  });
});
