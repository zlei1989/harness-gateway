/**
 * dist 单文件打包回归测试 — 真实执行 scripts/build.mjs，再用 node 启动产物请求选择页，
 * 验证「拷贝单文件到目标机直接 node 运行」部署路径可用。
 * 历史回归：产物为 CJS 但命名 dist/index.js，包 type:module 下 Node 按 ESM 解析、
 * require 未定义启动即崩——CJS 产物必须带 .cjs 扩展名（与本包源码直出运行时无关，
 * 仅约束打包脚本输出）。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { ChildProcess } from 'node:child_process';

const execFileAsync = promisify(execFile);
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(pkgDir, 'dist', 'index.cjs');

/** 取一个空闲端口（listen 0 后立即释放，窄窗口竞争在测试环境可接受） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr !== null ? addr.port : 0));
    });
  });
}

/** 等子进程 stdout 出现指定片段（启动就绪信号），超时拒绝 */
function waitForStdout(child: ChildProcess, marker: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`等「${marker}」超时，已输出: ${buf}`)), timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (buf.includes(marker)) { clearTimeout(timer); resolve(buf); }
    });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`进程提前退出 code=${code}，输出: ${buf}`)); });
  });
}

/** 终止子进程：先 SIGTERM，3s 未退则 SIGKILL 兜底，防测试悬挂 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const winner = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))]);
  if (winner === 'timeout') { child.kill('SIGKILL'); await exited; }
}

describe('dist 单文件打包', () => {
  it('build.mjs 产出 dist/index.cjs，node 直跑可提供选择页（部署回归）', { timeout: 30000 }, async () => {
    // 真实跑打包脚本（esbuild 毫秒级），产物须为 .cjs —— type:module 包内 .js 会被按 ESM 解析
    await execFileAsync(process.execPath, [join(pkgDir, 'scripts', 'build.mjs')], { cwd: pkgDir });
    expect(existsSync(bundle)).toBe(true);

    // 模拟目标机：直接 node 启动产物（不经 tsx），环境变量指定端口
    const port = await freePort();
    const child: ChildProcess = spawn(process.execPath, [bundle], {
      env: { ...process.env, HARNESS_GATEWAY_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForStdout(child, '网关就绪', 10000);
      const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('选择要连接的电脑');
    } finally {
      await stopChild(child);
    }
  });
});
