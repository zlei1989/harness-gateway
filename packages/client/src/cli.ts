#!/usr/bin/env node
/**
 * harness-client CLI — 加载 JS 配置文件并启动客户端。
 * 用法：harness-client [--config ./client.config.mjs]
 * 注意：本文件由 bin/harness-client.mjs 以 tsx 启动（仓库为 TS 源码直出，无构建产物）；
 * main() 返回退出码而非直接 process.exit，便于测试。
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client, type ClientOptions } from './index';

export interface CliArgs {
  config: string;
  help: boolean;
}

const USAGE = '用法: harness-client [--config <path>]  （默认 ./client.config.mjs）';

/** 解析 CLI 参数；未知参数抛错 */
export function parseArgs(argv: string[]): CliArgs {
  let config = './client.config.mjs';
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error('--config 缺参数值');
      config = value;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { config, help };
}

/** 加载配置文件：必须 export default 一个 ClientOptions 对象 */
export async function loadConfig(configPath: string): Promise<ClientOptions> {
  const mod = (await import(pathToFileURL(resolve(configPath)).href)) as { default?: unknown };
  if (typeof mod.default !== 'object' || mod.default === null) {
    throw new Error('配置文件必须 export default 一个对象');
  }
  return mod.default as ClientOptions;
}

/** 主流程：返回进程退出码（0 正常；1 失败） */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[harness-client] ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 1;
  }
  if (args.help) {
    console.info(USAGE);
    return 0;
  }

  let options: ClientOptions;
  try {
    options = await loadConfig(args.config);
  } catch (err) {
    // 安全红线：SyntaxError 的 message/stack 自带代码帧（出错行源码 + caret），
    // 若语法错误落在 token 所在行会回显 token 值；故只打印 err.name + message 首行，去除代码帧
    const firstLine = String((err as Error | undefined)?.message ?? err).split('\n')[0];
    const errName = (err as Error | undefined)?.name ?? 'Error';
    console.error(`[harness-client] 加载配置失败 ${errName}: ${firstLine}`);
    return 1;
  }

  let client: Client;
  try {
    client = new Client(options);
  } catch (err) {
    console.error('[harness-client] 配置非法', err);
    return 1;
  }
  // EventEmitter 语义：'error' 必须挂监听，否则进程抛异常退出
  client.on('error', (err: Error) => console.error('[harness-client] 客户端错误', err.message));

  // 优雅关停：SIGINT/SIGTERM → close() 后退出
  const shutdown = (): void => {
    void client.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
  } catch (err) {
    console.error('[harness-client] 连接网关失败', err);
    return 1;
  }
  console.info(`[harness-client] 隧道就绪 hostname=${options.hostname} tunnelId=${client.tunnelId ?? '-'} gateway=${options.gatewayUrl}`);
  return 0; // 进程由活跃隧道连接保活
}

// 入口守卫：仅直接执行时运行（测试 import 不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
