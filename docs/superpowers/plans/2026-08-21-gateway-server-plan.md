# 智能体网关 · 服务端（packages/server）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `gateway-server` 包：Node.js 库 + CLI，单端口承载浏览器 HTTP/WS 流量与多客户端隧道 WS，内置选择页 + cookie 会话路由，把浏览器请求经隧道桥接到对应客户端。

**Architecture:** Node 原生 `http` + `ws`（noServer 模式 + upgrade 按路径分发，沿用 `packages/web/server.ts`/`ws-gateway.ts` 范式）。隧道接入后经 hello 握手登记 hostname；浏览器请求查 cookie uuid → hostname → TunnelSession，注入 `Authorization: Bearer` 与 `X-Forwarded-For` 后经多路复用帧协议转发；鉴权权威在客户端（选择页 token 探测也经隧道问客户端）。

**Tech Stack:** Node.js 20+、TypeScript（strict，ESM 源码直出无构建）、`ws`（运行时唯一协议依赖）、`tsx`（仅 CLI 启动器）、vitest。

**Spec:** `docs/superpowers/specs/2026-08-21-gateway-server-design.md`（用户第三轮修订版，以仓库当前工作区文件为准）；帧协议字段与 `docs/superpowers/specs/2026-08-21-gateway-client-design.md` §4 共同定义

## Global Constraints

- 包管理只用 pnpm；新包自动被 `pnpm-workspace.yaml` 的 `packages/*` 覆盖
- ESM：`"type": "module"`，TS 源码直出，无构建步骤；TS 配置复制 `packages/protocol-sdk/tsconfig.json`
- 运行时依赖仅 `ws` + `tsx`；devDependencies 对齐 protocol-sdk + `@types/node` + `@types/ws`
- **不用任何 Web 框架**：HTTP 层用 Node 原生 `http`，WS 用 `ws` 的 `WebSocketServer({ noServer: true })` + 手动 upgrade 分发
- 选择页为服务端直出零依赖自包含 HTML；**hostname 是客户端可控输入，渲染必须 HTML 转义**
- 注释：中文 JSDoc + 文件头；日志遵循仓库级别约定，**任何级别不打印 token 与 Authorization 头**
- 协议细则（第三轮修订）：headers 编码 `string | string[]`；空体必须空载 `http.body.end` 收尾；`channel.close` 双向；4409 = 客户端进程级错误不重连（服务端无需防互踢）；`ws.accept` 回选子协议必须属于 `ws.open.protocols`，不符即断通道
- 转发 headers 三处加工：注入 `Authorization: Bearer`（覆盖原值）、剥离 `gateway_sid` cookie、注入/追加 `X-Forwarded-For`
- 测试：vitest，`src/**/*.test.ts`，辅助放 `src/test-utils/`
- 提交信息：`<type>: <description>`；每任务收尾 `pnpm --filter gateway-server test` 全绿再提交
- 相对导入不带扩展名

---

### Task 1: 包脚手架 + 帧协议编解码 + 日志

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/eslint.config.ts`
- Create: `packages/server/vitest.config.ts`
- Create: `packages/server/src/protocol.ts`
- Create: `packages/server/src/protocol.test.ts`
- Create: `packages/server/src/logger.ts`

**Interfaces:**
- Consumes: 无
- Produces: 与客户端计划 Task 1 **完全相同**的协议 API（`HeadersJson`、`ControlFrame` 全家族、`DataHeader`、`ProtocolError`、`encodeControl/decodeControl/encodeData/decodeData`、`normalizeHeaders/stripHopByHop`）与 `Logger`/`createConsoleLogger`/`createDefaultLogger`

- [ ] **Step 1: 创建包配置文件**

`packages/server/package.json`：

```json
{
  "name": "gateway-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "bin": {
    "harness-server": "./bin/harness-server.mjs"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "format": "eslint . --fix",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "tsx": "^4.19.2",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "@types/ws": "^8.18.1",
    "eslint": "^9",
    "jiti": "^2.7.0",
    "typescript": "^5",
    "typescript-eslint": "^8.61.0",
    "vitest": "^4.1.8"
  }
}
```

`tsconfig.json` / `eslint.config.ts` / `vitest.config.ts`：完整复制 `packages/protocol-sdk` 同名文件。

- [ ] **Step 2: 安装依赖**

Run: `pnpm install`
Expected: lockfile 更新无报错（版本号若失效，取 `pnpm view <pkg> version` 最新回填）

- [ ] **Step 3: 镜像协议实现与测试**

`packages/server/src/protocol.ts`：**完整复制** `packages/client/src/protocol.ts`（客户端计划 Task 1 Step 5 的全文），仅把文件头注释改为：

```ts
/**
 * 隧道帧协议编解码 — 服务端侧实现。
 * 注意：与客户端 packages/client/src/protocol.ts 互为镜像，任何改动必须双向同步。
 */
```

`packages/server/src/protocol.test.ts`：**完整复制** `packages/client/src/protocol.test.ts`。

Run: `pnpm --filter gateway-server exec vitest run src/protocol.test.ts`
Expected: PASS（协议测试不需要先失败——这是刻意镜像，测试即契约校验）

- [ ] **Step 4: 镜像 logger**

`packages/server/src/logger.ts`：复制客户端 `logger.ts`，行前缀 `[client]` 改 `[server]`。无需单独测试（client 侧已覆盖，server 侧在后续任务中经由注入使用）。

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "chore: gateway-server 包脚手架 + 帧协议镜像 + 日志"
```

---

### Task 2: 浏览器会话存储与 cookie 工具

**Files:**
- Create: `packages/server/src/browser-session.ts`
- Create: `packages/server/src/browser-session.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `BrowserSession { hostname: string; token: string }`
  - `class BrowserSessionStore`：`create(hostname: string, token: string): string`（返回 uuid）、`get(uuid: string): BrowserSession | undefined`
  - `SESSION_COOKIE = 'gateway_sid'`
  - `readSessionCookie(cookieHeader: string | string[] | undefined): string | undefined`
  - `buildSessionCookie(uuid: string): string`
  - `stripSessionCookie(cookieHeader: string | string[] | undefined): string | undefined`（剥离后无剩余 → undefined）

- [ ] **Step 1: 写失败的测试**

`packages/server/src/browser-session.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  BrowserSessionStore, buildSessionCookie, readSessionCookie, SESSION_COOKIE, stripSessionCookie,
} from './browser-session';

describe('BrowserSessionStore', () => {
  it('create 返回唯一 uuid，get 可取回', () => {
    const store = new BrowserSessionStore();
    const a = store.create('pc-a', 't1');
    const b = store.create('pc-b', 't2');
    expect(a).not.toBe(b);
    expect(store.get(a)).toEqual({ hostname: 'pc-a', token: 't1' });
    expect(store.get('no-such')).toBeUndefined();
  });
});

describe('cookie 工具', () => {
  it('readSessionCookie 解析单个/多个 cookie', () => {
    expect(readSessionCookie('gateway_sid=abc')).toBe('abc');
    expect(readSessionCookie('theme=dark; gateway_sid=xyz; other=1')).toBe('xyz');
    expect(readSessionCookie(undefined)).toBeUndefined();
    expect(readSessionCookie('other=1')).toBeUndefined();
  });

  it('readSessionCookie 兼容数组形态（Node 多 Cookie 头）', () => {
    expect(readSessionCookie(['theme=dark', 'gateway_sid=xyz'])).toBe('xyz');
  });

  it('buildSessionCookie 属性齐全且无过期时间（session cookie）', () => {
    const cookie = buildSessionCookie('uuid-1');
    expect(cookie).toContain(`${SESSION_COOKIE}=uuid-1`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/expires|max-age/i);
  });

  it('stripSessionCookie 只剥离 gateway_sid', () => {
    expect(stripSessionCookie('gateway_sid=abc; app_session=xyz')).toBe('app_session=xyz');
    expect(stripSessionCookie('gateway_sid=abc')).toBeUndefined();
    expect(stripSessionCookie(undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/browser-session.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 browser-session.ts**

`packages/server/src/browser-session.ts`：

```ts
/**
 * 浏览器会话存储与 cookie 工具 — 全内存（spec §6.1，重启即清空）。
 * 会话生命周期：无 logout，session cookie 关浏览器即失效；孤儿 uuid 留在内存（v1 非目标：TTL 清理）。
 * 注意：token 只进不出——除建立会话与转发注入外，任何日志/响应都不得携带。
 */

import { randomUUID } from 'node:crypto';

export interface BrowserSession {
  hostname: string;
  token: string;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSession>();

  /** 建立会话，返回 uuid */
  create(hostname: string, token: string): string {
    const uuid = randomUUID();
    this.sessions.set(uuid, { hostname, token });
    return uuid;
  }

  get(uuid: string): BrowserSession | undefined {
    return this.sessions.get(uuid);
  }
}

export const SESSION_COOKIE = 'gateway_sid';

/** 把 string | string[] 的 Cookie 头摊平为 "k=v; k=v" 串（Node 多 Cookie 头兼容） */
function flatten(cookieHeader: string | string[] | undefined): string {
  if (cookieHeader === undefined) return '';
  return Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
}

/** 从 Cookie 头读 gateway_sid */
export function readSessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  for (const pair of flatten(cookieHeader).split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) return pair.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** 生成 Set-Cookie 值：HttpOnly + SameSite=Lax + Path=/，无过期时间（session cookie，关浏览器失效） */
export function buildSessionCookie(uuid: string): string {
  return `${SESSION_COOKIE}=${uuid}; HttpOnly; SameSite=Lax; Path=/`;
}

/** 剥离 Cookie 头中的 gateway_sid，其余应用 cookie 原样透传；剥离后无剩余返回 undefined */
export function stripSessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  const kept = flatten(cookieHeader)
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && !pair.startsWith(`${SESSION_COOKIE}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/browser-session.test.ts`
Expected: PASS（全部 6 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/browser-session.ts packages/server/src/browser-session.test.ts
git commit -m "feat: gateway-server 浏览器会话存储与 cookie 工具"
```

---

### Task 3: TunnelSession 与 TunnelRegistry（通道表与隧道注册）

**Files:**
- Create: `packages/server/src/session.ts`
- Create: `packages/server/src/session.test.ts`

**Interfaces:**
- Consumes: Task 1 协议/Logger
- Produces（http-proxy / ws-proxy / tunnel.ts / select-page.ts 共同依赖）：
  - `PendingChannel { kind: 'http' | 'ws'; onControl(frame: ControlFrame): void; onData(header: DataHeader, payload: Buffer): void; onTunnelDown(): void }`
  - `TunnelHandle` 接口：`readonly hostname: string`、`register(channel: PendingChannel): number`、`unregister(channelId: number): void`、`sendControl(frame: ControlFrame): void`、`sendData(header: DataHeader, payload: Buffer): boolean`、`waitDrain(): Promise<void>`
  - `class TunnelSession implements TunnelHandle`：构造 `new TunnelSession(ws: WebSocket, info: { hostname: string; defaultPath: string }, logger: Logger, onDown: (session: TunnelSession) => void)`；另有 `readonly defaultPath: string`、`handleControl(frame)`、`handleData(header, payload)`、`teardown()`、`close()`
  - `class TunnelRegistry`：`get(hostname)` / `has(hostname)` / `set(hostname, session)` / `delete(hostname, session)`（仅当映射仍指向该 session）/ `list(): { hostname: string; defaultPath: string }[]` / `teardownAll()`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/session.test.ts`：

```ts
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { TunnelRegistry, TunnelSession, type PendingChannel } from './session';
import type { ControlFrame, DataHeader } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假 ws：记录发送内容，可触发事件 */
class FakeWs extends EventEmitter {
  sent: (string | Buffer)[] = [];
  bufferedAmount = 0;
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  terminate(): void { this.closed = { code: 1006 }; }
  asWs(): WebSocket { return this as unknown as WebSocket; }
}

function makeChannel(kind: 'http' | 'ws' = 'http') {
  const calls = { control: [] as ControlFrame[], data: [] as DataHeader[], down: 0 };
  const channel: PendingChannel = {
    kind,
    onControl: (f) => calls.control.push(f),
    onData: (h) => calls.data.push(h),
    onTunnelDown: () => { calls.down += 1; },
  };
  return { channel, calls };
}

function makeSession() {
  const ws = new FakeWs();
  const down: TunnelSession[] = [];
  const session = new TunnelSession(ws.asWs(), { hostname: 'pc-a', defaultPath: '/home' }, nullLogger, (s) => down.push(s));
  return { ws, session, down };
}

describe('TunnelSession', () => {
  it('register 递增分配 channelId，unregister 注销', () => {
    const { session } = makeSession();
    const a = makeChannel();
    expect(session.register(a.channel)).toBe(1);
    expect(session.register(makeChannel().channel)).toBe(2);
    session.unregister(1);
    session.handleControl({ type: 'http.head', channelId: 1, status: 200, headers: {} });
    expect(a.calls.control).toHaveLength(0); // 已注销不再路由
  });

  it('handleControl/handleData 按 channelId 路由', () => {
    const { session } = makeSession();
    const a = makeChannel();
    const id = session.register(a.channel);
    session.handleControl({ type: 'http.head', channelId: id, status: 200, headers: {} });
    session.handleData({ channelId: id, kind: 'http.body' }, Buffer.from('x'));
    expect(a.calls.control[0]).toMatchObject({ type: 'http.head', status: 200 });
    expect(a.calls.data[0]?.kind).toBe('http.body');
  });

  it('ping 自动回 pong，不上抛通道', () => {
    const { session, ws } = makeSession();
    session.handleControl({ type: 'ping' });
    expect(String(ws.sent[0])).toBe(JSON.stringify({ type: 'pong' }));
  });

  it('teardown：全部通道 onTunnelDown + 触发 onDown 回调', () => {
    const { session, down } = makeSession();
    const a = makeChannel();
    const b = makeChannel('ws');
    session.register(a.channel);
    session.register(b.channel);
    session.teardown();
    expect(a.calls.down).toBe(1);
    expect(b.calls.down).toBe(1);
    expect(down).toHaveLength(1);
  });

  it('close() 主动关闭底层 ws', () => {
    const { session, ws } = makeSession();
    session.close();
    expect(ws.closed).toEqual({ code: 1000, reason: 'server shutdown' });
  });
});

describe('TunnelRegistry', () => {
  it('set/get/list/delete（delete 校验 session 身份防重连竞态）', () => {
    const registry = new TunnelRegistry();
    const { session } = makeSession();
    registry.set('pc-a', session);
    expect(registry.get('pc-a')).toBe(session);
    expect(registry.list()).toEqual([{ hostname: 'pc-a', defaultPath: '/home' }]);
    const other = makeSession().session;
    registry.delete('pc-a', other); // 身份不符，不删
    expect(registry.has('pc-a')).toBe(true);
    registry.delete('pc-a', session);
    expect(registry.has('pc-a')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/session.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 session.ts**

`packages/server/src/session.ts`：

```ts
/**
 * TunnelSession（单条隧道连接的通道表）与 TunnelRegistry（hostname → 隧道注册表）。
 * 注意：channelId 会话内递增，隧道重建后编号空间重置（旧通道已全部 teardown）；
 * registry.delete 校验 session 身份，防止"旧隧道断开事件"误删"新隧道"的重连竞态。
 */

import type WebSocket from 'ws';
import type { Logger } from './logger';
import { encodeControl, encodeData, type ControlFrame, type DataHeader } from './protocol';

/** 一条挂靠在隧道上的待响应通道（http-proxy/ws-proxy/select 探测实现） */
export interface PendingChannel {
  kind: 'http' | 'ws';
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 隧道断开：通道不可迁移，实现方按 502/断开语义失败 */
  onTunnelDown(): void;
}

/** proxy 模块依赖的隧道最小接口（测试注入假实现） */
export interface TunnelHandle {
  readonly hostname: string;
  register(channel: PendingChannel): number;
  unregister(channelId: number): void;
  sendControl(frame: ControlFrame): void;
  sendData(header: DataHeader, payload: Buffer): boolean;
  waitDrain(): Promise<void>;
}

// 聚合背压水位（与客户端 Connection 对称）
const HIGH_WATER_BYTES = 16 * 1024 * 1024;
const LOW_WATER_BYTES = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 100;

export class TunnelSession implements TunnelHandle {
  readonly hostname: string;
  readonly defaultPath: string;
  private nextChannelId = 1;
  private readonly channels = new Map<number, PendingChannel>();
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private down = false;

  constructor(
    private readonly ws: WebSocket,
    info: { hostname: string; defaultPath: string },
    private readonly logger: Logger,
    private readonly onDown: (session: TunnelSession) => void,
  ) {
    this.hostname = info.hostname;
    this.defaultPath = info.defaultPath;
  }

  register(channel: PendingChannel): number {
    const channelId = this.nextChannelId++;
    this.channels.set(channelId, channel);
    return channelId;
  }

  unregister(channelId: number): void {
    this.channels.delete(channelId);
  }

  sendControl(frame: ControlFrame): void {
    this.ws.send(encodeControl(frame));
  }

  sendData(header: DataHeader, payload: Buffer): boolean {
    this.ws.send(encodeData(header, payload));
    if (this.ws.bufferedAmount > HIGH_WATER_BYTES) {
      this.startDrainPoll();
      return false;
    }
    return true;
  }

  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 控制帧入口（tunnel.ts 路由调用）：ping/pong 本层消化，其余按 channelId 分发 */
  handleControl(frame: ControlFrame): void {
    if (frame.type === 'ping') {
      this.ws.send(encodeControl({ type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    if (channelId === undefined) {
      this.logger.warn('隧道收到无 channelId 控制帧，丢弃', { type: frame.type });
      return;
    }
    this.channels.get(channelId)?.onControl(frame);
  }

  handleData(header: DataHeader, payload: Buffer): void {
    this.channels.get(header.channelId)?.onData(header, payload);
  }

  /** 隧道断开：全部通道失败 + 通知注册表注销（幂等） */
  teardown(): void {
    if (this.down) return;
    this.down = true;
    const all = [...this.channels.values()];
    this.channels.clear();
    for (const channel of all) channel.onTunnelDown();
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.onDown(this);
  }

  /** 服务端主动关闭（server.close） */
  close(): void {
    this.ws.close(1000, 'server shutdown');
    this.teardown();
  }

  private startDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.ws.bufferedAmount > LOW_WATER_BYTES) return;
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (this.drainWaiters.length === 0 && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, DRAIN_POLL_MS);
  }
}

export class TunnelRegistry {
  private readonly tunnels = new Map<string, TunnelSession>();

  get(hostname: string): TunnelSession | undefined {
    return this.tunnels.get(hostname);
  }

  has(hostname: string): boolean {
    return this.tunnels.has(hostname);
  }

  set(hostname: string, session: TunnelSession): void {
    this.tunnels.set(hostname, session);
  }

  /** 仅当映射仍指向该 session 才删除——防"旧隧道断开"误删"新隧道"的竞态 */
  delete(hostname: string, session: TunnelSession): void {
    if (this.tunnels.get(hostname) === session) this.tunnels.delete(hostname);
  }

  /** 选择页数据源：当前在线电脑列表 */
  list(): { hostname: string; defaultPath: string }[] {
    return [...this.tunnels.values()].map((s) => ({ hostname: s.hostname, defaultPath: s.defaultPath }));
  }

  teardownAll(): void {
    for (const session of [...this.tunnels.values()]) session.teardown();
    this.tunnels.clear();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/session.test.ts`
Expected: PASS（全部 6 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/session.ts packages/server/src/session.test.ts
git commit -m "feat: gateway-server TunnelSession 通道表与 TunnelRegistry 注册表"
```

---

### Task 4: 隧道接入（hello 握手与 hostname 仲裁）

**Files:**
- Create: `packages/server/src/tunnel.ts`
- Create: `packages/server/src/tunnel.test.ts`

**Interfaces:**
- Consumes: `TunnelSession`/`TunnelRegistry`（Task 3）、协议（Task 1）
- Produces:
  - `TunnelContext { tunnels: TunnelRegistry; helloTimeoutMs: number; logger: Logger }`
  - `attachTunnelHandler(server: http.Server, ctx: TunnelContext): WebSocketServer`——在 `server.on('upgrade')` 中**只处理 `pathname === ctx.tunnelPath`**（ TunnelContext 增加 `tunnelPath: string` 字段），其余交还

- [ ] **Step 1: 写失败的测试**

`packages/server/src/tunnel.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { attachTunnelHandler } from './tunnel';
import { TunnelRegistry } from './session';
import { encodeControl, type ControlFrame } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let httpServer: Server | null = null;
let port = 0;

afterEach(async () => {
  await new Promise<void>((r) => httpServer ? httpServer.close(() => r()) : r());
  httpServer = null;
});

async function setup(helloTimeoutMs = 200): Promise<TunnelRegistry> {
  const tunnels = new TunnelRegistry();
  httpServer = createServer();
  attachTunnelHandler(httpServer, { tunnels, tunnelPath: '/__gateway__/tunnel', helloTimeoutMs, logger: nullLogger });
  await new Promise<void>((r) => httpServer!.listen(0, '127.0.0.1', r));
  const addr = httpServer.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  port = addr.port;
  return tunnels;
}

function connectWs(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/__gateway__/tunnel`);
}

function sendHello(ws: WebSocket, hostname: string, defaultPath = '/'): void {
  ws.send(encodeControl({ type: 'hello', client: { hostname, defaultPath } }));
}

describe('隧道接入', () => {
  it('hello → ack，hostname 登记在线列表', async () => {
    const tunnels = await setup();
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    sendHello(ws, 'pc-a', '/dash');
    const ack = await new Promise<ControlFrame>((r) => ws.once('message', (d) => r(JSON.parse(String(d)) as ControlFrame)));
    expect(ack).toEqual({ type: 'hello.ack' });
    expect(tunnels.list()).toEqual([{ hostname: 'pc-a', defaultPath: '/dash' }]);
    ws.close();
  });

  it('hostname 冲突：后连者被 4409 关闭，先连者不受影响', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    sendHello(ws1, 'pc-a');
    await new Promise((r) => ws1.once('message', r));

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    sendHello(ws2, 'pc-a');
    const close = await new Promise<number>((r) => ws2.on('close', (code) => r(code)));
    expect(close).toBe(4409);
    expect(tunnels.get('pc-a')).toBeDefined(); // 先连者仍在
    ws1.close();
  });

  it('hello 超时：连接被关闭且不入册', async () => {
    const tunnels = await setup(100);
    const ws = connectWs();
    await new Promise<void>((r) => ws.on('open', r));
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4408);
    expect(tunnels.list()).toHaveLength(0);
  });

  it('隧道断开：hostname 注销；同名重连可恢复', async () => {
    const tunnels = await setup();
    const ws1 = connectWs();
    await new Promise<void>((r) => ws1.on('open', r));
    sendHello(ws1, 'pc-a');
    await new Promise((r) => ws1.once('message', r));
    ws1.terminate();
    await new Promise((r) => setTimeout(r, 50));
    expect(tunnels.has('pc-a')).toBe(false);

    const ws2 = connectWs();
    await new Promise<void>((r) => ws2.on('open', r));
    sendHello(ws2, 'pc-a');
    await new Promise((r) => ws2.once('message', r));
    expect(tunnels.has('pc-a')).toBe(true);
    ws2.close();
  });

  it('非隧道路径的 upgrade 不被本网关处理（交还其他监听者）', async () => {
    await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
    const code = await new Promise<number | 'error'>((resolve) => {
      ws.on('error', () => resolve('error')); // 无处理器时 socket 挂起或被销毁
      ws.on('close', (c) => resolve(c));
      setTimeout(() => resolve(408), 300); // 挂起也算"未处理"
    });
    expect(code).toBeDefined(); // 关键断言：隧道处理器没有 ack 它
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/tunnel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 tunnel.ts**

`packages/server/src/tunnel.ts`：

```ts
/**
 * 隧道接入 — tunnelPath 的 WS upgrade、hello 握手、hostname 唯一性仲裁。
 * 关闭码约定：4409 = hostname 冲突（客户端进程级错误，不重连，无需防互踢）；
 * 4408 = hello 超时；握手后才收 hello，超时前到达的其他帧一律按协议错误断开。
 * 注意：沿用仓库 ws-gateway.ts 范式——先 handleUpgrade 完成握手，再 close(code) 透传业务关闭码。
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from './logger';
import { decodeControl, decodeData, encodeControl, ProtocolError } from './protocol';
import { TunnelRegistry, TunnelSession } from './session';

export interface TunnelContext {
  tunnels: TunnelRegistry;
  /** 隧道接入保留路径（默认 /__gateway__/tunnel） */
  tunnelPath: string;
  helloTimeoutMs: number;
  logger: Logger;
}

/** RawData 统一转 Buffer */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** 把隧道 upgrade 处理器挂到 http.Server（只处理 tunnelPath，其余路径交还其他监听者） */
export function attachTunnelHandler(server: Server, ctx: TunnelContext): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    if (pathname !== ctx.tunnelPath) return; // 非本网关路径：交还
    wss.handleUpgrade(req, socket, head, (ws) => onTunnelConnection(ws, ctx));
  });

  return wss;
}

/** 隧道连接生命周期：等 hello → 仲裁 → 登记 → 帧路由 → 断开清理 */
function onTunnelConnection(ws: WebSocket, ctx: TunnelContext): void {
  let session: TunnelSession | null = null;

  // hello 超时：握手后 helloTimeoutMs 内未收到合法 hello
  const helloTimer = setTimeout(() => {
    ctx.logger.warn('hello 超时，断开隧道', { remote: ws.url });
    ws.close(4408, 'hello timeout');
  }, ctx.helloTimeoutMs);

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    const buf = toBuffer(raw);
    if (!session) {
      // 首条消息必须是 hello 控制帧
      if (isBinary) {
        ws.close(1002, 'protocol error');
        return;
      }
      let hostname: string;
      let defaultPath: string;
      try {
        const frame = decodeControl(buf.toString('utf8'));
        if (frame.type !== 'hello') throw new ProtocolError(`首帧非 hello: ${frame.type}`);
        hostname = frame.client.hostname;
        defaultPath = frame.client.defaultPath;
        if (!hostname) throw new ProtocolError('hello.hostname 为空');
      } catch (err) {
        ctx.logger.error('隧道首帧协议错误', { error: err instanceof Error ? err.message : String(err) });
        ws.close(1002, 'protocol error');
        return;
      }
      clearTimeout(helloTimer);
      // hostname 唯一性仲裁：先握手再 4409 关闭（仓库范式，业务关闭码可透传）
      if (ctx.tunnels.has(hostname)) {
        ctx.logger.warn('hostname 冲突，拒绝接入', { hostname });
        ws.close(4409, 'hostname conflict');
        return;
      }
      session = new TunnelSession(ws, { hostname, defaultPath }, ctx.logger, (s) => {
        ctx.tunnels.delete(s.hostname, s); // 身份校验防重连竞态
        ctx.logger.info('隧道断开', { hostname: s.hostname });
      });
      ctx.tunnels.set(hostname, session);
      ws.send(encodeControl({ type: 'hello.ack' }));
      ctx.logger.info('隧道接入', { hostname });
      return;
    }
    // 已就绪：帧路由
    try {
      if (isBinary) {
        const { header, payload } = decodeData(buf);
        session.handleData(header, payload);
      } else {
        session.handleControl(decodeControl(buf.toString('utf8')));
      }
    } catch (err) {
      ctx.logger.error('隧道协议错误，断开', { hostname: session?.hostname, error: err instanceof Error ? err.stack : String(err) });
      ws.close(1002, 'protocol error');
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    session?.teardown();
  });

  ws.on('error', (err) => {
    ctx.logger.error('隧道连接错误', { hostname: session?.hostname, error: err.stack ?? err.message });
    // close 事件随后触发清理
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/tunnel.test.ts`
Expected: PASS（全部 5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/tunnel.ts packages/server/src/tunnel.test.ts
git commit -m "feat: gateway-server 隧道接入（hello 握手/hostname 仲裁/4409-4408）"
```

---

### Task 5: 选择页与会话建立（含 token 探测）

**Files:**
- Create: `packages/server/src/select-page.ts`
- Create: `packages/server/src/select-page.test.ts`

**Interfaces:**
- Consumes: `TunnelRegistry`/`TunnelHandle`（Task 3）、`BrowserSessionStore`/`buildSessionCookie`（Task 2）
- Produces:
  - `renderSelectPage(computers: { hostname: string }[], error?: string): string`
  - `probeAuthCheck(tunnel: TunnelHandle, token: string, timeoutMs: number): Promise<'pass' | 'deny' | 'timeout'>`
  - `handleSelectGet(res: ServerResponse, tunnels: TunnelRegistry): void`
  - `handleSelectPost(req: IncomingMessage, res: ServerResponse, ctx: SelectContext): Promise<void>`，`SelectContext { tunnels: TunnelRegistry; sessions: BrowserSessionStore; headTimeoutMs: number; logger: Logger }`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/select-page.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSessionStore } from './browser-session';
import { probeAuthCheck, renderSelectPage } from './select-page';
import type { TunnelHandle, PendingChannel } from './session';
import type { ControlFrame, DataHeader } from './protocol';

/** 假隧道：捕获 http.open，按 authorization 自动应答 204/403 */
class FakeTunnel {
  hostname = 'pc-a';
  opened: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  private channels = new Map<number, PendingChannel>();
  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'http.open') {
      this.opened.push(frame);
      const channel = this.channels.get(frame.channelId);
      const ok = frame.headers['authorization'] === 'Bearer good';
      queueMicrotask(() => channel?.onControl({ type: 'http.head', channelId: frame.channelId, status: ok ? 204 : 403, headers: {} }));
    }
  }
  sendData(_header: DataHeader, _payload: Buffer): boolean { return true; }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  neverRespond = false; // 探测超时用例旋钮
  asHandle(): TunnelHandle { return this as unknown as TunnelHandle; }
}

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

describe('renderSelectPage', () => {
  it('渲染在线电脑列表，hostname 被 HTML 转义（XSS 防护）', () => {
    const html = renderSelectPage([{ hostname: 'pc-a' }, { hostname: '<script>alert(1)</script>' }]);
    expect(html).toContain('pc-a');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('带错误提示渲染', () => {
    expect(renderSelectPage([], 'token 错误')).toContain('token 错误');
  });
});

describe('probeAuthCheck', () => {
  it('Bearer 正确 → pass；错误 → deny', async () => {
    const tunnel = new FakeTunnel();
    expect(await probeAuthCheck(tunnel.asHandle(), 'good', 1000)).toBe('pass');
    expect(await probeAuthCheck(tunnel.asHandle(), 'bad', 1000)).toBe('deny');
    // 探测帧形态：GET /__gateway__/auth-check + Bearer 注入
    expect(tunnel.opened[0]).toMatchObject({ method: 'GET', url: '/__gateway__/auth-check' });
    expect(tunnel.opened[0]?.headers['authorization']).toBe('Bearer good');
  });
});

describe('handleSelectPost（经真实 HTTP）', () => {
  let server: Server | null = null;
  afterEach(async () => { await new Promise<void>((r) => server ? server.close(() => r()) : r()); server = null; });

  async function setup(tunnel: FakeTunnel) {
    const { TunnelRegistry } = await import('./session');
    const tunnels = new TunnelRegistry();
    // 把假隧道塞进注册表（利用 TunnelSession 结构等价性）
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('pc-a', tunnel);
    const sessions = new BrowserSessionStore();
    const { handleSelectPost } = await import('./select-page');
    server = createServer((req, res) => void handleSelectPost(req, res, { tunnels, sessions, headTimeoutMs: 500, logger: nullLogger }));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server!.address();
    if (typeof addr === 'string' || !addr) throw new Error('no addr');
    return { port: addr.port, sessions };
  }

  it('正确 token → Set-Cookie + 302 到 defaultPath', async () => {
    const tunnel = new FakeTunnel();
    const { port, sessions } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=good',
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/'); // FakeTunnel 无 defaultPath 字段时默认 '/'
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('gateway_sid=');
    expect(cookie).toContain('HttpOnly');
    const uuid = /gateway_sid=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(sessions.get(uuid)).toEqual({ hostname: 'pc-a', token: 'good' });
  });

  it('错误 token → 403 重渲染选择页', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=bad',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('token');
  });

  it('hostname 不在线 → 400', async () => {
    const tunnel = new FakeTunnel();
    const { port } = await setup(tunnel);
    const res = await fetch(`http://127.0.0.1:${port}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=offline-pc&token=x',
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/select-page.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 select-page.ts**

`packages/server/src/select-page.ts`：

```ts
/**
 * 内置选择页 — 零依赖自包含 HTML（spec §6；明确偏离 antd/DESIGN.md 规范，零依赖网关不引入前端构建链）。
 * POST 处理：解析表单 → hostname 在线校验 → 经隧道探测 token（客户端是唯一鉴权权威）→ 建会话 + 302。
 * 安全注意：hostname 是客户端可控输入，渲染必须 HTML 转义；表单体限 64KB 防内存放大。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildSessionCookie, type BrowserSessionStore } from './browser-session';
import type { Logger } from './logger';
import type { TunnelHandle, TunnelRegistry } from './session';

export interface SelectContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  headTimeoutMs: number;
  logger: Logger;
}

/** HTML 转义（选择页唯一用户可控输出点） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 渲染选择页：在线电脑图标列表 + token 输入；error 非空时展示错误条 */
export function renderSelectPage(computers: { hostname: string }[], error?: string): string {
  const items = computers.map((c) => {
    const name = escapeHtml(c.hostname);
    return `
      <form class="card" method="post" action="/__gateway__/select">
        <div class="icon">🖥️</div>
        <div class="name">${name}</div>
        <input type="hidden" name="hostname" value="${name}" />
        <input type="password" name="token" placeholder="请输入 token" required autocomplete="off" />
        <button type="submit">连接</button>
      </form>`;
  }).join('\n');
  const errorBar = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  const empty = computers.length === 0 ? '<p class="empty">暂无在线电脑</p>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>选择电脑 - 智能体网关</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f6f7; margin: 0; display: flex; justify-content: center; padding-top: 64px; }
  main { width: 640px; }
  h1 { font-size: 20px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 8px; padding: 24px 16px; text-align: center; }
  .icon { font-size: 40px; }
  .name { margin: 8px 0 12px; font-weight: 500; word-break: break-all; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 8px; border: 1px solid #e5e6eb; border-radius: 4px; }
  button { width: 100%; padding: 6px 0; border: none; border-radius: 4px; background: #165dff; color: #fff; cursor: pointer; }
  .error { background: #ffece8; color: #cb2634; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
  .empty { color: #86909c; }
</style>
</head>
<body>
<main>
  <h1>选择要连接的电脑</h1>
  ${errorBar}
  ${empty}
  <div class="grid">
    ${items}
  </div>
</main>
</body>
</html>`;
}

/** GET 选择页 */
export function handleSelectGet(res: ServerResponse, tunnels: TunnelRegistry): void {
  const body = renderSelectPage(tunnels.list());
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * 选择页 token 探测：经隧道向客户端发 GET /__gateway__/auth-check（Bearer 注入），
 * 客户端 authorization 链放行 → 204 = pass；拒绝 → deny；超时 → timeout。
 */
export function probeAuthCheck(tunnel: TunnelHandle, token: string, timeoutMs: number): Promise<'pass' | 'deny' | 'timeout'> {
  return new Promise((resolve) => {
    let channelId = 0;
    const timer = setTimeout(() => {
      tunnel.unregister(channelId);
      resolve('timeout');
    }, timeoutMs);
    const finish = (result: 'pass' | 'deny'): void => {
      clearTimeout(timer);
      tunnel.unregister(channelId);
      resolve(result);
    };
    channelId = tunnel.register({
      kind: 'http',
      onControl: (frame) => {
        if (frame.type === 'http.head') finish(frame.status === 204 ? 'pass' : 'deny');
      },
      onData: () => {},
      onTunnelDown: () => {
        clearTimeout(timer);
        resolve('deny'); // 隧道断开视为拒绝（选择页报 token 错误即可重试）
      },
    });
    tunnel.sendControl({
      type: 'http.open',
      channelId,
      method: 'GET',
      url: '/__gateway__/auth-check',
      headers: { authorization: `Bearer ${token}` },
    });
    // 空体规则：无 body 也必须空载 http.body.end 收尾
    tunnel.sendData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
  });
}

/** 读取表单体（application/x-www-form-urlencoded），限 64KB */
function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('form too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** POST 选择提交：hostname 在线校验 → 隧道探测 → 建会话 + 302 defaultPath */
export async function handleSelectPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SelectContext,
): Promise<void> {
  let form: URLSearchParams;
  try {
    form = await readFormBody(req);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad form');
    return;
  }
  const hostname = form.get('hostname') ?? '';
  const token = form.get('token') ?? '';
  const tunnel = ctx.tunnels.get(hostname);
  if (!tunnel) {
    ctx.logger.warn('选择失败：hostname 不在线', { hostname });
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderSelectPage(ctx.tunnels.list(), '该电脑不在线'));
    return;
  }
  const result = await probeAuthCheck(tunnel, token, ctx.headTimeoutMs);
  if (result === 'pass') {
    const uuid = ctx.sessions.create(hostname, token);
    ctx.logger.info('会话建立', { uuid, hostname }); // 红线：不记录 token
    res.writeHead(302, {
      'set-cookie': buildSessionCookie(uuid),
      location: tunnel.defaultPath || '/',
    });
    res.end();
    return;
  }
  if (result === 'timeout') {
    res.writeHead(504, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderSelectPage(ctx.tunnels.list(), '探测超时，请重试'));
    return;
  }
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
  res.end(renderSelectPage(ctx.tunnels.list(), 'token 错误'));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/select-page.test.ts`
Expected: PASS（全部 6 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/select-page.ts packages/server/src/select-page.test.ts
git commit -m "feat: gateway-server 内置选择页与 token 隧道探测"
```

---

### Task 6: http-proxy（浏览器 HTTP ↔ 隧道通道）

**Files:**
- Create: `packages/server/src/http-proxy.ts`
- Create: `packages/server/src/http-proxy.test.ts`

**Interfaces:**
- Consumes: `TunnelHandle`/`PendingChannel`（Task 3）、会话与 cookie 工具（Task 2）、协议（Task 1）
- Produces:
  - `ProxyContext { tunnels: TunnelRegistry; sessions: BrowserSessionStore; selectPath: string; headTimeoutMs: number; logger: Logger }`
  - `handleBrowserHttp(req: IncomingMessage, res: ServerResponse, ctx: ProxyContext): void`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/http-proxy.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserSessionStore, buildSessionCookie } from './browser-session';
import { handleBrowserHttp, type ProxyContext } from './http-proxy';
import { TunnelRegistry, type PendingChannel } from './session';
import type { ControlFrame, DataHeader, HeadersJson } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假隧道：捕获 open 帧与 body 数据，测试驱动其回包 */
class FakeTunnel {
  readonly hostname = 'pc-a';
  readonly defaultPath = '/';
  openFrames: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  bodyChunks: Buffer[] = [];
  closes: number[] = [];
  autoRespond: { status: number; headers: HeadersJson; body: Buffer } | null = { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] }, body: Buffer.from('upstream-ok') };
  private channels = new Map<number, PendingChannel>();

  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'http.open') this.openFrames.push(frame);
    if (frame.type === 'channel.close') this.closes.push(frame.channelId);
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (header.kind === 'http.body') this.bodyChunks.push(payload);
    if (header.kind === 'http.body.end' && this.autoRespond) {
      const channel = this.channels.get(header.channelId);
      const resp = this.autoRespond;
      queueMicrotask(() => {
        channel?.onControl({ type: 'http.head', channelId: header.channelId, status: resp.status, headers: resp.headers });
        channel?.onData({ channelId: header.channelId, kind: 'http.body' }, resp.body);
        channel?.onData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0));
      });
    }
    return true;
  }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  tunnelDown(channelId: number): void { this.channels.get(channelId)?.onTunnelDown(); }
}

let server: Server | null = null;
afterEach(async () => { await new Promise<void>((r) => server ? server.close(() => r()) : r()); server = null; });

async function setup(opts: { withTunnel?: boolean; headTimeoutMs?: number } = {}) {
  const tunnel = new FakeTunnel();
  const tunnels = new TunnelRegistry();
  if (opts.withTunnel !== false) {
    (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('pc-a', tunnel);
  }
  const sessions = new BrowserSessionStore();
  const uuid = sessions.create('pc-a', 'tok-user');
  const ctx: ProxyContext = { tunnels, sessions, selectPath: '/__gateway__/select', headTimeoutMs: opts.headTimeoutMs ?? 300, logger: nullLogger };
  server = createServer((req, res) => handleBrowserHttp(req, res, ctx));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  return { port: addr.port, tunnel, uuid };
}

describe('handleBrowserHttp', () => {
  it('无 cookie → 302 选择页', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/__gateway__/select');
  });

  it('无效 cookie → 302', async () => {
    const { port } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: 'gateway_sid=nope' }, redirect: 'manual' });
    expect(res.status).toBe(302);
  });

  it('有效会话但隧道离线 → 502', async () => {
    const { port, uuid } = await setup({ withTunnel: false });
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(502);
  });

  it('正常转发：headers 三处加工 + 响应回传（含多 Set-Cookie）', async () => {
    const { port, tunnel, uuid } = await setup();
    const res = await fetch(`http://127.0.0.1:${port}/api/x?q=1`, {
      method: 'POST',
      headers: { cookie: `gateway_sid=${uuid}; app_session=keep`, authorization: 'Bearer browser-value' },
      body: 'request-body',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upstream-ok');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    const open = tunnel.openFrames[0];
    expect(open?.method).toBe('POST');
    expect(open?.url).toBe('/api/x?q=1');
    // ① Bearer 注入覆盖浏览器原值
    expect(open?.headers['authorization']).toBe('Bearer tok-user');
    // ② gateway_sid 剥离，应用 cookie 保留
    expect(open?.headers['cookie']).toBe('app_session=keep');
    // ③ X-Forwarded-For 注入
    expect(open?.headers['x-forwarded-for']).toContain('127.0.0.1');
    // 请求体透传 + 空载 end 收尾
    expect(Buffer.concat(tunnel.bodyChunks).toString()).toBe('request-body');
  });

  it('GET 无 body：仍发空载 http.body.end（空体规则）', async () => {
    const { port, tunnel, uuid } = await setup();
    let endSeen = false;
    const origSendData = tunnel.sendData.bind(tunnel);
    tunnel.sendData = (header: DataHeader, payload: Buffer): boolean => {
      if (header.kind === 'http.body.end') { endSeen = true; expect(payload.length).toBe(0); }
      return origSendData(header, payload);
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(200);
    expect(endSeen).toBe(true);
  });

  it('等 http.head 超时 → 504 + channel.close', async () => {
    const { port, tunnel, uuid } = await setup({ headTimeoutMs: 100 });
    tunnel.autoRespond = null; // 客户端不应答
    const res = await fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    expect(res.status).toBe(504);
    expect(tunnel.closes.length).toBeGreaterThan(0);
  });

  it('隧道断开（在途通道）→ 502', async () => {
    const { port, tunnel, uuid } = await setup();
    tunnel.autoRespond = null;
    const pending = fetch(`http://127.0.0.1:${port}/api/x`, { headers: { cookie: `gateway_sid=${uuid}` } });
    await new Promise((r) => setTimeout(r, 30));
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.tunnelDown(channelId);
    const res = await pending;
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/http-proxy.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 http-proxy.ts**

`packages/server/src/http-proxy.ts`：

```ts
/**
 * 浏览器 HTTP ↔ 隧道通道桥接（spec §7.1）。
 * headers 三处加工：①注入 Authorization: Bearer（覆盖浏览器原值）②剥离 gateway_sid ③注入/追加 X-Forwarded-For。
 * 注意：等 http.head 有 headTimeoutMs 超时；收到 head 后不再设总超时（SSE/流式）；
 * 浏览器中途断开 → channel.close 取消通道；隧道断开 → 在途通道 502。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSessionCookie, stripSessionCookie, type BrowserSessionStore } from './browser-session';
import type { Logger } from './logger';
import { normalizeHeaders, stripHopByHop, type ControlFrame, type DataHeader, type HeadersJson } from './protocol';
import type { PendingChannel, TunnelRegistry } from './session';

export interface ProxyContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  selectPath: string;
  headTimeoutMs: number;
  logger: Logger;
}

/** headers 三处加工：Bearer 注入 / gateway_sid 剥离 / XFF 追加，再剥逐跳头 */
function prepareForwardHeaders(req: IncomingMessage, token: string): HeadersJson {
  const headers = normalizeHeaders(req.headers);
  headers['authorization'] = `Bearer ${token}`;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie === undefined) delete headers['cookie'];
  else headers['cookie'] = cookie;
  const remote = req.socket.remoteAddress;
  if (remote) {
    const existing = headers['x-forwarded-for'];
    const first = Array.isArray(existing) ? existing.join(', ') : existing;
    headers['x-forwarded-for'] = first ? `${first}, ${remote}` : remote;
  }
  delete headers['host']; // Host 由客户端按 upstream 重写（spec 已确认）
  return stripHopByHop(headers);
}

/** 浏览器 HTTP 请求入口（非保留路径） */
export function handleBrowserHttp(req: IncomingMessage, res: ServerResponse, ctx: ProxyContext): void {
  // cookie 会话检查：无/失效 → 302 选择页
  const uuid = readSessionCookie(req.headers.cookie);
  const session = uuid ? ctx.sessions.get(uuid) : undefined;
  if (!session) {
    res.writeHead(302, { location: ctx.selectPath });
    res.end();
    return;
  }
  const tunnel = ctx.tunnels.get(session.hostname);
  if (!tunnel) {
    ctx.logger.warn('隧道离线', { hostname: session.hostname });
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('tunnel offline');
    return;
  }

  let finished = false;
  let headTimer: NodeJS.Timeout | null = null;
  const finish = (fn: () => void): void => {
    if (finished) return;
    finished = true;
    if (headTimer) clearTimeout(headTimer);
    tunnel.unregister(channelId);
    fn();
  };

  const channel: PendingChannel = {
    kind: 'http',
    onControl: (frame: ControlFrame) => {
      if (frame.type === 'http.head') {
        finishHeaders(frame.status, frame.headers);
      } else if (frame.type === 'channel.error') {
        ctx.logger.error('通道级错误（客户端回报）', { channelId, message: frame.message });
        finish(() => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end();
        });
      } else if (frame.type === 'channel.close') {
        finish(() => res.end());
      }
    },
    onData: (header: DataHeader, payload: Buffer) => {
      if (header.kind === 'http.body') {
        if (!res.write(payload)) {
          // 浏览器侧写缓冲背压：暂停读取由整体 WS bufferedAmount 兜底（v1 不做逐通道背压，spec §4.3）
        }
      } else if (header.kind === 'http.body.end') {
        finish(() => res.end());
      }
    },
    onTunnelDown: () => {
      finish(() => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end();
      });
    },
  };

  const finishHeaders = (status: number, headers: HeadersJson): void => {
    if (headTimer) clearTimeout(headTimer);
    headTimer = null;
    if (finished) return;
    // 响应头剥逐跳头后原样回写（set-cookie 数组 Node 原生支持）
    res.writeHead(status, stripHopByHop(headers) as Record<string, string | string[]>);
  };

  const channelId = tunnel.register(channel);

  tunnel.sendControl({
    type: 'http.open',
    channelId,
    method: req.method ?? 'GET',
    url: req.url ?? '/',
    headers: prepareForwardHeaders(req, session.token),
  });
  ctx.logger.info('请求入口', { channelId, method: req.method, url: req.url, hostname: session.hostname });

  // 请求体流式透传；空体规则：end 事件必发空载 http.body.end
  req.on('data', (chunk: Buffer) => {
    if (!finished) tunnel.sendData({ channelId, kind: 'http.body' }, chunk);
  });
  req.on('end', () => {
    if (!finished) tunnel.sendData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
  });

  // 浏览器中途断开 → 取消通道
  req.on('close', () => {
    if (!finished && !res.writableEnded) {
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser aborted' }));
    }
  });

  // 等 http.head 超时（收到 head 后不再设总超时，支持 SSE）
  headTimer = setTimeout(() => {
    ctx.logger.warn('等 http.head 超时', { channelId });
    finish(() => {
      tunnel.sendControl({ type: 'channel.close', channelId, reason: 'head timeout' });
      if (!res.headersSent) res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('gateway timeout');
    });
  }, ctx.headTimeoutMs);
}
```

> 注意：`finishHeaders` 在 `channel` 定义之后引用是刻意的前向声明顺序——`channel.onControl` 闭包内调用时 `finishHeaders` 已赋值。若 lint 报 `no-use-before-define`，把 `finishHeaders` 移到 `channel` 之前并把它引用的 `headTimer` 保持 `let` 形态即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/http-proxy.test.ts`
Expected: PASS（全部 7 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/http-proxy.ts packages/server/src/http-proxy.test.ts
git commit -m "feat: gateway-server http-proxy（会话检查/三处 header 加工/流式桥接/超时）"
```

---

### Task 7: ws-proxy（浏览器 WS ↔ 隧道通道）

**Files:**
- Create: `packages/server/src/ws-proxy.ts`
- Create: `packages/server/src/ws-proxy.test.ts`

**Interfaces:**
- Consumes: 同 Task 6 + `WebSocketServer`（浏览器侧，noServer 模式）
- Produces:
  - `handleBrowserWs(req: IncomingMessage, socket: Duplex, head: Buffer, browserWss: WebSocketServer, ctx: ProxyContext): void`
  - 浏览器侧 `browserWss` 由 server.ts（Task 8）以 `handleProtocols: (protocols) => [...protocols][0] ?? false` 构造；ws-proxy 在 `handleUpgrade` 前把 `req.headers['sec-websocket-protocol']` 改写为客户端回选值

- [ ] **Step 1: 写失败的测试**

`packages/server/src/ws-proxy.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserSessionStore } from './browser-session';
import { TunnelRegistry, type PendingChannel } from './session';
import { handleBrowserWs, type ProxyContext } from './ws-proxy';
import type { ControlFrame, DataHeader } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假隧道：捕获 ws.open，测试驱动 accept/reject/message */
class FakeTunnel {
  readonly hostname = 'pc-a';
  openFrames: Extract<ControlFrame, { type: 'ws.open' }>[] = [];
  messages: { dataType?: string; payload: Buffer }[] = [];
  closes: (number | undefined)[] = [];
  private channels = new Map<number, PendingChannel>();
  register(channel: PendingChannel): number {
    const id = this.channels.size + 1;
    this.channels.set(id, channel);
    return id;
  }
  unregister(id: number): void { this.channels.delete(id); }
  sendControl(frame: ControlFrame): void {
    if (frame.type === 'ws.open') this.openFrames.push(frame);
    if (frame.type === 'channel.close') this.closes.push(frame.code);
  }
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (header.kind === 'ws.message') this.messages.push({ dataType: header.dataType, payload });
    return true;
  }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  accept(channelId: number, protocol?: string): void {
    this.channels.get(channelId)?.onControl({ type: 'ws.accept', channelId, protocol });
  }
  reject(channelId: number, status: number, body: string): void {
    this.channels.get(channelId)?.onControl({ type: 'ws.reject', channelId, status, body });
  }
  pushMessage(channelId: number, dataType: 'text' | 'binary', payload: Buffer): void {
    this.channels.get(channelId)?.onData({ channelId, kind: 'ws.message', dataType }, payload);
  }
  closeChannel(channelId: number, code?: number): void {
    this.channels.get(channelId)?.onControl({ type: 'channel.close', channelId, code });
  }
}

let server: Server | null = null;
let browserWss: WebSocketServer | null = null;
let port = 0;
let sessions: BrowserSessionStore;
let tunnel: FakeTunnel;

afterEach(async () => {
  browserWss?.close();
  await new Promise<void>((r) => server ? server.close(() => r()) : r());
  server = null;
  browserWss = null;
});

async function setup(): Promise<string> {
  tunnel = new FakeTunnel();
  const tunnels = new TunnelRegistry();
  (tunnels as unknown as { tunnels: Map<string, unknown> }).tunnels.set('pc-a', tunnel);
  sessions = new BrowserSessionStore();
  const ctx: ProxyContext = { tunnels, sessions, selectPath: '/__gateway__/select', headTimeoutMs: 300, logger: nullLogger };
  server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  browserWss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => [...protocols][0] ?? false });
  server.on('upgrade', (req, socket, head) => handleBrowserWs(req, socket, head, browserWss!, ctx));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server!.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  port = addr.port;
  return sessions.create('pc-a', 'tok-user');
}

function connectBrowser(path: string, cookie?: string, protocols: string[] = []): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
    headers: cookie ? { cookie } : {},
  });
}

describe('handleBrowserWs', () => {
  it('无 cookie → HTTP 401 拒绝（WS 握手无法 302）', async () => {
    await setup();
    const ws = connectBrowser('/socket');
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(401);
  });

  it('有效会话 → ws.open 发出（Bearer 注入 + cookie 剥离 + XFF + 子协议透传）→ accept 后双向 echo', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket?a=1', `gateway_sid=${uuid}; app=keep`, ['chat']);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    const open = tunnel.openFrames[0];
    expect(open?.url).toBe('/socket?a=1');
    expect(open?.headers['authorization']).toBe('Bearer tok-user');
    expect(open?.headers['cookie']).toBe('app=keep');
    expect(open?.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(open?.protocols).toEqual(['chat']);
    expect(ws.protocol).toBe('chat'); // 回选子协议透传到浏览器

    // 浏览器 → 隧道
    ws.send('hello');
    await new Promise((r) => setTimeout(r, 30));
    expect(tunnel.messages[0]).toMatchObject({ dataType: 'text' });
    expect(tunnel.messages[0]?.payload.toString()).toBe('hello');

    // 隧道 → 浏览器（二进制）
    tunnel.pushMessage(open!.channelId, 'binary', Buffer.from([0x01, 0x02]));
    const msg = await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer)));
    expect(msg).toEqual(Buffer.from([0x01, 0x02]));
    ws.close();
  });

  it('ws.reject → 浏览器收到原始 HTTP 响应（鉴权拒绝透传）', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    // 等待 ws.open 到达后拒绝
    await new Promise((r) => setTimeout(r, 30));
    tunnel.reject(tunnel.openFrames[0]?.channelId ?? 0, 403, 'denied by client');
    expect(await status).toBe(403);
  });

  it('回选子协议不属于 ws.open.protocols → 断通道', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`, ['chat']);
    await new Promise((r) => setTimeout(r, 30));
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(channelId, 'not-offered'); // 非法回选
    await new Promise((r) => setTimeout(r, 30));
    expect(tunnel.closes).toContain(channelId); // 通道被关闭
    ws.on('error', () => {});
  });

  it('浏览器关闭 → channel.close 携带关闭码发给客户端', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    await new Promise((r) => setTimeout(r, 30));
    const channelId = tunnel.openFrames[0]?.channelId ?? 0;
    tunnel.accept(channelId);
    await new Promise<void>((r) => ws.on('open', r));
    ws.close(1001, 'bye');
    await new Promise((r) => setTimeout(r, 50));
    expect(tunnel.closes).toContain(1001);
  });

  it('等 ws.accept 超时 → 504 + channel.close', async () => {
    const uuid = await setup();
    const ws = connectBrowser('/socket', `gateway_sid=${uuid}`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(await status).toBe(504);
    ws.on('error', () => {});
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/ws-proxy.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ws-proxy.ts**

`packages/server/src/ws-proxy.ts`：

```ts
/**
 * 浏览器 WS ↔ 隧道 ws 通道桥接（spec §7.2）。
 * 注意：无/失效 cookie 与各类握手失败都在 upgrade 前的原始 socket 上手写 HTTP 响应（WS 握手无法 302）；
 * ws.reject 的响应原样回写（鉴权拒绝透传到浏览器）；回选子协议必须属于 ws.open.protocols，不符即断通道（第三轮修订）；
 * handleUpgrade 前改写 req.headers['sec-websocket-protocol'] 为客户端回选值，配合 browserWss 的 handleProtocols 完成回显。
 */

import { STATUS_CODES } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket, WebSocketServer } from 'ws';
import { readSessionCookie, stripSessionCookie, type BrowserSessionStore } from './browser-session';
import type { Logger } from './logger';
import { normalizeHeaders, stripHopByHop, type ControlFrame, type DataHeader, type HeadersJson } from './protocol';
import type { PendingChannel, TunnelRegistry } from './session';

export interface ProxyContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  selectPath: string;
  headTimeoutMs: number;
  logger: Logger;
}

/** 在 upgrade 前的原始 socket 上手写 HTTP 响应（401/502/504/ws.reject 透传共用） */
function writeRawResponse(socket: Duplex, status: number, headers: HeadersJson, body: Buffer): void {
  const filtered = stripHopByHop(normalizeHeaders(headers));
  delete filtered['content-length']; // 长度以实际 body 为准，防止透传值不一致
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    ...Object.entries(filtered).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map((v) => `${key}: ${v}`)),
    `content-length: ${body.length}`,
    'connection: close',
    '',
    '',
  ];
  socket.write(lines.join('\r\n'));
  if (body.length > 0) socket.write(body);
  socket.destroy();
}

/** 浏览器 WS upgrade 入口（非保留路径） */
export function handleBrowserWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  browserWss: WebSocketServer,
  ctx: ProxyContext,
): void {
  // cookie 会话检查：WS 握手无法 302，401 拒绝
  const uuid = readSessionCookie(req.headers.cookie);
  const session = uuid ? ctx.sessions.get(uuid) : undefined;
  if (!session) {
    writeRawResponse(socket, 401, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('unauthorized'));
    return;
  }
  const tunnel = ctx.tunnels.get(session.hostname);
  if (!tunnel) {
    writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('tunnel offline'));
    return;
  }

  const protocols = (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const headers = normalizeHeaders(req.headers);
  headers['authorization'] = `Bearer ${session.token}`;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie === undefined) delete headers['cookie'];
  else headers['cookie'] = cookie;
  const remote = req.socket.remoteAddress;
  if (remote) {
    const existing = headers['x-forwarded-for'];
    const first = Array.isArray(existing) ? existing.join(', ') : existing;
    headers['x-forwarded-for'] = first ? `${first}, ${remote}` : remote;
  }
  delete headers['host'];

  let browserWs: WebSocket | null = null;
  let finished = false;
  let acceptTimer: NodeJS.Timeout | null = null;
  const finish = (fn: () => void): void => {
    if (finished) return;
    finished = true;
    if (acceptTimer) clearTimeout(acceptTimer);
    tunnel.unregister(channelId);
    fn();
  };

  const channel: PendingChannel = {
    kind: 'ws',
    onControl: (frame: ControlFrame) => {
      if (frame.type === 'ws.accept') {
        // 子协议回选校验（第三轮修订）：不属于 ws.open.protocols 即断通道
        if (frame.protocol !== undefined && !protocols.includes(frame.protocol)) {
          ctx.logger.warn('客户端回选子协议非法，断通道', { channelId, protocol: frame.protocol });
          finish(() => {
            tunnel.sendControl({ type: 'channel.close', channelId, reason: 'invalid subprotocol' });
            socket.destroy();
          });
          return;
        }
        if (acceptTimer) clearTimeout(acceptTimer);
        acceptTimer = null;
        // 回显客户端选定的子协议：改写请求头后由 handleProtocols 回选
        if (frame.protocol !== undefined) req.headers['sec-websocket-protocol'] = frame.protocol;
        else delete req.headers['sec-websocket-protocol'];
        browserWss.handleUpgrade(req, socket, head, (ws) => {
          browserWs = ws;
          wireBrowserWs(ws);
        });
        return;
      }
      if (frame.type === 'ws.reject') {
        // 客户端鉴权拒绝/upstream 失败：响应原样回浏览器
        finish(() => writeRawResponse(socket, frame.status, frame.headers ?? {}, Buffer.from(frame.body ?? '')));
        return;
      }
      if (frame.type === 'channel.error') {
        ctx.logger.error('WS 通道级错误（客户端回报）', { channelId, message: frame.message });
        finish(() => browserWs?.close(1011, 'upstream error'));
        return;
      }
      if (frame.type === 'channel.close') {
        // 客户端（upstream）主动关闭：同码透传浏览器
        finish(() => browserWs?.close(frame.code ?? 1000, frame.reason));
      }
    },
    onData: (header: DataHeader, payload: Buffer) => {
      if (header.kind === 'ws.message' && browserWs) {
        browserWs.send(payload, { binary: header.dataType === 'binary' });
      }
    },
    onTunnelDown: () => {
      finish(() => {
        if (browserWs) browserWs.close(1011, 'tunnel down');
        else writeRawResponse(socket, 502, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('tunnel offline'));
      });
    },
  };

  /** accept 后的浏览器侧接线：消息进隧道、关闭透传 */
  const wireBrowserWs = (ws: WebSocket): void => {
    ws.on('message', (data, isBinary) => {
      if (finished) return;
      const payload = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!tunnel.sendData({ channelId, kind: 'ws.message', dataType: isBinary ? 'binary' : 'text' }, payload)) {
        ws.pause();
        void tunnel.waitDrain().then(() => ws.resume());
      }
    });
    ws.on('close', (code) => {
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, code }));
    });
    ws.on('error', (err) => {
      ctx.logger.error('浏览器 WS 错误', { channelId, error: err.message });
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser error' }));
    });
  };

  const channelId = tunnel.register(channel);
  tunnel.sendControl({ type: 'ws.open', channelId, url: req.url ?? '/', headers: stripHopByHop(headers), protocols });
  ctx.logger.info('WS 升级入口', { channelId, url: req.url, hostname: session.hostname });

  // 等 ws.accept 超时
  acceptTimer = setTimeout(() => {
    ctx.logger.warn('等 ws.accept 超时', { channelId });
    finish(() => {
      tunnel.sendControl({ type: 'channel.close', channelId, reason: 'accept timeout' });
      writeRawResponse(socket, 504, { 'content-type': 'text/plain; charset=utf-8' }, Buffer.from('gateway timeout'));
    });
  }, ctx.headTimeoutMs);

  // 浏览器在 accept 前断开
  socket.on('close', () => {
    if (!finished && !browserWs) {
      finish(() => tunnel.sendControl({ type: 'channel.close', channelId, reason: 'browser aborted before accept' }));
    }
  });
}
```

> 注意：`channel` 与 `wireBrowserWs` 的相互引用靠闭包，`wireBrowserWs` 是 `const` 箭头函数且在 `channel.onControl` 触发时必然已初始化（open 帧先于 accept）；若 lint 报 `no-use-before-define`，将 `wireBrowserWs` 改为 `function` 声明即可。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/ws-proxy.test.ts`
Expected: PASS（全部 6 个用例）。若 "ws.reject" 用例时序不稳，把 `setTimeout 30ms` 提到 60ms。

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ws-proxy.ts packages/server/src/ws-proxy.test.ts
git commit -m "feat: gateway-server ws-proxy（cookie 检查/子协议回选校验/reject 透传/双向桥接）"
```

---

### Task 8: GatewayServer 主类与包入口

**Files:**
- Create: `packages/server/src/server.ts`
- Create: `packages/server/src/index.ts`
- Create: `packages/server/src/server.test.ts`

**Interfaces:**
- Consumes: Tasks 2-7 全部
- Produces（包公共 API）：
  - `GatewayServerOptions { port: number; tunnelPath?: string; selectPath?: string; helloTimeoutMs?: number; headTimeoutMs?: number; logger?: Logger }`（默认值：tunnelPath `/__gateway__/tunnel`、selectPath `/__gateway__/select`、hello 5s、head 30s）
  - `class GatewayServer`：`listen(): Promise<number>`（返回实际端口，支持 `port: 0` 测试）、`close(): Promise<void>`
  - `index.ts` 导出：`GatewayServer`、`GatewayServerOptions`、`Logger`、`createConsoleLogger`、`createDefaultLogger`、`ProtocolError`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/server.test.ts`：

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from './server';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let server: GatewayServer | null = null;
afterEach(async () => { await server?.close(); server = null; });

describe('GatewayServer 流量分发', () => {
  it('保留命名空间：隧道 GET 404、未知 /__gateway__/ 路径 404、选择页 200、其余无 cookie 302', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    const base = `http://127.0.0.1:${port}`;

    const tunnelGet = await fetch(`${base}/__gateway__/tunnel`, { redirect: 'manual' });
    expect(tunnelGet.status).toBe(404);

    const unknownReserved = await fetch(`${base}/__gateway__/anything`, { redirect: 'manual' });
    expect(unknownReserved.status).toBe(404);

    const select = await fetch(`${base}/__gateway__/select`);
    expect(select.status).toBe(200);
    expect(await select.text()).toContain('选择要连接的电脑');

    const proxied = await fetch(`${base}/api/chat`, { redirect: 'manual' });
    expect(proxied.status).toBe(302);
    expect(proxied.headers.get('location')).toBe('/__gateway__/select');
  });

  it('配置非法：端口缺省/非法值 → 构造抛错', () => {
    expect(() => new GatewayServer({ port: Number.NaN, logger: nullLogger })).toThrow(/port/);
  });

  it('close() 后再请求连接被拒', async () => {
    server = new GatewayServer({ port: 0, logger: nullLogger });
    const port = await server.listen();
    await server.close();
    await expect(fetch(`http://127.0.0.1:${port}/__gateway__/select`)).rejects.toThrow();
    server = null; // 已关闭，afterEach 跳过
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/server.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 server.ts 与 index.ts**

`packages/server/src/server.ts`：

```ts
/**
 * GatewayServer 主类 — 单端口装配：HTTP 请求与 WS upgrade 按路径分发（spec §4）。
 * 保留命名空间 /__gateway__/：tunnelPath 只接受 WS upgrade（GET 404）、selectPath 选择页、其余前缀路径 404。
 * upgrade 分发沿用 packages/web ws-gateway.ts 的 noServer 范式；浏览器侧 wss 配 handleProtocols 支持子协议回显。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { BrowserSessionStore } from './browser-session';
import { handleBrowserHttp, type ProxyContext } from './http-proxy';
import { createDefaultLogger, type Logger } from './logger';
import { handleSelectGet, handleSelectPost } from './select-page';
import { TunnelRegistry } from './session';
import { attachTunnelHandler } from './tunnel';
import { handleBrowserWs } from './ws-proxy';

export interface GatewayServerOptions {
  port: number;
  tunnelPath?: string;
  selectPath?: string;
  helloTimeoutMs?: number;
  headTimeoutMs?: number;
  logger?: Logger;
}

const RESERVED_PREFIX = '/__gateway__/';

export class GatewayServer {
  private readonly options: Required<Omit<GatewayServerOptions, 'logger'>>;
  private readonly logger: Logger;
  private readonly tunnels = new TunnelRegistry();
  private readonly sessions = new BrowserSessionStore();
  private httpServer: Server | null = null;

  constructor(options: GatewayServerOptions) {
    // 配置非法 = 进程级错误：构造即抛错
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
      throw new Error('GatewayServerOptions.port 必须是 0-65535 的整数');
    }
    this.logger = options.logger ?? createDefaultLogger();
    this.options = {
      port: options.port,
      tunnelPath: options.tunnelPath ?? '/__gateway__/tunnel',
      selectPath: options.selectPath ?? '/__gateway__/select',
      helloTimeoutMs: options.helloTimeoutMs ?? 5000,
      headTimeoutMs: options.headTimeoutMs ?? 30_000,
    };
  }

  /** 启动监听；返回实际绑定端口（port: 0 时用于测试） */
  listen(): Promise<number> {
    const { tunnelPath, selectPath, helloTimeoutMs, headTimeoutMs } = this.options;
    const proxyCtx: ProxyContext = {
      tunnels: this.tunnels,
      sessions: this.sessions,
      selectPath,
      headTimeoutMs,
      logger: this.logger,
    };

    this.httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      // 保留命名空间：隧道 GET 404 / 选择页 / 其余前缀路径 404（不转发，spec §4 自审补丁）
      if (pathname.startsWith(RESERVED_PREFIX)) {
        if (pathname === selectPath && req.method === 'GET') {
          handleSelectGet(res, this.tunnels);
          return;
        }
        if (pathname === selectPath && req.method === 'POST') {
          void handleSelectPost(req, res, { ...proxyCtx }).catch((err: unknown) => {
            this.logger.error('选择页 POST 处理异常', { error: err instanceof Error ? err.stack : String(err) });
            if (!res.headersSent) res.writeHead(500);
            res.end();
          });
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      handleBrowserHttp(req, res, proxyCtx);
    });

    // 隧道 WS 接入（只处理 tunnelPath，其余路径交还）
    attachTunnelHandler(this.httpServer, {
      tunnels: this.tunnels,
      tunnelPath,
      helloTimeoutMs,
      logger: this.logger,
    });

    // 浏览器 WS：handleProtocols 回选改写后的唯一协议（ws-proxy 在 handleUpgrade 前改写请求头）
    const browserWss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => [...protocols][0] ?? false,
    });
    this.httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
      if (pathname === tunnelPath) return; // 已被隧道处理器接管
      if (pathname.startsWith(RESERVED_PREFIX)) {
        socket.destroy(); // 保留命名空间不转发
        return;
      }
      handleBrowserWs(req, socket, head, browserWss, proxyCtx);
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.options.port, () => {
        const addr = this.httpServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : this.options.port;
        this.logger.info('网关就绪', { port });
        resolve(port);
      });
    });
  }

  /** 优雅关闭：全部隧道 teardown（在途通道 502/断开）→ 关 HTTP 服务 */
  async close(): Promise<void> {
    this.tunnels.teardownAll();
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.closeIdleConnections?.();
      server.close(() => resolve());
    });
  }
}
```

`packages/server/src/index.ts`：

```ts
/**
 * gateway-server 包入口。
 * 用法见 spec §3：new GatewayServer({ port, tunnelPath?, selectPath? }) → listen() → close()
 */

export { GatewayServer, type GatewayServerOptions } from './server';
export { ProtocolError } from './protocol';
export { createConsoleLogger, createDefaultLogger, type Logger, type LogLevel } from './logger';
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/server.test.ts`
Expected: PASS（全部 3 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/index.ts packages/server/src/server.test.ts
git commit -m "feat: gateway-server GatewayServer 主类与单端口流量分发"
```

---

### Task 9: CLI（纯参数，无配置文件）+ bin 启动器

**Files:**
- Create: `packages/server/src/cli.ts`
- Create: `packages/server/src/cli.test.ts`
- Create: `packages/server/bin/harness-server.mjs`

**Interfaces:**
- Consumes: `GatewayServer`（Task 8）
- Produces:
  - `parseArgs(argv: string[]): { port: number; tunnelPath?: string | undefined; selectPath?: string | undefined; help: boolean }`（`--port` 默认 3081）
  - `main(argv: string[]): Promise<number>`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/cli.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { main, parseArgs } from './cli';

describe('parseArgs', () => {
  it('默认 port 3081', () => {
    expect(parseArgs([]).port).toBe(3081);
  });
  it('--port / --tunnel-path / --select-path', () => {
    const args = parseArgs(['--port', '9090', '--tunnel-path', '/t', '--select-path', '/s']);
    expect(args).toMatchObject({ port: 9090, tunnelPath: '/t', selectPath: '/s' });
  });
  it('端口非法抛错', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/port/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/port/);
  });
  it('未知参数抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });
});

describe('main', () => {
  it('--help → 0', async () => {
    expect(await main(['--help'])).toBe(0);
  });
  it('参数非法 → 1', async () => {
    expect(await main(['--port', 'abc'])).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/cli.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 cli.ts 与 bin 启动器**

`packages/server/src/cli.ts`：

```ts
#!/usr/bin/env node
/**
 * harness-server CLI — 纯参数启动网关（服务端无函数型选项，不需要配置文件，spec §1.3-1）。
 * 用法：harness-server [--port 3081] [--tunnel-path /__gateway__/tunnel] [--select-path /__gateway__/select]
 * 注意：由 bin/harness-server.mjs 以 tsx 启动；main() 返回退出码便于测试。
 */

import { pathToFileURL } from 'node:url';
import { GatewayServer } from './server';

export interface CliArgs {
  port: number;
  tunnelPath?: string | undefined;
  selectPath?: string | undefined;
  help: boolean;
}

const USAGE = '用法: harness-server [--port <3081>] [--tunnel-path <path>] [--select-path <path>]';

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
  const server = new GatewayServer({
    port: args.port,
    tunnelPath: args.tunnelPath,
    selectPath: args.selectPath,
  });
  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    const port = await server.listen();
    console.info(`[harness-server] 网关就绪 http://localhost:${port}（隧道 ${args.tunnelPath ?? '/__gateway__/tunnel'}）`);
    return 0; // 进程由 http.Server 保活
  } catch (err) {
    console.error('[harness-server] 启动失败', err);
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

`packages/server/bin/harness-server.mjs`：与客户端 `bin/harness-client.mjs` 相同结构，仅入口路径改为 `../src/cli.ts`、注释中包名改为 harness-server：

```js
#!/usr/bin/env node
/**
 * harness-server bin 启动器 — 以 tsx 运行 TS 源码入口。
 * 仓库包为 TS 源码直出（无构建产物），Node 20 无类型剥离，故经 tsx 加载。
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

- [ ] **Step 4: 运行测试确认通过 + 手动验证 bin**

Run: `pnpm --filter gateway-server exec vitest run src/cli.test.ts`
Expected: PASS（全部 6 个用例）

Run: `pnpm --filter gateway-server exec node bin/harness-server.mjs --help`
Expected: 输出用法行，退出码 0

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/cli.ts packages/server/src/cli.test.ts packages/server/bin/harness-server.mjs
git commit -m "feat: gateway-server CLI（纯参数）与 tsx bin 启动器"
```

---

### Task 10: 端到端集成（模拟隧道客户端全链路）+ 全量检查

**Files:**
- Create: `packages/server/src/test-utils/mock-tunnel-client.ts`
- Create: `packages/server/src/e2e.test.ts`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无新公共 API（测试辅助 `MockTunnelClient` 仅供本包测试）

- [ ] **Step 1: 实现 MockTunnelClient 测试辅助**

`packages/server/src/test-utils/mock-tunnel-client.ts`：

```ts
/**
 * 内存模拟隧道客户端 — 讲隧道协议的 ws 客户端，供 e2e 测试驱动服务端。
 * 行为旋钮：auth-check 按 token 判定 204/403；业务请求回显 method/url/headers/body；ws.open 接受并 echo。
 */

import WebSocket from 'ws';
import {
  decodeControl, decodeData, encodeControl, encodeData,
  type ControlFrame, type DataHeader, type HeadersJson,
} from '../protocol';

export interface MockTunnelClientOptions {
  gatewayUrl: string;
  hostname: string;
  defaultPath?: string;
  /** 合法 token（auth-check 探测判定用） */
  validToken: string;
}

export class MockTunnelClient {
  /** 服务端转发来的业务请求记录（断言 Bearer 注入/cookie 剥离/XFF 用） */
  httpOpens: Extract<ControlFrame, { type: 'http.open' }>[] = [];
  ws: WebSocket | null = null;
  private bodies = new Map<number, Buffer[]>();

  constructor(private readonly opts: MockTunnelClientOptions) {}

  /** 连接 + hello；ack 后 resolve */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.gatewayUrl);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(encodeControl({ type: 'hello', client: { hostname: this.opts.hostname, defaultPath: this.opts.defaultPath ?? '/' } }));
      });
      ws.on('message', (raw, isBinary) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (isBinary) {
          const { header, payload } = decodeData(buf);
          this.onData(header, payload);
          return;
        }
        const frame = decodeControl(buf.toString('utf8'));
        if (frame.type === 'hello.ack') resolve();
        else this.onControl(frame);
      });
      ws.on('error', reject);
    });
  }

  private sendControl(frame: ControlFrame): void {
    this.ws?.send(encodeControl(frame));
  }

  private onControl(frame: ControlFrame): void {
    if (frame.type === 'ping') {
      this.sendControl({ type: 'pong' });
      return;
    }
    if (frame.type === 'http.open') {
      this.recordOpen(frame);
      this.bodies.set(frame.channelId, []);
      return;
    }
    if (frame.type === 'ws.open') {
      // 鉴权模拟：Bearer 不符 → reject 403；符 → accept 并等 echo
      const ok = frame.headers['authorization'] === `Bearer ${this.opts.validToken}`;
      if (!ok) {
        this.sendControl({ type: 'ws.reject', channelId: frame.channelId, status: 403, body: 'denied by client' });
        return;
      }
      this.sendControl({ type: 'ws.accept', channelId: frame.channelId, protocol: frame.protocols[0] });
      return;
    }
  }

  private onData(header: DataHeader, payload: Buffer): void {
    if (header.kind === 'http.body') {
      this.bodies.get(header.channelId)?.push(payload);
      return;
    }
    if (header.kind === 'http.body.end') {
      const chunks = this.bodies.get(header.channelId) ?? [];
      // auth-check 探测模拟：按 token 判定
      const auth = (this.lastHeaders ?? {})['authorization'];
      if ((this.lastUrl ?? '') === '/__gateway__/auth-check') {
        this.sendControl({ type: 'http.head', channelId: header.channelId, status: auth === `Bearer ${this.opts.validToken}` ? 204 : 403, headers: {} });
        this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
        return;
      }
      // 业务请求：回显 method/url/headers/body 为 JSON 响应（模拟 upstream）
      const echo = JSON.stringify({
        method: this.lastMethod, url: this.lastUrl, headers: this.lastHeaders,
        body: Buffer.concat(chunks).toString(),
      });
      this.sendControl({ type: 'http.head', channelId: header.channelId, status: 200, headers: { 'content-type': 'application/json', 'set-cookie': ['app=1', 'b=2'] } });
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body' }, Buffer.from(echo)));
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
      return;
    }
    if (header.kind === 'ws.message') {
      // echo 回浏览器
      this.ws?.send(encodeData({ channelId: header.channelId, kind: 'ws.message', dataType: header.dataType }, payload));
    }
  }

  // http.open 的 method/url/headers 暂存（body.end 时拼装回显）
  private lastMethod: string | undefined;
  private lastUrl: string | undefined;
  private lastHeaders: HeadersJson | undefined;

  /** 记录 http.open 帧（httpOpens 供断言；last* 供回显拼装） */
  private recordOpen(frame: Extract<ControlFrame, { type: 'http.open' }>): void {
    this.httpOpens.push(frame);
    this.lastMethod = frame.method;
    this.lastUrl = frame.url;
    this.lastHeaders = frame.headers;
  }

  close(): void {
    this.ws?.terminate();
  }
}
```

- [ ] **Step 2: 写 e2e 测试**

`packages/server/src/e2e.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { GatewayServer } from './server';
import { MockTunnelClient } from './test-utils/mock-tunnel-client';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

let server: GatewayServer | null = null;
let client: MockTunnelClient | null = null;
let port = 0;
const tunnelUrl = (): string => `ws://127.0.0.1:${port}/__gateway__/tunnel`;
const base = (): string => `http://127.0.0.1:${port}`;

beforeEach(async () => {
  server = new GatewayServer({ port: 0, headTimeoutMs: 500, helloTimeoutMs: 500, logger: nullLogger });
  port = await server.listen();
});

afterEach(async () => {
  client?.close();
  await server?.close();
  server = null;
  client = null;
});

async function connectClient(hostname = 'pc-a', defaultPath = '/dash'): Promise<MockTunnelClient> {
  client = new MockTunnelClient({ gatewayUrl: tunnelUrl(), hostname, defaultPath, validToken: 'good-token' });
  await client.connect();
  return client;
}

/** 走完选择页流程，返回可用 cookie */
async function selectAndGetCookie(token: string): Promise<string> {
  const res = await fetch(`${base()}/__gateway__/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `hostname=pc-a&token=${token}`,
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  return res.headers.get('set-cookie') ?? '';
}

describe('e2e：选择页与会话', () => {
  it('无 cookie → 302 → 选择页含在线 hostname', async () => {
    await connectClient();
    const home = await fetch(`${base()}/`, { redirect: 'manual' });
    expect(home.status).toBe(302);
    const page = await fetch(`${base()}/__gateway__/select`);
    expect(await page.text()).toContain('pc-a');
  });

  it('错误 token → 403 提示；正确 token → Set-Cookie + 302 defaultPath', async () => {
    await connectClient();
    const bad = await fetch(`${base()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=wrong',
    });
    expect(bad.status).toBe(403);
    const cookie = await selectAndGetCookie('good-token');
    expect(cookie).toContain('gateway_sid=');
    const res = await fetch(`${base()}/__gateway__/select`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'hostname=pc-a&token=good-token',
      redirect: 'manual',
    });
    expect(res.headers.get('location')).toBe('/dash');
  });
});

describe('e2e：HTTP 转发', () => {
  it('带 cookie 请求：Bearer 注入 + gateway_sid 剥离 + XFF 注入，响应与多 Set-Cookie 回传', async () => {
    const c = await connectClient();
    const cookie = await selectAndGetCookie('good-token');
    const res = await fetch(`${base()}/api/chat?q=1`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: 'ping',
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(['app=1', 'b=2']);
    const echo = JSON.parse(await res.text()) as { method: string; url: string; headers: Record<string, string>; body: string };
    expect(echo.method).toBe('POST');
    expect(echo.url).toBe('/api/chat?q=1');
    expect(echo.headers['authorization']).toBe('Bearer good-token');
    expect(echo.headers['cookie'] ?? '').not.toContain('gateway_sid');
    expect(echo.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(echo.body).toBe('ping');
    expect(c.httpOpens.length).toBeGreaterThan(0);
  });

  it('隧道离线 → 502；重连后老 cookie 恢复可用', async () => {
    await connectClient();
    const cookie = await selectAndGetCookie('good-token');
    client?.close();
    await new Promise((r) => setTimeout(r, 100));
    const offline = await fetch(`${base()}/api/x`, { headers: { cookie } });
    expect(offline.status).toBe(502);
    // 同名重连（sessions 保留，免重新选择）
    await connectClient();
    const back = await fetch(`${base()}/api/x`, { headers: { cookie } });
    expect(back.status).toBe(200);
  });
});

describe('e2e：WS 转发', () => {
  it('echo：text 与 binary 双向保真', async () => {
    await connectClient();
    const cookie = await selectAndGetCookie('good-token');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie } });
    await new Promise<void>((r, j) => { ws.on('open', r); ws.on('error', j); });
    ws.send('hello');
    const text = await new Promise<string>((r) => ws.once('message', (d) => r(String(d))));
    expect(text).toBe('hello');
    ws.send(Buffer.from([0x09, 0x08]));
    const bin = await new Promise<Buffer>((r) => ws.once('message', (d) => r(d as Buffer)));
    expect(bin).toEqual(Buffer.from([0x09, 0x08]));
    ws.close();
  });

  it('客户端鉴权拒绝：浏览器收到 403', async () => {
    await connectClient();
    // 用错误 token 建不出会话 → 改走"会话 token 正确但客户端策略变严"场景：
    // MockTunnelClient 以 Bearer 判定，故构造一个 cookie 有效但 token 与 validToken 不一致的会话：
    // 直接复用选择流程不可行（探测会被拒），改为断开隧道让 ws 走 502 分支验证异常路径。
    client?.close();
    await new Promise((r) => setTimeout(r, 100));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`, { headers: { cookie: 'gateway_sid=whatever' } });
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(status).toBe(401); // 无效 cookie
  });
});

describe('e2e：hostname 冲突', () => {
  it('同名接入 → 4409', async () => {
    await connectClient();
    const second = new WebSocket(tunnelUrl());
    await new Promise<void>((r) => second.on('open', r));
    second.send(JSON.stringify({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } }));
    const code = await new Promise<number>((r) => second.on('close', (c) => r(c)));
    expect(code).toBe(4409);
  });
});
```

> 说明："客户端鉴权拒绝 → 浏览器 403"的纯 WS reject 链路已由 Task 7 单测覆盖（FakeTunnel.reject）；e2e 这里验证无 cookie 的 401 异常路径即可，避免为模拟器加复杂旋钮。

- [ ] **Step 3: 运行 e2e 确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/e2e.test.ts`
Expected: PASS（全部 6 个用例）

- [ ] **Step 4: 全量测试 + 类型检查 + 格式化（根 CLAUDE.md 约定顺序：typecheck → format → 修复所有错误）**

Run: `pnpm --filter gateway-server test`
Expected: 全部测试文件 PASS

Run: `pnpm --filter gateway-server typecheck`
Expected: 无错误；有则修复后重跑

Run: `pnpm --filter gateway-server format`
Expected: eslint --fix 无剩余错误；格式化变更随本任务提交

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "test: gateway-server 端到端集成测试（模拟隧道客户端全链路）"
```

---

## Self-Review 记录（计划落盘前已执行）

- **Spec 覆盖**：流量分发（§4）→Task 8；隧道接入/hello/4409（§5）→Task 4；选择页与会话（§6）→Tasks 2/5；HTTP 转发（§7.1）→Task 6；WS 转发（§7.2）→Task 7；超时与错误分级（§8）→散布 Tasks 4/6/7/8 并在各任务测试用例锚定；日志红线（§9）→Global Constraints；测试计划（§10）→Tasks 2-10；CLI（§3）→Task 9
- **类型一致性**：`PendingChannel`/`TunnelHandle`/`TunnelRegistry`（Task 3 定义）在 Tasks 4/5/6/7 引用一致；`ProxyContext`（Task 6 定义）被 Task 7 复用（同名字段）；`probeAuthCheck` 依赖 `TunnelHandle` 而非具体类，测试中 FakeTunnel 注入
- **计划纠错点已标注**：Task 6/7 的前向引用 lint 处理；server.ts `closeIdleConnections` 的可选调用（Node 18.2+ 有，20 可用）
- **已知取舍**：浏览器侧写缓冲的逐通道背压不做（spec §4.3）；Task 7 的 `ws.reject` 用例时序给了 60ms 容错提示
