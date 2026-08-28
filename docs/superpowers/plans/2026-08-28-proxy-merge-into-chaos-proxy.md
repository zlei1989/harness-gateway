# proxy 并入 chaos-proxy 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 gateway-proxy 的限流语义（全局共享带宽 + 连接准入）注入 chaos-proxy，删除 proxy 整包，手动验证工具换成极简 throttle-proxy 脚本。

**Architecture:** chaos-proxy 泵模型上增加 `setThrottle(bps, 'shared')` 全局预算分配与 `setAdmissionRate(connPerSec)` FIFO 准入门控；新增 `packages/chaos-proxy/scripts/throttle-proxy.ts` 非产品化脚本承接手动验证；proxy 包与其 spec/plan 文档物理删除；AGENT.md 验证拓扑形态不变、仅工具名改写。

**Tech Stack:** Node 20 + tsx（TS 源码直出）、vitest、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-28-proxy-merge-into-chaos-proxy-design.md`

## Global Constraints

- 仅用 pnpm；根 `preinstall` 拒绝 npm/yarn。
- 代码变更后、进入审查前必须按序执行：`pnpm typecheck` → `pnpm format` → 修复所有错误（AGENT.md 约束）。
- chaos-proxy 库本体 zero runtime dep：tsx 只能进 devDependencies。
- `setThrottle(bps)` 不传 mode 行为必须与现状完全一致（client/server e2e-chaos 零改动回归不破）。
- 注释用中文 JSDoc，先说"做什么"再说"怎么做"（AGENT.md 注释规则）。
- 测试用 127.0.0.1 回环 + 随机端口（listenPort 用例除外）、真实定时器、`--passWithNoTests`。

---

### Task 1: chaos-proxy `setThrottle` shared 模式

**Files:**
- Modify: `packages/chaos-proxy/src/chaos-proxy.ts`
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Consumes: 现有 `pumpPipe(pipe, budgetBytes)` 与 10ms 泵循环（`throttleBps` 闭包变量）。
- Produces: `export type ChaosThrottleMode = 'per-conn' | 'shared'`（从 `chaos-proxy.ts` 与 `index.ts` 导出）；`setThrottle(bytesPerSec: number, mode?: ChaosThrottleMode): void`——Task 3 脚本以 `setThrottle(n, 'shared')` 消费。

- [ ] **Step 1: 写失败测试**

在 `packages/chaos-proxy/src/chaos-proxy.test.ts` 文件末尾追加：

```ts
describe('shared 限速（setThrottle mode）', () => {
  /** 两连接并行各传 size 字节，返回较慢连接的总耗时 */
  async function twoConnTransfer(mode: 'per-conn' | 'shared' | undefined, size: number): Promise<number> {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    if (mode === undefined) proxy.setThrottle(50_000);
    else proxy.setThrottle(50_000, mode);
    const startAt = Date.now();
    await Promise.all([dial(port), dial(port)].map((s) => new Promise<void>((resolve) => {
      let got = 0;
      s.on('data', (c: Buffer) => { got += c.length; if (got >= size) resolve(); });
      s.write(Buffer.alloc(size, 0x61)); // 未 connect 时内核缓冲，建连后发出
    })));
    return Date.now() - startAt;
  }

  it('shared：两连接共享 50KB/s，总量被全局预算钳制', async () => {
    const elapsed = await twoConnTransfer('shared', 50_000);
    // 理论 4s：4 pipe × 50KB = 200KB 共享一份 50KB/s 预算；保守下界 3s
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(15_000); // 上限防泵实现失控
  }, 20_000);

  it('per-conn（显式）：两连接各自独享，总耗时 ≈ 单连接', async () => {
    const elapsed = await twoConnTransfer('per-conn', 50_000);
    // 理论 ≈1s：每 pipe 50KB @ 50KB/s，两连接四 pipe 并行各自有预算
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2500); // 与 shared（≥3s）拉开区分度
  }, 10_000);

  it('不传 mode：缺省 per-conn（回归保护）', async () => {
    const elapsed = await twoConnTransfer(undefined, 50_000);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2500);
  }, 10_000);
});
```

- [ ] **Step 2: 跑测试确认 shared 用例失败**

Run: `pnpm --filter chaos-proxy test`
Expected: `shared：两连接共享 50KB/s` FAIL——现有实现忽略第二参数，按 per-conn 跑，elapsed ≈1s 不满足 `≥3000`；per-conn 与缺省两个用例 PASS。

- [ ] **Step 3: 实现 shared 模式**

`packages/chaos-proxy/src/chaos-proxy.ts` 共 5 处改动：

① 类型导出（放在 `ChaosDirection` 旁）：

```ts
export type ChaosThrottleMode = 'per-conn' | 'shared';
```

② `ChaosProxy` 接口签名改：

```ts
  setThrottle(bytesPerSec: number, mode?: ChaosThrottleMode): void;
```

③ `pumpPipe` 返回消耗量（shared 模式需要从未分配预算中扣减）。改函数签名与首尾：

```ts
  /** 泵送一 pipe；返回本次实际转发字节数（shared 模式据以扣全局预算） */
  function pumpPipe(pipe: Pipe, budgetBytes: number): number {
    if (pipe.blackholed) return 0;
    let budget = budgetBytes;
    // ……中间 while 循环、FIN 传播、resume 逻辑原样不动……
    return budgetBytes - budget;
  }
```

④ 泵循环：shared 时全场共享一份预算（迭代序先到先得，spec §3 明确不做公平轮转）：

```ts
  const pumpTimer = setInterval(() => {
    const now = Date.now();
    const perPipeBudget = throttleBps > 0 ? (throttleBps * PUMP_MS) / 1000 : Number.POSITIVE_INFINITY;
    let sharedRemaining = perPipeBudget; // shared 模式：本 tick 全场共享这一份预算
    for (const conn of [...conns]) {
      if (idleTimeoutMs > 0 && now - conn.lastActivityAt > idleTimeoutMs) {
        destroyConn(conn);
        continue;
      }
      if (throttleShared) {
        sharedRemaining -= pumpPipe(conn.c2s, sharedRemaining);
        sharedRemaining -= pumpPipe(conn.s2c, sharedRemaining);
      } else {
        pumpPipe(conn.c2s, perPipeBudget);
        pumpPipe(conn.s2c, perPipeBudget);
      }
      // 双向 FIN 均已传播（或对端已毁）：连接自然终结，移出在场集合
      const done = (p: Pipe): boolean => p.destEnded || p.dest.destroyed;
      if (done(conn.c2s) && done(conn.s2c)) conns.delete(conn);
    }
  }, PUMP_MS);
```

⑤ 状态与 `setThrottle` 实现：

```ts
  let throttleBps = 0; // 0 = 不限速
  let throttleShared = false; // shared = 全连接共享一份带宽预算（模拟共享链路）
```

```ts
    setThrottle(bytesPerSec: number, mode: ChaosThrottleMode = 'per-conn'): void {
      throttleBps = bytesPerSec;
      throttleShared = mode === 'shared';
    },
```

`packages/chaos-proxy/src/index.ts` 导出追加 `type ChaosThrottleMode`：

```ts
export {
  createChaosProxy,
  type ChaosDirection,
  type ChaosProxy,
  type ChaosProxyOptions,
  type ChaosProxyStats,
  type ChaosThrottleMode,
} from './chaos-proxy';
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter chaos-proxy test`
Expected: 全部 PASS（含既有用例——per-conn 路径行为零变化）。

- [ ] **Step 5: typecheck + format**

Run: `pnpm --filter chaos-proxy typecheck && pnpm --filter chaos-proxy format`
Expected: 无错误；format 若有改动随本任务提交。

- [ ] **Step 6: Commit**

```bash
git add packages/chaos-proxy/src/chaos-proxy.ts packages/chaos-proxy/src/chaos-proxy.test.ts packages/chaos-proxy/src/index.ts
git commit -m "feat(chaos-proxy): setThrottle 增加 shared 模式——全局共享带宽预算（模拟共享链路）"
```

---

### Task 2: chaos-proxy `setAdmissionRate` 连接准入原语

**Files:**
- Modify: `packages/chaos-proxy/src/chaos-proxy.ts`
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Consumes: 现有 `wireReject(client, status)`、`wirePipe(conn, pipe)`、`blackholeFlags`、`ConnState`/`Pipe` 结构。
- Produces: `setAdmissionRate(connPerSec: number): void`（`connPerSec <= 0` 关闭）——Task 3 脚本以 `setAdmissionRate(8)` 消费。

- [ ] **Step 1: 写失败测试**

在 `packages/chaos-proxy/src/chaos-proxy.test.ts` 文件末尾追加：

```ts
describe('setAdmissionRate 连接准入', () => {
  /** 准入信号：准入放行后代理才 wirePipe，内核缓冲的 'x' 被读出经 echo 返回 */
  function admitted(s: net.Socket): Promise<number> {
    return new Promise<number>((resolve) => {
      s.once('data', () => resolve(Date.now()));
      s.write('x'); // 未 connect/未准入时内核缓冲，放行后交付
    });
  }

  it('前 rate 个立即通，其余按间隔匀速放行', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setAdmissionRate(4); // 满桶 4：前 4 立即通；每 250ms 补 1 名额
    const startAt = Date.now();
    const times = await Promise.all(Array.from({ length: 12 }, () => admitted(dial(port))));
    const sorted = times.map((t) => t - startAt).sort((a, b) => a - b);
    expect(sorted[3]!).toBeLessThan(200); // 前 4 立即通（泵转发 ≈10ms 级）
    expect(sorted[11]!).toBeGreaterThanOrEqual(1500); // 第 12 个等 8 个匀速名额，理论 2s
  }, 10_000);

  it('排队中 close 不占名额；setAdmissionRate(0) 清队即放', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setAdmissionRate(1); // 满桶 1：仅第 1 个立即通，后续排队
    await admitted(dial(port)); // s1 占掉唯一名额，保持在线
    const s2 = dial(port);
    await new Promise<void>((r) => s2.on('connect', r));
    s2.destroy(); // 排队中放弃：出队取消，不占名额
    const s3 = dial(port);
    proxy.setAdmissionRate(0); // 关闭准入：排队连接立即全部放行（死连接跳过）
    await admitted(s3);
    expect(proxy.stats().connections).toBe(2); // s1 + s3：已毁的 s2 被跳过、未建 conn
  }, 10_000);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter chaos-proxy test`
Expected: 两用例 FAIL——`proxy.setAdmissionRate is not a function`。

- [ ] **Step 3: 实现准入门控**

`packages/chaos-proxy/src/chaos-proxy.ts` 共 4 处改动：

① 接口加方法（`ChaosProxy` 内，`setThrottle` 旁）：

```ts
  setAdmissionRate(connPerSec: number): void;
```

② 状态变量（`createChaosProxy` 闭包内，`rejectStatus` 旁）：

```ts
  let admissionPerSec = 0; // 0 = 准入不限速
  let admissionTokens = 0; // 准入令牌：满桶 = admissionPerSec（突发），匀速补充
  const admissionQueue: net.Socket[] = []; // FIFO 准入排队
  let admissionTimer: NodeJS.Timeout | null = null;
```

③ `createServer` 回调改为排队门控 + 抽取 `handleClient`（原回调内 reject/connect 逻辑整体搬入，行为不变）：

```ts
  const server = net.createServer((client) => {
    if (closed) { client.destroy(); return; }
    if (admissionPerSec > 0) {
      // 准入排队：FIFO 等放行；排队中 close 出队取消（不空耗名额）
      admissionQueue.push(client);
      client.once('close', () => {
        const index = admissionQueue.indexOf(client);
        if (index >= 0) admissionQueue.splice(index, 1);
      });
      drainAdmission();
      return;
    }
    handleClient(client);
  });

  /** 准入后接线：reject 优先，否则对接 target 双向透传（放行才消耗 target 资源） */
  function handleClient(client: net.Socket): void {
    if (rejectStatus !== null) { wireReject(client, rejectStatus); return; }
    const target = net.createConnection({ host: opts.targetHost, port: opts.targetPort });
    // 新 pipe 以全局黑洞标志初始化：黑洞期间新建连接同样静默
    const mkPipe = (source: net.Socket, dest: net.Socket, blackholed: boolean): Pipe => ({
      source, dest, blackholed,
      queue: [], queuedBytes: 0, sourcePaused: false, sourceClosed: false, destEnded: false,
    });
    const conn: ConnState = {
      client,
      target,
      c2s: mkPipe(client, target, blackholeFlags.c2s),
      s2c: mkPipe(target, client, blackholeFlags.s2c),
      lastActivityAt: Date.now(),
    };
    conns.add(conn);
    target.on('error', () => client.destroy()); // target 不可达/被 RST → 客户端看到断开
    wirePipe(conn, conn.c2s);
    wirePipe(conn, conn.s2c);
    if (conn.c2s.blackholed) client.pause(); // 黑洞中建连：源侧即停，窗口填满
    if (conn.s2c.blackholed) target.pause();
  }

  /** 按令牌放行队首（满桶突发 + 匀速补充）；死 socket 跳过不占名额 */
  function drainAdmission(): void {
    while (admissionTokens > 0) {
      const client = admissionQueue.shift();
      if (!client) return;
      if (client.destroyed) continue;
      admissionTokens -= 1;
      handleClient(client);
    }
  }
```

④ `setAdmissionRate` 实现 + `close()` 清理：

```ts
    setAdmissionRate(connPerSec: number): void {
      admissionPerSec = connPerSec;
      if (admissionTimer) { clearInterval(admissionTimer); admissionTimer = null; }
      if (connPerSec <= 0) {
        // 关闭准入：排队连接立即全部放行（死连接跳过）
        for (const client of admissionQueue.splice(0)) {
          if (!client.destroyed) handleClient(client);
        }
        return;
      }
      admissionTokens = connPerSec; // 满桶起步：前 connPerSec 个立即通
      drainAdmission();
      admissionTimer = setInterval(() => {
        admissionTokens = Math.min(connPerSec, admissionTokens + 1); // 匀速补充，不超容量
        drainAdmission();
      }, Math.max(1, Math.floor(1000 / connPerSec)));
      admissionTimer.unref();
    },
```

`close()` 内（`clearInterval(pumpTimer)` 之后）追加两行：

```ts
      if (admissionTimer) { clearInterval(admissionTimer); admissionTimer = null; }
      for (const client of admissionQueue.splice(0)) client.destroy(); // 排队未放行的一并收尾
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter chaos-proxy test`
Expected: 全部 PASS（含 Task 1 与既有用例——`admissionPerSec` 缺省 0 时 createServer 行为与现状一致）。

- [ ] **Step 5: typecheck + format**

Run: `pnpm --filter chaos-proxy typecheck && pnpm --filter chaos-proxy format`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add packages/chaos-proxy/src/chaos-proxy.ts packages/chaos-proxy/src/chaos-proxy.test.ts
git commit -m "feat(chaos-proxy): setAdmissionRate 连接准入——FIFO 排队匀速放行，close 出队取消"
```

---

### Task 3: throttle-proxy 脚本 + `listenPort` 选项 + 根脚本改指向

**Files:**
- Modify: `packages/chaos-proxy/src/chaos-proxy.ts`（`ChaosProxyOptions` + `listen()`）
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`
- Create: `packages/chaos-proxy/scripts/throttle-proxy.ts`
- Modify: `packages/chaos-proxy/tsconfig.json`、`packages/chaos-proxy/package.json`、根 `package.json`

**Interfaces:**
- Consumes: Task 1 的 `setThrottle(bps, mode)`、Task 2 的 `setAdmissionRate(rate)`、既有 `setLatency(ms, jitter)`。
- Produces: `ChaosProxyOptions.listenPort?: number`（缺省 0 随机，现有调用零影响）；根命令 `pnpm run proxy`（= throttle-proxy：共享 50KB/s + 准入 8/s + 监听 9080）——Task 5 文档引用该命令。

> 背景：`createChaosProxy.listen()` 现为硬编码 `server.listen(0, ...)` 随机端口，脚本需要固定 `--listen 9080`，故先补 `listenPort` 选项（spec §5 隐含需求，plan 补齐）。

- [ ] **Step 1: 写 listenPort 失败测试**

在 `packages/chaos-proxy/src/chaos-proxy.test.ts` 的 `describe('基础转发')` 块内追加：

```ts
  it('listenPort：固定端口监听（脚本/手动验证用）', async () => {
    await startEcho();
    // 先借一个随机端口再释放，作为固定端口入参（回环瞬时占用冲突概率可忽略）
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const fixedPort = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort, listenPort: fixedPort });
    expect(await proxy.listen()).toBe(fixedPort);
    const s = dial(fixedPort);
    await new Promise<void>((r) => s.on('connect', r));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter chaos-proxy test`
Expected: FAIL——`listenPort` 被忽略，`listen()` 返回随机端口 ≠ `fixedPort`。

- [ ] **Step 3: 实现 listenPort**

`packages/chaos-proxy/src/chaos-proxy.ts` 两处：

```ts
export interface ChaosProxyOptions { targetHost: string; targetPort: number; listenPort?: number }
```

```ts
        server.listen(opts.listenPort ?? 0, '127.0.0.1', () => {
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `pnpm --filter chaos-proxy test`
Expected: 全部 PASS。

- [ ] **Step 5: 写 throttle-proxy 脚本**

创建 `packages/chaos-proxy/scripts/throttle-proxy.ts`：

```ts
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
  const suffix = match[2]?.toLowerCase();
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
```

- [ ] **Step 6: 配置三处**

`packages/chaos-proxy/tsconfig.json`——include 加 scripts（否则脚本不被 typecheck）：

```json
  "include": ["src/**/*.ts", "scripts/**/*.ts"],
```

`packages/chaos-proxy/package.json`——devDependencies 加 tsx（对齐 proxy 包版本；库本体 zero runtime dep 红线不破）：

```json
  "devDependencies": {
    "@types/node": "^20.19.43",
    "eslint": "^9",
    "tsx": "^4.19.2",
    "typescript": "^5",
    "typescript-eslint": "^8.61.0",
    "vitest": "^4.1.8"
  }
```

根 `package.json`——`proxy` 脚本改指向（`pnpm --filter ... exec` 使 tsx 从 chaos-proxy 的 devDep 解析；默认参数对齐 AGENT.md 验证拓扑）：

```json
    "proxy": "pnpm --filter chaos-proxy exec tsx scripts/throttle-proxy.ts --throttle 50k --shared --admission 8",
```

- [ ] **Step 7: pnpm install 刷新 lockfile**

Run: `pnpm install`
Expected: chaos-proxy 新增 tsx 解析成功，lockfile 更新。

- [ ] **Step 8: 手动 smoke——脚本起代理 + 透传验证**

```powershell
# 终端 1（后台）：target echo 服务
node -e "require('net').createServer((s)=>s.pipe(s)).listen(9000,'127.0.0.1')"

# 终端 2（后台）：限流代理
pnpm run proxy
# 预期日志：[throttle-proxy] 代理就绪 :9080 → 127.0.0.1:9000（限速 51200 B/s shared，延迟 0ms+0ms，准入 8/s）

# 终端 3：经代理收发
node -e "const s=require('net').connect(9080,'127.0.0.1',()=>s.write('ping'));s.on('data',(d)=>{console.log('echo:',d.toString());s.end();process.exit(0);})"
# 预期输出：echo: ping
```

验证完毕 kill 两个后台进程。

- [ ] **Step 9: typecheck + format**

Run: `pnpm --filter chaos-proxy typecheck && pnpm --filter chaos-proxy format`
Expected: 无错误（scripts/ 已被 include 覆盖）。

- [ ] **Step 10: Commit**

```bash
git add packages/chaos-proxy/scripts/throttle-proxy.ts packages/chaos-proxy/src/chaos-proxy.ts packages/chaos-proxy/src/chaos-proxy.test.ts packages/chaos-proxy/tsconfig.json packages/chaos-proxy/package.json package.json pnpm-lock.yaml
git commit -m "feat(chaos-proxy): throttle-proxy 手动验证脚本 + listenPort 选项，根 pnpm proxy 改指向"
```

---

### Task 4: 删除 proxy 包与 gateway-proxy 文档

**Files:**
- Delete: `packages/proxy/`（整目录）
- Delete: `docs/superpowers/specs/2026-08-27-gateway-proxy-design.md`
- Delete: `docs/superpowers/plans/2026-08-27-gateway-proxy-plan.md`
- Modify: `pnpm-lock.yaml`（install 刷新）

**Interfaces:**
- Consumes: Task 3 的根 `proxy` 脚本（已指向 throttle-proxy，删除旧包后 `pnpm run proxy` 仍可用）。
- Produces: 无。

- [ ] **Step 1: git rm 删除**

```powershell
git rm -r packages/proxy
git rm docs/superpowers/specs/2026-08-27-gateway-proxy-design.md docs/superpowers/plans/2026-08-27-gateway-proxy-plan.md
```

- [ ] **Step 2: pnpm install 刷新 lockfile**

Run: `pnpm install`
Expected: gateway-proxy 条目从 lockfile 消失，无残留引用报错。

- [ ] **Step 3: 全量验证**

Run: `pnpm typecheck && pnpm format && pnpm test`
Expected: 全绿——无任何包引用 gateway-proxy（Task 3 已改根脚本），client/server e2e-chaos 不受影响。

- [ ] **Step 4: 复跑 smoke 确认 `pnpm run proxy` 仍可用**

同 Task 3 Step 8 三条命令，预期相同。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 删除 gateway-proxy 包与其 spec/plan——限流能力已迁入 chaos-proxy"
```

---

### Task 5: AGENT.md 与 multiconn plan 文档更新

**Files:**
- Modify: `AGENT.md`（验证章节三处）
- Modify: `docs/superpowers/plans/2026-08-28-gateway-multiconn.md`（Task 10 Step 4 与「验证记录」）

**Interfaces:**
- Consumes: Task 3 的根 `pnpm run proxy` 命令形态与 throttle-proxy 参数（`--throttle 5m --shared --latency 100`）。
- Produces: 无。

- [ ] **Step 1: AGENT.md 三处编辑**

① 拓扑行（工具名改写，拓扑形态与「共享 50KB/s 全局带宽桶」原理描述不变）：

old:
```
浏览器 ──HTTP/WS──> [proxy :9080 限流 8 连接/s + 全局 50KB/s] ──> [server :9000] <──WS 隧道(同过 proxy)── [client] ──> upstream(DSH Web :3088)
```
new:
```
浏览器 ──HTTP/WS──> [throttle-proxy :9080 准入 8 连接/s + 共享 50KB/s] ──> [server :9000] <──WS 隧道(同过 proxy)── [client] ──> upstream(DSH Web :3088)
```

② 步骤 1（命令形态 `pnpm run proxy` 不变，工具说明注入）：

old:
```
1. **启动三进程**（各开一个终端或后台任务）：`pnpm run proxy`、`pnpm run server`、`pnpm run client`（客户端读 `packages/client/client.config.mjs`：hostname=工位001、token=test、gatewayUrl 指向 :9080）。确认客户端日志出现"隧道就绪"、服务端日志出现"隧道接入"。
```
new:
```
1. **启动三进程**（各开一个终端或后台任务）：`pnpm run proxy`（chaos-proxy throttle-proxy 脚本：共享 50KB/s + 准入 8/s）、`pnpm run server`、`pnpm run client`（客户端读 `packages/client/client.config.mjs`：hostname=工位001、token=test、gatewayUrl 指向 :9080）。确认客户端日志出现"隧道就绪"、服务端日志出现"隧道接入"。
```

③ 排查指引（指向迁入后的语义所在文件）：

old:
```
- 响应尾包截断（差几十~几百字节）→ 中间盒在 FIN 后丢弃了节流队列，查 `packages/proxy/src/server.ts` 优雅关闭语义。
```
new:
```
- 响应尾包截断（差几十~几百字节）→ 中间盒在 FIN 后丢弃了节流队列，查 `packages/chaos-proxy/src/chaos-proxy.ts` FIN 排空传播语义（sourceClosed/destEnded）。
```

- [ ] **Step 2: multiconn plan 两处编辑**

① Task 10 Step 4（约 1570 行）：

old:
```
用 `packages/proxy`（gateway-proxy，throttle 限流验证基座）在限流链路下对比：

```bash
# 终端1：pnpm run server --port 9000
# 终端2：gateway-proxy 限流（如 5Mbps / RTT 100ms）挂在 server 与 client 之间
```
new:
```
用 `packages/chaos-proxy/scripts/throttle-proxy.ts`（chaos 限流验证脚本）在限流链路下对比：

```bash
# 终端1：pnpm run server --port 9000
# 终端2：throttle-proxy 限流挂在 server 与 client 之间：
#         tsx packages/chaos-proxy/scripts/throttle-proxy.ts --throttle 5m --shared --latency 100
```

② 「验证记录」步骤 2（约 1591 行）：

old:
```
2. 终端2：`packages/proxy`（gateway-proxy，throttle 限流验证基座）挂在 server 与 client 之间，限流 5Mbps / RTT 100ms。
```
new:
```
2. 终端2：throttle-proxy 挂在 server 与 client 之间：`tsx packages/chaos-proxy/scripts/throttle-proxy.ts --throttle 5m --shared --latency 100`（共享 5Mbps + RTT 100ms）。
```

- [ ] **Step 3: Commit**

```bash
git add AGENT.md docs/superpowers/plans/2026-08-28-gateway-multiconn.md
git commit -m "docs: AGENT.md 验证拓扑与 multiconn 手动验证改用 throttle-proxy 脚本"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 shared 限速 → Task 1；§4 准入原语 → Task 2；§5 脚本 → Task 3；§6 删除清单 → Task 4；§7 AGENT.md → Task 5；§8 测试 5 用例 → Task 1（T1-T3）+ Task 2（T4-T5）；§9 验证 → 各 Task 内 typecheck/format/test + Task 3/4 smoke。
- **spec 缺口补齐**：`ChaosProxyOptions.listenPort`（脚本固定端口需要，spec §5 隐含）→ Task 3 Step 1-4。
- **类型一致性**：`ChaosThrottleMode`、`setThrottle(bps, mode?)`、`setAdmissionRate(rate)`、`listenPort` 在 Tasks 1-3 间引用一致；multiconn plan 的 `--throttle 5m --shared --latency 100` 与脚本参数解析一致（k/m 后缀、flag 名）。
- **占位符**：无。
