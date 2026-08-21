/**
 * select-page 单元测试 — 选择页渲染（XSS 转义）、token 隧道探测、POST 会话建立全流程。
 * 注意：FakeTunnel 捕获 http.open 帧并按 authorization 自动应答 204/403；
 * handleSelectPost 用例经真实 HTTP 服务器端到端验证（含 Set-Cookie 与 302）。
 */

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserSessionStore } from './browser-session';
import { probeAuthCheck, renderSelectPage } from './select-page';

import type { ControlFrame, DataHeader } from './protocol';
import type { PendingChannel, TunnelHandle } from './session';

/** 假隧道：捕获 http.open，按 authorization 自动应答 204/403 */
class FakeTunnel {
  hostname = 'pc-a';
  defaultPath = '/'; // 用例旋钮：恶意 defaultPath 开放重定向防线测试
  opened: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  private channels = new Map<number, PendingChannel>();
  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'http.open') {
      this.opened.push(frame);
      const channel = this.channels.get(frame.channelId);
      const ok = frame.headers['authorization'] === 'Bearer good';
      queueMicrotask(() => channel?.onControl({ type: 'http.head', channelId: frame.channelId, status: ok ? 204 : 403, headers: {} }));
    }
  }
  sendData(_header: DataHeader, _payload: Buffer): boolean { return true; }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  neverRespond = false; // 探测超时用例旋钮
  asHandle(): TunnelHandle { return this as unknown as TunnelHandle; }
}

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

describe('renderSelectPage', () => {
  it('渲染在线电脑列表，hostname 被 HTML 转义（XSS 防护）', () => {
    const html = renderSelectPage([{ hostname: 'pc-a' }, { hostname: '<script>alert(1)</script>' }]);
    expect(html).toContain('pc-a');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('带错误提示渲染', () => {
    expect(renderSelectPage([], 'token 错误')).toContain('token 错误');
  });
});

describe('probeAuthCheck', () => {
  it('Bearer 正确 → pass；错误 → deny', async () => {
    const tunnel = new FakeTunnel();
    expect(await probeAuthCheck(tunnel.asHandle(), 'good', 1000)).toBe('pass');
    expect(await probeAuthCheck(tunnel.asHandle(), 'bad', 1000)).toBe('deny');
    // 探测帧形态：GET /__gateway__/auth-check + Bearer 注入
    expect(tunnel.opened[0]).toMatchObject({ method: 'GET', url: '/__gateway__/auth-check' });
    expect(tunnel.opened[0]?.headers['authorization']).toBe('Bearer good');
  });
});

describe('handleSelectPost（经真实 HTTP）', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  async function setup(tunnel: FakeTunnel) {
    const { TunnelRegistry } = await import('./session');
    const tunnels = new TunnelRegistry();
    // 把假隧道塞进注册表（利用 TunnelSession 结构等价性）
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('pc-a', tunnel);
    const sessions = new BrowserSessionStore();
    const { handleSelectPost } = await import('./select-page');
    const ctx = { tunnels, sessions, headTimeoutMs: 500, logger: nullLogger };
    server = createServer((req, res) => void handleSelectPost(req, res, ctx));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server!.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return { port: addr.port, sessions };
  }

  it('正确 token → Set-Cookie + 302 到 defaultPath', async () => {
    const tunnel = new FakeTunnel();
    const { port, sessions } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=good',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/'); // FakeTunnel 无 defaultPath 字段时默认 '/'
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('gateway_sid=');
    expect(cookie).toContain('HttpOnly');
    const uuid = /gateway_sid=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(sessions.get(uuid)).toEqual({ hostname: 'pc-a', token: 'good' });
  });

  it('错误 token → 403 重渲染选择页', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=bad',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('token');
  });

  it('hostname 不在线 → 400', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=offline-pc&token=x',
    });
    expect(res.status).toBe(400);
  });

  /** 提交一次正确 token 的选择表单，返回 302 响应 */
  async function postSelect(port: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=good',
      redirect: 'manual',
    });
  }

  it('恶意 defaultPath（站外绝对 URL）→ 302 Location 回落 /（开放重定向防线）', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = 'https://evil.com'; // 客户端可控输入，不得进 Location
    const { port } = await setup(tunnel);
    const res = await postSelect(port);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('恶意 defaultPath（// 协议相对 URL）→ 302 Location 回落 /', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = '//evil.com'; // 浏览器按当前协议跳转站外，同属开放重定向
    const { port } = await setup(tunnel);
    const res = await postSelect(port);
    expect(res.headers.get('location')).toBe('/');
  });

  it('合法站内 defaultPath → 302 Location 原样使用', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = '/dash?q=1';
    const { port } = await setup(tunnel);
    const res = await postSelect(port);
    expect(res.headers.get('location')).toBe('/dash?q=1');
  });

  it('表单体超 64KB → 客户端真实收到 400 状态行（而非连接重置）', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    // 超限主体：padding 字段把表单撑过 64KB 上限
    const body = `hostname=pc-a&token=x&padding=${'a'.repeat(65 * 1024)}`;
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bad form');
  });
});
