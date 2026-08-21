/**
 * CORS 允许名单测试：环境变量解析（逗号分隔）与 Origin 匹配规则。
 * 规则：'*' 全放行；'*.jd.com' 匹配本体及任意子域（不限 scheme/端口）；
 * 含 ':' 的项按 host:port 精确匹配，其余按 host 精确匹配（任意端口）。
 */

import { describe, expect, it } from 'vitest';

import { createOriginMatcher, DEFAULT_CORS_ORIGINS, parseCorsOrigins } from './cors';

describe('parseCorsOrigins', () => {
  it('undefined / 空串 → undefined（上层用默认名单）', () => {
    expect(parseCorsOrigins(undefined)).toBeUndefined();
    expect(parseCorsOrigins('')).toBeUndefined();
    expect(parseCorsOrigins('  , , ')).toBeUndefined();
  });

  it('逗号分隔，去空白与空项', () => {
    expect(parseCorsOrigins(' *.jd.com , https://a.com ,,')).toEqual(['*.jd.com', 'https://a.com']);
  });
});

describe('createOriginMatcher', () => {
  it('通配子域：匹配本体与任意层级子域，不限 scheme/端口', () => {
    const match = createOriginMatcher(['*.jd.com']);
    expect(match('https://jd.com')).toBe(true);
    expect(match('https://m.jd.com')).toBe(true);
    expect(match('http://a.b.jd.com:8080')).toBe(true);
  });

  it('通配子域：不匹配相似后缀与跨级伪装', () => {
    const match = createOriginMatcher(['*.jd.com']);
    expect(match('https://notjd.com')).toBe(false);
    expect(match('https://jd.com.evil.com')).toBe(false);
    expect(match('https://example.com')).toBe(false);
  });

  it('含端口项按 host:port 精确匹配', () => {
    const match = createOriginMatcher(['localhost:3000']);
    expect(match('http://localhost:3000')).toBe(true);
    expect(match('http://localhost:3001')).toBe(false);
  });

  it('无通配无端口项按 host 精确匹配（任意端口）', () => {
    const match = createOriginMatcher(['example.com']);
    expect(match('https://example.com')).toBe(true);
    expect(match('http://example.com:9000')).toBe(true);
    expect(match('https://sub.example.com')).toBe(false);
  });

  it('* 全放行', () => {
    const match = createOriginMatcher(['*']);
    expect(match('https://anything.example.org')).toBe(true);
  });

  it('非法 Origin 字符串 → false（不抛错）', () => {
    const match = createOriginMatcher(['*']);
    expect(match('not-a-url')).toBe(false);
    expect(match('')).toBe(false);
  });

  it('默认名单放行 *.7qbjs.com、*.jd.com 与 localhost（任意端口，方便本地调试）', () => {
    expect(DEFAULT_CORS_ORIGINS).toEqual(['*.7qbjs.com', '*.jd.com', 'localhost', '127.0.0.1']);
    const match = createOriginMatcher(DEFAULT_CORS_ORIGINS);
    expect(match('https://m.7qbjs.com')).toBe(true);
    expect(match('https://m.jd.com')).toBe(true);
    expect(match('http://localhost:3000')).toBe(true);
    expect(match('http://localhost:5173')).toBe(true);
    expect(match('http://127.0.0.1:8080')).toBe(true);
    expect(match('https://example.com')).toBe(false);
  });
});
