# gateway-proxy 轻量化代理 CLI 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 monorepo 新增 `packages/proxy`：纯 TCP 透传代理 CLI（默认监听 9080 → 127.0.0.1:9000），带连接准入限流（8/s 排队）与全局带宽限流（50 KB/s 双向共享），HTTP/WS 天然支持。

**Architecture:** 纯 TCP 透传（方案 B）：`net.createServer` 接收入站连接 → 连接准入令牌桶（FIFO 排队等待）→ `net.connect` 到 target → 双向各插一个 `ThrottleStream`（Transform），每个 chunk 先向全局带宽令牌桶申请令牌再下发，形成背压延迟。零运行时依赖（tsx 除外，对齐兄弟包）。

**Tech Stack:** Node 20+、TypeScript ESM、tsx、vitest、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-27-gateway-proxy-design.md`

## Global Constraints

- 默认：监听 `9080`，转发 `127.0.0.1:9000`，连接准入 `8/s`（容量 8，每 125ms 补 1），带宽 `51200 B/s`（容量 51200，每 100ms 补 5120）
- 限流超出一律**等待/延迟**，不拒绝、不丢数据
- 零运行时依赖：只用 Node 内置模块（`tsx` 为运行器，对齐兄弟包计入 dependencies）
- 仅允许 pnpm 安装依赖（根 preinstall 强制）
- 代码风格：ESM、`'use strict'` 不需要、单引号分号、中文注释（对齐现有包）；错误输出单行诊断
- 裸 socket 一律先挂 `error` 消化监听（对齐 server 包裸 socket 事故修复模式）
- 工作树有历史未提交改动：每步 commit 只 add 本计划涉及的文件

---

### Task 1: 包脚手架

**Files:**
- Create: `packages/proxy/package.json`
- Create: `packages/proxy/tsconfig.json`
- Create: `packages/proxy/vitest.config.ts`
- Create: `packages/proxy/eslint.config.ts`
- Create: `packages/proxy/bin/harness-proxy.mjs`
- Create: `packages/proxy/src/index.ts`（占位，Task 5 补全导出）

**Interfaces:**
- Consumes: 无
- Produces: 包名 `gateway-proxy`；bin `harness-proxy`；脚本 `start/typecheck/format/test`

- [ ] **Step 1: 写 `packages/proxy/package.json`**

```json
{
  "name": "gateway-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "bin": {
    "harness-proxy": "./bin/harness-proxy.mjs"
  },
  "scripts": {
    "start": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit",
    "format": "eslint . --fix",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "tsx": "^4.19.2"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "eslint": "^9",
    "jiti": "^2.7.0",
    "typescript": "^5",
    "typescript-eslint": "^8.61.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: 写 `packages/proxy/tsconfig.json`（与 server 包一致）**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: 写 `packages/proxy/vitest.config.ts`（与 server 包一致）**

```ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 写 `packages/proxy/eslint.config.ts`（与 server 包一致）**

```ts
/**
 * ESLint 9 flat config — gateway-proxy。
 * 使用统一格式规则（根 eslint.shared.ts）+ TypeScript recommended 基线。
 */
import tseslint from "typescript-eslint";
import { sharedFormatRules } from "../../eslint.shared";

export default tseslint.config(
  ...tseslint.configs.recommended,
  // 统一格式规则
  ...sharedFormatRules,
  // 忽略构建产物与配置文件
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  },
);
```

- [ ] **Step 5: 写 `packages/proxy/bin/harness-proxy.mjs`（复制 server 启动器模式）**

```js
#!/usr/bin/env node
/**
 * harness-proxy bin 启动器 — 以 tsx 运行 TS 源码入口。
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
```

- [ ] **Step 6: 写占位 `packages/proxy/src/index.ts`（Task 5 补全导出）**

```ts
export {};
```

- [ ] **Step 7: 安装依赖并验证空跑**

Run: `pnpm install && pnpm --filter gateway-proxy typecheck && pnpm --filter gateway-proxy test`
Expected: install 成功；typecheck PASS；test PASS（passWithNoTests）

- [ ] **Step 8: Commit**

```bash
git add packages/proxy
git commit -m "feat: gateway-proxy 包脚手架——对齐 monorepo tsx/vitest/eslint 模式"
```

---

### Task 2: 令牌桶限流器（rate-limiter.ts）

**Files:**
- Create: `packages/proxy/src/rate-limiter.ts`
- Test: `packages/proxy/src/rate-limiter.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class TokenBucket { constructor(options: TokenBucketOptions); acquire(cost: number, onQueued?: (cancel: () => void) => void): Promise<void>; close(): void }`
  - `interface TokenBucketOptions { capacity: number; refillPerSecond: number; intervalMs: number }`
  - `class ConnectionLimiter { constructor(maxPerSecond: number); acquire(socket: Socket): Promise<void>; close(): void }`
  - `class BandwidthLimiter { constructor(maxBytesPerSecond: number); acquire(bytes: number): Promise<void>; close(): void }`
  - 语义：容量内立即放行；不足 FIFO 挂起、匀速补充后严格队首唤醒；`cost > capacity` 按容量切片累计；`onQueued` 回调取消函数（从队列剔除，该 Promise 永挂起）

- [ ] **Step 1: 写失败测试 `packages/proxy/src/rate-limiter.test.ts`**

```ts
import { Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionLimiter, TokenBucket } from './rate-limiter';

describe('TokenBucket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('容量内立即放行', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, intervalMs: 500 });
    await bucket.acquire(1);
    await bucket.acquire(2); // 恰好清空
    bucket.close();
  });

  it('耗尽后按节拍补充并严格 FIFO 唤醒', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, intervalMs: 500 }); // 每拍补 1
    const order: string[] = [];
    await bucket.acquire(2); // 清空
    void bucket.acquire(1).then(() => order.push('a'));
    void bucket.acquire(1).then(() => order.push('b'));
    await vi.advanceTimersByTimeAsync(499);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); // 第 500ms 补 1 → a
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(500); // 再补 1 → b
    expect(order).toEqual(['a', 'b']);
    bucket.close();
  });

  it('cost 超容量时按容量切片累计等待', async () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 10, intervalMs: 100 }); // 每拍补 1
    let done = false;
    const p = bucket.acquire(25).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0); // t0 立即扣 10（容量），余 15 排队
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); // +10 → 第二片
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500); // +5 → 第三片
    await p;
    expect(done).toBe(true);
    bucket.close();
  });

  it('onQueued 取消：从队列剔除且永挂起，token 留给后来者', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 1, intervalMs: 100 });
    await bucket.acquire(1); // 清空
    let cancel: (() => void) | undefined;
    let resolved = false;
    void bucket.acquire(1, (c) => {
      cancel = c;
    }).then(() => {
      resolved = true;
    });
    cancel?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
    await bucket.acquire(1); // token 未被偷走，立即可得
    bucket.close();
  });
});

describe('ConnectionLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('容量内立即准入，超出按节拍放行；排队中 socket close 取消', async () => {
    const limiter = new ConnectionLimiter(4); // 容量 4，每 250ms 补 1
    const admitted: number[] = [];
    const sockets = Array.from({ length: 6 }, () => new Socket());
    sockets.forEach((s, i) => void limiter.acquire(s).then(() => admitted.push(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual([0, 1, 2, 3]);
    sockets[5]?.emit('close'); // 第 6 个排队中断开 → 出队
    await vi.advanceTimersByTimeAsync(250); // 补 1 → 第 5 个放行
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(1000); // 再补 4；已取消者永不放行
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    limiter.close();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-proxy test`
Expected: FAIL —— `Cannot find module './rate-limiter'`

- [ ] **Step 3: 实现 `packages/proxy/src/rate-limiter.ts`**

```ts
/**
 * 令牌桶限流（spec §4.1）。
 * TokenBucket：匀速补充 + FIFO 挂起唤醒；acquire(cost) 支持大于容量的切片累计。
 * ConnectionLimiter：新建连接准入（默认 8/s），排队中 socket close 自动取消（Promise 永挂起）。
 * BandwidthLimiter：全局带宽（默认 51200 B/s），上下行所有连接共享一个桶。
 */

import type { Socket } from 'node:net';

export interface TokenBucketOptions {
  /** 容量（突发上限），token 不超此值 */
  capacity: number;
  /** 每秒补充 token 数 */
  refillPerSecond: number;
  /** 补充节拍（毫秒）；每拍补 refillPerSecond * intervalMs / 1000 */
  intervalMs: number;
}

interface Waiter {
  cost: number;
  resolve: () => void;
}

/** 令牌桶基元：匀速补充；FIFO 严格队首唤醒（不跳过，防插队饿死） */
export class TokenBucket {
  private tokens: number;
  private readonly queue: Waiter[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillPerSecond <= 0 || options.intervalMs <= 0) {
      throw new Error('TokenBucket 参数须为正数');
    }
    this.tokens = options.capacity;
    this.timer = setInterval(() => this.refill(), options.intervalMs);
    this.timer.unref(); // 不阻止进程退出
  }

  /**
   * 申请 cost 个 token；不足时 FIFO 挂起。
   * cost > capacity 时按容量切片累计等待（大 chunk 不死锁）。
   * onQueued：进入队列时回调取消函数（从队列剔除，Promise 永挂起）。
   */
  async acquire(cost: number, onQueued?: (cancel: () => void) => void): Promise<void> {
    let remaining = cost;
    let first = true;
    while (remaining > 0) {
      const slice = Math.min(remaining, this.options.capacity);
      await this.acquireSlice(slice, first ? onQueued : undefined);
      first = false;
      remaining -= slice;
    }
  }

  private acquireSlice(cost: number, onQueued?: (cancel: () => void) => void): Promise<void> {
    if (this.queue.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { cost, resolve };
      this.queue.push(waiter);
      onQueued?.(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      });
    });
  }

  private refill(): void {
    const add = (this.options.refillPerSecond * this.options.intervalMs) / 1000;
    this.tokens = Math.min(this.options.capacity, this.tokens + add);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined || this.tokens < head.cost) return;
      this.tokens -= head.cost;
      this.queue.shift();
      head.resolve();
    }
  }

  /** 停止补充定时器（close 后桶不再补充，挂起的 acquire 永挂起） */
  close(): void {
    clearInterval(this.timer);
  }
}

/** 新建连接准入：默认 8/s（每 125ms 补 1，容量 8） */
export class ConnectionLimiter {
  private readonly bucket: TokenBucket;

  constructor(maxPerSecond: number) {
    this.bucket = new TokenBucket({
      capacity: maxPerSecond,
      refillPerSecond: maxPerSecond,
      intervalMs: Math.max(1, Math.floor(1000 / maxPerSecond)),
    });
  }

  /** 等待准入；排队期间 socket close → 出队取消（Promise 永挂起，调用方随 close 收尾） */
  acquire(socket: Socket): Promise<void> {
    if (socket.destroyed) return new Promise(() => {});
    return this.bucket.acquire(1, (cancel) => socket.once('close', cancel));
  }

  close(): void {
    this.bucket.close();
  }
}

/** 全局带宽：默认 51200 B/s（每 100ms 补 1/10，容量为 1s 突发） */
export class BandwidthLimiter {
  private readonly bucket: TokenBucket;

  constructor(maxBytesPerSecond: number) {
    this.bucket = new TokenBucket({
      capacity: maxBytesPerSecond,
      refillPerSecond: maxBytesPerSecond,
      intervalMs: 100,
    });
  }

  acquire(bytes: number): Promise<void> {
    return this.bucket.acquire(bytes);
  }

  close(): void {
    this.bucket.close();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-proxy test`
Expected: PASS（rate-limiter.test.ts 5 个用例）

- [ ] **Step 5: 格式化 + typecheck + Commit**

```bash
pnpm --filter gateway-proxy format
pnpm --filter gateway-proxy typecheck
git add packages/proxy/src/rate-limiter.ts packages/proxy/src/rate-limiter.test.ts
git commit -m "feat: gateway-proxy 令牌桶限流器——连接准入 8/s FIFO 排队 + 全局带宽桶"
```

---

### Task 3: 节流 Transform（throttle.ts）

**Files:**
- Create: `packages/proxy/src/throttle.ts`
- Test: `packages/proxy/src/throttle.test.ts`

**Interfaces:**
- Consumes: `BandwidthLimiter`（Task 2）
- Produces: `class ThrottleStream extends Transform { constructor(limiter: BandwidthLimiter) }` —— 每 chunk 先 `await limiter.acquire(chunk.length)` 再下发

- [ ] **Step 1: 写失败测试 `packages/proxy/src/throttle.test.ts`（真实定时器）**

```ts
import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { BandwidthLimiter } from './rate-limiter';
import { ThrottleStream } from './throttle';

describe('ThrottleStream', () => {
  it('数据完整透传，且受带宽桶节流', async () => {
    const limiter = new BandwidthLimiter(100); // 容量 100，每 100ms 补 10
    const chunks = [Buffer.alloc(50, 1), Buffer.alloc(50, 2), Buffer.alloc(50, 3)];
    const startedAt = Date.now();
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const throttle = new ThrottleStream(limiter);
      Readable.from(chunks)
        .pipe(throttle)
        .on('data', (chunk: Buffer) => received.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    limiter.close();
    expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
    // 前两片吃容量（100B），第三片 50B 需等 50/10 = 5 拍 = 500ms
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400); // 保守下界防抖动
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-proxy test`
Expected: FAIL —— `Cannot find module './throttle'`

- [ ] **Step 3: 实现 `packages/proxy/src/throttle.ts`**

```ts
/**
 * 节流 Transform（spec §4.2）：每 chunk 先向全局带宽桶申请令牌再下发；
 * 令牌不足即挂起等待——上游背压暂停读取，只延迟不丢数据。
 */

import { Transform, type TransformCallback } from 'node:stream';

import type { BandwidthLimiter } from './rate-limiter';

export class ThrottleStream extends Transform {
  constructor(private readonly limiter: BandwidthLimiter) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.limiter.acquire(chunk.length).then(
      () => callback(null, chunk),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-proxy test`
Expected: PASS（含 throttle.test.ts 1 个用例）

- [ ] **Step 5: 格式化 + typecheck + Commit**

```bash
pnpm --filter gateway-proxy format
pnpm --filter gateway-proxy typecheck
git add packages/proxy/src/throttle.ts packages/proxy/src/throttle.test.ts
git commit -m "feat: gateway-proxy 节流 Transform——chunk 级带宽令牌申请与背压"
```

---

### Task 4: TCP 代理服务器（server.ts）

**Files:**
- Create: `packages/proxy/src/server.ts`
- Test: `packages/proxy/src/server.test.ts`

**Interfaces:**
- Consumes: `ConnectionLimiter`、`BandwidthLimiter`（Task 2）、`ThrottleStream`（Task 3）
- Produces:
  - `interface ProxyLogger { info(message: string, context?: Record<string, unknown>): void; warn(...): void; error(...): void }`
  - `interface ProxyServerOptions { listenPort: number; targetHost: string; targetPort: number; maxConnectionsPerSecond: number; maxBytesPerSecond: number; logger?: ProxyLogger | undefined }`
  - `class ProxyServer { constructor(options: ProxyServerOptions); listen(): Promise<number>; close(): Promise<void> }`
  - 行为：入站连接先挂 `error` 消化 → 准入排队（close 自动取消）→ 准入后 `net.connect(target)`，失败销毁客户端 → 双向 `pipe(ThrottleStream).pipe()` → 任一侧 close/error 双侧销毁

- [ ] **Step 1: 写失败测试 `packages/proxy/src/server.test.ts`（集成，真实定时器，随机端口）**

```ts
import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ProxyServer } from './server';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 本地 echo target：原样回写收到的字节 */
async function startEchoTarget(): Promise<{ port: number }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { port: typeof address === 'object' && address !== null ? address.port : 0 };
}

async function startProxy(options: {
  targetPort: number;
  maxConnectionsPerSecond: number;
  maxBytesPerSecond: number;
}): Promise<number> {
  const proxy = new ProxyServer({
    listenPort: 0,
    targetHost: '127.0.0.1',
    targetPort: options.targetPort,
    maxConnectionsPerSecond: options.maxConnectionsPerSecond,
    maxBytesPerSecond: options.maxBytesPerSecond,
  });
  cleanups.push(() => proxy.close());
  return proxy.listen();
}

describe('ProxyServer', () => {
  it('HTTP 请求经代理往返成功', async () => {
    const target = http.createServer((req, res) => res.end(`ok:${req.url}`));
    cleanups.push(() => closeServer(target));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({ targetPort, maxConnectionsPerSecond: 1000, maxBytesPerSecond: 10 * 1024 * 1024 });
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/hello?x=1`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }).on('error', reject);
    });
    expect(body).toBe('ok:/hello?x=1');
  });

  it('WS Upgrade 握手与后续帧透传', async () => {
    const sockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', (frame) => socket.write(frame)); // echo 后续帧
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(target);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({ targetPort, maxConnectionsPerSecond: 1000, maxBytesPerSecond: 10 * 1024 * 1024 });

    const client = net.connect(proxyPort, '127.0.0.1');
    cleanups.push(() => client.destroy());
    client.write(
      'GET /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    let buffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      client.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.includes('\r\n\r\n')) resolve();
      });
      client.on('error', reject);
    });
    expect(buffer.toString('utf8').startsWith('HTTP/1.1 101')).toBe(true);
    // 握手后帧透传（echo）
    const echoed = new Promise<Buffer>((resolve) => {
      client.once('data', resolve);
    });
    client.write('ping-frame');
    expect((await echoed).toString('utf8')).toBe('ping-frame');
  });

  it('连接准入节奏：容量内立即放行，超出按节拍排队', async () => {
    const { port: targetPort } = await startEchoTarget();
    const proxyPort = await startProxy({ targetPort, maxConnectionsPerSecond: 4, maxBytesPerSecond: 10 * 1024 * 1024 });
    const startedAt = Date.now();
    const admittedAt: number[] = [];
    await Promise.all(Array.from({ length: 12 }, () =>
      new Promise<void>((resolve, reject) => {
        const client = net.connect(proxyPort, '127.0.0.1', () => client.write('x'));
        cleanups.push(() => client.destroy());
        client.once('data', () => {
          admittedAt.push(Date.now() - startedAt);
          resolve();
        });
        client.on('error', reject);
      })));
    admittedAt.sort((a, b) => a - b);
    // 前 4 个立即准入（本地 echo，远小于一拍 250ms）
    expect(admittedAt[3]).toBeLessThan(500);
    // 第 12 个需等 8 拍 × 250ms = 2000ms，断言保守下界
    expect(admittedAt[11]).toBeGreaterThanOrEqual(1500);
  }, 15000);

  it('带宽节流：共享桶下双向字节合计受限', async () => {
    // target：收满 600 字节后回 'done'（4 字节）
    const sockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let received = 0;
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received >= 600) socket.write('done');
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(target);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({ targetPort, maxConnectionsPerSecond: 100, maxBytesPerSecond: 200 });

    const startedAt = Date.now();
    const client = net.connect(proxyPort, '127.0.0.1');
    cleanups.push(() => client.destroy());
    await new Promise<void>((resolve, reject) => {
      client.once('data', () => resolve());
      client.on('error', reject);
      client.on('connect', () => client.write(Buffer.alloc(600, 1)));
    });
    // 双向合计 604B，容量 200 先行放走，余 404B 按 200B/s 补充 → 理论约 2s
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1500); // 保守下界防 CI 抖动
  }, 15000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-proxy test`
Expected: FAIL —— `Cannot find module './server'`

- [ ] **Step 3: 实现 `packages/proxy/src/server.ts`**

```ts
/**
 * TCP 透传代理服务器（spec §4.3）。
 * 入站连接先过连接准入令牌桶（FIFO 排队等待，close 自动取消），准入后对接 target 并双向节流透传。
 * HTTP 与 WS 均为 TCP 字节流，天然透传。裸 socket 一律先挂 error 消化监听
 * （对齐 server 包裸 socket 事故修复模式：未处理 error 会崩进程）。
 */

import net from 'node:net';

import { BandwidthLimiter, ConnectionLimiter } from './rate-limiter';
import { ThrottleStream } from './throttle';

export interface ProxyLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ProxyServerOptions {
  listenPort: number;
  targetHost: string;
  targetPort: number;
  maxConnectionsPerSecond: number;
  maxBytesPerSecond: number;
  logger?: ProxyLogger | undefined;
}

/** 静默 logger（缺省）：库用法/测试不传 logger 时不喷控制台 */
const noopLogger: ProxyLogger = { info: () => {}, warn: () => {}, error: () => {} };

export class ProxyServer {
  private readonly connectionLimiter: ConnectionLimiter;
  private readonly bandwidth: BandwidthLimiter;
  private readonly logger: ProxyLogger;
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly options: ProxyServerOptions) {
    this.connectionLimiter = new ConnectionLimiter(options.maxConnectionsPerSecond);
    this.bandwidth = new BandwidthLimiter(options.maxBytesPerSecond);
    this.logger = options.logger ?? noopLogger;
  }

  /** 启动监听；返回实际端口（传 0 时取随机端口，供测试） */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      this.server = server;
      server.on('error', reject);
      server.listen(this.options.listenPort, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address !== null ? address.port : this.options.listenPort);
      });
    });
  }

  /** 关停：停止 accept，销毁全部在途与排队连接，停止限流器定时器 */
  close(): Promise<void> {
    this.connectionLimiter.close();
    this.bandwidth.close();
    for (const socket of this.sockets) socket.destroy();
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
  }

  private onConnection(client: net.Socket): void {
    this.track(client);
    // 裸 socket error 消化：排队/准入窗内对端 RST 不得以未处理 error 崩进程
    client.on('error', (err) => this.logger.warn('客户端 socket 错误', { error: err.message }));
    void this.connectionLimiter.acquire(client).then(() => this.admit(client));
  }

  private admit(client: net.Socket): void {
    if (client.destroyed) return; // 排队后已断开的时序兜底
    const { targetHost, targetPort } = this.options;
    const target = net.connect({ host: targetHost, port: targetPort });
    this.track(target);
    target.on('error', (err) => {
      this.logger.warn('目标连接失败/错误', { error: err.message, target: `${targetHost}:${targetPort}` });
      client.destroy();
    });
    client.on('close', () => target.destroy());
    target.on('close', () => client.destroy());
    client.pipe(new ThrottleStream(this.bandwidth)).pipe(target);
    target.pipe(new ThrottleStream(this.bandwidth)).pipe(client);
    this.logger.info('连接准入', { remote: client.remoteAddress, target: `${targetHost}:${targetPort}` });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-proxy test`
Expected: PASS（含 server.test.ts 4 个用例）

- [ ] **Step 5: 格式化 + typecheck + Commit**

```bash
pnpm --filter gateway-proxy format
pnpm --filter gateway-proxy typecheck
git add packages/proxy/src/server.ts packages/proxy/src/server.test.ts
git commit -m "feat: gateway-proxy TCP 透传服务器——准入排队 + 双向节流管道"
```

---

### Task 5: CLI 与包导出（cli.ts + index.ts）

**Files:**
- Create: `packages/proxy/src/cli.ts`
- Modify: `packages/proxy/src/index.ts`（占位改为完整导出）
- Test: `packages/proxy/src/cli.test.ts`

**Interfaces:**
- Consumes: `ProxyServer`、`ProxyLogger`（Task 4）
- Produces:
  - `interface CliArgs { listen: number; targetHost: string; targetPort: number; maxConnectionsPerSecond: number; maxBytesPerSecond: number; help: boolean }`
  - `parseArgs(argv: string[]): CliArgs`（非法值抛错）
  - `parseTarget(value: string): { host: string; port: number }`（支持 IPv6 `[::1]:9000`）
  - `parseBytesPerSecond(value: string): number`（支持 `k`/`m` 后缀，`50k` → 51200）
  - `main(argv: string[]): Promise<number>`（0 正常 / 1 失败）
  - `index.ts` 导出：`ProxyServer`、`ProxyServerOptions`、`ProxyLogger`、`TokenBucket`、`TokenBucketOptions`、`ConnectionLimiter`、`BandwidthLimiter`、`ThrottleStream`

- [ ] **Step 1: 写失败测试 `packages/proxy/src/cli.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parseArgs, parseBytesPerSecond, parseTarget } from './cli';

afterEach(() => vi.restoreAllMocks());

describe('parseArgs', () => {
  it('默认值', () => {
    expect(parseArgs([])).toEqual({
      listen: 9080,
      targetHost: '127.0.0.1',
      targetPort: 9000,
      maxConnectionsPerSecond: 8,
      maxBytesPerSecond: 51200,
      help: false,
    });
  });

  it('覆盖值', () => {
    expect(parseArgs([
      '--listen', '8080',
      '--target', 'localhost:8000',
      '--max-connections-per-second', '16',
      '--max-bytes-per-second', '100k',
    ])).toEqual({
      listen: 8080,
      targetHost: 'localhost',
      targetPort: 8000,
      maxConnectionsPerSecond: 16,
      maxBytesPerSecond: 102400,
      help: false,
    });
  });

  it.each([
    [['--listen', 'x']],
    [['--listen', '70000']],
    [['--target', 'nohost']],
    [['--max-connections-per-second', '0']],
    [['--max-bytes-per-second', '-5']],
    [['--unknown']],
  ])('非法值抛错 %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('parseTarget', () => {
  it('host:port', () => {
    expect(parseTarget('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
  });
  it('IPv6 方括号写法', () => {
    expect(parseTarget('[::1]:9000')).toEqual({ host: '::1', port: 9000 });
  });
  it('非法', () => {
    expect(() => parseTarget(':8080')).toThrow();
    expect(() => parseTarget('h:abc')).toThrow();
  });
});

describe('parseBytesPerSecond', () => {
  it('裸数字与 k/m 后缀', () => {
    expect(parseBytesPerSecond('51200')).toBe(51200);
    expect(parseBytesPerSecond('50k')).toBe(51200);
    expect(parseBytesPerSecond('2M')).toBe(2097152);
  });
  it('非法', () => {
    expect(() => parseBytesPerSecond('0')).toThrow();
    expect(() => parseBytesPerSecond('1.5k')).toThrow();
  });
});

describe('main', () => {
  it('--help 打印用法并返回 0', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
  });
  it('非法参数单行诊断并返回 1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--listen', 'bad'])).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-proxy test`
Expected: FAIL —— `Cannot find module './cli'`

- [ ] **Step 3: 实现 `packages/proxy/src/cli.ts`**

```ts
#!/usr/bin/env node
/**
 * harness-proxy CLI — 纯参数启动（spec §4.4，对齐 harness-server cli 模式）。
 * 用法：harness-proxy [--listen 9080] [--target 127.0.0.1:9000]
 *       [--max-connections-per-second 8] [--max-bytes-per-second 51200|50k]
 * 安全红线：错误只输出单行诊断（err.message 首行），不打印堆栈；
 * main() 返回退出码便于测试；SIGINT/SIGTERM 优雅关停 + 5s 兜底强退。
 */

import { pathToFileURL } from 'node:url';

import { ProxyServer, type ProxyLogger } from './server';

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
  const match = /^\[(?<host>[^\]]+)\]:(?<port>\d+)$/.exec(value) ?? /^(?<host>[^:]+):(?<port>\d+)$/.exec(value);
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
```

- [ ] **Step 4: 补全 `packages/proxy/src/index.ts` 导出（整文件替换占位）**

```ts
export { BandwidthLimiter, ConnectionLimiter, TokenBucket, type TokenBucketOptions } from './rate-limiter';
export { ThrottleStream } from './throttle';
export { ProxyServer, type ProxyLogger, type ProxyServerOptions } from './server';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter gateway-proxy test`
Expected: PASS（含 cli.test.ts）

- [ ] **Step 6: 格式化 + typecheck + Commit**

```bash
pnpm --filter gateway-proxy format
pnpm --filter gateway-proxy typecheck
git add packages/proxy/src/cli.ts packages/proxy/src/cli.test.ts packages/proxy/src/index.ts
git commit -m "feat: gateway-proxy CLI——纯参数启动、单行诊断、优雅关停，补全包导出"
```

---

### Task 6: 根脚本接入与全量验证

**Files:**
- Modify: `package.json`（根，加 `proxy` 脚本）

**Interfaces:**
- Consumes: 以上全部
- Produces: 根 `pnpm proxy` 快捷启动

- [ ] **Step 1: 根 `package.json` 的 scripts 中 `"format"` 与 `"server"` 之间插入一行**

修改前：
```json
    "format": "pnpm -r format",
    "server": "pnpm --filter gateway-server start",
```
修改后：
```json
    "format": "pnpm -r format",
    "proxy": "pnpm --filter gateway-proxy start",
    "server": "pnpm --filter gateway-server start",
```

- [ ] **Step 2: 全量验证**

Run: `pnpm -r typecheck && pnpm --filter gateway-proxy test`
Expected: 三个包 typecheck 全部 PASS；proxy 测试全部 PASS

- [ ] **Step 3: 冒烟验证 CLI 实际启动**

Run: `pnpm proxy -- --help`
Expected: 打印用法行（含 `--listen` / `--target` / `--max-connections-per-second` / `--max-bytes-per-second`），退出码 0

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat: 根脚本接入 gateway-proxy——pnpm proxy 快捷启动"
```

---

## Self-Review 记录

- Spec §2 默认端口/限流口径 → Task 1（包）、Task 5（CLI 默认值）覆盖 ✓
- Spec §3 数据流 / §4.3 server → Task 4 覆盖 ✓
- Spec §4.1 限流器 → Task 2；§4.2 throttle → Task 3；§4.4 CLI → Task 5；§4.5 包文件 → Task 1 ✓
- Spec §5 错误与边界 → Task 4 server 实现（error 消化、双侧销毁、排队取消、大 chunk 切片）✓
- Spec §6 测试计划 → Task 2/3/4/5 各测试文件一一对应 ✓
- 类型一致性：`acquire(cost, onQueued?)`、`ThrottleStream(limiter)`、`ProxyServerOptions`、`CliArgs` 跨任务引用一致 ✓
