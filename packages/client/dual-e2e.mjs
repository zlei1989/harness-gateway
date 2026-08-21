/**
 * 双端联调验证脚本（一次性验证工具，非包测试）。
 * 全链路：模拟浏览器 → GatewayServer → 隧道 → Client → upstream 应用服务。
 * 覆盖：选择页流程（302/选择页/token 错误 403/正确 302+cookie）、
 *       HTTP 转发三处 header 加工（Authorization 注入 / gateway_sid 剥离 / XFF）、
 *       WS echo 全链路、无效 cookie 302、多 Set-Cookie 保真。
 * 运行：corepack pnpm --filter gateway-client exec tsx dual-e2e.mjs
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { WebSocket } from 'ws';

import { GatewayServer } from '../server/src/index.ts';

import { Client } from './src/index.ts';

const TOKEN = 'dual-e2e-secret';
const HOSTNAME = 'dual-pc';
const results = [];
function check(name, fn) {
  try { fn(); results.push(`PASS ${name}`); }
  catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}

// ---------- upstream 应用服务 ----------
const upstreamHits = [];
const upstream = http.createServer((req, res) => {
  upstreamHits.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, xff: req.headers['x-forwarded-for'] });
  if (req.url === '/api/json') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello-from-upstream');
  }
});
// upstream WS echo
const { WebSocketServer } = await import('ws');
const upstreamWss = new WebSocketServer({ noServer: true });
upstream.on('upgrade', (req, socket, head) => {
  upstreamWss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamPort = upstream.address().port;

// ---------- 网关服务端 ----------
const server = new GatewayServer({ port: 0 });
const serverPort = await server.listen();

// ---------- 客户端（下游机器） ----------
const client = new Client({
  upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
  gatewayUrl: `ws://127.0.0.1:${serverPort}/__gateway__/tunnel`,
  hostname: HOSTNAME,
  token: TOKEN,
  defaultPath: '/',
  logger: { debug() {}, info() {}, warn() {}, error(m, c) { console.error('[client-err]', m); } },
});
await client.connect();

const base = `http://127.0.0.1:${serverPort}`;
async function raw(path, opts = {}) {
  // 手动跟随重定向，拿到原始响应
  return fetch(base + path, { redirect: 'manual', ...opts });
}

try {
  // 1. 无 cookie → 302 到选择页
  const r1 = await raw('/');
  check('无 cookie → 302', () => assert.equal(r1.status, 302));
  check('302 Location 是选择页', () => assert.ok(r1.headers.get('location')?.includes('/__gateway__/select')));

  // 2. 选择页含 hostname
  const r2 = await raw('/__gateway__/select');
  const html = await r2.text();
  check('选择页 200 且含 hostname', () => { assert.equal(r2.status, 200); assert.ok(html.includes(HOSTNAME)); });

  // 3. 错误 token → 403（探测经隧道问客户端）
  const r3 = await raw('/__gateway__/select', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `hostname=${HOSTNAME}&token=wrong` });
  check('错误 token → 403', () => assert.equal(r3.status, 403));

  // 4. 正确 token → 302 + gateway_sid cookie
  const r4 = await raw('/__gateway__/select', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `hostname=${HOSTNAME}&token=${TOKEN}` });
  check('正确 token → 302 到 defaultPath', () => { assert.equal(r4.status, 302); assert.equal(r4.headers.get('location'), '/'); });
  const setCookie = r4.headers.get('set-cookie') ?? '';
  check('Set-Cookie gateway_sid HttpOnly', () => { assert.ok(setCookie.includes('gateway_sid=')); assert.ok(/httponly/i.test(setCookie)); });
  const sid = setCookie.match(/gateway_sid=([^;]+)/)[1];
  const cookie = `gateway_sid=${sid}`;

  // 5. 带 cookie 访问 → 转发到 upstream
  const r5 = await raw('/api/json', { headers: { cookie } });
  const body = await r5.json();
  check('带 cookie → 200 + upstream 响应', () => { assert.equal(r5.status, 200); assert.deepEqual(body, { ok: true }); });
  check('多 Set-Cookie 保真', () => assert.deepEqual(r5.headers.getSetCookie().map((s) => s.split(';')[0]), ['a=1', 'b=2']));
  const hit = upstreamHits.find((h) => h.url === '/api/json');
  check('Authorization 注入 upstream', () => assert.equal(hit?.authorization, `Bearer ${TOKEN}`));
  check('gateway_sid 剥离（转发 cookie 不含）', () => assert.ok(!String(hit?.cookie ?? '').includes('gateway_sid')));
  check('X-Forwarded-For 已注入', () => assert.ok(typeof hit?.xff === 'string' && hit.xff.length > 0));

  // 6. 无效 cookie → 302 选择页
  const r6 = await raw('/', { headers: { cookie: 'gateway_sid=not-a-real-uuid' } });
  check('无效 cookie → 302', () => assert.equal(r6.status, 302));

  // 7. WS echo 全链路（带 cookie 握手）
  const wsResult = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws-echo`, { headers: { cookie } });
    const timeout = setTimeout(() => reject(new Error('ws echo 超时')), 5000);
    ws.on('open', () => ws.send('dual-e2e-ping'));
    ws.on('message', (data) => { clearTimeout(timeout); ws.close(); resolve(data.toString()); });
    ws.on('error', reject);
  });
  check('WS echo 全链路', () => assert.equal(wsResult, 'dual-e2e-ping'));

  // 8. WS 无 cookie → 401
  const wsNoCookie = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws-echo`);
    ws.on('open', () => resolve('opened'));
    ws.on('error', (e) => resolve(e.message));
    ws.on('unexpected-response', (req, res) => resolve(`status-${res.statusCode}`));
    setTimeout(() => resolve('timeout'), 3000);
  });
  check('WS 无 cookie → 401', () => assert.ok(String(wsNoCookie).includes('401')));
} finally {
  await client.close();
  await server.close();
  upstreamWss.close();
  upstream.close();
}

console.log('\n===== 双端联调结果 =====');
for (const r of results) console.log(r);
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length > 0 ? 1 : 0);

