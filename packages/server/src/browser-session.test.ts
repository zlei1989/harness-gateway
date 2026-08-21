/**
 * 浏览器会话存储与 cookie 工具测试 — 对应 browser-session.ts。
 * 注意：token 为敏感字段，断言只比对结构相等，不单独打印 token 值。
 */

import { describe, expect, it } from 'vitest';

import {
  BrowserSessionStore, buildSessionCookie, readSessionCookie, SESSION_COOKIE, stripSessionCookie,
} from './browser-session';

describe('BrowserSessionStore', () => {
  it('create 返回唯一 uuid，get 可取回', () => {
    const store = new BrowserSessionStore();
    const a = store.create('pc-a', 't1');
    const b = store.create('pc-b', 't2');
    expect(a).not.toBe(b);
    expect(store.get(a)).toEqual({ hostname: 'pc-a', token: 't1' });
    expect(store.get('no-such')).toBeUndefined();
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

  it('buildSessionCookie 属性齐全且无过期时间（session cookie）', () => {
    const cookie = buildSessionCookie('uuid-1');
    expect(cookie).toContain(`${SESSION_COOKIE}=uuid-1`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/expires|max-age/i);
  });

  it('stripSessionCookie 只剥离 gateway_sid', () => {
    expect(stripSessionCookie('gateway_sid=abc; app_session=xyz')).toBe('app_session=xyz');
    expect(stripSessionCookie('gateway_sid=abc')).toBeUndefined();
    expect(stripSessionCookie(undefined)).toBeUndefined();
  });
});
