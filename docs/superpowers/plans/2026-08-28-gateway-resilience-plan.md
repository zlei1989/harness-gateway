# 网关稳健性与登录态持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复诊断日志丢失、实现浏览器登录态跨服务端重启/浏览器重开持久化、新建 chaos-proxy 故障注入库并以 19 个自动化场景锤炼隧道稳健性（含瞬断宽限）。

**Architecture:** 全部 in-process：真实 Client ⇄ chaos-proxy（TCP 故障注入）⇄ 真实 GatewayServer ⇄ 真实 upstream，vitest 自动化回归；服务端会话加 TTL + JSON 快照（0600），cookie 加 Max-Age（与 TTL 同源）。

**Tech Stack:** Node.js (net/http/ws)、TypeScript、vitest、pnpm workspace（包间经 `src/index.ts` 直接解析 TS，无需构建）。

**Spec:** `docs/superpowers/specs/2026-08-28-gateway-resilience-design.md`

## Global Constraints

- 代码注释/日志文案用中文，风格对齐仓库现有包；日志前缀 `[dsh-remote-access]`（插件）/ `[client]` / `[harness-server]`。
- **token 红线**：token 只进不出——任何日志/响应/断言消息不得打印 token；会话快照日志只记数量。
- 不新增运行时依赖（chaos-proxy 纯 Node `net`/`http`，零依赖）；新依赖仅限 devDependencies。
- 配置非法 = 进程级错误：构造即抛错（对齐 GatewayServer/Client 现状）。
- 测试确定性：真实定时器 + 条件轮询 `waitFor`（禁固定 sleep 等待状态）；`afterEach` 确定性收尾，无悬挂句柄。
- 仓库根执行命令：`pnpm --filter <pkg> test` / `pnpm --filter <pkg> typecheck`；包名：server=`gateway-server`、client=`gateway-client`、插件=`dsh-remote-access`、新包=`chaos-proxy`。
- 每次 package.json 依赖变更后必须 `pnpm install`。
- 工作目录即仓库根 `D:\zhanglei1120\Github\harness-gateway`（非 git worktree；直接在 main 上按任务提交）。

---

### Task 1: M0 — 插件日志适配层透传 context

**Files:**
- Create: `packages/dsh-remote-access/src/host/logger.ts`
- Modify: `packages/dsh-remote-access/src/host/connection-manager.ts:61-66`（内联 logger 替换）
- Test: `packages/dsh-remote-access/src/host/logger.test.ts`

**Interfaces:**
- Consumes: `gateway-client` 导出的 `Logger` 类型（`{ debug/info/warn/error(message, context?) }`）
- Produces: `createPluginLogger(): Logger`——context 以 JSON 附加，Task 2+ 的所有诊断可见性依赖它

- [ ] **Step 1: 写失败测试**

```ts
// packages/dsh-remote-access/src/host/logger.test.ts
/**
 * 插件日志适配层测试 — context 必须透传（线上"隧道连接错误无详情"根因修复的回归锁）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginLogger } from './logger';

describe('createPluginLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('error 透传 context JSON（err.stack 不再被吞）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = 'Error: read ECONNRESET';
    createPluginLogger().error('隧道连接错误', { error });
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [ERROR] 隧道连接错误 ${JSON.stringify({ error })}`);
  });

  it('warn 透传断开诊断 code/reason/readyMs', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = { code: 1006, reason: undefined, readyMs: 1234 };
    createPluginLogger().warn('隧道连接断开', ctx);
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [WARN] 隧道连接断开 ${JSON.stringify(ctx)}`);
  });

  it('无 context 时不带 JSON 尾巴', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    createPluginLogger().info('隧道就绪');
    expect(spy).toHaveBeenCalledWith('[dsh-remote-access] [INFO] 隧道就绪');
  });

  it('debug 恢复透传（原为完全静默）', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    createPluginLogger().debug('未知通道数据帧，丢弃', { channelId: 7 });
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [DEBUG] 未知通道数据帧，丢弃 ${JSON.stringify({ channelId: 7 })}`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL（`./logger` 模块不存在）

- [ ] **Step 3: 实现 logger.ts 并接线 connection-manager**

```ts
// packages/dsh-remote-access/src/host/logger.ts
/**
 * 插件日志适配 — 把 gateway-client 的 Logger context 透传到控制台（JSON 附加）。
 * 线上事故修复：原内联适配层丢弃 context，"隧道连接错误/断开"的 err.stack 与 close code 全被吞。
 * 红线不变：gateway-client 日志约定本不放 token，context 透传不引入泄露面。
 */

import type { Logger } from 'gateway-client';

const LOG_PREFIX = '[dsh-remote-access]';

const fmt = (lv: string, m: string, c?: Record<string, unknown>): string =>
  `${LOG_PREFIX} [${lv}] ${m}${c ? ' ' + JSON.stringify(c) : ''}`;

export function createPluginLogger(): Logger {
  return {
    debug: (m, c) => console.debug(fmt('DEBUG', m, c)),
    info: (m, c) => console.info(fmt('INFO', m, c)),
    warn: (m, c) => console.warn(fmt('WARN', m, c)),
    error: (m, c) => console.error(fmt('ERROR', m, c)),
  };
}
```

`connection-manager.ts` 改动（import 块加一行；`new Client({...})` 的 logger 字段替换；文件其余 LOG_PREFIX 用法保留）：

```ts
import { createPluginLogger } from './logger';
// ...
      client = new Client({
        upstreamUrl: this.deps.upstreamUrl,
        gatewayUrl: endpoints.gatewayUrl,
        hostname,
        token: cfg.token,
        compress: cfg.compress,
        logger: createPluginLogger(),
      });
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter dsh-remote-access test && pnpm --filter dsh-remote-access typecheck`
Expected: 全绿（含既有 connection-manager 测试不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-remote-access/src/host/logger.ts packages/dsh-remote-access/src/host/logger.test.ts packages/dsh-remote-access/src/host/connection-manager.ts
git commit -m "fix(dsh-remote-access): 日志适配层透传 context——隧道错误/断开诊断不再被吞（M0）"
```

---

### Task 2: M1 — BrowserSessionStore TTL + 快照持久化

**Files:**
- Modify: `packages/server/src/browser-session.ts`（整体改写 store 部分，cookie 工具本任务不动）
- Test: `packages/server/src/browser-session.test.ts`

**Interfaces:**
- Consumes: 无新依赖（Node fs/path）
- Produces（后续任务依赖的确切签名）:
  - `new BrowserSessionStore(options?: { ttlMs?: number; persistPath?: string }, logger?: Logger)`
  - `store.ttlMs: number`（只读，Task 3 cookie Max-Age 取值处）
  - `BrowserSession { tunnelId: string; hostname: string; token: string; expiresAt: number }`
  - `DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000`
  - 行为：create 同步落盘（低频人工动作，无防抖——比 spec 的 1s 防抖更稳：kill 窗口为零）；get 惰性过期 + 过期即落盘；构造时恢复快照（缺失=空表、损坏=WARN 降级空表、过期条目丢弃）

- [ ] **Step 1: 写失败测试（追加到 browser-session.test.ts 新 describe）**

```ts
// 追加 import：import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
//              import { tmpdir } from 'node:os'; import { join } from 'node:path';
describe('BrowserSessionStore TTL 与持久化', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
  const makeDir = (): string => { dir = mkdtempSync(join(tmpdir(), 'gw-session-')); return dir; };

  it('ttlMs 过期后 get 返回 undefined', () => {
    vi.useFakeTimers();
    try {
      const store = new BrowserSessionStore({ ttlMs: 1000 });
      const uuid = store.create('tid', 'host', 'tok');
      expect(store.get(uuid)).toBeDefined();
      vi.advanceTimersByTime(1001);
      expect(store.get(uuid)).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it('快照 round-trip：create 落盘（0600），新实例恢复会话', () => {
    const path = join(makeDir(), 'sessions.json');
    const a = new BrowserSessionStore({ ttlMs: 60_000, persistPath: path });
    const uuid = a.create('tid-1', 'pc-a', 'tok-secret');
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { version: number; sessions: { uuid: string; token: string }[] };
    expect(raw.version).toBe(1);
    expect(raw.sessions).toHaveLength(1);
    expect(raw.sessions[0]?.uuid).toBe(uuid);
    const b = new BrowserSessionStore({ ttlMs: 60_000, persistPath: path });
    expect(b.get(uuid)?.tunnelId).toBe('tid-1');
  });

  it('快照损坏 → WARN 降级空表不抛错', () => {
    const path = join(makeDir(), 'sessions.json');
    writeFileSync(path, 'not-json{{{', 'utf8');
    const warnings: string[] = [];
    const logger = { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {} };
    const store = new BrowserSessionStore({ persistPath: path }, logger as never);
    expect(store.get('x')).toBeUndefined();
    expect(warnings.some((m) => m.includes('损坏'))).toBe(true);
  });

  it('过期条目加载即丢弃', () => {
    const path = join(makeDir(), 'sessions.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessions: [{ uuid: 'old', tunnelId: 't', hostname: 'h', token: 'x', expiresAt: Date.now() - 1 }],
    }), 'utf8');
    const store = new BrowserSessionStore({ persistPath: path });
    expect(store.get('old')).toBeUndefined();
  });

  it('缺文件 = 空表正常启动；ttlMs 默认值 7 天', () => {
    const store = new BrowserSessionStore({ persistPath: join(makeDir(), 'none.json') });
    expect(store.ttlMs).toBe(DEFAULT_SESSION_TTL_MS);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server test -- browser-session`
Expected: FAIL（构造选项/expiresAt/DEFAULT_SESSION_TTL_MS 不存在）

- [ ] **Step 3: 实现**

`browser-session.ts` store 部分替换为（cookie 工具函数保持原样，仅顶部 import 与文件头注释更新）：

```ts
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Logger } from './logger';

export interface BrowserSession {
  /** 隧道身份（服务端分配的 tunnelId；隧道断开重连复用后会话自动恢复可用） */
  tunnelId: string;
  /** 选择时的展示名快照，仅供日志（hostname 可重复，不参与路由） */
  hostname: string;
  token: string;
  /** 过期时刻（epoch ms）；get 惰性过期，无后台定时器 */
  expiresAt: number;
}

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BrowserSessionStoreOptions {
  /** 会话生存期（默认 7 天）；cookie Max-Age 与其同源 */
  ttlMs?: number;
  /** 会话快照路径（缺省 = 纯内存，测试密封）；明文 JSON + 0600（token 落盘已评审接受） */
  persistPath?: string;
}

interface SnapshotFile {
  version: 1;
  sessions: Array<{ uuid: string; tunnelId: string; hostname: string; token: string; expiresAt: number }>;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSession>();
  readonly ttlMs: number;
  private readonly persistPath: string | undefined;

  constructor(options: BrowserSessionStoreOptions = {}, private readonly logger?: Logger) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.persistPath = options.persistPath;
    if (this.persistPath) this.restore();
  }

  /** 建立会话，返回 uuid；低频人工动作：同步落盘（kill 窗口为零，不做防抖） */
  create(tunnelId: string, hostname: string, token: string): string {
    const uuid = randomUUID();
    this.sessions.set(uuid, { tunnelId, hostname, token, expiresAt: Date.now() + this.ttlMs });
    this.persist();
    return uuid;
  }

  /** 惰性过期：过期即删并落盘（无定时器，防悬挂进程/测试） */
  get(uuid: string): BrowserSession | undefined {
    const session = this.sessions.get(uuid);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(uuid);
      this.persist();
      return undefined;
    }
    return session;
  }

  /** 启动恢复：缺文件空表；损坏 WARN 降级空表（不崩进程）；过期条目丢弃。红线：日志只记数量 */
  private restore(): void {
    const path = this.persistPath!;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile;
      if (raw?.version !== 1 || !Array.isArray(raw.sessions)) throw new Error('快照结构非法');
      const now = Date.now();
      for (const s of raw.sessions) {
        if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) continue;
        this.sessions.set(s.uuid, { tunnelId: s.tunnelId, hostname: s.hostname, token: s.token, expiresAt: s.expiresAt });
      }
      this.logger?.info('浏览器会话快照已恢复', { count: this.sessions.size });
    } catch (err) {
      this.logger?.warn('会话快照损坏，降级空表启动', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 原子写（临时文件 + rename）+ 0600；落盘前顺带清扫过期条目 */
  private persist(): void {
    if (!this.persistPath) return;
    const now = Date.now();
    const sessions = [...this.sessions.entries()]
      .filter(([, s]) => s.expiresAt > now)
      .map(([uuid, s]) => ({ uuid, ...s }));
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions } satisfies SnapshotFile), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.persistPath);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-server test`
Expected: 全绿（既有用例不受影响——旧构造 `new BrowserSessionStore()` 仍合法）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/browser-session.ts packages/server/src/browser-session.test.ts
git commit -m "feat(server): 浏览器会话 TTL + 快照持久化（0600 原子写、惰性过期、损坏降级）（M1）"
```

---

### Task 3: M1 — cookie Max-Age 与选择页接线

**Files:**
- Modify: `packages/server/src/browser-session.ts`（`buildSessionCookie` 签名）
- Modify: `packages/server/src/select-page.ts:306`（调用点）
- Test: `packages/server/src/browser-session.test.ts`、`packages/server/src/select-page.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `store.ttlMs`
- Produces: `buildSessionCookie(uuid: string, maxAgeSec: number): string`——含 `Max-Age=<秒>`

- [ ] **Step 1: 改测试（先红）**

`browser-session.test.ts` 既有用例 `buildSessionCookie 属性齐全且无过期时间（session cookie）` 改为：

```ts
it('buildSessionCookie 属性齐全且 Max-Age 与 TTL 同源', () => {
  const cookie = buildSessionCookie('uuid-1', 604800);
  expect(cookie).toContain(`${SESSION_COOKIE}=uuid-1`);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('SameSite=Lax');
  expect(cookie).toContain('Path=/');
  expect(cookie).toContain('Max-Age=604800');
});
```

`select-page.test.ts` 既有用例（正确 token → Set-Cookie）追加一行断言：

```ts
expect(cookie).toContain('Max-Age=');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server test -- browser-session select-page`
Expected: FAIL（Max-Age 缺失 / 签名不符）

- [ ] **Step 3: 实现**

```ts
/** 生成 Set-Cookie 值：HttpOnly + SameSite=Lax + Path=/ + Max-Age（与服务端 TTL 同源，同时到期无悬空态） */
export function buildSessionCookie(uuid: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${uuid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}
```

`select-page.ts:306` 调用点改为：

```ts
    sendJson(res, 200, { ok: true, redirect: target }, {
      'set-cookie': buildSessionCookie(uuid, Math.floor(ctx.sessions.ttlMs / 1000)),
    });
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter gateway-server test && pnpm --filter gateway-server typecheck`
Expected: 全绿（e2e 既有 `expect(cookie).toContain('gateway_sid=')` 不受影响）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/browser-session.ts packages/server/src/select-page.ts packages/server/src/browser-session.test.ts packages/server/src/select-page.test.ts
git commit -m "feat(server): 会话 cookie 增加 Max-Age（与 TTL 同源）——浏览器重开免重登（M1）"
```

---

### Task 4: M1 — GatewayServerOptions 装配 + CLI 参数

**Files:**
- Modify: `packages/server/src/server.ts`（options + 校验 + store 构造）
- Modify: `packages/server/src/cli.ts`（`--session-store` / `--browser-session-ttl`）
- Test: `packages/server/src/cli.test.ts`、`packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BrowserSessionStoreOptions` / `DEFAULT_SESSION_TTL_MS`
- Produces: `GatewayServerOptions.browserSessionTtlMs?: number`（默认 7d）、`GatewayServerOptions.sessionStorePath?: string`（默认 undefined 纯内存）；`CliArgs.sessionStorePath?: string`、`CliArgs.browserSessionTtlMs?: number`

- [ ] **Step 1: 写失败测试**

`cli.test.ts` 追加：

```ts
it('解析 --session-store / --browser-session-ttl', () => {
  const args = parseArgs(['--session-store', '/tmp/s.json', '--browser-session-ttl', '3600000']);
  expect(args.sessionStorePath).toBe('/tmp/s.json');
  expect(args.browserSessionTtlMs).toBe(3600000);
});

it('--browser-session-ttl 非法值抛错', () => {
  expect(() => parseArgs(['--browser-session-ttl', '0'])).toThrow('--browser-session-ttl 非法');
  expect(() => parseArgs(['--browser-session-ttl', 'abc'])).toThrow('--browser-session-ttl 非法');
});
```

`server.test.ts` 追加：

```ts
it('browserSessionTtlMs 非法（0/负数/非整数）构造抛错', () => {
  for (const v of [0, -1, 1.5]) {
    expect(() => new GatewayServer({ port: 0, browserSessionTtlMs: v, logger: nullLogger }))
      .toThrow('GatewayServerOptions.browserSessionTtlMs 必须是正整数毫秒值');
  }
});
```

（`nullLogger` 在 server.test.ts 已有同名形态则复用，没有则按 `const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;` 补充。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server test -- cli server`
Expected: FAIL（选项不存在）

- [ ] **Step 3: 实现**

`server.ts`：

```ts
// GatewayServerOptions 增加：
  /** 浏览器会话生存期（毫秒，须为正整数；cookie Max-Age 同源）。默认 7 天 */
  browserSessionTtlMs?: number;
  /** 浏览器会话快照路径（缺省 = 纯内存）；明文 JSON + 0600，重启恢复 */
  sessionStorePath?: string;

// options 字段类型改为：
  private readonly options: Required<Omit<GatewayServerOptions, 'logger' | 'sessionStorePath'>>
    & Pick<GatewayServerOptions, 'sessionStorePath'>;
// sessions 字段改为构造器赋值：
  private readonly sessions: BrowserSessionStore;

// 构造器校验（keepAlive 校验之后）追加：
    if (options.browserSessionTtlMs !== undefined
      && (!Number.isInteger(options.browserSessionTtlMs) || options.browserSessionTtlMs <= 0)) {
      throw new Error('GatewayServerOptions.browserSessionTtlMs 必须是正整数毫秒值');
    }
// options 归一化追加：
      browserSessionTtlMs: options.browserSessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
      sessionStorePath: options.sessionStorePath,
// 构造器末尾：
    this.sessions = new BrowserSessionStore(
      { ttlMs: this.options.browserSessionTtlMs, persistPath: this.options.sessionStorePath },
      this.logger,
    );
// import 更新：import { BrowserSessionStore, DEFAULT_SESSION_TTL_MS } from './browser-session';
```

`cli.ts`：`CliArgs` 加 `sessionStorePath?: string | undefined; browserSessionTtlMs?: number | undefined;`；USAGE 追加 `[--session-store <path>] [--browser-session-ttl <ms>]`；parseArgs 增加分支：

```ts
    } else if (arg === '--session-store') {
      sessionStorePath = argv[++i];
      if (!sessionStorePath) throw new Error('--session-store 缺参数值');
    } else if (arg === '--browser-session-ttl') {
      const value = argv[++i];
      const parsed = Number(value);
      if (!value || !Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--browser-session-ttl 非法: ${value}（须正整数毫秒值）`);
      }
      browserSessionTtlMs = parsed;
    }
```

`main()` 的 `new GatewayServer({...})` 追加 `sessionStorePath: args.sessionStorePath, browserSessionTtlMs: args.browserSessionTtlMs,`。

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `pnpm --filter gateway-server test && pnpm --filter gateway-server typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/cli.ts packages/server/src/cli.test.ts packages/server/src/server.test.ts
git commit -m "feat(server): browserSessionTtlMs/sessionStorePath 选项装配 + CLI 参数（M1）"
```

---

### Task 5: M1 验收 — E 组 e2e（S15 服务端重启 / S16 浏览器重开 / S17 会话过期）

**Files:**
- Test: `packages/server/src/e2e.test.ts`（追加 describe；E 组无故障注入依赖且 `MockTunnelClient` 原生支持 tunnelId 回带，就近放此——spec §10 的 e2e-chaos 归置仅适用于 B/C/F 组）

**Interfaces:**
- Consumes: Task 2-4 全部；`MockTunnelClient.tunnelId`（公开字段，手动预置即等价真实 Client 的回带行为）
- Produces: S15/S16/S17 回归锁

- [ ] **Step 1: 写失败测试（追加 describe，自带独立 server 生命周期，不复用 beforeEach 的实例）**

```ts
describe('e2e：会话持久化（E 组）', () => {
  let dir = '';
  let srv: GatewayServer | null = null;
  let srvPort = 0;
  const persistPath = (): string => join(dir, 'sessions.json');
  const srvBase = (): string => `http://127.0.0.1:${srvPort}`;
  const srvTunnelUrl = (): string => `ws://127.0.0.1:${srvPort}/__gateway__/tunnel`;

  afterEach(async () => {
    await srv?.close();
    srv = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  async function startServer(opts: { ttlMs?: number } = {}): Promise<void> {
    srv = new GatewayServer({
      port: 0, headTimeoutMs: 500, helloTimeoutMs: 500, logger: nullLogger,
      sessionStorePath: persistPath(),
      ...(opts.ttlMs !== undefined ? { browserSessionTtlMs: opts.ttlMs } : {}),
    });
    srvPort = await srv.listen();
  }

  async function selectCookie(tunnelId: string): Promise<string> {
    const res = await fetch(`${srvBase()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `tunnelId=${tunnelId}&token=good-token`,
      redirect: 'manual',
    });
    expect(res.status).toBe(200);
    return res.headers.get('set-cookie') ?? '';
  }

  it('S15：服务端重启 → 快照恢复 + tunnelId 回带复用 → 老 cookie 免重登', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer();
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    await srv?.close(); // 优雅关停：快照已在 create 时同步落盘

    await startServer(); // 同 persistPath 重启
    const b = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(b);
    b.tunnelId = a.tunnelId; // 进程内存回带（等价真实 Client 重连行为）
    await b.connect();
    expect(b.tunnelId).toBe(a.tunnelId); // 注册表为空，复用必成功

    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie } });
    expect(res.status).toBe(200); // 免重登：会话恢复 + 隧道重新对上
  });

  it('S16：浏览器重开（仅带持久 cookie 的新 HTTP 会话）→ 免重登', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer();
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    expect(cookie).toContain('Max-Age='); // 持久化的载体
    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie: cookie.split(';')[0] ?? '' } });
    expect(res.status).toBe(200); // 新"浏览器"只带 gateway_sid kv
  });

  it('S17：会话 TTL 过期 → 302 重选且快照同步清理', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gw-e2e-persist-'));
    await startServer({ ttlMs: 400 });
    const a = new MockTunnelClient({ gatewayUrl: srvTunnelUrl(), hostname: 'pc-a', validToken: 'good-token' });
    clients.push(a);
    await a.connect();
    const cookie = await selectCookie(a.tunnelId ?? '');
    await new Promise((r) => setTimeout(r, 500)); // 真实时钟过期（waitFor 无法加速 TTL 本身，400ms 可控）
    const res = await fetch(`${srvBase()}/api/x`, { headers: { cookie }, redirect: 'manual' });
    expect(res.status).toBe(302);
    const raw = JSON.parse(readFileSync(persistPath(), 'utf8')) as { sessions: unknown[] };
    expect(raw.sessions).toHaveLength(0); // get 惰性过期已触发落盘清扫
  });
});
```

（文件顶部 import 追加：`mkdtempSync, readFileSync, rmSync` from 'node:fs'，`tmpdir` from 'node:os'，`join` from 'node:path'。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server test -- e2e`
Expected: FAIL（`sessionStorePath`/`browserSessionTtlMs` 未识别 → 若 Task 4 已合入则为绿；本任务以 Task 4 为前置，红灯预期仅在顺序打乱时出现——按序执行时直接验证全绿即可）

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter gateway-server test -- e2e`
Expected: 全绿（S15/S16/S17 + 既有 e2e 用例）

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/e2e.test.ts
git commit -m "test(server): 会话持久化 e2e——服务端重启/浏览器重开免重登、TTL 过期清扫（M1 验收 S15-S17）"
```

---

### Task 6: M2 — chaos-proxy 包脚手架 + 基础转发

**Files:**
- Create: `packages/chaos-proxy/package.json`、`tsconfig.json`、`eslint.config.ts`、`vitest.config.ts`
- Create: `packages/chaos-proxy/src/chaos-proxy.ts`、`src/index.ts`
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Produces（Task 7-9 逐步补全同一实现；完整公开面）:
```ts
export type ChaosDirection = 'c2s' | 's2c' | 'both';
export interface ChaosProxyOptions { targetHost: string; targetPort: number }
export interface ChaosProxyStats { connections: number; destroyed: number; bytesRelayed: number }
export interface ChaosProxy {
  listen(): Promise<number>; close(): Promise<void>;
  destroyAll(): void;
  blackhole(direction?: ChaosDirection): void; heal(): void;
  setLatency(ms: number, jitterMs?: number): void;
  setThrottle(bytesPerSec: number): void;
  setIdleTimeout(ms: number): void;
  flappy(intervalMs: number): void; stopFlappy(): void;
  rejectUpgradeWith(status: number): void; clearRejectUpgrade(): void;
  stats(): ChaosProxyStats;
}
export function createChaosProxy(opts: ChaosProxyOptions): ChaosProxy;
```

- [ ] **Step 1: 脚手架（无测试先行——纯配置）**

`package.json`（对齐仓库形态：私有、type module、出口直指 src TS）：

```json
{
  "name": "chaos-proxy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "format": "eslint . --fix",
    "test": "vitest run --passWithNoTests"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "eslint": "^9",
    "typescript": "^5",
    "typescript-eslint": "^8.61.0",
    "vitest": "^4.1.8"
  }
}
```

`tsconfig.json` 与 `packages/client/tsconfig.json` 完全一致；`vitest.config.ts` 与 `packages/client/vitest.config.ts` 完全一致；`eslint.config.ts` 复制 client 版并把注释里的包名改为 chaos-proxy。`pnpm-workspace.yaml` 已含 `packages/*` 无需改动。

Run: `pnpm install`

- [ ] **Step 2: 写失败测试（基础透传 + stats）**

```ts
// packages/chaos-proxy/src/chaos-proxy.test.ts
/**
 * chaos-proxy 自身单测 — 以真实 TCP echo 服务为 target，net.Socket 客户端经代理收发。
 * 后序任务（destroy/blackhole/latency/throttle/idle/flappy/reject）在本文件追加 describe。
 */
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createChaosProxy, type ChaosProxy } from './chaos-proxy';

let echo: net.Server | null = null;
let echoPort = 0;
let proxy: ChaosProxy | null = null;
const sockets: net.Socket[] = [];

async function startEcho(): Promise<void> {
  echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo!.listen(0, '127.0.0.1', r));
  echoPort = (echo!.address() as net.AddressInfo).port;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await proxy?.close();
  proxy = null;
  await new Promise<void>((r) => echo?.close(() => r()) ?? r());
  echo = null;
});

function dial(port: number): net.Socket {
  const s = net.createConnection({ host: '127.0.0.1', port });
  sockets.push(s);
  return s;
}

describe('基础转发', () => {
  it('listen 后透传双向数据，stats 记账', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    const echoed = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      s.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length >= 5) resolve(Buffer.concat(chunks)); });
    });
    s.write('hello');
    expect((await echoed).toString()).toBe('hello');
    expect(proxy.stats().connections).toBe(1);
    expect(proxy.stats().bytesRelayed).toBe(10); // c2s 5 + s2c 5
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter chaos-proxy test`
Expected: FAIL（`./chaos-proxy` 不存在）

- [ ] **Step 4: 实现（pipe/pump 骨架——本任务只通无故障路径，故障字段就位）**

```ts
// packages/chaos-proxy/src/chaos-proxy.ts
/**
 * chaos-proxy — TCP 层故障注入代理（测试专用，零依赖）。
 * 保真度设计：转发经「队列 + 10ms 泵」模型——blackhole = 暂停源 socket（内核窗口填满，与真实
 * 丢包/半开逐字节一致）；throttle 超水位暂停源 socket（真实 TCP 背压）；destroy = 双端 RST。
 * 代理不懂 WS/HTTP 语义（真实中间盒也不懂），这是保真度来源。
 */

import { STATUS_CODES } from 'node:http';
import net from 'node:net';

export type ChaosDirection = 'c2s' | 's2c' | 'both';
export interface ChaosProxyOptions { targetHost: string; targetPort: number }
export interface ChaosProxyStats { connections: number; destroyed: number; bytesRelayed: number }
export interface ChaosProxy {
  listen(): Promise<number>;
  close(): Promise<void>;
  destroyAll(): void;
  blackhole(direction?: ChaosDirection): void;
  heal(): void;
  setLatency(ms: number, jitterMs?: number): void;
  setThrottle(bytesPerSec: number): void;
  setIdleTimeout(ms: number): void;
  flappy(intervalMs: number): void;
  stopFlappy(): void;
  rejectUpgradeWith(status: number): void;
  clearRejectUpgrade(): void;
  stats(): ChaosProxyStats;
}

interface QueueItem { chunk: Buffer; due: number }
interface Pipe {
  source: net.Socket;
  dest: net.Socket;
  queue: QueueItem[];
  queuedBytes: number;
  blackholed: boolean;
  sourcePaused: boolean;
}
interface ConnState {
  client: net.Socket;
  target: net.Socket | null;
  c2s: Pipe;
  s2c: Pipe;
  lastActivityAt: number;
}

const PUMP_MS = 10;
/** 队列超此水位暂停源 socket：throttle 经真实 TCP 背压生效（不是内存黑洞） */
const QUEUE_PAUSE_BYTES = 1024 * 1024;

export function createChaosProxy(opts: ChaosProxyOptions): ChaosProxy {
  const conns = new Set<ConnState>();
  let destroyed = 0;
  let bytesRelayed = 0;
  let latencyMs = 0;
  let jitterMs = 0;
  let throttleBps = 0; // 0 = 不限速
  let idleTimeoutMs = 0; // 0 = 不启用
  let rejectStatus: number | null = null;
  let flappyTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function pumpPipe(pipe: Pipe, budgetBytes: number): void {
    if (pipe.blackholed) return;
    let budget = budgetBytes;
    const now = Date.now();
    while (pipe.queue.length > 0 && budget > 0) {
      const head = pipe.queue[0];
      if (!head || head.due > now) break;
      pipe.queue.shift();
      pipe.queuedBytes -= head.chunk.length;
      budget -= head.chunk.length;
      bytesRelayed += head.chunk.length;
      pipe.dest.write(head.chunk);
    }
    if (pipe.sourcePaused && pipe.queuedBytes <= QUEUE_PAUSE_BYTES / 2 && !pipe.blackholed) {
      pipe.sourcePaused = false;
      pipe.source.resume();
    }
  }

  const pumpTimer = setInterval(() => {
    const now = Date.now();
    const budget = throttleBps > 0 ? (throttleBps * PUMP_MS) / 1000 : Number.POSITIVE_INFINITY;
    for (const conn of [...conns]) {
      if (idleTimeoutMs > 0 && now - conn.lastActivityAt > idleTimeoutMs) {
        destroyConn(conn);
        continue;
      }
      pumpPipe(conn.c2s, budget);
      pumpPipe(conn.s2c, budget);
    }
  }, PUMP_MS);
  pumpTimer.unref(); // 不阻止进程退出（测试收尾另有 close 清理）

  function destroyConn(conn: ConnState): void {
    if (!conns.delete(conn)) return; // 幂等
    destroyed += 1;
    conn.client.destroy();
    conn.target?.destroy();
  }

  function wirePipe(conn: ConnState, pipe: Pipe): void {
    pipe.source.on('data', (chunk: Buffer) => {
      conn.lastActivityAt = Date.now();
      const delay = latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
      pipe.queue.push({ chunk, due: Date.now() + delay });
      pipe.queuedBytes += chunk.length;
      if (!pipe.sourcePaused && pipe.queuedBytes > QUEUE_PAUSE_BYTES) {
        pipe.sourcePaused = true;
        pipe.source.pause();
      }
    });
    // 对端 RST/断开：消化 error（防未处理事件崩测试进程），close 时拆对端
    pipe.source.on('error', () => undefined);
    pipe.source.on('close', () => {
      conns.delete(conn);
      pipe.dest.destroy();
    });
  }

  /** rejectUpgrade 模式：读完 HTTP 头回错误响应再关（反代 502/404 保真） */
  function wireReject(client: net.Socket, status: number): void {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0 && head.length <= 16 * 1024) return;
      client.removeListener('data', onData);
      const body = Buffer.alloc(0);
      client.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`,
      );
    };
    client.on('data', onData);
    client.on('error', () => undefined);
    client.on('close', () => undefined);
  }

  const server = net.createServer((client) => {
    if (closed) { client.destroy(); return; }
    if (rejectStatus !== null) { wireReject(client, rejectStatus); return; }
    const target = net.createConnection({ host: opts.targetHost, port: opts.targetPort });
    const conn: ConnState = {
      client,
      target,
      c2s: { source: client, dest: target, queue: [], queuedBytes: 0, blackholed: false, sourcePaused: false },
      s2c: { source: target, dest: client, queue: [], queuedBytes: 0, blackholed: false, sourcePaused: false },
      lastActivityAt: Date.now(),
    };
    conns.add(conn);
    target.on('error', () => client.destroy()); // target 不可达/被 RST → 客户端看到断开
    wirePipe(conn, conn.c2s);
    wirePipe(conn, conn.s2c);
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (typeof addr === 'string' || !addr) { reject(new Error('no addr')); return; }
          resolve(addr.port);
        });
      });
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(pumpTimer);
      if (flappyTimer) { clearInterval(flappyTimer); flappyTimer = null; }
      for (const conn of [...conns]) destroyConn(conn);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    destroyAll(): void {
      for (const conn of [...conns]) destroyConn(conn);
    },
    blackhole(direction: ChaosDirection = 'both'): void {
      for (const conn of conns) {
        if (direction === 'c2s' || direction === 'both') {
          conn.c2s.blackholed = true;
          conn.c2s.source.pause(); // 窗口填满 = 真实丢包/半开
        }
        if (direction === 's2c' || direction === 'both') {
          conn.s2c.blackholed = true;
          conn.s2c.source.pause();
        }
      }
    },
    heal(): void {
      for (const conn of conns) {
        for (const pipe of [conn.c2s, conn.s2c]) {
          pipe.blackholed = false;
          if (!pipe.sourcePaused) pipe.source.resume(); // 冲刷内核积压，转发恢复
        }
      }
    },
    setLatency(ms: number, jitter = 0): void { latencyMs = ms; jitterMs = jitter; },
    setThrottle(bytesPerSec: number): void { throttleBps = bytesPerSec; },
    setIdleTimeout(ms: number): void { idleTimeoutMs = ms; },
    flappy(intervalMs: number): void {
      if (flappyTimer) clearInterval(flappyTimer);
      flappyTimer = setInterval(() => {
        for (const conn of [...conns]) destroyConn(conn);
      }, intervalMs);
      flappyTimer.unref();
    },
    stopFlappy(): void {
      if (flappyTimer) { clearInterval(flappyTimer); flappyTimer = null; }
    },
    rejectUpgradeWith(status: number): void { rejectStatus = status; },
    clearRejectUpgrade(): void { rejectStatus = null; },
    stats(): ChaosProxyStats {
      return { connections: conns.size, destroyed, bytesRelayed };
    },
  };
}
```

```ts
// packages/chaos-proxy/src/index.ts
export {
  createChaosProxy,
  type ChaosDirection,
  type ChaosProxy,
  type ChaosProxyOptions,
  type ChaosProxyStats,
} from './chaos-proxy';
```

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm --filter chaos-proxy test && pnpm --filter chaos-proxy typecheck`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add packages/chaos-proxy pnpm-lock.yaml
git commit -m "feat(chaos-proxy): 包脚手架 + TCP 透传底座（队列+泵模型，故障字段就位）（M2）"
```

---

### Task 7: M2 — destroyAll / blackhole / heal 单测锁定

**Files:**
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Consumes: Task 6 实现（语义已实现，本任务补测试锁定）
- Produces: S4-S7 场景依赖的原语行为契约

- [ ] **Step 1: 写测试并确认通过（实现已在 Task 6 就位；若红则按测试修正实现）**

```ts
describe('destroy / blackhole / heal', () => {
  it('destroyAll：客户端收到连接终止，stats.destroyed 记账', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const closed = new Promise<void>((r) => s.on('close', r));
    proxy.destroyAll();
    await closed;
    expect(proxy.stats().destroyed).toBe(1);
    expect(proxy.stats().connections).toBe(0);
  });

  it('blackhole：数据静默无回（不 RST）；heal 后恢复转发', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    proxy.blackhole('both');
    let received = 0;
    s.on('data', () => { received += 1; });
    s.write('ping');
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(0); // 黑洞：无任何回包
    expect(s.destroyed).toBe(false); // 且不 RST（半开保真）
    proxy.heal();
    await new Promise<void>((resolve) => {
      s.on('data', function onData() { s.removeListener('data', onData); resolve(); });
      s.write('ping2');
    });
    expect(received).toBeGreaterThan(0); // heal 后自愈
  });
});
```

- [ ] **Step 2: 跑测试 + typecheck**

Run: `pnpm --filter chaos-proxy test && pnpm --filter chaos-proxy typecheck`
Expected: 全绿（注意 heal 用例第一次 write 在黑洞期被 pause 在源侧内核，heal 后冲刷——若断言_received_ 只计 heal 后数据，先写即得）

- [ ] **Step 3: Commit**

```bash
git add packages/chaos-proxy/src/chaos-proxy.test.ts packages/chaos-proxy/src/chaos-proxy.ts
git commit -m "test(chaos-proxy): destroy/blackhole/heal 语义锁定（M2）"
```

---

### Task 8: M2 — latency / throttle / idleTimeout 单测锁定

**Files:**
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Consumes: Task 6 实现
- Produces: S8-S11 场景依赖的原语行为契约

- [ ] **Step 1: 写测试并确认通过（若红则按测试修正实现）**

```ts
describe('latency / throttle / idleTimeout', () => {
  it('setLatency：回包延迟 ≥ 设定值', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setLatency(200);
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const started = Date.now();
    await new Promise<void>((resolve) => {
      s.on('data', () => resolve());
      s.write('x');
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(380); // 双向各 200ms（留 20ms 时钟余量）
  });

  it('setThrottle：吞吐被钳制在速率附近', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setThrottle(100_000); // 100KB/s
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const total = 200_000;
    const started = Date.now();
    let got = 0;
    const done = new Promise<void>((resolve) => {
      s.on('data', (c) => { got += c.length; if (got >= total) resolve(); });
    });
    s.write(Buffer.alloc(total)); // 必须先写后等（执行期修正：原稿 await 在 write 前会死锁）
    await done;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500); // 理论 2s（回显 200KB），下限留余量
    expect(elapsed).toBeLessThan(6000); // 上限防泵实现失控
  });

  it('setIdleTimeout：空闲连接被 destroy；活跃连接存活', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setIdleTimeout(300);
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const closed = new Promise<void>((r) => s.on('close', r));
    await closed; // 空闲 300ms 后被回收
    expect(proxy.stats().destroyed).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试 + typecheck**

Run: `pnpm --filter chaos-proxy test && pnpm --filter chaos-proxy typecheck`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add packages/chaos-proxy/src/chaos-proxy.test.ts packages/chaos-proxy/src/chaos-proxy.ts
git commit -m "test(chaos-proxy): latency/throttle/idleTimeout 语义锁定（M2）"
```

---

### Task 9: M2 — flappy / rejectUpgradeWith 单测锁定

**Files:**
- Test: `packages/chaos-proxy/src/chaos-proxy.test.ts`

**Interfaces:**
- Consumes: Task 6 实现
- Produces: S2/S12/S18（超时支路）依赖的原语行为契约

- [ ] **Step 1: 写测试并确认通过（若红则按测试修正实现）**

```ts
describe('flappy / rejectUpgrade', () => {
  it('flappy：周期 destroy 新连接；stopFlappy 后新连接存活', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.flappy(200);
    const s1 = dial(port);
    const closed1 = new Promise<void>((r) => s1.on('close', r));
    await closed1; // 下一个 tick 被杀
    expect(proxy.stats().destroyed).toBeGreaterThanOrEqual(1);
    proxy.stopFlappy();
    const s2 = dial(port);
    await new Promise<void>((r) => s2.on('connect', r));
    await new Promise((r) => setTimeout(r, 450));
    expect(s2.destroyed).toBe(false);
  });

  it('rejectUpgradeWith(502)：读到 HTTP 错误响应；clearRejectUpgrade 后恢复透传', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.rejectUpgradeWith(502);
    const s = dial(port);
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve) => {
      s.on('data', (c) => chunks.push(c));
      s.on('close', () => resolve(Buffer.concat(chunks)));
    });
    s.write('GET /__gateway__/tunnel HTTP/1.1\r\nHost: x\r\n\r\n');
    expect((await done).toString()).toContain('HTTP/1.1 502');
    proxy.clearRejectUpgrade();
    const s2 = dial(port);
    const echoed = new Promise<void>((resolve) => {
      s2.on('data', () => resolve());
      s2.on('connect', () => s2.write('ok'));
    });
    await echoed;
  });
});
```

- [ ] **Step 2: 跑测试 + typecheck**

Run: `pnpm --filter chaos-proxy test && pnpm --filter chaos-proxy typecheck`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add packages/chaos-proxy/src/chaos-proxy.test.ts packages/chaos-proxy/src/chaos-proxy.ts
git commit -m "test(chaos-proxy): flappy/rejectUpgrade 语义锁定（M2 完成）"
```

---

### Task 10: M3 — A 组建连期场景（client e2e-chaos：S1/S2/S3）

**Files:**
- Modify: `packages/client/package.json`（devDependencies 加 `"chaos-proxy": "workspace:*"`）
- Test: `packages/client/src/e2e-chaos.test.ts`

**Interfaces:**
- Consumes: chaos-proxy 完整 API（Task 6-9）；`ClientOptions`（`reconnect.baseDelayMs`、`connectTimeoutMs`、`logger`）
- Produces: `waitFor(fn: () => boolean, timeoutMs, label?): Promise<void>` 条件轮询助手（本文件导出，server 侧 Task 11 复制同款——跨包不共享测试工具，有意为之）

- [ ] **Step 1: `pnpm install`（package.json 变更后）**

Run: `pnpm install`

- [ ] **Step 2: 写失败测试**

```ts
// packages/client/src/e2e-chaos.test.ts
/**
 * A 组建连期故障场景（spec §7）— 真实 Client + chaos-proxy + 最小 hello 网关。
 * 断言错误日志内容（M0 修复后的诊断可见性在库层同样成立）与退避重连收敛。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChaosProxy, type ChaosProxy } from 'chaos-proxy';
import { WebSocketServer, type WebSocket } from 'ws';

import { Client } from './client';
import type { LogLevel } from './logger';

interface LogEntry { level: LogLevel; message: string; context?: Record<string, unknown> }

/** 日志捕获：断言 err.stack/错误码可见性的载体 */
function captureLog(): { entries: LogEntry[]; logger: import('./logger').Logger } {
  const entries: LogEntry[] = [];
  const push = (level: LogLevel) => (message: string, context?: Record<string, unknown>): void => {
    entries.push({ level, message, context });
  };
  return { entries, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } };
}

/** 条件轮询（禁固定 sleep）：到点不达即失败并带现场 */
async function waitFor(fn: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (fn()) return;
  throw new Error(`waitFor 超时: ${label}`);
}

/** 最小 hello 网关：hello → ack + ping → pong（供 S1/S2 的最终收敛）；port 缺省 0（ephemeral） */
class HelloGateway {
  private wss: WebSocketServer;
  private sockets = new Set<WebSocket>();
  readonly listening: Promise<void>;
  constructor(port = 0) {
    this.wss = new WebSocketServer({ port });
    this.listening = new Promise<void>((r) => this.wss.on('listening', r));
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'hello') ws.send(JSON.stringify({ type: 'hello.ack', tunnelId: 'tid-a' }));
        else if (frame.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
  }
  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}`;
  }
  get port(): number {
    const addr = this.wss.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return addr.port;
  }
  async close(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const clients: Client[] = [];
const gateways: HelloGateway[] = [];
const proxies: ChaosProxy[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  for (const p of proxies.splice(0)) await p.close();
  for (const g of gateways.splice(0)) await g.close();
});

function makeClient(gatewayUrl: string, logger: import('./logger').Logger): Client {
  const client = new Client({
    upstreamUrl: 'http://127.0.0.1:1', // A 组不开通道，upstream 不参与
    gatewayUrl,
    hostname: 'pc-chaos',
    logger,
    heartbeatIntervalMs: 300,
    connectTimeoutMs: 8000,
    reconnect: { baseDelayMs: 100, maxDelayMs: 500 },
  });
  client.on('error', () => undefined); // EventEmitter 语义：error 必须挂监听
  clients.push(client);
  return client;
}

describe('A 组：建连期故障', () => {
  it('S1：对端不可达（ECONNREFUSED）→ 退避重试；服务恢复后 connected；日志含错误码', async () => {
    // 拿一个"必拒"端口：先监听再关闭（loopback 下被抢注概率可忽略）
    const probe = new HelloGateway();
    await probe.listening;
    const port = probe.port;
    await probe.close();
    const { entries, logger } = captureLog();
    const client = makeClient(`ws://127.0.0.1:${port}/__gateway__/tunnel`, logger);
    const connected = new Promise<void>((r) => client.on('connected', r));
    void client.connect().catch(() => undefined);
    await waitFor(() => entries.filter((e) => e.message === '隧道重连中').length >= 2, 5000, '退避重试 ≥2 次');
    await waitFor(
      () => entries.some((e) => /ECONNREFUSED/.test(String(e.context?.['error'] ?? ''))),
      1000, 'ECONNREFUSED 诊断可见',
    );
    // 服务恢复：同端口起真网关 → connectTimeoutMs(8s) 内恢复即成功
    const gw = new HelloGateway(port);
    gateways.push(gw);
    await gw.listening;
    await connected;
  }, 15_000);

  it('S2：反代 502 → error 日志含 Unexpected server response: 502；清除后自愈 connected', async () => {
    const gw = new HelloGateway();
    gateways.push(gw);
    await gw.listening;
    const proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: gw.port });
    proxies.push(proxy);
    const proxyPort = await proxy.listen();
    proxy.rejectUpgradeWith(502);
    const { entries, logger } = captureLog();
    const client = makeClient(`ws://127.0.0.1:${proxyPort}/__gateway__/tunnel`, logger);
    const connected = new Promise<void>((r) => client.on('connected', r));
    void client.connect().catch(() => undefined);
    await waitFor(
      () => entries.some((e) => e.level === 'error' && String(e.context?.['error'] ?? '').includes('Unexpected server response: 502')),
      5000, '502 诊断可见',
    );
    proxy.clearRejectUpgrade();
    await connected; // 退避后自愈
  });

  it('S3：域名不存在（ENOTFOUND/EAI_AGAIN）→ 诊断明确、connectTimeout reject、进程不崩', async () => {
    const { entries, logger } = captureLog();
    const client = makeClient('ws://nonexistent.invalid/__gateway__/tunnel', logger);
    await expect(client.connect()).rejects.toThrow('connect timeout');
    await waitFor(
      () => entries.some((e) => /ENOTFOUND|EAI_AGAIN/.test(String(e.context?.['error'] ?? ''))),
      1000, 'DNS 错误码可见',
    );
  });
});
```

- [ ] **Step 3: 跑测试确认行为**

Run: `pnpm --filter gateway-client test -- e2e-chaos`
Expected: 全绿（✅ 场景为回归固化；红则按 systematic-debugging 定位后修实现，不得改断言语义）

- [ ] **Step 4: Commit**

```bash
git add packages/client/package.json packages/client/src/e2e-chaos.test.ts pnpm-lock.yaml
git commit -m "test(client): A 组建连期故障场景——ECONNREFUSED/反代502/DNS 诊断与退避收敛（M3 S1-S3）"
```

---

### Task 11: M3 — server e2e-chaos 骨架 + B 组 S4-S7

**Files:**
- Modify: `packages/server/package.json`（devDependencies 加 `"chaos-proxy": "workspace:*"`、`"gateway-client": "workspace:*"`）
- Test: `packages/server/src/e2e-chaos.test.ts`

**Interfaces:**
- Consumes: chaos-proxy API；真实 `Client`（gateway-client）；`GatewayServer`
- Produces: `startStack()` 测试骨架（Task 12-15 复用）：
```ts
interface Stack {
  server: GatewayServer; proxy: ChaosProxy; client: Client;
  tunnelId: string; cookie: string;
  entries: LogEntry[]; // 客户端日志捕获
}
async function startStack(opts?: {
  heartbeatIntervalMs?: number; graceMs?: number; serverTtlMs?: number;
}): Promise<Stack>;
async function stopStack(s: Stack): Promise<void>; // 幂等收尾
```

- [ ] **Step 1: `pnpm install`**

Run: `pnpm install`

- [ ] **Step 2: 写骨架 + S4-S7 测试**

```ts
// packages/server/src/e2e-chaos.test.ts
/**
 * B/C/F 组会话期故障场景（spec §7）— 真实 Client ⇄ chaos-proxy ⇄ 真实 GatewayServer ⇄ 真实 upstream。
 * 断言契约：断连日志 code 可见（M0 在库层的对应面）；tunnelId 复用 cookie 免重登；
 * 在途通道 502 一次是正确语义；判死/自愈边界精确。
 */
import { createServer, type Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import { createChaosProxy, type ChaosProxy } from 'chaos-proxy';
import { Client } from 'gateway-client';
import { WebSocketServer } from 'ws';

import { GatewayServer } from './server';
import type { Logger } from './logger';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

interface LogEntry { level: string; message: string; context?: Record<string, unknown> }

function captureLog(): { entries: LogEntry[]; logger: Logger } {
  const entries: LogEntry[] = [];
  const push = (level: string) => (message: string, context?: Record<string, unknown>): void => {
    entries.push({ level, message, context });
  };
  return { entries, logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') } as Logger };
}

async function waitFor(fn: () => boolean, timeoutMs: number, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (fn()) return;
  throw new Error(`waitFor 超时: ${label}`);
}

interface Stack {
  server: GatewayServer;
  proxy: ChaosProxy;
  client: Client;
  upstream: Server;
  serverPort: number;
  tunnelId: string;
  cookie: string;
  entries: LogEntry[];
  onDisconnected: () => void;
  onConnected: () => void;
}

const stacks: Stack[] = [];

/** 一键起全栈：upstream（echo + /file?bytes=N）→ GatewayServer → chaos-proxy → 真实 Client（token good-token） */
async function startStack(opts: { heartbeatIntervalMs?: number; graceMs?: number } = {}): Promise<Stack> {
  const upstream = createServer((req, res) => {
    if (req.url?.startsWith('/file')) {
      const bytes = Number(new URL(req.url, 'http://x').searchParams.get('bytes') ?? '1024');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes) });
      let sent = 0;
      const chunk = Buffer.alloc(64 * 1024, 1);
      const writeMore = (): void => {
        while (sent < bytes) {
          const n = Math.min(chunk.length, bytes - sent);
          sent += n;
          if (!res.write(chunk.subarray(0, n))) { res.once('drain', writeMore); return; }
        }
        res.end();
      };
      writeMore();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamAddr = upstream.address();
  if (typeof upstreamAddr === 'string' || !upstreamAddr) throw new Error('no addr');

  const { entries, logger } = captureLog();
  const server = new GatewayServer({
    port: 0, headTimeoutMs: 10_000, helloTimeoutMs: 2000, logger: nullLogger,
    ...(opts.graceMs !== undefined ? { tunnelRestoreGraceMs: opts.graceMs } : {}),
  });
  const serverPort = await server.listen();

  const proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: serverPort });
  const proxyPort = await proxy.listen();

  let disconnectedCount = 0;
  let connectedCount = 0;
  const client = new Client({
    upstreamUrl: `http://127.0.0.1:${upstreamAddr.port}`,
    gatewayUrl: `ws://127.0.0.1:${proxyPort}/__gateway__/tunnel`,
    hostname: 'pc-chaos',
    token: 'good-token',
    logger,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 300,
    connectTimeoutMs: 10_000,
    reconnect: { baseDelayMs: 100, maxDelayMs: 500 },
  });
  client.on('error', () => undefined);
  client.on('fatal', () => undefined);
  const stack: Stack = {
    server, proxy, client, upstream, serverPort,
    tunnelId: '', cookie: '', entries,
    onDisconnected: () => { disconnectedCount += 1; },
    onConnected: () => { connectedCount += 1; },
  };
  client.on('disconnected', stack.onDisconnected);
  client.on('connected', stack.onConnected);
  stacks.push(stack);
  await client.connect();
  stack.tunnelId = client.tunnelId ?? '';
  expect(stack.tunnelId).not.toBe('');

  const res = await fetch(`http://127.0.0.1:${serverPort}/__gateway__/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `tunnelId=${stack.tunnelId}&token=good-token`,
    redirect: 'manual',
  });
  expect(res.status).toBe(200);
  stack.cookie = res.headers.get('set-cookie') ?? '';
  return stack;
}

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.client.close().catch(() => undefined);
    await s.proxy.close();
    await s.server.close();
    await new Promise<void>((r) => s.upstream.close(() => r()));
  }
});

const fetchApp = (s: Stack, path = '/api/x', init?: RequestInit): Promise<Response> =>
  fetch(`http://127.0.0.1:${s.serverPort}${path}`, {
    ...init,
    headers: { cookie: s.cookie, ...(init?.headers ?? {}) },
  });

const disconnectedCount = (s: Stack): number =>
  s.entries.filter((e) => e.message === '隧道连接断开').length;

describe('B 组：会话期传输故障', () => {
  it('S4：空闲断链 → 自动重连 + tunnelId 复用 + 老 cookie 免重登 + 断开日志 code=1006', async () => {
    const s = await startStack();
    const tid = s.tunnelId;
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开日志');
    await waitFor(() => s.client.ready && s.entries.some((e) => e.message === '隧道就绪' && e.context?.['tunnelId'] === tid), 5000, 'tunnelId 复用重连');
    const res = await fetchApp(s);
    expect(res.status).toBe(200);
    const disc = s.entries.find((e) => e.message === '隧道连接断开');
    expect(disc?.context?.['code']).toBe(1006); // RST → 无 close 帧
  });

  it('S5：大流量中断链 → 在途请求 502 一次；重连后新请求正常；客户端通道表清空', async () => {
    const s = await startStack();
    const pending = fetchApp(s, '/file?bytes=5242880'); // 5MB 下载中
    await new Promise((r) => setTimeout(r, 200)); // 确保已进通道
    s.proxy.destroyAll();
    const res = await pending.catch(() => null);
    expect(res === null || res.status === 502).toBe(true); // 在途失败一次（正确语义）
    await waitFor(() => s.client.ready, 5000, '重连就绪');
    const after = await fetchApp(s, '/file?bytes=1024');
    expect(after.status).toBe(200);
    expect((s.client as unknown as { channels: Map<number, unknown> }).channels.size).toBe(0); // 无泄漏
  });

  it('S6：静默黑洞（半开）→ 判死窗口内 terminate + 自动重连', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 }); // 判死 ≈900ms
    s.proxy.blackhole('both');
    await waitFor(() => s.entries.some((e) => e.message === '心跳超时，判定死连接'), 3000, '心跳判死');
    await waitFor(() => disconnectedCount(s) >= 1, 3000, '断开');
    s.proxy.heal(); // 重连需要通路
    await waitFor(() => s.client.ready, 5000, '判死后重连');
    expect((await fetchApp(s)).status).toBe(200);
  });

  it('S7：黑洞在判死窗口内 heal → 不重连、会话无损', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.blackhole('both');
    await new Promise((r) => setTimeout(r, 400)); // < 900ms 判死窗
    s.proxy.heal();
    await new Promise((r) => setTimeout(r, 1000)); // 观察一个判死周期
    expect(disconnectedCount(s)).toBe(0); // 无断开：黑洞短于判死窗可自愈
    expect((await fetchApp(s)).status).toBe(200);
  });
});
```

- [ ] **Step 3: 跑测试确认行为**

Run: `pnpm --filter gateway-server test -- e2e-chaos`
Expected: 全绿；红则按 systematic-debugging 定位（先读断连日志 code/readyMs），修实现不改断言语义

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json packages/server/src/e2e-chaos.test.ts pnpm-lock.yaml
git commit -m "test(server): e2e-chaos 骨架 + B 组断链/黑洞场景——重连复用、在途502、判死与自愈（M3 S4-S7）"
```

---

### Task 12: M3 — B 组 S8/S9（心跳续命 vs 中间盒空闲回收）+ 部署文档

**Files:**
- Test: `packages/server/src/e2e-chaos.test.ts`（追加 describe 用例）
- Modify: `README.md`（部署注意一节）

**Interfaces:**
- Consumes: Task 11 的 `startStack`
- Produces: S8/S9 回归锁 + "心跳间隔必须 < 中间盒空闲超时"部署约束文档

- [ ] **Step 1: 写测试**

```ts
describe('B 组：空闲回收 vs 心跳续命', () => {
  it('S8：空闲回收(2s)慢于心跳(300ms) → 存活 ≥6s 零断开', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.setIdleTimeout(2000);
    await new Promise((r) => setTimeout(r, 6000));
    expect(disconnectedCount(s)).toBe(0);
    s.proxy.setIdleTimeout(0); // 收尾不再杀
    expect((await fetchApp(s)).status).toBe(200);
  }, 15_000);

  it('S9：空闲回收(3s)快于心跳(10s) → 每轮回收自动重连 ≥2 周期，cookie 始终可用', async () => {
    const s = await startStack({ heartbeatIntervalMs: 10_000 });
    s.proxy.setIdleTimeout(3000);
    await waitFor(() => disconnectedCount(s) >= 2, 20_000, '两次回收重连');
    s.proxy.setIdleTimeout(0);
    await waitFor(() => s.client.ready, 5000, '末轮重连就绪');
    expect((await fetchApp(s)).status).toBe(200);
  }, 30_000);
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm --filter gateway-server test -- e2e-chaos`
Expected: 全绿

- [ ] **Step 3: README 部署注意（在合适章节追加；无部署章节则新建）**

```markdown
## 部署注意（真实网络）

- **心跳间隔必须小于链路上最短的中间盒空闲超时**（Nginx `proxy_read_timeout` 默认 60s、
  Cloudflare ≈100s、家用 NAT 通常小时级、移动 CGNAT 可短至数分钟）。客户端默认 30s
  应用层 ping 可覆盖绝大多数场景；部署在空闲超时 <30s 的反代后时，必须用
  `heartbeatIntervalMs` 调小客户端心跳，否则隧道会被周期性回收（表现：规律性 1006 重连）。
- 反代必须为隧道路径开启 WS Upgrade 转发（Nginx：`proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";`），否则客户端报 `Unexpected server response`。
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/e2e-chaos.test.ts README.md
git commit -m "test(server): 心跳续命 vs 空闲回收场景 + 部署文档心跳/反代约束（M3 S8-S9）"
```

---

### Task 13: M3 — C 组品质劣化场景（S10 高 RTT / S11 限速 / S12 重连风暴）⚡

**Files:**
- Test: `packages/server/src/e2e-chaos.test.ts`（追加 describe 用例）

**Interfaces:**
- Consumes: Task 11 的 `startStack`
- Produces: S10-S12 回归锁；⚡ 红灯时按 systematic-debugging 出修复任务（不得改断言语义放行）

- [ ] **Step 1: 写测试**

```ts
describe('C 组：链路品质劣化', () => {
  it('S10：高 RTT(150ms±50) 下 5MB 下载 → headTimeout 不触发、不判死、字节完整', async () => {
    const s = await startStack({ heartbeatIntervalMs: 1000 });
    s.proxy.setLatency(150, 50);
    const res = await fetchApp(s, '/file?bytes=5242880');
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(5242880);
    expect(disconnectedCount(s)).toBe(0);
  }, 60_000);

  it('S11：限速 128KB/s 上传 1MB → 背压有界 + ack 活性保心跳不判死', async () => {
    const s = await startStack({ heartbeatIntervalMs: 2000 }); // 判死 6s
    s.proxy.setThrottle(128 * 1024);
    const started = Date.now();
    const res = await fetchApp(s, '/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.alloc(1024 * 1024, 2),
    });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000); // ≈8s 证明限速生效
    expect(disconnectedCount(s)).toBe(0); // tunnel.ack 入站活性兜底（线上断连根因修复的回归锁）
  }, 30_000);

  it('S12：flappy(1s)×15 重连风暴 → 每次恢复 connected、无 fatal、稳态定时器单例', async () => {
    const s = await startStack({ heartbeatIntervalMs: 300 });
    s.proxy.flappy(1000);
    await waitFor(() => disconnectedCount(s) >= 15, 25_000, '15 次断开重连');
    s.proxy.stopFlappy();
    await waitFor(() => s.client.ready, 5000, '末次重连就绪');
    await new Promise((r) => setTimeout(r, 1000)); // 稳态观察窗
    expect(s.entries.some((e) => e.message === '重连次数耗尽，停止重试')).toBe(false); // 无终态
    const conn = s.client as unknown as { connection: { heartbeatTimer: unknown; reconnectTimer: unknown } };
    expect(conn.connection.heartbeatTimer).not.toBeNull(); // 心跳在跑
    expect(conn.connection.reconnectTimer).toBeNull(); // 无残留重连定时器
    expect((await fetchApp(s)).status).toBe(200);
  }, 40_000);
});
```

- [ ] **Step 2: 跑测试确认行为**

Run: `pnpm --filter gateway-server test -- e2e-chaos`
Expected: 全绿。⚡ 若红：**这是场景的设计目的**——按 systematic-debugging 出根因（证据先行：断连 code/readyMs/心跳 silentMs），最小修复后固化，修复单独提交并在消息中引用场景号

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/e2e-chaos.test.ts
git commit -m "test(server): C 组高RTT/限速/重连风暴场景——流量窗口、ack 活性、退避收敛（M3 S10-S12）"
```

---

### Task 14: M3 — D 组 S13 坏帧注入（e2e 固化）

**Files:**
- Test: `packages/server/src/e2e-chaos.test.ts`（追加 describe 用例）

**Interfaces:**
- Consumes: `GatewayServer`（helloTimeoutMs）；ws 库裸客户端
- Produces: S13 回归锁（单测已有协议层覆盖，此处锁 e2e 行为）

- [ ] **Step 1: 写测试**

```ts
describe('D 组：协议健壮性', () => {
  it('S13：hello 后 4 坏帧隧道存活（ping 有 pong），第 5 坏帧触发 1002 断开', async () => {
    const s = await startStack(); // 仅借用 server；本用例直连不走 proxy/client
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${s.serverPort}/__gateway__/tunnel`);
    await new Promise<void>((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', client: { hostname: 'evil', defaultPath: '/' } }));
    await new Promise<void>((resolve) => {
      ws.on('message', function onMsg(raw) {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'hello.ack') { ws.removeListener('message', onMsg); resolve(); }
      });
    });
    const bad = Buffer.from([0xff, 0x00, 0x01]); // 非协议二进制帧
    for (let i = 0; i < 4; i++) ws.send(bad);
    // 4 帧未超预算：ping 应有 pong（隧道存活）
    const pong = new Promise<void>((resolve) => {
      ws.on('message', function onMsg(raw) {
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'pong') { ws.removeListener('message', onMsg); resolve(); }
      });
    });
    ws.send(JSON.stringify({ type: 'ping' }));
    await pong;
    // 第 5 帧超预算 → 1002。注意预算是"连续"语义：成功解码的 ping 已重置连续坏帧计数
    // （tunnel.ts 路由阶段成功解码即清零，单测锁定间歇坏帧不升级——执行期修正：原稿
    // ping 夹在第 4/5 坏帧间会清零计数，永不触发 1002），
    // 故超预算验证须再起一轮连续 5 坏帧，由该轮第 5 帧触发断开
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    for (let i = 0; i < 5; i++) ws.send(bad);
    expect(await closed).toBe(1002);
  });
});
```

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm --filter gateway-server test -- e2e-chaos`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/e2e-chaos.test.ts
git commit -m "test(server): D 组坏帧注入 e2e——5 帧预算 → 1002（M3 S13）"
```

---

### Task 15: M3 — F1 瞬断宽限（registry.waitFor + 双 proxy + S18/S19）

**Files:**
- Modify: `packages/server/src/session.ts`（`TunnelRegistry.waitFor` + set/teardownAll/closeAll 唤醒）
- Modify: `packages/server/src/server.ts`（`tunnelRestoreGraceMs` 选项 + proxyCtx 透传 + 两处调用点 async 化）
- Modify: `packages/server/src/http-proxy.ts`（离线分支宽限等待 + `handleBrowserHttp` async 化）
- Modify: `packages/server/src/ws-proxy.ts`（离线分支宽限等待 + `handleBrowserWs` async 化）
- Test: `packages/server/src/session.test.ts`、`packages/server/src/http-proxy.test.ts`、`packages/server/src/ws-proxy.test.ts`（ctx 字面量补 `tunnelRestoreGraceMs: 0`）、`packages/server/src/e2e-chaos.test.ts`（S18/S19）

**Interfaces:**
- Consumes: Task 11 骨架；`TunnelRegistry`
- Produces:
  - `TunnelRegistry.waitFor(tunnelId: string, timeoutMs: number): Promise<TunnelSession | null>`（已在立即返回；超时 null；teardownAll/closeAll 全部唤醒 null）
  - `GatewayServerOptions.tunnelRestoreGraceMs?: number`（默认 30_000，须非负整数；0 = 即时 502 旧行为）
  - 两个 `ProxyContext` 均加 `tunnelRestoreGraceMs: number`（必填字段——测试 ctx 字面量同步补 0）

- [ ] **Step 1: 写失败测试（session 单测先行）**

`session.test.ts` 追加：

```ts
describe('TunnelRegistry.waitFor（瞬断宽限）', () => {
  it('已在立即返回；上线唤醒；超时 null；teardownAll 唤醒 null', async () => {
    const registry = new TunnelRegistry();
    const session = makeSession(); // 复用文件内既有 session 构造助手
    // 已在
    registry.set('tid-1', session);
    await expect(registry.waitFor('tid-1', 50)).resolves.toBe(session);
    registry.delete('tid-1', session);
    // 上线唤醒
    const pending = registry.waitFor('tid-2', 1000);
    registry.set('tid-2', session);
    await expect(pending).resolves.toBe(session);
    // 超时 null
    await expect(registry.waitFor('tid-3', 50)).resolves.toBeNull();
    // teardownAll 唤醒 null
    const hanging = registry.waitFor('tid-4', 60_000);
    registry.teardownAll();
    await expect(hanging).resolves.toBeNull();
  });
});
```

`http-proxy.test.ts`：既有"隧道离线 → 502"用例所在 ctx 补 `tunnelRestoreGraceMs: 0`（保持即时 502）；新增：

```ts
it('宽限内隧道恢复 → 请求挂起后正常转发（不 502）', async () => {
  // 复用文件内既有 fake tunnel/registry 形态：ctx.tunnelRestoreGraceMs = 1000；
  // 请求发出时 registry 为空，200ms 后 registry.set(uuid 对应 tunnelId 的 fake tunnel)，
  // 断言响应为转发结果而非 502
});
```

（ws-proxy.test.ts 同理：ctx 补 `tunnelRestoreGraceMs: 0`；宽限用例可选——e2e S19 已锁行为。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server test -- session http-proxy ws-proxy`
Expected: FAIL（waitFor / tunnelRestoreGraceMs 不存在）

- [ ] **Step 3: 实现**

`session.ts`（TunnelRegistry 内）：

```ts
  private readonly attachWaiters = new Set<{
    tunnelId: string;
    timer: NodeJS.Timeout;
    resolve: (s: TunnelSession | null) => void;
  }>();

  /**
   * 等待隧道上线（瞬断宽限）：已在立即返回；超时 resolve null；
   * teardownAll/closeAll 全部唤醒 null（服务端关停不得悬挂浏览器请求）
   */
  waitFor(tunnelId: string, timeoutMs: number): Promise<TunnelSession | null> {
    const existing = this.tunnels.get(tunnelId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter = {
        tunnelId,
        timer: setTimeout(() => {
          this.attachWaiters.delete(waiter);
          resolve(null);
        }, timeoutMs),
        resolve,
      };
      waiter.timer.unref();
      this.attachWaiters.add(waiter);
    });
  }

  set(tunnelId: string, session: TunnelSession): void {
    this.tunnels.set(tunnelId, session);
    for (const w of [...this.attachWaiters]) {
      if (w.tunnelId !== tunnelId) continue;
      clearTimeout(w.timer);
      this.attachWaiters.delete(w);
      w.resolve(session);
    }
  }

  /** 关停唤醒：等待方一律 null（走 502 快失败，不悬挂） */
  private failAllWaiters(): void {
    for (const w of [...this.attachWaiters]) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.attachWaiters.clear();
  }
  // teardownAll() / closeAll() 首行各调用 this.failAllWaiters();
```

`server.ts`：options 加 `tunnelRestoreGraceMs?: number`（默认 30_000；校验：非负整数——`Number.isInteger(v) && v >= 0`，报错文案 `GatewayServerOptions.tunnelRestoreGraceMs 必须是非负整数毫秒值`）；proxyCtx 字面量加 `tunnelRestoreGraceMs`；HTTP 调用点：

```ts
      // 原：handleBrowserHttp(req, res, proxyCtx);
      void handleBrowserHttp(req, res, proxyCtx).catch((err: unknown) => {
        this.logger.error('浏览器 HTTP 处理异常', { error: err instanceof Error ? err.stack : String(err) });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
```

upgrade 调用点：

```ts
      // 原：handleBrowserWs(req, socket, head, browserWss, proxyCtx);
      void handleBrowserWs(req, socket, head, browserWss, proxyCtx).catch((err: unknown) => {
        this.logger.error('浏览器 WS 处理异常', { error: err instanceof Error ? err.stack : String(err) });
        socket.destroy();
      });
```

`http-proxy.ts`：`ProxyContext` 加 `tunnelRestoreGraceMs: number`；`handleBrowserHttp` 改 `async`，离线分支替换：

```ts
  let tunnel = ctx.tunnels.get(session.tunnelId);
  if (!tunnel && ctx.tunnelRestoreGraceMs > 0) {
    ctx.logger.info('隧道离线，宽限等待重连', { hostname: session.hostname, graceMs: ctx.tunnelRestoreGraceMs });
    const browserGone = new Promise<null>((resolve) => res.once('close', () => resolve(null)));
    tunnel = (await Promise.race([
      ctx.tunnels.waitFor(session.tunnelId, ctx.tunnelRestoreGraceMs),
      browserGone,
    ])) ?? undefined;
    if (tunnel) ctx.logger.info('隧道已恢复，继续转发', { hostname: session.hostname });
  }
  if (!tunnel) {
    if (res.writableEnded || res.destroyed) return; // 宽限期间浏览器已走
    ctx.logger.warn('隧道离线', { hostname: session.hostname });
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...cors });
    res.end('tunnel offline');
    return;
  }
```

（`tunnel` 变量后续引用处把 `const channelId = tunnel.register(channel)` 等保持原样；TS 收窄后类型为 TunnelSession。）

`ws-proxy.ts`：`ProxyContext` 加 `tunnelRestoreGraceMs: number`；`handleBrowserWs` 改 `async`，离线分支替换：

```ts
  let tunnel = ctx.tunnels.get(session.tunnelId);
  if (!tunnel && ctx.tunnelRestoreGraceMs > 0) {
    ctx.logger.info('隧道离线，WS 升级宽限等待', { hostname: session.hostname, graceMs: ctx.tunnelRestoreGraceMs });
    const browserGone = new Promise<null>((resolve) => socket.once('close', () => resolve(null)));
    tunnel = (await Promise.race([
      ctx.tunnels.waitFor(session.tunnelId, ctx.tunnelRestoreGraceMs),
      browserGone,
    ])) ?? undefined;
  }
  if (!tunnel) {
    if (!socket.destroyed) {
      writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('tunnel offline'));
    }
    return;
  }
```

- [ ] **Step 4: 跑单测确认通过 + typecheck**

Run: `pnpm --filter gateway-server test && pnpm --filter gateway-server typecheck`
Expected: 全绿（既有离线 502 用例因 ctx 补 0 保持旧语义）

- [ ] **Step 5: 写 S18/S19 e2e 并跑绿**

`e2e-chaos.test.ts` 追加（S18 用 `startStack({ graceMs: 8000 })`；超时支路用 `rejectUpgradeWith` 阻断重连保证确定性）：

```ts
describe('F 组：瞬断宽限', () => {
  it('S18a：grace 8s 内重连（≈1s）→ 断连期 HTTP 请求挂起后透明完成', async () => {
    const s = await startStack({ graceMs: 8000 });
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const started = Date.now();
    const res = await fetchApp(s); // 离线窗口内发出：应挂起而非 502
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(8000);
    await res.text();
  });

  it('S18b：重连被阻断（rejectUpgrade）→ 宽限耗尽 502', async () => {
    const s = await startStack({ graceMs: 1000 });
    s.proxy.destroyAll();
    s.proxy.rejectUpgradeWith(502); // 客户端重连全部失败
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const res = await fetchApp(s);
    expect(res.status).toBe(502);
    s.proxy.clearRejectUpgrade(); // 收尾让 client 能重连，afterEach 干净
  }, 15_000);

  it('S19：断连期 WS upgrade 挂起 → 恢复后完成握手并 echo', async () => {
    const s = await startStack({ graceMs: 8000 });
    s.proxy.destroyAll();
    await waitFor(() => disconnectedCount(s) >= 1, 5000, '断开发生');
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${s.serverPort}/socket`, { headers: { cookie: s.cookie } });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await opened; // 挂起期间客户端自动重连成功 → upgrade 完成
    const echoed = new Promise<string>((resolve) => {
      ws.on('message', (raw) => resolve(String(raw)));
      ws.send('grace-ok');
    });
    expect(await echoed).toBe('grace-ok');
    ws.terminate();
  }, 15_000);
});
```

（S19 需要 upstream WS echo：`startStack` 的 upstream `createServer` 上挂 `new WebSocketServer({ noServer: true })` + upgrade 处理 echo——在骨架 upstream 里补充，与 client e2e.test.ts:54-56 同范式。）

Run: `pnpm --filter gateway-server test -- e2e-chaos`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/session.ts packages/server/src/server.ts packages/server/src/http-proxy.ts packages/server/src/ws-proxy.ts packages/server/src/session.test.ts packages/server/src/http-proxy.test.ts packages/server/src/ws-proxy.test.ts packages/server/src/e2e-chaos.test.ts
git commit -m "feat(server): 瞬断宽限——隧道离线时浏览器请求挂起等重连（tunnelRestoreGraceMs 默认30s），超时才 502（M3 S18-S19）"
```

---

### Task 16: 收尾 — 全仓回归 + 根 README 结构更新

**Files:**
- Modify: `README.md`（目录结构补 `chaos-proxy/` 一行）

- [ ] **Step 1: README 结构段落补一行**

```markdown
├── chaos-proxy/        # chaos-proxy — TCP 故障注入代理（私有，测试专用：destroy/blackhole/latency/throttle/idle/flappy/reject）
```

- [ ] **Step 2: 全仓回归**

Run: `pnpm install && pnpm -r typecheck && pnpm -r test`
Expected: 全部包通过（chaos-proxy 新增用例全绿；既有包零回归）

- [ ] **Step 3: `pnpm --filter dsh-remote-access format`（ESLint --fix 统一格式）后 `git diff --stat` 确认改动符合预期；同样跑 `pnpm --filter chaos-proxy format` / `pnpm --filter gateway-server format` / `pnpm --filter gateway-client format`，再全量测试一次**

- [ ] **Step 4: Commit**

```bash
git add README.md packages
git commit -m "chore: 根 README 补 chaos-proxy；全仓格式统一与回归（稳健性项目收尾）"
```

---

## Self-Review 记录（计划落盘前已执行）

- **Spec 覆盖**：M0→Task 1；M1（§5.1/5.2/CLI）→Task 2-4；E 组（S15-S17）→Task 5；M2（§6 API 全量）→Task 6-9；A/B/C/D/F 组→Task 10-15；§8 宽限→Task 15；§9 日志纪律→Task 1 + 各场景断言；§10 测试策略→各任务 Step；部署文档（S9 衍生）→Task 12；S14（巨帧，spec 标可选）有意排除（YAGNI）。
- **spec 偏离（有意）**：① E 组放 e2e.test.ts 而非 e2e-chaos（M1 先于 M2 落地，无故障注入依赖，MockTunnelClient 原生支持回带）；② 快照落盘由 1s 防抖改为同步写（kill 窗口为零，create 是低频人工动作）。
- **类型一致性**：`createPluginLogger`、`buildSessionCookie(uuid, maxAgeSec)`、`BrowserSessionStoreOptions`、`DEFAULT_SESSION_TTL_MS`、`waitFor(tunnelId, timeoutMs)`、`tunnelRestoreGraceMs`、`ChaosProxy` 全接口在 Task 2/3/6/15 的 Produces 与消费任务间已逐一核对。
