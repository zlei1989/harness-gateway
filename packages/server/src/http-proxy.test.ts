/**
 * http-proxy 单元测试：假隧道捕获 open 帧与 body 数据，测试驱动其回包。
 * 覆盖：路由分支（无 cookie/无效 cookie/隧道离线）、headers 三处加工、
 * 空体规则、head 超时 504、隧道断开 502。
 */

import { createServer, request as httpRequest, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserSessionStore } from './browser-session';
import { createOriginMatcher } from './cors';
import { handleBrowserHttp, type ProxyContext } from './http-proxy';
import { type PendingChannel, TunnelRegistry, type TunnelSession } from './session';

import type { ControlFrame, DataHeader, HeadersJson } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假隧道：捕获 open 帧与 body 数据，测试驱动其回包 */
class FakeTunnel {
  readonly tunnelId = 'tid-1';
  readonly hostname = 'pc-a';
  readonly defaultPath = '/';
  openFrames: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  bodyChunks: Buffer[] = [];
  closes: number[] = [];
  /** 测试旋钮：下一个 http.body 帧的 sendData 返回 false（模拟聚合高水位），消费后自动复位 */
  highWaterOnce = false;
  /** waitDrain 注册的回落实控器：测试手动放行以驱动 pause→resume 全流程 */
  drainResolvers: Array<() => void> = [];
  endFrames = 0;
  autoRespond: { status: number; headers: HeadersJson; body: Buffer } | null = {
    status: 200,
    headers: { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] },
    body: Buffer.from('upstream-ok'),
  };
  private channels = new Map<number, PendingChannel>();

  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'http.open') this.openFrames.push(frame);
    if (frame.type === 'channel.close') this.closes.push(frame.channelId);
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (header.kind === 'http.body') {
      this.bodyChunks.push(payload);
      if (this.highWaterOnce) {
        this.highWaterOnce = false; // 仅第一帧报高水位
        return false;
      }
      return true;
    }
    if (header.kind === 'http.body.end') {
      this.endFrames += 1;
      if (this.autoRespond) {
        const channel = this.channels.get(header.channelId);
        const resp = this.autoRespond;
        queueMicrotask(() => {
          channel?.onControl({ type: 'http.head', channelId: header.channelId, status: resp.status, headers: resp.headers });
          channel?.onData({ channelId: header.channelId, kind: 'http.body' }, resp.body);
          channel?.onData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0));
        });
      }
    }
    return true;
  }
  waitDrain(): Promise<void> { return new Promise((r) => this.drainResolvers.push(r)); }
  tunnelDown(channelId: number): void { this.channels.get(channelId)?.onTunnelDown(); }
  /** 手动驱动：回 http.head（SSE/慢速 upstream 用例须绕过 autoRespond） */
  sendHead(channelId: number, status: number, headers: HeadersJson): void {
    this.channels.get(channelId)?.onControl({ type: 'http.head', channelId, status, headers });
  }
  /** 手动驱动：推一个 http.body 分块 */
  pushBody(channelId: number, payload: Buffer): void {
    this.channels.get(channelId)?.onData({ channelId, kind: 'http.body' }, payload);
  }
  /** 手动驱动：空载 http.body.end 收尾 */
  pushEnd(channelId: number): void {
    this.channels.get(channelId)?.onData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
  }
}

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** 轮询等待条件成立：替代固定 sleep，消除帧到达时序抖动 */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup(opts: { withTunnel?: boolean; headTimeoutMs?: number; graceMs?: number; logger?: import('./logger').Logger; corsOrigins?: string[] } = {}) {
  const tunnel = new FakeTunnel();
  const tunnels = new TunnelRegistry();
  if (opts.withTunnel !== false) {
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('tid-1', tunnel);
  }
  const sessions = new BrowserSessionStore();
  const uuid = sessions.create('tid-1', 'pc-a', 'tok-user');
  const ctx: ProxyContext = {
    tunnels,
    sessions,
    selectPath: '/__gateway__/select',
    headTimeoutMs: opts.headTimeoutMs ?? 300,
    // 瞬断宽限：缺省 0 = 即时 502 旧语义（既有用例不变）；宽限用例显式传 graceMs
    tunnelRestoreGraceMs: opts.graceMs ?? 0,
    logger: opts.logger ?? nullLogger,
    corsAllowOrigin: createOriginMatcher(opts.corsOrigins ?? ['*.example.com']),
  };
  server = createServer((req, res) => { void handleBrowserHttp(req, res, ctx); });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  return { port: addr.port, tunnel, uuid, tunnels };
}

describe('handleBrowserHttp', () => {
  it('无 cookie → 302 选择页', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/__gateway__/select');
  });

  it('无效 cookie → 302', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: 'gateway_sid=nope' }, redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('有效会话但隧道离线 → 502', async () => {
    const { port, uuid } = await setup({ withTunnel: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(502);
  });

  it('宽限内隧道恢复 → 请求挂起后正常转发（不 502）', async () => {
    // 请求发出时注册表为空：进入宽限等待（而非即时 502）；200ms 后隧道重连上线唤醒挂起请求
    const { port, tunnel, uuid, tunnels } = await setup({ withTunnel: false, graceMs: 1000 });
    const pending = fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    await new Promise((r) => setTimeout(r, 200));
    expect(tunnel.openFrames.length).toBe(0); // 仍在宽限等待，未创建通道
    tunnels.set('tid-1', tunnel as unknown as TunnelSession); // 隧道重连上线（走真 set 唤醒等待方）
    const res = await pending;
    expect(res.status).toBe(200); // 转发结果而非 502
    expect(await res.text()).toBe('upstream-ok');
  });

  it('宽限耗尽仍离线 → 502', async () => {
    const { port, uuid } = await setup({ withTunnel: false, graceMs: 150 });
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(502);
  });

  it('正常转发：headers 三处加工 + 响应回传（含多 Set-Cookie）', async () => {
    const { port, tunnel, uuid } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x?q=1`, {
      method: 'POST',
      headers: { cookie: `gateway_sid=${uuid}; app_session=keep`, authorization: 'Bearer browser-value' },
      body: 'request-body',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream-ok');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    const open = tunnel.openFrames[0];
    expect(open?.method).toBe('POST');
    expect(open?.url).toBe('/api/x?q=1');
    // ① Bearer 注入覆盖浏览器原值
    expect(open?.headers['authorization']).toBe('Bearer tok-user');
    // ② gateway_sid 剥离，应用 cookie 保留
    expect(open?.headers['cookie']).toBe('app_session=keep');
    // ③ X-Forwarded-For 注入
    expect(open?.headers['x-forwarded-for']).toContain('127.0.0.1');
    // 请求体透传 + 空载 end 收尾
    expect(Buffer.concat(tunnel.bodyChunks).toString()).toBe('request-body');
  });

  it('GET 无 body：仍发空载 http.body.end（空体规则）', async () => {
    const { port, tunnel, uuid } = await setup();
    let endSeen = false;
    const origSendData = tunnel.sendData.bind(tunnel);
    tunnel.sendData = (header: DataHeader, payload: Buffer): boolean => {
      if (header.kind === 'http.body.end') { endSeen = true; expect(payload.length).toBe(0); }
      return origSendData(header, payload);
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(200);
    expect(endSeen).toBe(true);
  });

  // 请求体聚合背压（大文件上传防服务端缓冲无界堆积）：sendData 报高水位 → 暂停读取请求体
  // → waitDrain 回落 → 恢复转发，后续分块与 end 帧完整到达
  it('请求体背压：超高水位暂停读取，waitDrain 回落后恢复转发', async () => {
    const { port, tunnel, uuid } = await setup();
    tunnel.autoRespond = null;
    tunnel.highWaterOnce = true; // 第一个 body 帧报聚合高水位
    // 原始 http 客户端逐块写请求体（chunked），便于观察 pause 行为
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/upload', method: 'POST',
      headers: { cookie: `gateway_sid=${uuid}`, 'transfer-encoding': 'chunked' },
    });
    req.on('response', (res) => res.resume()); // 终态响应（本例为 head 超时 504）直接排空
    req.on('error', () => {}); // 收尾 destroy/服务关闭的 ECONNRESET 属预期，消化防未处理 error
    req.write('chunk-A');
    await waitFor(() => tunnel.bodyChunks.length === 1); // A 已转发并触发背压（req 已 pause）
    await waitFor(() => tunnel.drainResolvers.length === 1); // 已登记 waitDrain 等待
    req.write('chunk-B');
    await new Promise((r) => setTimeout(r, 100));
    expect(tunnel.bodyChunks.length).toBe(1); // 暂停生效：B 不得越过高水位继续转发
    for (const resolve of tunnel.drainResolvers.splice(0)) resolve(); // 回落到低水位
    await waitFor(() => tunnel.bodyChunks.length === 2); // 恢复读取：B 转发
    req.end();
    await waitFor(() => tunnel.endFrames === 1); // end 帧完整收尾
    req.destroy();
  });

  it('等 http.head 超时 → 504 + channel.close', async () => {
    const { port, tunnel, uuid } = await setup({ headTimeoutMs: 100 });
    tunnel.autoRespond = null; // 客户端不应答
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(504);
    expect(tunnel.closes.length).toBeGreaterThan(0);
  });

  it('请求完成日志：status/headMs/totalMs/bodyBytes 分段计时（url 只记 pathname）', async () => {
    const records: { message: string; context?: Record<string, unknown> }[] = [];
    const recordingLogger = {
      debug() {},
      info(message: string, context?: Record<string, unknown>) {
        records.push({ message, context });
      },
      warn() {},
      error() {},
    } as unknown as import('./logger').Logger;
    const { port, uuid } = await setup({ logger: recordingLogger });
    const res = await fetch(`http://127.0.0.1:${port}/api/big?secret=1`, {
      headers: { cookie: `gateway_sid=${uuid}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream-ok');
    const done = records.find((r) => r.message === '请求完成');
    expect(done).toBeDefined();
    const ctx = done?.context as Record<string, unknown>;
    expect(ctx['status']).toBe(200);
    expect(ctx['url']).toBe('/api/big'); // 计时日志同样只记 pathname
    expect(typeof ctx['headMs']).toBe('number');
    expect(typeof ctx['totalMs']).toBe('number');
    expect(ctx['bodyBytes']).toBe('upstream-ok'.length);
    // head 到达早于完成（分段单调）
    expect((ctx['headMs'] as number) <= (ctx['totalMs'] as number)).toBe(true);
  });

  it('隧道断开（在途通道）→ 502', async () => {
    const { port, tunnel, uuid } = await setup();
    tunnel.autoRespond = null;
    const pending = fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    // 条件轮询替代固定 sleep：负载下固定 30ms 会被 CPU 争用击穿（时序抖动族）
    const deadline = Date.now() + 5000;
    while (tunnel.openFrames.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.tunnelDown(channelId);
    const res = await pending;
    expect(res.status).toBe(502);
  });

  it('请求入口日志只记 pathname：查询串（常见 token 携带位）不得入日志', async () => {
    const records: { message: string; context?: Record<string, unknown> }[] = [];
    const recordingLogger = {
      debug() {},
      info(message: string, context?: Record<string, unknown>) {
        records.push({ message, context });
      },
      warn() {},
      error() {},
    } as unknown as import('./logger').Logger;
    const { port, uuid } = await setup({ logger: recordingLogger });
    const res = await fetch(`http://127.0.0.1:${port}/api/x?token=secret-query&a=1`, {
      headers: { cookie: `gateway_sid=${uuid}` },
    });
    expect(res.status).toBe(200); // 转发本身不受影响（open 帧仍带完整 url）
    const entry = records.find((r) => r.message === '请求入口');
    expect(entry).toBeDefined();
    expect(entry?.context?.['url']).toBe('/api/x');
    expect(JSON.stringify(records)).not.toContain('secret-query');
  });

  it('SSE 流式：分块逐段到达浏览器；收到 head 后超过 headTimeoutMs 不设总超时', async () => {
    const { port, tunnel, uuid } = await setup({ headTimeoutMs: 150 });
    tunnel.autoRespond = null; // 手动驱动：模拟 SSE upstream 慢速分块
    const pending = fetch(`http://127.0.0.1:${port}/sse`, { headers: { cookie: `gateway_sid=${uuid}` } });
    await waitFor(() => tunnel.openFrames.length > 0);
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.sendHead(channelId, 200, { 'content-type': 'text/event-stream' });
    const res = await pending;
    expect(res.status).toBe(200);
    if (!res.body) throw new Error('响应无 body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // 第一块：body.end 前必须已到达（防"缓冲到收尾才一次性吐"回归）；先挂 read 再推块，断言真实流式
    const firstRead = reader.read();
    tunnel.pushBody(channelId, Buffer.from('data: chunk1\n\n'));
    const first = await firstRead;
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe('data: chunk1\n\n');
    // 关键承诺（spec §7.1）：收到 head 后无总超时——静默窗口超过 headTimeoutMs（150ms）流必须仍存活
    await new Promise((r) => setTimeout(r, 400));
    const secondRead = reader.read();
    tunnel.pushBody(channelId, Buffer.from('data: chunk2\n\n'));
    const second = await secondRead;
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe('data: chunk2\n\n');
    // 正常收尾：body.end 后流结束，非超时/异常截断
    tunnel.pushEnd(channelId);
    const tail = await reader.read();
    expect(tail.done).toBe(true);
  });
});

describe('CORS 全放行', () => {
  it('OPTIONS 预检：无 cookie 也短路 204，反射 Origin 与请求头，不创建通道', async () => {
    const { port, tunnel } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'x-custom-token, x-anything',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-headers')).toBe('x-custom-token, x-anything');
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(res.headers.get('access-control-max-age')).toBe('600');
    expect(tunnel.openFrames.length).toBe(0); // 预检不得进入转发链路
  });

  it('预检未带 Access-Control-Request-Headers → Allow-Headers 为 *', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      method: 'OPTIONS',
      headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe('*');
  });

  it('无 Origin 的 OPTIONS → 非预检，走正常链路（无 cookie → 302）', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { method: 'OPTIONS', redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('正常转发响应：反射 Origin，覆盖上游自带的冲突 CORS 头', async () => {
    const { port, tunnel, uuid } = await setup();
    tunnel.autoRespond = {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'access-control-allow-origin': 'https://upstream-evil.com',
        'access-control-allow-credentials': 'false',
      },
      body: Buffer.from('ok'),
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { cookie: `gateway_sid=${uuid}`, origin: 'https://app.example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-expose-headers')).toBe('*');
  });

  it('错误路径也带 CORS 头：无 cookie 302 / 隧道离线 502', async () => {
    const { port, uuid } = await setup({ withTunnel: false });
    const origin = 'https://app.example.com';
    const r302 = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { origin }, redirect: 'manual' });
    expect(r302.status).toBe(302);
    expect(r302.headers.get('access-control-allow-origin')).toBe(origin);
    const r502 = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { origin, cookie: `gateway_sid=${uuid}` } });
    expect(r502.status).toBe(502);
    expect(r502.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('无 Origin 的普通请求：不加任何 CORS 头', async () => {
    const { port, uuid } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('名单外 Origin：预检不短路（无 cookie → 302）且无 CORS 头', async () => {
    const { port, tunnel } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      method: 'OPTIONS',
      redirect: 'manual',
      headers: {
        origin: 'https://evil.org',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'x-a',
      },
    });
    expect(res.status).toBe(302); // 走正常链路的会话检查
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(tunnel.openFrames.length).toBe(0);
  });

  it('名单外 Origin：请求仍正常转发，但响应不带 CORS 头（浏览器自行拦截）', async () => {
    const { port, uuid } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { cookie: `gateway_sid=${uuid}`, origin: 'https://evil.org' },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream-ok');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-expose-headers')).toBeNull();
  });

  it('名单外 Origin：上游自带的 CORS 头也被清除（不得透传绕过名单）', async () => {
    const { port, tunnel, uuid } = await setup();
    tunnel.autoRespond = {
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' },
      body: Buffer.from('ok'),
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { cookie: `gateway_sid=${uuid}`, origin: 'https://evil.org' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('env 配置的精确项生效：localhost:3000 放行，3001 不放行', async () => {
    const { port, uuid } = await setup({ corsOrigins: ['localhost:3000'] });
    const ok = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { cookie: `gateway_sid=${uuid}`, origin: 'http://localhost:3000' },
    });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    const no = await fetch(`http://127.0.0.1:${port}/api/x`, {
      headers: { cookie: `gateway_sid=${uuid}`, origin: 'http://localhost:3001' },
    });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});
