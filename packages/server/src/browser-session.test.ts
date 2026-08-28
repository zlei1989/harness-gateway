/**
 * 浏览器会话存储与 cookie 工具测试 — 对应 browser-session.ts。
 * 注意：token 为敏感字段，断言只比对结构相等，不单独打印 token 值。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BrowserSessionStore, buildSessionCookie, DEFAULT_SESSION_TTL_MS, readSessionCookie, SESSION_COOKIE,
  stripSessionCookie,
} from './browser-session';

describe('BrowserSessionStore', () => {
  it('create 返回唯一 uuid，get 可取回', () => {
    const store = new BrowserSessionStore();
    const a = store.create('tid-1', 'pc-a', 't1');
    const b = store.create('tid-2', 'pc-b', 't2');
    expect(a).not.toBe(b);
    // 会话现含 expiresAt（TTL），结构匹配用 toMatchObject
    expect(store.get(a)).toMatchObject({ tunnelId: 'tid-1', hostname: 'pc-a', token: 't1' });
    expect(store.get('no-such')).toBeUndefined();
  });
});

describe('BrowserSessionStore TTL 与持久化', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const makeDir = (): string => { dir = mkdtempSync(join(tmpdir(), 'gw-session-')); return dir; };

  it('ttlMs 过期后 get 返回 undefined', () => {
    vi.useFakeTimers();
    try {
      const store = new BrowserSessionStore({ ttlMs: 1000 });
      const uuid = store.create('tid', 'host', 'tok');
      expect(store.get(uuid)).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(store.get(uuid)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('快照 round-trip：create 落盘（0600），新实例恢复会话', () => {
    const path = join(makeDir(), 'sessions.json');
    const a = new BrowserSessionStore({ ttlMs: 60_000, persistPath: path });
    const uuid = a.create('tid-1', 'pc-a', 'tok-secret');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sessions: { uuid: string; token: string }[] };
    expect(raw.version).toBe(1);
    expect(raw.sessions).toHaveLength(1);
    expect(raw.sessions[0]?.uuid).toBe(uuid);
    const b = new BrowserSessionStore({ ttlMs: 60_000, persistPath: path });
    expect(b.get(uuid)?.tunnelId).toBe('tid-1');
  });

  it('快照损坏 → WARN 降级空表不抛错', () => {
    const path = join(makeDir(), 'sessions.json');
    writeFileSync(path, 'not-json{{{', 'utf8');
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const store = new BrowserSessionStore({ persistPath: path }, logger as never);
    expect(store.get('x')).toBeUndefined();
    expect(warnings.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('快照损坏 WARN 只记错误名不回显文件内容（旧版 Node 的 JSON.parse 报错回显原文会泄露 token）', () => {
    const path = join(makeDir(), 'sessions.json');
    // 损坏点位于文件中后段：Node 20 部分版本的 JSON.parse 报错会回显输入前段（含 token）
    writeFileSync(path, '{"version":1,"sessions":[{"uuid":"u","tunnelId":"t","hostname":"h","token":"tok-leak-marker"@@@', 'utf8');
    const lines: string[] = [];
    // 模拟真实 logger：context 以 JSON 附加在消息后（泄露路径在 context）
    const logger = { debug() {}, info() {}, warn: (m: string, c?: Record<string, unknown>) => lines.push(c ? `${m} ${JSON.stringify(c)}` : m), error() {} };
    const store = new BrowserSessionStore({ persistPath: path }, logger as never);
    expect(store.get('x')).toBeUndefined();
    const warn = lines.find((l) => l.includes('损坏')) ?? '';
    expect(warn).toContain('SyntaxError'); // 只记 err.name
    expect(warn).not.toContain('tok-leak-marker'); // 不得携带 err.message 回显的文件原文
  });

  it('过期条目加载即丢弃', () => {
    const path = join(makeDir(), 'sessions.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessions: [{ uuid: 'old', tunnelId: 't', hostname: 'h', token: 'x', expiresAt: Date.now() - 1 }],
    }), 'utf8');
    const store = new BrowserSessionStore({ persistPath: path });
    expect(store.get('old')).toBeUndefined();
  });

  it('缺文件 = 空表正常启动；ttlMs 默认值 7 天', () => {
    const store = new BrowserSessionStore({ persistPath: join(makeDir(), 'none.json') });
    expect(store.ttlMs).toBe(DEFAULT_SESSION_TTL_MS);
  });
});

describe('cookie 工具', () => {
  it('readSessionCookie 解析单个/多个 cookie', () => {
    expect(readSessionCookie('gateway_sid=abc')).toBe('abc');
    expect(readSessionCookie('theme=dark; gateway_sid=xyz; other=1')).toBe('xyz');
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie('other=1')).toBeUndefined();
  });

  it('readSessionCookie 兼容数组形态（Node 多 Cookie 头）', () => {
    expect(readSessionCookie(['theme=dark', 'gateway_sid=xyz'])).toBe('xyz');
  });

  it('buildSessionCookie 属性齐全且 Max-Age 与 TTL 同源', () => {
    const cookie = buildSessionCookie('uuid-1', 604800);
    expect(cookie).toContain(`${SESSION_COOKIE}=uuid-1`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
  });

  it('stripSessionCookie 只剥离 gateway_sid', () => {
    expect(stripSessionCookie('gateway_sid=abc; app_session=xyz')).toBe('app_session=xyz');
    expect(stripSessionCookie('gateway_sid=abc')).toBeUndefined();
    expect(stripSessionCookie(undefined)).toBeUndefined();
  });
});
