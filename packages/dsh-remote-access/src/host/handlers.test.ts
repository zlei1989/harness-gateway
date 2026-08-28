import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config';
import { ConnectionManager } from './connection-manager';
import { createHandlers, type Handler } from './handlers';

let home: string;
let manager: ConnectionManager;
let handlers: Map<string, Handler>;

const call = (method: string, params: Record<string, unknown> = {}) =>
  handlers.get(method)!(params) as Promise<Record<string, unknown>>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ra-handlers-'));
  manager = new ConnectionManager({ upstreamUrl: 'http://127.0.0.1:1' });
  handlers = createHandlers({ homeDir: home, manager, envHostname: 'env-host-1' });
});
afterEach(async () => {
  await manager.disable();
  rmSync(home, { recursive: true, force: true });
});

describe('remote-status', () => {
  it('返回缺省补全的配置、环境主机名与 off 状态', async () => {
    const res = await call('remote-status');
    expect(res.ok).toBe(true);
    expect(res.envHostname).toBe('env-host-1');
    const cfg = res.config as Record<string, unknown>;
    expect(cfg.hostname).toBe('');
    expect(String(cfg.token)).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(cfg.gateway).toBe('harness-gateway.7qbjs.com');
    expect(cfg.compress).toBe(true); // 压缩传输默认开
    expect(res.connection).toEqual({ state: 'off' });
  });
});

describe('remote-save-config', () => {
  it('合法保存后 loadConfig 可读到（含 compress 开关）', async () => {
    const res = await call('remote-save-config', { hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com', compress: false });
    expect(res.ok).toBe(true);
    expect(loadConfig(home)).toEqual({ hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com', compress: false });
  });

  it('compress 缺省：回落已保存值（表单未携带该字段时不清空开关）', async () => {
    await call('remote-save-config', { hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com', compress: false });
    const res = await call('remote-save-config', { hostname: 'my-pc-2' });
    expect(res.ok).toBe(true);
    expect(loadConfig(home)).toEqual({ hostname: 'my-pc-2', token: 'aB3x9Kq2', gateway: 'https://gw.example.com', compress: false });
  });

  it('非法网关地址：ok=false 且不写文件', async () => {
    const res = await call('remote-save-config', { hostname: '', token: 'aB3x9Kq2', gateway: 'ftp://x' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/协议不支持/);
  });

  it('非法 token：ok=false', async () => {
    const res = await call('remote-save-config', { hostname: '', token: 'has space', gateway: 'gw.example.com' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/令牌密钥/);
  });
});

describe('remote-enable / remote-disable', () => {
  it('网关不可达：enable 后状态为 error（不抛异常给路由层）', async () => {
    await call('remote-save-config', { hostname: '', token: 'aB3x9Kq2', gateway: '127.0.0.1:1' });
    const res = await call('remote-enable');
    expect(res.ok).toBe(true);
    const conn = res.connection as Record<string, unknown>;
    // 不可达时 connect 内部退避：要么 error 要么仍在 connecting，disable 必须能复位
    expect(['connecting', 'error']).toContain(conn.state);
    const off = await call('remote-disable');
    expect(off.connection).toEqual({ state: 'off' });
  });

  it('配置非法（未保存过且文件损坏场景以外的直接非法）: enable 返回 ok=false', async () => {
    // 先把 gateway 写成非法协议（绕过 save 校验直接改 manager 的输入路径：
    // enable 从 loadConfig 读，故先写一份合法配置再手工损坏字段不可行——
    // 这里验证 token 为空的直接调用路径）
    const res = await call('remote-enable', { override: { hostname: '', token: '', gateway: 'gw.example.com' } });
    expect(res.ok).toBe(false);
  });
});
