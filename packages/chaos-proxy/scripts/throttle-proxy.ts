#!/usr/bin/env node
/**
 * throttle-proxy 手动验证脚本 — 在 server 与 client/浏览器之间挂限速/延迟/准入（chaos-proxy）。
 * 用法：tsx packages/chaos-proxy/scripts/throttle-proxy.ts
 *   [--listen 9080] [--target 127.0.0.1:9000]
 *   [--throttle 50k] [--shared] [--latency 100] [--jitter 50] [--admission 8]
 * 非产品化 CLI：极简解析、非法值直接抛错退出；无 bin、无信号协议（Ctrl-C 直接杀，泵定时器已 unref）。
 */

import { createChaosProxy } from '../src/index';

/** 解析字节速率：正整数，支持 k/m 后缀（50k = 51200，5m = 5242880） */
function parseBytes(value: string): number {
  const match = /^(\d+)([kKmM])?$/.exec(value);
  const num = match?.[1];
  if (num === undefined) throw new Error(`非法字节速率: ${value}（须正整数，可带 k/m 后缀）`);
  const suffix = match?.[2]?.toLowerCase();
  const parsed = Number(num) * (suffix === 'k' ? 1024 : suffix === 'm' ? 1024 * 1024 : 1);
  if (parsed <= 0) throw new Error(`非法字节速率: ${value}（须正整数，可带 k/m 后缀）`);
  return parsed;
}

/** 解析 host:port（支持 IPv6 [::1]:9000 写法） */
function parseTarget(value: string): { host: string; port: number } {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  const host = match?.[1];
  const port = Number(match?.[2]);
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`非法 target: ${value}（须 host:port，IPv6 用 [::1]:9000）`);
  }
  return { host, port };
}

/** 解析非负整数参数 */
function parseNonNegInt(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} 非法: ${value}（须非负整数）`);
  }
  return parsed;
}

let listenPort = 9080;
let targetHost = '127.0.0.1';
let targetPort = 9000;
let throttle = 0;
let shared = false;
let latency = 0;
let jitter = 0;
let admission = 0;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--listen') listenPort = parseNonNegInt('--listen', process.argv[++i]);
  else if (arg === '--target') {
    const value = process.argv[++i];
    if (!value) throw new Error('--target 缺参数值');
    const parsed = parseTarget(value);
    targetHost = parsed.host;
    targetPort = parsed.port;
  }
  else if (arg === '--throttle') throttle = parseBytes(process.argv[++i] ?? '');
  else if (arg === '--shared') shared = true;
  else if (arg === '--latency') latency = parseNonNegInt('--latency', process.argv[++i]);
  else if (arg === '--jitter') jitter = parseNonNegInt('--jitter', process.argv[++i]);
  else if (arg === '--admission') admission = parseNonNegInt('--admission', process.argv[++i]);
  else throw new Error(`未知参数: ${arg}`);
}

const proxy = createChaosProxy({ targetHost, targetPort, listenPort });
if (throttle > 0) proxy.setThrottle(throttle, shared ? 'shared' : 'per-conn');
if (latency > 0) proxy.setLatency(latency, jitter);
if (admission > 0) proxy.setAdmissionRate(admission);
const port = await proxy.listen();
console.info(
  `[throttle-proxy] 代理就绪 :${port} → ${targetHost}:${targetPort}`
  + `（限速 ${throttle > 0 ? `${throttle} B/s ${shared ? 'shared' : 'per-conn'}` : '关'}`
  + `，延迟 ${latency}ms+${jitter}ms，准入 ${admission > 0 ? `${admission}/s` : '关'}）`,
);
