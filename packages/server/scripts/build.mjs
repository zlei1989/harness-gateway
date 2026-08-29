#!/usr/bin/env node
/**
 * gateway-server 单文件打包脚本 — esbuild API 直调（无配置文件）。
 * 产物 dist/index.cjs：CJS、零依赖（ws 已内联），拷贝到目标机后
 * 仅需 Node 20+，以 HARNESS_GATEWAY_PORT 指定端口（默认 9000）运行：
 *   HARNESS_GATEWAY_PORT=8080 node index.cjs
 * 注意：必须 .cjs 扩展名——本包 type:module，命名 .js 时 Node 按 ESM
 * 解析产物中的 require，启动即崩（dist-bundle.test.ts 有回归看守）。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, '../src/dist-entry.ts')],
  outfile: join(here, '../dist/index.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // ws 的可选原生加速依赖：不打进包里；运行时 require 失败被 ws 内部 try/catch 捕获，自动回退纯 JS 实现
  external: ['bufferutil', 'utf-8-validate'],
  logLevel: 'info',
});
