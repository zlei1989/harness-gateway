/**
 * WS 大流量丢帧复现脚本 v2（生产问题本地取证，一次性诊断用途）。
 * 拓扑：本脚本(browser ws) → GatewayServer → 隧道 → Client → echo upstream ws。
 * 与 v1 的差异：每个场景重建 browser/upstream 连接（1009 关断不污染后续场景）；
 * 新增 maxPayload 边界帧测试（帧过端点但隧道帧超限 → 杀整条隧道）与慢消费者内存测试。
 * 运行（packages/server 目录下）：node_modules/.bin/tsx repro-ws-loss.mts
 */

import { WebSocket, WebSocketServer } from 'ws';

import { Client } from '../client/src/index.ts';

import { GatewayServer } from './src/index.ts';

import type { Logger } from './src/index.ts';

const MIB = 1024 * 1024;
const WS_MAX_PAYLOAD = 100 * MIB; // ws 库默认 maxPayload

// ---------- 计数 logger：只收集 warn/error 供报告 ----------
interface CapturedLog { level: string; message: string; context?: Record<string, unknown> }
function createCountingLogger(tag: string, sink: CapturedLog[]): Logger {
  const push = (level: string) => (message: string, context?: Record<string, unknown>) => {
    sink.push({ level, message: `[${tag}] ${message}`, context });
  };
  return { debug: () => {}, info: () => {}, warn: push('warn'), error: push('error') };
}

// ---------- 帧工具：4 字节序号 + 填充 ----------
function makeFrame(seq: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(seq >>> 0, 0);
  return buf;
}
function frameSeq(data: unknown): number {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
  return buf.readUInt32BE(0);
}

/** 发送方自持背压，避免测试脚本自身成为变量 */
async function sendAll(ws: WebSocket, count: number, size: number, label: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    while (ws.bufferedAmount > 8 * MIB) await new Promise((r) => setTimeout(r, 5));
    ws.send(makeFrame(i, size));
    if (i % 4096 === 0) await new Promise((r) => setImmediate(r));
  }
  console.log(`[${label}] 发送完成 ${count} × ${size}B`);
}

class RecvStat {
  received = 0;
  readonly seen = new Set<number>();
  add(data: unknown): void {
    this.received++;
    this.seen.add(frameSeq(data));
  }
  missing(total: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < total; i++) if (!this.seen.has(i)) out.push(i);
    return out;
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
async function waitReceived(stat: RecvStat, expected: number, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (stat.received < expected && Date.now() - t0 < timeoutMs) await sleep(50);
  return stat.received >= expected;
}
function rss(): string {
  return `${Math.round(process.memoryUsage().rss / MIB)}MB`;
}

// ---------- 拓扑装配 ----------
const gwLogs: CapturedLog[] = [];
const clLogs: CapturedLog[] = [];
process.on('unhandledRejection', (err) => console.error('!!! unhandledRejection:', err));

// echo upstream：默认不回显（B 方向统计干净），文本 'echo' 首帧切回显模式
const upstreamWss = new WebSocketServer({ port: 0 });
await new Promise<void>((r) => upstreamWss.once('listening', r));
const upstreamPort = (upstreamWss.address() as { port: number }).port;
let upstreamConn: WebSocket | null = null;
let upstreamStat = new RecvStat();
const upstreamEvents: string[] = [];
upstreamWss.on('connection', (ws) => {
  if (upstreamConn && upstreamConn.readyState === WebSocket.OPEN) upstreamConn.close(1000);
  upstreamConn = ws;
  let echo = false;
  ws.on('message', (data, isBinary) => {
    if (!isBinary && data.toString() === 'echo') {
      echo = true;
      return;
    }
    upstreamStat.add(data);
    if (echo) ws.send(data, { binary: isBinary });
  });
  ws.on('close', (code, reason) => upstreamEvents.push(`upstream close code=${code} reason=${reason.toString()}`));
  ws.on('error', (err) => upstreamEvents.push(`upstream error ${err.message}`));
});

const gw = new GatewayServer({ port: 0, logger: createCountingLogger('gw', gwLogs) });
const gwPort = await gw.listen();

const client = new Client({
  upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
  gatewayUrl: `ws://127.0.0.1:${gwPort}/__gateway__/tunnel`,
  hostname: 'repro-ws',
  token: 'test',
  logger: createCountingLogger('cl', clLogs),
});
client.on('error', () => {});
await client.connect();

const sel = await fetch(`http://127.0.0.1:${gwPort}/__gateway__/select`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'hostname=repro-ws&token=test',
});
const cookie = sel.headers.getSetCookie()[0]?.split(';')[0];
if (sel.status !== 302 || !cookie) throw new Error(`建会话失败: ${sel.status}`);

let browser: WebSocket | null = null;
let browserStat = new RecvStat();
const browserEvents: string[] = [];

/** 每个场景重建 browser ws（旧连接若还活着先关掉），并等对侧拨到 upstream */
async function freshBrowserWs(): Promise<void> {
  if (browser && browser.readyState === WebSocket.OPEN) browser.close(1000);
  browser = new WebSocket(`ws://127.0.0.1:${gwPort}/ws/test`, { headers: { cookie } });
  browserStat = new RecvStat();
  browser.on('message', (data) => browserStat.add(data));
  browser.on('close', (code, reason) => browserEvents.push(`browser close code=${code} reason=${reason.toString()}`));
  browser.on('error', (err) => browserEvents.push(`browser error ${err.message}`));
  await waitOpen(browser);
  const t0 = Date.now();
  while (!upstreamConn || upstreamConn.readyState !== WebSocket.OPEN) {
    if (Date.now() - t0 > 10_000) throw new Error('等 upstream 连接超时');
    await sleep(20);
  }
  upstreamStat = new RecvStat();
}

console.log(`拓扑就绪: gw=${gwPort} upstream=${upstreamPort} rss=${rss()}`);

// ---------- 场景执行器 ----------
interface RegimeResult { lossA: number; lossB: number }
async function regime(
  label: string,
  aCount: number,
  bCount: number,
  size: number,
  timeoutMs: number,
): Promise<RegimeResult> {
  const gwMark = gwLogs.length;
  const clMark = clLogs.length;
  const evMark = browserEvents.length + upstreamEvents.length;
  await freshBrowserWs();

  const sends: Promise<void>[] = [];
  if (aCount > 0) sends.push(sendAll(browser!, aCount, size, `${label}/A`));
  if (bCount > 0) sends.push(sendAll(upstreamConn!, bCount, size, `${label}/B`));
  await Promise.all(sends);

  await Promise.all([
    waitReceived(upstreamStat, aCount, timeoutMs),
    waitReceived(browserStat, bCount, timeoutMs),
  ]);

  const missA = upstreamStat.missing(aCount);
  const missB = browserStat.missing(bCount);
  console.log(`--- ${label} ---`);
  console.log(`  A(browser→upstream): 发 ${aCount} 收 ${upstreamStat.received} 缺 ${missA.length}${missA.length ? ` 缺失序号: ${missA.slice(0, 8).join(',')}` : ''}`);
  console.log(`  B(upstream→browser): 发 ${bCount} 收 ${browserStat.received} 缺 ${missB.length}${missB.length ? ` 缺失序号: ${missB.slice(0, 8).join(',')}` : ''}`);
  console.log(`  结果: ${missA.length === 0 && missB.length === 0 ? '✅ 无丢失' : '❌ 有丢失/未收满'} | rss=${rss()}`);
  const newEvents = [...browserEvents, ...upstreamEvents].slice(evMark);
  if (newEvents.length > 0) console.log(`  连接事件: ${newEvents.join(' | ')}`);
  for (const l of [...gwLogs.slice(gwMark), ...clLogs.slice(clMark)]) {
    console.log(`  [${l.level}] ${l.message} ${l.context ? JSON.stringify(l.context) : ''}`);
  }
  return { lossA: missA.length, lossB: missB.length };
}

// R0 基线
await regime('R0 基线 100×1KB 双向', 100, 100, 1024, 15_000);

// R1/R2 高吞吐（超 16MB 聚合高水位，走背压路径）
await regime('R1 A 方向 20000×1KB', 20000, 0, 1024, 60_000);
await regime('R2 B 方向 20000×1KB', 0, 20000, 1024, 60_000);

// R5 双向饱和
await regime('R5 双向 10000×4KB', 10000, 10000, 4096, 120_000);

// R3b 边界帧 A 方向：100MiB-32B —— 过 browserWss，隧道帧超限 → 预期杀整条隧道
await regime('R3b A 边界帧 100MiB-32B', 1, 0, WS_MAX_PAYLOAD - 32, 120_000);

// R4b 边界帧 B 方向：100MiB-32B —— 过 client upstream ws，隧道帧超限 → 预期杀整条隧道
await regime('R4b B 边界帧 100MiB-32B', 0, 1, WS_MAX_PAYLOAD - 32, 120_000);

// R3c A 方向超大帧 101MiB —— 预期 browserWss 直接 1009 杀浏览器连接
await regime('R3c A 超大帧 101MiB', 1, 0, 101 * MIB, 120_000);

// R6 慢消费者 B 方向：browser 暂停读取，upstream 灌 300MB，观察服务端无界缓冲（OOM 风险）
{
  const gwMark = gwLogs.length;
  const clMark = clLogs.length;
  const evMark = browserEvents.length + upstreamEvents.length;
  await freshBrowserWs();
  browser!.pause();
  console.log('--- R6 B 方向慢消费者（browser.pause + 300×1MB） ---');
  const rssBefore = process.memoryUsage().rss;
  await sendAll(upstreamConn!, 300, MIB, 'R6/B');
  await sleep(2000); // 等数据全链路沉入缓冲
  const rssGrowth = Math.round((process.memoryUsage().rss - rssBefore) / MIB);
  console.log(`  灌入 300MB 后 rss 增长: +${rssGrowth}MB（无背压即无界缓冲）`);
  browser!.resume();
  const ok = await waitReceived(browserStat, 300, 120_000);
  const miss = browserStat.missing(300);
  console.log(`  恢复读取后: 收 ${browserStat.received}/300 缺 ${miss.length} ${ok && miss.length === 0 ? '✅ 无丢失（代价是内存）' : '❌ 有丢失'}`);
  const newEvents = [...browserEvents, ...upstreamEvents].slice(evMark);
  if (newEvents.length > 0) console.log(`  连接事件: ${newEvents.join(' | ')}`);
  for (const l of [...gwLogs.slice(gwMark), ...clLogs.slice(clMark)]) {
    console.log(`  [${l.level}] ${l.message} ${l.context ? JSON.stringify(l.context) : ''}`);
  }
}

console.log('=== 复现结束 ===');
await client.close();
await gw.close();
upstreamWss.close();
browser?.close();
process.exit(0);
