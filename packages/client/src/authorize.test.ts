import { describe, expect, it } from 'vitest';

import { type AuthRequest, buildAuthRequest, runAuthorization } from './authorize';

const REQ: AuthRequest = {
  method: 'GET', url: '/api/x', headers: {}, ip: null, isWebSocket: false,
};

describe('默认鉴权（无自定义钩子）', () => {
  it('无钩子无 token → 放行', async () => {
    const d = await runAuthorization(undefined, REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('无钩子有 token：Bearer 匹配 → 放行', async () => {
    const req = { ...REQ, headers: { authorization: 'Bearer t1' } };
    const d = await runAuthorization(undefined, req, { token: 't1', timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('无钩子有 token：Bearer 不符/缺失 → 403', async () => {
    expect((await runAuthorization(undefined, REQ, { token: 't1', timeoutMs: 1000 })).status).toBe(403);
    const wrong = { ...REQ, headers: { authorization: 'Bearer no' } };
    expect((await runAuthorization(undefined, wrong, { token: 't1', timeoutMs: 1000 })).allowed).toBe(false);
  });
});

describe('自定义钩子', () => {
  it('next() → 放行', async () => {
    const d = await runAuthorization((_req, _res, next) => next(), REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('写 res → 拒绝且响应原样保留', async () => {
    const d = await runAuthorization((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('no auth');
    }, REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(401);
    expect(d.body.toString()).toBe('no auth');
    expect(d.headers['content-type']).toBe('text/plain');
  });

  it('异步写 res → 同样捕获为拒绝', async () => {
    const d = await runAuthorization((_req, res) => {
      setTimeout(() => res.writeHead(403).end('late'), 10);
    }, REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
    expect(d.body.toString()).toBe('late');
  });

  it('next(err) → 403', async () => {
    const d = await runAuthorization((_req, _res, next) => next(new Error('x')), REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
  });

  it('钩子同步抛异常 → 403', async () => {
    const d = await runAuthorization(() => { throw new Error('boom'); }, REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
  });

  it('悬挂 → 超时兜底 403', async () => {
    const d = await runAuthorization(() => { /* 什么都不做 */ }, REQ, { timeoutMs: 30 });
    expect(d.status).toBe(403);
  });
});

describe('buildAuthRequest', () => {
  it('X-Forwarded-For 取首项为 ip', () => {
    const req = buildAuthRequest({ type: 'http.open', channelId: 1, method: 'GET', url: '/a', headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }, false);
    expect(req.ip).toBe('1.2.3.4');
  });

  it('缺失 XFF → ip 为 null', () => {
    const req = buildAuthRequest({ type: 'http.open', channelId: 1, method: 'GET', url: '/a', headers: {} }, false);
    expect(req.ip).toBeNull();
  });

  it('ws.open 无 method 字段时为 GET 且 isWebSocket 透传', () => {
    const req = buildAuthRequest({ type: 'ws.open', channelId: 1, url: '/ws', headers: {}, protocols: [] }, true);
    expect(req.method).toBe('GET');
    expect(req.isWebSocket).toBe(true);
  });
});
