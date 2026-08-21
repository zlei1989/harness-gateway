#!/usr/bin/env node
/**
 * harness-client bin 启动器 — 以 tsx 运行 TS 源码入口。
 * 仓库包为 TS 源码直出（无构建产物），Node 20 无类型剥离，故经 tsx 加载。
 * stdio 继承 + 退出码透传；信号由控制台进程组语义直达子进程。
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(here, '../src/cli.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
