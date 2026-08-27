#!/usr/bin/env node
/**
 * harness-proxy CLI — 纯参数启动（spec §4.4，对齐 harness-server cli 模式）。
 * 用法：harness-proxy [--listen 9080] [--target 127.0.0.1:9000]
 *       [--max-connections-per-second 8] [--max-bytes-per-second 51200|50k]
 * 安全红线：错误只输出单行诊断（err.message 首行），不打印堆栈；
 * main() 返回退出码便于测试；SIGINT/SIGTERM 优雅关停 + 5s 兜底强退。
 */

import { pathToFileURL } from 'node:url';

import { type ProxyLogger, ProxyServer } from './server';

export interface CliArgs {
  listen: number;
  targetHost: string;
  targetPort: number;
  maxConnectionsPerSecond: number;
  maxBytesPerSecond: number;
  help: boolean;
}

const USAGE = '用法: harness-proxy [--listen <9080>] [--target <127.0.0.1:9000>] '
  + '[--max-connections-per-second <8>] [--max-bytes-per-second <51200|50k>]';

/** 单行诊断：只取 message 首行，剥离堆栈与代码帧 */
function singleLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0] ?? '';
}

/** 解析 host:port（支持 IPv6 [::1]:9000 写法） */
export function parseTarget(value: string): { host: string; port: number } {
  const ipv6Match = /^\[(?<host>[^\]]+)\]:(?<port>\d+)$/.exec(value);
  const match = ipv6Match ?? /^(?<host>[^:]+):(?<port>\d+)$/.exec(value);
  const host = match?.groups?.['host'];
  const portText = match?.groups?.['port'];
  const port = portText === undefined ? Number.NaN : Number(portText);
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--target 非法: ${value}（须 host:port，IPv6 用 [::1]:9000）`);
  }
  return { host, port };
}

/** 解析字节速率：正整数，支持 k/m 后缀（50k = 51200，2M = 2097152） */
export function parseBytesPerSecond(value: string): number {
  const match = /^(?<num>\d+)(?<suffix>[kKmM])?$/.exec(value);
  const num = match?.groups?.['num'];
  if (num === undefined) {
    throw new Error(`--max-bytes-per-second 非法: ${value}（须正整数，可带 k/m 后缀）`);
  }
  const suffix = match?.groups?.['suffix']?.toLowerCase();
  const parsed = Number(num) * (suffix === 'k' ? 1024 : suffix === 'm' ? 1024 * 1024 : 1);
  if (parsed <= 0) {
    throw new Error(`--max-bytes-per-second 非法: ${value}（须正整数，可带 k/m 后缀）`);
  }
  return parsed;
}

function parsePort(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`${flag} 非法: ${value}（须 0-65535 整数）`);
  }
  return parsed;
}

function parsePositiveInt(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} 非法: ${value}（须正整数）`);
  }
  return parsed;
}

/** 解析 CLI 参数；非法值抛错 */
export function parseArgs(argv: string[]): CliArgs {
  let listen = 9080;
  let targetHost = '127.0.0.1';
  let targetPort = 9000;
  let maxConnectionsPerSecond = 8;
  let maxBytesPerSecond = 51200;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--listen') listen = parsePort('--listen', argv[++i]);
    else if (arg === '--target') {
      const value = argv[++i];
      if (!value) throw new Error('--target 缺参数值');
      const parsed = parseTarget(value);
      targetHost = parsed.host;
      targetPort = parsed.port;
    } else if (arg === '--max-connections-per-second') {
      maxConnectionsPerSecond = parsePositiveInt('--max-connections-per-second', argv[++i]);
    } else if (arg === '--max-bytes-per-second') {
      const value = argv[++i];
      if (!value) throw new Error('--max-bytes-per-second 缺参数值');
      maxBytesPerSecond = parseBytesPerSecond(value);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { listen, targetHost, targetPort, maxConnectionsPerSecond, maxBytesPerSecond, help };
}

/** CLI 控制台 logger：[harness-proxy][级别] 消息 {context} */
function createCliLogger(): ProxyLogger {
  const line = (level: string, message: string, context?: Record<string, unknown>): string =>
    context ? `[harness-proxy][${level}] ${message} ${JSON.stringify(context)}` : `[harness-proxy][${level}] ${message}`;
  return {
    info: (message, context) => console.info(line('info', message, context)),
    warn: (message, context) => console.warn(line('warn', message, context)),
    error: (message, context) => console.error(line('error', message, context)),
  };
}

/** 主流程：返回退出码（0 正常；1 失败） */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[harness-proxy] ${singleLine(err)}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.info(USAGE);
    return 0;
  }
  const server = new ProxyServer({
    listenPort: args.listen,
    targetHost: args.targetHost,
    targetPort: args.targetPort,
    maxConnectionsPerSecond: args.maxConnectionsPerSecond,
    maxBytesPerSecond: args.maxBytesPerSecond,
    logger: createCliLogger(),
  });
  // 优雅关停：SIGINT/SIGTERM → close() 后退出；5s 优雅窗口后强制退出，进程不得永久悬挂
  const shutdown = (): void => {
    const forceTimer = setTimeout(() => process.exit(1), 5000);
    forceTimer.unref();
    void server.close().then(() => {
      clearTimeout(forceTimer);
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const port = await server.listen();
    console.info(`[harness-proxy] 代理就绪 :${port} → ${args.targetHost}:${args.targetPort}`
      + `（连接 ${args.maxConnectionsPerSecond}/s，带宽 ${args.maxBytesPerSecond} B/s）`);
    return 0; // 进程由 net.Server 保活
  } catch (err) {
    console.error(`[harness-proxy] 启动失败: ${singleLine(err)}`);
    return 1;
  }
}

// 入口守卫：仅直接执行时运行（测试 import 不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
