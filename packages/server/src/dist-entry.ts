#!/usr/bin/env node
/**
 * dist 部署入口 — esbuild 单文件打包专用（scripts/build.mjs → dist/index.cjs）。
 * 与 cli.ts 的区别：面向「拷贝单文件到目标机直接 node 运行」的部署场景，
 * 不支持 CLI 参数，端口只读环境变量 HARNESS_GATEWAY_PORT（未设置/非法 → 9000）。
 * 安全红线同 cli.ts：错误只输出单行诊断（err.message 首行），不打印原始堆栈/代码帧。
 */

import { GatewayServer } from './server';

/** 部署默认端口：HARNESS_GATEWAY_PORT 缺失或非法时的回落值 */
const DEFAULT_PORT = 9000;

/** 单行诊断：只取 message 首行，剥离堆栈与代码帧 */
function singleLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).split('\n')[0] ?? '';
}

/**
 * 解析监听端口：HARNESS_GATEWAY_PORT 为 1-65535 整数时采用，否则回落 9000。
 * 部署场景排除 0（随机端口对部署无意义）；非法但已设置时打 WARN 便于运维发现配置笔误。
 */
function resolvePort(env: string | undefined): number {
  if (env === undefined || env === '') return DEFAULT_PORT;
  const parsed = Number(env);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  console.warn(`[harness-server] HARNESS_GATEWAY_PORT 非法: ${env}（须 1-65535 整数），回落 ${DEFAULT_PORT}`);
  return DEFAULT_PORT;
}

/** 主流程：返回退出码（0 正常；1 失败） */
async function main(): Promise<number> {
  const port = resolvePort(process.env.HARNESS_GATEWAY_PORT);
  let server: GatewayServer;
  try {
    server = new GatewayServer({ port });
  } catch (err) {
    console.error(`[harness-server] 配置非法: ${singleLine(err)}`);
    return 1;
  }
  // 优雅关停：SIGINT/SIGTERM → close() 后退出。
  // force-exit 定时器兜底：对端不应答 WS 关闭握手等极端情况 close() 可能超窗，
  // 优雅窗口（5s）后强制退出，进程不得永久悬挂（语义同 cli.ts）
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
    const actual = await server.listen();
    console.info(`[harness-server] 网关就绪 http://localhost:${actual}（隧道 /__gateway__/tunnel）`);
    return 0; // 进程由 http.Server 保活
  } catch (err) {
    console.error(`[harness-server] 启动失败: ${singleLine(err)}`);
    return 1;
  }
}

void main().then((code) => {
  if (code !== 0) process.exit(code);
});
