#!/usr/bin/env node
/**
 * harness-server CLI — 纯参数启动网关（服务端无函数型选项，不需要配置文件，spec §1.3-1）。
 * 用法：harness-server [--port 3081] [--tunnel-path <path>] [--select-path <path>]（spec §1.3-1 纯参数）
 * 注意：由 bin/harness-server.mjs 以 tsx 启动；main() 返回退出码便于测试。
 * 安全红线：所有错误路径只输出单行诊断（err.message 首行），不打印原始 Error 对象/堆栈，
 * 避免回显可能含敏感信息的代码帧（对齐客户端已审定 CLI 的安全修复语义）。
 */

import { pathToFileURL } from 'node:url';

import { parseCorsOrigins } from './cors';
import { GatewayServer } from './server';

export interface CliArgs {
  port: number;
  tunnelPath?: string | undefined;
  selectPath?: string | undefined;
  help: boolean;
}

const USAGE = '用法: harness-server [--port <3081>] [--tunnel-path <path>] [--select-path <path>]\n'
  + '环境变量: HARNESS_CORS_ORIGINS —— 逗号分隔的 CORS 允许名单（默认 *.7qbjs.com,*.jd.com,localhost,127.0.0.1；* 全放行）';

/** 单行诊断：只取 message 首行，剥离堆栈与代码帧 */
function singleLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0] ?? '';
}

/** 解析 CLI 参数；非法值抛错 */
export function parseArgs(argv: string[]): CliArgs {
  let port = 3081;
  let tunnelPath: string | undefined;
  let selectPath: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--port') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`--port 非法: ${value}（须 0-65535 整数）`);
      }
      port = parsed;
    } else if (arg === '--tunnel-path') {
      tunnelPath = argv[++i];
      if (!tunnelPath) throw new Error('--tunnel-path 缺参数值');
    } else if (arg === '--select-path') {
      selectPath = argv[++i];
      if (!selectPath) throw new Error('--select-path 缺参数值');
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { port, tunnelPath, selectPath, help };
}

/** 主流程：返回退出码（0 正常；1 失败） */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[harness-server] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.info(USAGE);
    return 0;
  }
  // GatewayServer 构造对保留前缀外的 tunnelPath/selectPath 抛错：CLI 层单行诊断后返回 1
  let server: GatewayServer;
  try {
    server = new GatewayServer({
      port: args.port,
      tunnelPath: args.tunnelPath,
      selectPath: args.selectPath,
      corsOrigins: parseCorsOrigins(process.env['HARNESS_CORS_ORIGINS']),
    });
  } catch (err) {
    console.error(`[harness-server] 配置非法: ${singleLine(err)}`);
    return 1;
  }
  // 优雅关停：SIGINT/SIGTERM → close() 后退出。
  // force-exit 定时器兜底：对端不应答 WS 关闭握手等极端情况 close() 可能超窗，
  // 优雅窗口（5s）后强制退出，进程不得永久悬挂
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
    console.info(`[harness-server] 网关就绪 http://localhost:${port}（隧道 ${args.tunnelPath ?? '/__gateway__/tunnel'}）`);
    return 0; // 进程由 http.Server 保活
  } catch (err) {
    console.error(`[harness-server] 启动失败: ${singleLine(err)}`);
    return 1;
  }
}

// 入口守卫：仅直接执行时运行（测试 import 不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
