/**
 * select-page 单元测试 — 选择页渲染（XSS 转义、卡片矩阵、对话框骨架）、token 隧道探测、POST ajax 全流程。
 * 注意：FakeTunnel 捕获 http.open 帧并按 authorization 自动应答 204/403；
 * handleSelectPost 用例经真实 HTTP 服务器端到端验证（JSON 契约 + Set-Cookie）。
 */

import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserSessionStore } from './browser-session';
import { probeAuthCheck, renderSelectPage } from './select-page';

import type { ControlFrame, DataHeader } from './protocol';
import type { PendingChannel, TunnelHandle } from './session';

/** 假隧道：捕获 http.open，按 authorization 自动应答 204/403 */
class FakeTunnel {
  tunnelId = 'tid-1';
  hostname = 'pc-a';
  defaultPath = '/'; // 用例旋钮：恶意 defaultPath 开放重定向防线测试
  neverRespond = false; // 探测超时用例旋钮
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
      if (this.neverRespond) return;
      const channel = this.channels.get(frame.channelId);
      const ok = frame.headers['authorization'] === 'Bearer good';
      queueMicrotask(() => channel?.onControl({ type: 'http.head', channelId: frame.channelId, status: ok ? 204 : 403, headers: {} }));
    }
  }
  sendData(_header: DataHeader, _payload: Buffer): boolean { return true; }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  asHandle(): TunnelHandle { return this as unknown as TunnelHandle; }
}

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

describe('renderSelectPage', () => {
  it('渲染在线电脑图标矩阵：卡片仅图标+名字，携带 data-tunnel-id，hostname 被 HTML 转义（XSS 防护）', () => {
    const html = renderSelectPage([
      { tunnelId: 'tid-1', hostname: 'pc-a' },
      { tunnelId: 'tid-2', hostname: '<script>alert(1)</script>' },
    ]);
    expect(html).toContain('data-tunnel-id="tid-1"');
    expect(html).toContain('data-tunnel-id="tid-2"');
    expect(html).toContain('pc-a');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // 卡片不含 token 输入框与提交按钮（token 移入点击后的对话框）
    const card = html.split('\n').filter((l) => l.includes('class="card"'));
    expect(card.length).toBe(2);
    for (const line of card) {
      expect(line).not.toContain('<input');
      expect(line).not.toContain('<form');
    }
  });

  it('同名卡片并存（不同 tunnelId 区分）', () => {
    const html = renderSelectPage([
      { tunnelId: 'tid-1', hostname: 'pc-a' },
      { tunnelId: 'tid-2', hostname: 'pc-a' },
    ]);
    expect(html.match(/class="card"/g)).toHaveLength(2);
  });

  it('页面含隐藏模态对话框与 ajax 脚本（fetch POST + 深链处理）', () => {
    const html = renderSelectPage([{ tunnelId: 'tid-1', hostname: 'pc-a' }]);
    expect(html).toContain('id="mask"');
    expect(html).toContain('id="tokenInput"');
    expect(html).toContain('id="dialogError"');
    expect(html).toContain('fetch(location.pathname');
    expect(html).toContain("new URLSearchParams(location.search).get('tunnelId')");
  });

  it('遮罩带 [hidden] 兜底样式：author display:flex 会覆盖 hidden 的 UA display:none（缺它弹窗常驻、卡片点不动）', () => {
    const html = renderSelectPage([{ tunnelId: 'tid-1', hostname: 'pc-a' }]);
    expect(html).toContain('.mask[hidden]');
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
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set(tunnel.tunnelId, tunnel);
    const sessions = new BrowserSessionStore();
    const { handleSelectPost } = await import('./select-page');
    const ctx = { tunnels, sessions, headTimeoutMs: 500, logger: nullLogger };
    server = createServer((req, res) => void handleSelectPost(req, res, ctx));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server!.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return { port: addr.port, sessions };
  }

  /** 提交一次选择表单（ajax 口径），body 为 tunnelId + token */
  function postSelect(port: number, body: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
  }

  it('正确 token → 200 JSON redirect + Set-Cookie', async () => {
    const tunnel = new FakeTunnel();
    const { port, sessions } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=good');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const data = await res.json() as { ok: boolean; redirect: string };
    expect(data).toEqual({ ok: true, redirect: '/' }); // FakeTunnel 默认 defaultPath '/'
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('gateway_sid=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Max-Age=');
    const uuid = /gateway_sid=([^;]+)/.exec(cookie)?.[1] ?? '';
    // 会话现含 expiresAt（TTL），结构匹配用 toMatchObject
    expect(sessions.get(uuid)).toMatchObject({ tunnelId: 'tid-1', hostname: 'pc-a', token: 'good' });
  });

  it('错误 token → 403 JSON error（对话框内展示，不重渲染页面）', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=bad');
    expect(res.status).toBe(403);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data).toEqual({ ok: false, error: 'token 错误' });
  });

  it('tunnelId 不在线 → 409 JSON error', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=offline-tid&token=x');
    expect(res.status).toBe(409);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data).toEqual({ ok: false, error: '该电脑不在线或已断开' });
  });

  it('探测超时 → 504 JSON error', async () => {
    const tunnel = new FakeTunnel();
    tunnel.neverRespond = true;
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=good');
    expect(res.status).toBe(504);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data).toEqual({ ok: false, error: '探测超时，请重试' });
  });

  it('恶意 defaultPath（站外绝对 URL）→ JSON redirect 回落 /（开放重定向防线）', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = 'https://evil.com'; // 客户端可控输入，不得进 redirect
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=good');
    expect((await res.json() as { redirect: string }).redirect).toBe('/');
  });

  it('恶意 defaultPath（// 协议相对 URL）→ JSON redirect 回落 /', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = '//evil.com'; // 浏览器按当前协议跳转站外，同属开放重定向
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=good');
    expect((await res.json() as { redirect: string }).redirect).toBe('/');
  });

  it('合法站内 defaultPath → JSON redirect 原样使用', async () => {
    const tunnel = new FakeTunnel();
    tunnel.defaultPath = '/dash?q=1';
    const { port } = await setup(tunnel);
    const res = await postSelect(port, 'tunnelId=tid-1&token=good');
    expect((await res.json() as { redirect: string }).redirect).toBe('/dash?q=1');
  });

  it('表单体超 64KB → 客户端真实收到 400 状态行（而非连接重置）', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    // 超限主体：padding 字段把表单撑过 64KB 上限
    const body = `tunnelId=tid-1&token=x&padding=${'a'.repeat(65 * 1024)}`;
    const res = await postSelect(port, body);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('bad form');
  });
});
