# 智能体网关 · 客户端（packages/client）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `gateway-client` 包：Node.js 库 + CLI，向网关建立持久 WS 隧道，多路复用转发 HTTP/WS 到本地应用服务，并在客户端侧执行权限管控。

**Architecture:** 单条持久 WS 隧道 + 自定义多路复用帧协议（控制帧 JSON + 数据帧二进制 `[u32be 头长][JSON 头][负载]`）。Client 主类装配 Connection（连接管理）与通道表；每条转发通道为独立对象（HttpChannel / WsChannel），桥接隧道帧与 upstream 真实请求；authorization 为 Express 中间件风格钩子，全部请求先鉴权再触达 upstream。

**Tech Stack:** Node.js 20+、TypeScript（strict，ESM 源码直出无构建）、`ws`（运行时唯一协议依赖）、`tsx`（仅 CLI 启动器）、vitest。

**Spec:** `docs/superpowers/specs/2026-08-21-gateway-client-design.md`（用户第三轮修订版——以仓库当前工作区文件为准；多客户端/选择页配套见服务端 spec）

## Global Constraints

- 包管理只用 pnpm（仓库 preinstall 强制）；新包自动被 `pnpm-workspace.yaml` 的 `packages/*` 覆盖
- ESM：`"type": "module"`，TS 源码直出（`main`/`exports` 指向 `./src/index.ts`），无构建步骤
- TS 配置复制 `packages/protocol-sdk/tsconfig.json`（strict + `noUncheckedIndexedAccess` + `noUnusedLocals/Parameters`）
- 运行时依赖仅 `ws` + `tsx`；devDependencies 对齐 protocol-sdk（eslint/jiti/typescript/typescript-eslint/vitest）+ `@types/node` + `@types/ws`
- 注释：中文 JSDoc，文件头说明职责与注意事项（根 CLAUDE.md 约定）
- 日志：遵循仓库级别约定（INFO 连接状态/请求入口、DEBUG 帧级、ERROR 堆栈+上下文、WARN 重试超时）；**任何级别不打印 token 与 Authorization 头**
- 协议细则（第三轮修订）：headers 编码 `string | string[]`（多值头数组）；空体必须以空载 `http.body.end` 收尾；`channel.close` 双向；4409 = 进程级错误不重连；`X-Forwarded-For` 首项 → `req.ip`
- 测试：vitest，测试文件与源码同目录（`src/**/*.test.ts`），测试辅助放 `src/test-utils/`
- 提交信息：`<type>: <description>`（feat/fix/refactor/docs/test/chore/perf/ci）
- 每个任务收尾：`pnpm --filter gateway-client test` 全绿再提交
- 相对导入不带扩展名（沿用仓库现有包风格）

---

### Task 1: 包脚手架 + 帧协议编解码 + 日志

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/eslint.config.ts`
- Create: `packages/client/vitest.config.ts`
- Create: `packages/client/src/protocol.ts`
- Create: `packages/client/src/protocol.test.ts`
- Create: `packages/client/src/logger.ts`
- Create: `packages/client/src/logger.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces（后续所有任务依赖）:
  - `HeadersJson = Record<string, string | string[]>`
  - `ControlFrame` 联合类型及成员：`HelloFrame / HelloAckFrame / HttpOpenFrame / WsOpenFrame / ChannelCloseFrame / HttpHeadFrame / WsAcceptFrame / WsRejectFrame / ChannelErrorFrame / PingFrame / PongFrame`（字段名与 spec §4.1 一致）
  - `DataKind = 'http.body' | 'http.body.end' | 'ws.message'`；`DataHeader { channelId: number; kind: DataKind; dataType?: 'text' | 'binary' }`
  - `ProtocolError extends Error`
  - `encodeControl(frame: ControlFrame): string` / `decodeControl(text: string): ControlFrame`
  - `encodeData(header: DataHeader, payload: Buffer): Buffer` / `decodeData(buf: Buffer): { header: DataHeader; payload: Buffer }`
  - `normalizeHeaders(input: Record<string, string | string[] | undefined>): HeadersJson`（key 小写化、丢弃 undefined）
  - `stripHopByHop(headers: HeadersJson): HeadersJson`
  - `Logger` 接口（`debug/info/warn/error(message, context?)`）、`createConsoleLogger(level?: LogLevel): Logger`、`createDefaultLogger(): Logger`

- [ ] **Step 1: 创建包配置文件**

`packages/client/package.json`：

```json
{
  "name": "gateway-client",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "bin": {
    "harness-client": "./bin/harness-client.mjs"
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

`packages/client/tsconfig.json`：完整复制 `packages/protocol-sdk/tsconfig.json`（内容不变）。

`packages/client/eslint.config.ts`：完整复制 `packages/protocol-sdk/eslint.config.ts`（内容不变）。

`packages/client/vitest.config.ts`：完整复制 `packages/protocol-sdk/vitest.config.ts`（内容不变）。

- [ ] **Step 2: 安装依赖**

Run: `pnpm install`
Expected: lockfile 更新，无报错。若 tsx/@types/ws 版本号不存在，`pnpm view tsx version` / `pnpm view @types/ws version` 取最新并回填 package.json。

- [ ] **Step 3: 写失败的协议测试**

`packages/client/src/protocol.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import {
  decodeControl, decodeData, encodeControl, encodeData,
  normalizeHeaders, ProtocolError, stripHopByHop, type ControlFrame,
} from './protocol';

describe('控制帧编解码', () => {
  it('全部控制帧类型 round-trip', () => {
    const frames: ControlFrame[] = [
      { type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } },
      { type: 'hello.ack' },
      { type: 'http.open', channelId: 1, method: 'GET', url: '/api/x', headers: { accept: 'application/json' } },
      { type: 'ws.open', channelId: 2, url: '/ws', headers: {}, protocols: ['chat'] },
      { type: 'channel.close', channelId: 1, code: 1000, reason: 'bye' },
      { type: 'http.head', channelId: 1, status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] } },
      { type: 'ws.accept', channelId: 2, protocol: 'chat' },
      { type: 'ws.reject', channelId: 2, status: 403, body: 'forbidden' },
      { type: 'channel.error', channelId: 1, message: 'boom' },
      { type: 'ping' },
      { type: 'pong' },
    ];
    for (const frame of frames) {
      expect(decodeControl(encodeControl(frame))).toEqual(frame);
    }
  });

  it('未知 type 抛 ProtocolError', () => {
    expect(() => decodeControl('{"type":"nope"}')).toThrow(ProtocolError);
  });

  it('非 JSON 抛 ProtocolError', () => {
    expect(() => decodeControl('not-json{')).toThrow(ProtocolError);
  });

  it('多值 headers（Set-Cookie 数组）round-trip 不丢失', () => {
    const frame: ControlFrame = { type: 'http.head', channelId: 1, status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] } };
    const decoded = decodeControl(encodeControl(frame));
    expect(decoded).toEqual(frame);
  });
});

describe('数据帧编解码', () => {
  it('http.body round-trip（含任意二进制字节）', () => {
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    const { header, payload: out } = decodeData(encodeData({ channelId: 7, kind: 'http.body' }, payload));
    expect(header).toEqual({ channelId: 7, kind: 'http.body' });
    expect(out.equals(payload)).toBe(true);
  });

  it('空负载 http.body.end round-trip（空体收尾规则）', () => {
    const { header, payload } = decodeData(encodeData({ channelId: 3, kind: 'http.body.end' }, Buffer.alloc(0)));
    expect(header.kind).toBe('http.body.end');
    expect(payload.length).toBe(0);
  });

  it('ws.message 携带 dataType', () => {
    const { header } = decodeData(encodeData({ channelId: 2, kind: 'ws.message', dataType: 'binary' }, Buffer.from('x')));
    expect(header.dataType).toBe('binary');
  });

  it('头长越界抛 ProtocolError', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(999, 0);
    expect(() => decodeData(buf)).toThrow(ProtocolError);
  });
});

describe('headers 工具', () => {
  it('normalizeHeaders 小写化并丢弃 undefined', () => {
    expect(normalizeHeaders({ Host: 'a.com', 'X-Skip': undefined })).toEqual({ host: 'a.com' });
  });

  it('stripHopByHop 剥离逐跳头、保留 set-cookie 数组', () => {
    const out = stripHopByHop({ 'transfer-encoding': 'chunked', connection: 'keep-alive', 'set-cookie': ['a=1'] });
    expect(out).toEqual({ 'set-cookie': ['a=1'] });
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/protocol.test.ts`
Expected: FAIL（`./protocol` 模块不存在）

- [ ] **Step 5: 实现 protocol.ts**

`packages/client/src/protocol.ts`：

```ts
/**
 * 隧道帧协议编解码 — 客户端侧实现。
 * 控制帧 = JSON 文本帧；数据帧 = 单条二进制 WS 消息 [u32be 头长][JSON 头][原始负载]。
 * 注意：与服务端 packages/server/src/protocol.ts 互为镜像，任何改动必须双向同步。
 */

/** 帧内 headers 编码约定：多值头（如 Set-Cookie）必须用数组表达，禁止丢失重复头 */
export type HeadersJson = Record<string, string | string[]>;

// ---- 控制帧 ----

export interface HelloFrame { type: 'hello'; client: { hostname: string; defaultPath: string } }
export interface HelloAckFrame { type: 'hello.ack' }
export interface HttpOpenFrame { type: 'http.open'; channelId: number; method: string; url: string; headers: HeadersJson }
export interface WsOpenFrame { type: 'ws.open'; channelId: number; url: string; headers: HeadersJson; protocols: string[] }
/** 双向：网关→客户端 = 浏览器侧关闭/取消；客户端→网关 = upstream 主动关闭/中止 */
export interface ChannelCloseFrame { type: 'channel.close'; channelId: number; code?: number; reason?: string }
export interface HttpHeadFrame { type: 'http.head'; channelId: number; status: number; headers: HeadersJson }
export interface WsAcceptFrame { type: 'ws.accept'; channelId: number; protocol?: string }
/** body 仅支持文本（控制帧为 JSON，无二进制体） */
export interface WsRejectFrame { type: 'ws.reject'; channelId: number; status: number; headers?: HeadersJson; body?: string }
export interface ChannelErrorFrame { type: 'channel.error'; channelId: number; message: string }
export interface PingFrame { type: 'ping' }
export interface PongFrame { type: 'pong' }

export type ControlFrame =
  | HelloFrame | HelloAckFrame | HttpOpenFrame | WsOpenFrame | ChannelCloseFrame
  | HttpHeadFrame | WsAcceptFrame | WsRejectFrame | ChannelErrorFrame | PingFrame | PongFrame;

/** 协议错误（坏帧/未知 type）：连接级错误，调用方断开重连 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const CONTROL_TYPES = new Set([
  'hello', 'hello.ack', 'http.open', 'ws.open', 'channel.close',
  'http.head', 'ws.accept', 'ws.reject', 'channel.error', 'ping', 'pong',
]);

/** 编码控制帧为 JSON 文本帧 */
export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** 解码控制帧；非对象/未知 type 抛 ProtocolError */
export function decodeControl(text: string): ControlFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProtocolError(`控制帧 JSON 解析失败: ${text.slice(0, 80)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ProtocolError('控制帧非 JSON 对象');
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) {
    throw new ProtocolError(`未知控制帧 type: ${String(type)}`);
  }
  return parsed as ControlFrame;
}

// ---- 数据帧 ----

export type DataKind = 'http.body' | 'http.body.end' | 'ws.message';

export interface DataHeader {
  channelId: number;
  kind: DataKind;
  /** 仅 kind === 'ws.message' 使用，保证 WS 消息类型保真 */
  dataType?: 'text' | 'binary';
}

const DATA_KINDS = new Set<string>(['http.body', 'http.body.end', 'ws.message']);

/** 编码数据帧：[u32be 头长][JSON 头][payload] */
export function encodeData(header: DataHeader, payload: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + head.length + payload.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  payload.copy(out, 4 + head.length);
  return out;
}

/** 解码数据帧；长度越界/头非法抛 ProtocolError */
export function decodeData(buf: Buffer): { header: DataHeader; payload: Buffer } {
  if (buf.length < 4) throw new ProtocolError('数据帧过短');
  const headLen = buf.readUInt32BE(0);
  if (4 + headLen > buf.length) throw new ProtocolError(`数据帧头长越界: ${headLen}`);
  let header: DataHeader;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8')) as DataHeader;
  } catch {
    throw new ProtocolError('数据帧头 JSON 解析失败');
  }
  if (typeof header.channelId !== 'number' || !DATA_KINDS.has(header.kind)) {
    throw new ProtocolError('数据帧头字段非法');
  }
  return { header, payload: buf.subarray(4 + headLen) };
}

// ---- headers 工具 ----

/** 规范化 headers：key 统一小写、丢弃 undefined（兼容 Node req.headers 形态） */
export function normalizeHeaders(input: Record<string, string | string[] | undefined>): HeadersJson {
  const out: HeadersJson = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** RFC 2616 逐跳头，转发前后各剥离一次 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 剥离逐跳头 */
export function stripHopByHop(headers: HeadersJson): HeadersJson {
  const out: HeadersJson = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    out[key] = value;
  }
  return out;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/protocol.test.ts`
Expected: PASS（全部 8 个用例）

- [ ] **Step 7: 写失败的日志测试**

`packages/client/src/logger.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { createConsoleLogger, type Logger } from './logger';

/** 捕获 console 输出的测试辅助 */
function capture(): { lines: string[]; logger: Logger; restore: () => void } {
  const lines: string[] = [];
  const orig = console.info;
  console.info = (msg?: unknown) => lines.push(String(msg));
  return { lines, logger: createConsoleLogger('info'), restore: () => { console.info = orig; } };
}

describe('logger', () => {
  it('info 级别输出 info、过滤 debug', () => {
    const { lines, logger, restore } = capture();
    try {
      logger.debug('不应出现');
      logger.info('连接建立', { hostname: 'pc-a' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('连接建立');
      expect(lines[0]).toContain('pc-a');
    } finally {
      restore();
    }
  });
});
```

Run: `pnpm --filter gateway-client exec vitest run src/logger.test.ts`
Expected: FAIL（`./logger` 模块不存在）

- [ ] **Step 8: 实现 logger.ts 并确认通过**

`packages/client/src/logger.ts`：

```ts
/**
 * 统一日志 — 级别与场景约定见根 CLAUDE.md。
 * 注意：DEBUG 生产默认关闭（默认级别 info）；任何级别调用方都不得放入 token/Authorization。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 控制台 logger：context 以 JSON 附加在消息后 */
export function createConsoleLogger(level: LogLevel = 'info'): Logger {
  const emit = (lv: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (ORDER[lv] < ORDER[level]) return;
    const line = context ? `[client][${lv}] ${message} ${JSON.stringify(context)}` : `[client][${lv}] ${message}`;
    if (lv === 'error') console.error(line);
    else if (lv === 'warn') console.warn(line);
    else if (lv === 'debug') console.debug(line);
    else console.info(line);
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  };
}

/** 默认 logger：读 LOG_LEVEL 环境变量，缺省 info */
export function createDefaultLogger(): Logger {
  const lv = process.env.LOG_LEVEL?.toLowerCase();
  return createConsoleLogger(lv === 'debug' || lv === 'warn' || lv === 'error' ? lv : 'info');
}
```

Run: `pnpm --filter gateway-client exec vitest run src/logger.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/client
git commit -m "chore: gateway-client 包脚手架 + 帧协议编解码 + 日志"
```

---

### Task 2: authorization 执行器（Express 中间件风格适配）

**Files:**
- Create: `packages/client/src/authorize.ts`
- Create: `packages/client/src/authorize.test.ts`

**Interfaces:**
- Consumes: `HeadersJson`、`HttpOpenFrame`、`WsOpenFrame`（Task 1）
- Produces:
  - `AuthRequest { method: string; url: string; headers: HeadersJson; ip: string | null; isWebSocket: boolean }`
  - `buildAuthRequest(open: HttpOpenFrame | WsOpenFrame, isWebSocket: boolean): AuthRequest`
  - `AuthResponse` 类（`writeHead(status, headers?): this`、`end(body?: string | Buffer): void`、`writableEnded: boolean`、`statusCode`、`headers`、`body: Buffer`）
  - `AuthorizationHook = (req: AuthRequest, res: AuthResponse, next: (err?: unknown) => void) => void`
  - `AuthDecision { allowed: boolean; status: number; headers: HeadersJson; body: Buffer }`
  - `runAuthorization(hook: AuthorizationHook | undefined, req: AuthRequest, opts: { token?: string | undefined; timeoutMs: number }): Promise<AuthDecision>`

- [ ] **Step 1: 写失败的测试**

`packages/client/src/authorize.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildAuthRequest, runAuthorization, type AuthRequest } from './authorize';

const REQ: AuthRequest = {
  method: 'GET', url: '/api/x', headers: {}, ip: null, isWebSocket: false,
};

describe('默认鉴权（无自定义钩子）', () => {
  it('无钩子无 token → 放行', async () => {
    const d = await runAuthorization(undefined, REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('无钩子有 token：Bearer 匹配 → 放行', async () => {
    const req = { ...REQ, headers: { authorization: 'Bearer t1' } };
    const d = await runAuthorization(undefined, req, { token: 't1', timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('无钩子有 token：Bearer 不符/缺失 → 403', async () => {
    expect((await runAuthorization(undefined, REQ, { token: 't1', timeoutMs: 1000 })).status).toBe(403);
    const wrong = { ...REQ, headers: { authorization: 'Bearer no' } };
    expect((await runAuthorization(undefined, wrong, { token: 't1', timeoutMs: 1000 })).allowed).toBe(false);
  });
});

describe('自定义钩子', () => {
  it('next() → 放行', async () => {
    const d = await runAuthorization((_req, _res, next) => next(), REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(true);
  });

  it('写 res → 拒绝且响应原样保留', async () => {
    const d = await runAuthorization((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('no auth');
    }, REQ, { timeoutMs: 1000 });
    expect(d.allowed).toBe(false);
    expect(d.status).toBe(401);
    expect(d.body.toString()).toBe('no auth');
    expect(d.headers['content-type']).toBe('text/plain');
  });

  it('异步写 res → 同样捕获为拒绝', async () => {
    const d = await runAuthorization((_req, res) => {
      setTimeout(() => res.writeHead(403).end('late'), 10);
    }, REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
    expect(d.body.toString()).toBe('late');
  });

  it('next(err) → 403', async () => {
    const d = await runAuthorization((_req, _res, next) => next(new Error('x')), REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
  });

  it('钩子同步抛异常 → 403', async () => {
    const d = await runAuthorization(() => { throw new Error('boom'); }, REQ, { timeoutMs: 1000 });
    expect(d.status).toBe(403);
  });

  it('悬挂 → 超时兜底 403', async () => {
    const d = await runAuthorization(() => { /* 什么都不做 */ }, REQ, { timeoutMs: 30 });
    expect(d.status).toBe(403);
  });
});

describe('buildAuthRequest', () => {
  it('X-Forwarded-For 取首项为 ip', () => {
    const req = buildAuthRequest({ type: 'http.open', channelId: 1, method: 'GET', url: '/a', headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }, false);
    expect(req.ip).toBe('1.2.3.4');
  });

  it('缺失 XFF → ip 为 null', () => {
    const req = buildAuthRequest({ type: 'http.open', channelId: 1, method: 'GET', url: '/a', headers: {} }, false);
    expect(req.ip).toBeNull();
  });

  it('ws.open 无 method 字段时为 GET 且 isWebSocket 透传', () => {
    const req = buildAuthRequest({ type: 'ws.open', channelId: 1, url: '/ws', headers: {}, protocols: [] }, true);
    expect(req.method).toBe('GET');
    expect(req.isWebSocket).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/authorize.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 authorize.ts**

`packages/client/src/authorize.ts`：

```ts
/**
 * authorization 执行器 — Express 中间件风格钩子在隧道场景的适配层。
 * 语义（spec §3.1）：next() 放行；写 res 即拒绝（原样透传浏览器）；next(err)/同步抛异常/悬挂超时 → 403。
 * 注意：选择页探测（/__gateway__/auth-check）也走此执行器，自定义钩子必须兼容该路径。
 */

import type { HeadersJson, HttpOpenFrame, WsOpenFrame } from './protocol';

/** 鉴权请求的只读信息（HTTP 与 WS 握手共用） */
export interface AuthRequest {
  method: string;
  url: string;
  headers: HeadersJson;
  /** 浏览器真实 IP：服务端注入的 X-Forwarded-For 首项；缺省 null（不是隧道对端地址） */
  ip: string | null;
  isWebSocket: boolean;
}

/** 由 open 帧构造 AuthRequest（headers 在协议层已小写化） */
export function buildAuthRequest(open: HttpOpenFrame | WsOpenFrame, isWebSocket: boolean): AuthRequest {
  const xff = open.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff;
  const ip = first?.split(',')[0]?.trim() || null;
  return {
    method: 'method' in open ? open.method : 'GET',
    url: open.url,
    headers: open.headers,
    ip,
    isWebSocket,
  };
}

/** 钩子可写的最小响应对象：写 res（end）即视为拒绝，内容原样透传浏览器 */
export class AuthResponse {
  statusCode = 200;
  headers: HeadersJson = {};
  body: Buffer = Buffer.alloc(0);
  writableEnded = false;

  writeHead(status: number, headers?: HeadersJson): this {
    this.statusCode = status;
    if (headers) this.headers = { ...this.headers, ...headers };
    return this;
  }

  end(body?: string | Buffer): void {
    if (body !== undefined) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    }
    this.writableEnded = true;
  }
}

export type AuthorizationHook = (
  req: AuthRequest,
  res: AuthResponse,
  next: (err?: unknown) => void,
) => void;

/** 鉴权结论：allowed=false 时其余字段为拒绝响应 */
export interface AuthDecision {
  allowed: boolean;
  status: number;
  headers: HeadersJson;
  body: Buffer;
}

const ALLOW: AuthDecision = { allowed: true, status: 200, headers: {}, body: Buffer.alloc(0) };
const FORBIDDEN: AuthDecision = {
  allowed: false,
  status: 403,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body: Buffer.from('forbidden'),
};

/** 执行鉴权：无钩子且有 token → 内置 Bearer 校验；都无 → 放行；有钩子 → 钩子为准 */
export function runAuthorization(
  hook: AuthorizationHook | undefined,
  req: AuthRequest,
  opts: { token?: string | undefined; timeoutMs: number },
): Promise<AuthDecision> {
  if (!hook) {
    if (opts.token === undefined) return Promise.resolve(ALLOW);
    return Promise.resolve(req.headers['authorization'] === `Bearer ${opts.token}` ? ALLOW : FORBIDDEN);
  }
  return new Promise<AuthDecision>((resolve) => {
    const res = new AuthResponse();
    let settled = false;
    const done = (decision: AuthDecision): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(decision);
    };
    // 悬挂兜底：既不调 next 也不写 res，超时按拒绝处理
    const timer = setTimeout(() => done(FORBIDDEN), opts.timeoutMs);
    // 包装 end：先包装再调钩子，同步/异步写 res 都能即时捕获
    const origEnd = res.end.bind(res);
    res.end = (body?: string | Buffer): void => {
      origEnd(body);
      done({ allowed: false, status: res.statusCode, headers: res.headers, body: res.body });
    };
    const next = (err?: unknown): void => {
      done(err === undefined ? ALLOW : FORBIDDEN);
    };
    try {
      const returned = hook(req, res, next) as unknown;
      // 宽容处理 async 钩子：reject 视为拒绝（Express 风格不 await，但不应让进程崩）
      if (returned instanceof Promise) returned.catch(() => done(FORBIDDEN));
    } catch {
      done(FORBIDDEN);
    }
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/authorize.test.ts`
Expected: PASS（全部 11 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/authorize.ts packages/client/src/authorize.test.ts
git commit -m "feat: gateway-client authorization 执行器（Express 风格 + 默认 Bearer 校验）"
```

---

### Task 3: Connection 连接管理（hello 握手 / 重连 / 心跳 / 背压）

**Files:**
- Create: `packages/client/src/connection.ts`
- Create: `packages/client/src/connection.test.ts`

**Interfaces:**
- Consumes: Task 1 的协议编解码、`Logger`
- Produces:
  - `ReconnectOptions { baseDelayMs: number; maxDelayMs: number; maxRetries: number }`
  - `ConnectionOptions { gatewayUrl: string; hello: { hostname: string; defaultPath: string }; heartbeatIntervalMs: number; connectTimeoutMs: number; reconnect: ReconnectOptions; logger: Logger }`
  - `ConnectionHandlers { onControl(frame: ControlFrame): void; onData(header: DataHeader, payload: Buffer): void; onDisconnected(): void }`
  - `class Connection extends EventEmitter`：`connect(): Promise<void>`、`sendControl(frame: ControlFrame): void`、`sendData(header: DataHeader, payload: Buffer): boolean`（false = 超聚合高水位）、`waitDrain(): Promise<void>`、`close(): Promise<void>`、`get ready(): boolean`；事件 `'connected' | 'disconnected' | 'error'`
  - `hello.ack`/`ping`/`pong` 由 Connection 内部消化，不上抛 onControl

- [ ] **Step 1: 写失败的测试（先写 mock 网关辅助 + 用例）**

`packages/client/src/connection.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { Connection } from './connection';
import { decodeControl, encodeControl, type ControlFrame, type DataHeader } from './protocol';
import type { Logger } from 'node:console';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 内存模拟网关：自动应答 hello/ping，记录收到的控制帧 */
class MockGateway {
  wss = new WebSocketServer({ port: 0 });
  sockets: WsWebSocket[] = [];
  received: ControlFrame[] = [];
  /** 测试旋钮：收到 hello 后的行为 */
  helloAction: 'ack' | 'close4409' | 'ignore' = 'ack';

  constructor() {
    this.wss.on('connection', (ws) => {
      this.sockets.push(ws);
      ws.on('message', (data, isBinary) => {
        if (isBinary) return; // 数据帧在用例外处理
        const frame = decodeControl(String(data));
        this.received.push(frame);
        if (frame.type === 'hello' && this.helloAction === 'ack') ws.send(encodeControl({ type: 'hello.ack' }));
        if (frame.type === 'hello' && this.helloAction === 'close4409') ws.close(4409, 'hostname conflict');
        if (frame.type === 'ping') ws.send(encodeControl({ type: 'pong' }));
      });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }

  /** 主动断开当前所有隧道连接 */
  dropAll(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets = [];
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

const OPTS = {
  hello: { hostname: 'pc-a', defaultPath: '/' },
  heartbeatIntervalMs: 60,
  connectTimeoutMs: 300,
  reconnect: { baseDelayMs: 20, maxDelayMs: 80, maxRetries: Infinity },
  logger: nullLogger,
};

function makeHandlers() {
  const calls = { control: [] as ControlFrame[], data: [] as DataHeader[], disconnected: 0 };
  return {
    calls,
    handlers: {
      onControl: (f: ControlFrame) => calls.control.push(f),
      onData: (h: DataHeader) => calls.data.push(h),
      onDisconnected: () => { calls.disconnected += 1; },
    },
  };
}

describe('Connection', () => {
  it('hello 握手：连接后首帧为 hello，收到 ack 后 ready 并 resolve', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    expect(conn.ready).toBe(true);
    expect(gw.received[0]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } });
    await conn.close();
    await gw.close();
  });

  it('connect 超时：端口不可达时 connectTimeoutMs 后 reject', async () => {
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: 'ws://127.0.0.1:1/__gateway__/tunnel', ...OPTS }, handlers);
    conn.on('error', () => {});
    await expect(conn.connect()).rejects.toThrow(/connect timeout/);
  });

  it('4409 hostname 冲突：connect 立即 reject 且不重连', async () => {
    const gw = new MockGateway();
    gw.helloAction = 'close4409';
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await expect(conn.connect()).rejects.toThrow(/4409/);
    await new Promise((r) => setTimeout(r, 200));
    expect(gw.sockets.length + gw.received.length).toBeLessThanOrEqual(1 + 1); // 只连过 1 次
    await gw.close();
  });

  it('断线自动重连：drop 后 disconnected → 重连成功再 connected', async () => {
    const gw = new MockGateway();
    const { handlers, calls } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    const events: string[] = [];
    conn.on('connected', () => events.push('connected'));
    conn.on('disconnected', () => events.push('disconnected'));
    await conn.connect();
    gw.dropAll();
    await new Promise<void>((resolve) => conn.once('connected', resolve));
    expect(events).toEqual(['connected', 'disconnected', 'connected']);
    expect(calls.disconnected).toBe(1);
    await conn.close();
    await gw.close();
  });

  it('心跳死连接检测：对端静默超过 2 个周期 → 主动断开并重连', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    // 网关侧停止一切 outbound（不应答 ping、不发任何帧）
    gw.sockets[0]?.pause();
    await new Promise<void>((resolve) => conn.once('connected', resolve)); // 重连成功
    expect(conn.ready).toBe(true);
    await conn.close();
    await gw.close();
  });

  it('close()：主动关闭后不重连', async () => {
    const gw = new MockGateway();
    const { handlers } = makeHandlers();
    const conn = new Connection({ gatewayUrl: gw.url, ...OPTS }, handlers);
    conn.on('error', () => {});
    await conn.connect();
    await conn.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(gw.sockets.length).toBe(0);
    await gw.close();
  });
});
```

> 说明：测试里的 `nullLogger` 用 `import('./logger').Logger` 类型即可，避免未实现期编译错误之外的噪音；`connect timeout` 用例把 gatewayUrl 指向 1 号端口（不可达）。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/connection.test.ts`
Expected: FAIL（`./connection` 模块不存在）

- [ ] **Step 3: 实现 connection.ts**

`packages/client/src/connection.ts`：

```ts
/**
 * 网关隧道连接管理 — hello 握手、自动重连（指数退避+抖动）、应用层心跳、聚合背压。
 * 语义（spec §6）：connect() 首连失败按退避持续重试，connectTimeoutMs 内未就绪则 reject；
 * 4409 = 进程级错误（hostname 冲突），connect() 立即 reject 且不重连；重连是全新会话。
 * 注意：hello.ack/ping/pong 在本层消化，不上抛；'error' 事件必须被外层监听（EventEmitter 语义）。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  decodeControl, decodeData, encodeControl, encodeData,
  type ControlFrame, type DataHeader,
} from './protocol';
import type { Logger } from './logger';

export interface ReconnectOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface ConnectionOptions {
  gatewayUrl: string;
  hello: { hostname: string; defaultPath: string };
  heartbeatIntervalMs: number;
  connectTimeoutMs: number;
  reconnect: ReconnectOptions;
  logger: Logger;
}

/** 上行帧回调（hello.ack/ping/pong 已消化，不会出现在这里） */
export interface ConnectionHandlers {
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 隧道断开（每次断开都触发，含重连中的断开）：Client 用它中止在途通道 */
  onDisconnected(): void;
}

// 聚合背压水位（spec §4.3：v1 只尊重整体 WS bufferedAmount）
const HIGH_WATER_BYTES = 16 * 1024 * 1024;
const LOW_WATER_BYTES = 4 * 1024 * 1024;
const DRAIN_POLL_MS = 100;
/** close() 时对端不配合关闭的强制 terminate 等待 */
const CLOSE_FORCE_MS = 2000;

/** ws RawData 统一转 Buffer（Buffer/ArrayBuffer/Buffer[] 三态） */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private readyState = false;
  private closing = false;
  private attempts = 0;
  private lastActivityAt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly opts: ConnectionOptions,
    private readonly handlers: ConnectionHandlers,
  ) {
    super();
  }

  /** 隧道是否就绪（已收到 hello.ack） */
  get ready(): boolean {
    return this.readyState;
  }

  /** 建立隧道：首连失败持续退避重试；connectTimeoutMs 未就绪 / 4409 → reject */
  connect(): Promise<void> {
    this.closing = false;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.closing = true;
        this.clearReconnectTimer();
        this.ws?.close();
        reject(new Error(`connect timeout after ${this.opts.connectTimeoutMs}ms`));
      }, this.opts.connectTimeoutMs);
      this.connectResolve = () => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        resolve();
      };
      this.connectReject = (err) => {
        clearTimeout(timeout);
        this.connectResolve = null;
        this.connectReject = null;
        reject(err);
      };
      this.attempt();
    });
  }

  /** 发送控制帧；未就绪抛错（调用方只应在 ready 后调用） */
  sendControl(frame: ControlFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tunnel not ready');
    this.ws.send(encodeControl(frame));
  }

  /** 发送数据帧；返回 false = 超聚合高水位，调用方应暂停生产并 waitDrain() 后恢复 */
  sendData(header: DataHeader, payload: Buffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('tunnel not ready');
    this.ws.send(encodeData(header, payload));
    if (this.ws.bufferedAmount > HIGH_WATER_BYTES) {
      this.startDrainPoll();
      return false;
    }
    return true;
  }

  /** 等聚合发送缓冲回落到低水位以下 */
  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 优雅关闭：停心跳/重连 → 关闭隧道 WS（在途通道由 Client 在 onDisconnected 中中止） */
  async close(): Promise<void> {
    this.closing = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.connectReject?.(new Error('connection closed by caller'));
    const ws = this.ws;
    this.readyState = false;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => {
        ws.terminate();
        resolve();
      }, CLOSE_FORCE_MS);
      ws.once('close', () => {
        clearTimeout(force);
        resolve();
      });
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    });
  }

  /** 发起一次连接尝试并接线全部事件 */
  private attempt(): void {
    const ws = new WebSocket(this.opts.gatewayUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.lastActivityAt = Date.now();
      // 首帧必须是 hello（spec §4.1：连接建立后首帧发送，不含 token）
      ws.send(encodeControl({ type: 'hello', client: this.opts.hello }));
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      this.lastActivityAt = Date.now(); // 任何入站消息都算活跃（心跳判死依据）
      try {
        if (isBinary) {
          const { header, payload } = decodeData(toBuffer(data));
          this.handlers.onData(header, payload);
        } else {
          this.handleControl(decodeControl(toBuffer(data).toString('utf8')));
        }
      } catch (err) {
        // 协议错误 = 连接级：ERROR 日志 + 断开走重连
        this.opts.logger.error('隧道协议错误，断开重连', { error: err instanceof Error ? err.stack : String(err) });
        ws.close(1002, 'protocol error');
      }
    });

    ws.on('close', (code: number) => this.handleClose(code));
    // 'error' 之后必有 'close'，重连逻辑集中在 handleClose
    ws.on('error', (err: Error) => this.emit('error', err));
  }

  /** 控制帧分发：hello.ack/ping/pong 本层消化，其余上抛 */
  private handleControl(frame: ControlFrame): void {
    if (frame.type === 'hello.ack') {
      this.readyState = true;
      this.attempts = 0; // 重连成功后重置退避
      this.startHeartbeat();
      this.opts.logger.info('隧道就绪', { hostname: this.opts.hello.hostname });
      this.emit('connected');
      this.connectResolve?.();
      return;
    }
    if (frame.type === 'ping') {
      this.ws?.send(encodeControl({ type: 'pong' }));
      return;
    }
    if (frame.type === 'pong') return;
    this.handlers.onControl(frame);
  }

  /** 关闭处理：4409 进程级不重连；其余按退避重连（closing 时不重连） */
  private handleClose(code: number): void {
    const wasReady = this.readyState;
    this.readyState = false;
    this.stopHeartbeat();
    this.handlers.onDisconnected();
    if (wasReady) this.emit('disconnected');
    if (this.closing) return;
    if (code === 4409) {
      const err = new Error('hostname conflict (4409): 同名客户端已在线');
      this.opts.logger.error('hostname 冲突，不再重连', { hostname: this.opts.hello.hostname });
      if (this.connectReject) this.connectReject(err);
      else this.emit('error', err);
      return;
    }
    this.scheduleReconnect();
  }

  /** 退避重连：base * 2^attempts 封顶 max，加 ±50% 抖动；maxRetries 耗尽按场景 reject 或报错停止 */
  private scheduleReconnect(): void {
    if (this.closing) return;
    if (this.attempts >= this.opts.reconnect.maxRetries) {
      const err = new Error(`reconnect exhausted after ${this.attempts} attempts`);
      if (this.connectReject) {
        this.connectReject(err);
      } else {
        this.opts.logger.warn('重连次数耗尽，停止重试', { attempts: this.attempts });
        this.emit('error', err);
      }
      return;
    }
    const { baseDelayMs, maxDelayMs } = this.opts.reconnect;
    const exp = Math.min(baseDelayMs * 2 ** this.attempts, maxDelayMs);
    const delay = exp * (0.5 + Math.random() * 0.5);
    this.attempts += 1;
    this.opts.logger.info('隧道重连中', { attempts: this.attempts, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => this.attempt(), delay);
  }

  /** 应用层心跳：每周期发 ping；连续 2 个周期无任何入站判死，terminate 触发重连 */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const silentMs = Date.now() - this.lastActivityAt;
      if (silentMs > 2 * this.opts.heartbeatIntervalMs) {
        this.opts.logger.warn('心跳超时，判定死连接', { silentMs });
        this.ws?.terminate();
        return;
      }
      try {
        this.ws?.send(encodeControl({ type: 'ping' }));
      } catch {
        // 发送失败由 close 事件兜底走重连
      }
    }, this.opts.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** 背压轮询：缓冲低于低水位时唤醒全部等待方；无等待方即停 */
  private startDrainPoll(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      const amount = this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws.bufferedAmount : 0;
      if (amount > LOW_WATER_BYTES) return;
      const waiters = this.drainWaiters.splice(0);
      for (const waiter of waiters) waiter();
      if (this.drainWaiters.length === 0 && this.drainTimer) {
        clearInterval(this.drainTimer);
        this.drainTimer = null;
      }
    }, DRAIN_POLL_MS);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/connection.test.ts`
Expected: PASS（全部 6 个用例）。若心跳用例偶发慢，确认 `ws.pause()` 在 ws v8 存在（存在）；必要时把 `heartbeatIntervalMs` 调到 80。

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/connection.ts packages/client/src/connection.test.ts
git commit -m "feat: gateway-client Connection 连接管理（hello/重连/心跳/背压）"
```

---

### Task 4: HttpChannel（HTTP 通道桥接）

**Files:**
- Create: `packages/client/src/http-channel.ts`
- Create: `packages/client/src/http-channel.test.ts`

**Interfaces:**
- Consumes: Task 1 协议、`Connection`（Task 3，测试中以 `as unknown as Connection` 注入假实现）、`buildAuthRequest`/`AuthRequest`/`AuthDecision`（Task 2）
- Produces:
  - `HttpChannelParams { id: number; open: HttpOpenFrame; upstream: URL; connection: Connection; authorize: (req: AuthRequest) => Promise<AuthDecision>; logger: Logger; onDone: (id: number) => void }`
  - `class HttpChannel`：`start(): Promise<void>`、`onBody(payload: Buffer): void`、`onBodyEnd(): void`、`onPeerClose(frame: ChannelCloseFrame): void`、`abort(): void`

- [ ] **Step 1: 写失败的测试**

`packages/client/src/http-channel.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpChannel } from './http-channel';
import type { Connection } from './connection';
import type { AuthDecision, AuthRequest } from './authorize';
import type { ControlFrame, DataHeader, HttpOpenFrame } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

/** 假 Connection：记录发出的帧；sendData 可被测试控制返回 false 一次 */
class FakeConnection {
  controls: ControlFrame[] = [];
  data: { header: DataHeader; payload: Buffer }[] = [];
  failNextSend = false;
  private drainResolve: (() => void) | null = null;

  sendControl(frame: ControlFrame): void { this.controls.push(frame); }
  sendData(header: DataHeader, payload: Buffer): boolean {
    this.data.push({ header, payload });
    if (this.failNextSend) { this.failNextSend = false; return false; }
    return true;
  }
  waitDrain(): Promise<void> {
    return new Promise((r) => { this.drainResolve = r; });
  }
  drain(): void { this.drainResolve?.(); }
  asConnection(): Connection { return this as unknown as Connection; }
}

const ALLOW = async (_req: AuthRequest): Promise<AuthDecision> => ({ allowed: true, status: 200, headers: {}, body: Buffer.alloc(0) });

function makeOpen(overrides: Partial<HttpOpenFrame> = {}): HttpOpenFrame {
  return { type: 'http.open', channelId: 1, method: 'GET', url: '/api/x?y=1', headers: { host: 'gateway.example', accept: 'application/json' }, ...overrides };
}

/** 起真实 upstream http server，handler 由用例定制 */
function startUpstream(handler: Parameters<typeof createServer>[0]): Promise<{ server: Server; url: URL; hits: { body: Buffer; headers: Record<string, unknown> }[] }> {
  const hits: { body: Buffer; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits.push({ body: Buffer.concat(chunks), headers: req.headers });
      handler(req, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr) resolve({ server, url: new URL(`http://127.0.0.1:${addr.port}`), hits });
    });
  });
}

let cleanup: Server | null = null;
afterEach(async () => { await new Promise((r) => cleanup?.close(() => r(null))); cleanup = null; });

describe('HttpChannel', () => {
  it('GET 转发：Host 重写为 upstream、剥 host 原值、空体收尾、响应头/体帧序正确', async () => {
    const up = await startUpstream((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello'); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    ch.onBodyEnd(); // 空体规则：无 body 也必须 end 收尾
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.headers['host']).toBe(`127.0.0.1:${up.url.port}`);
    const head = conn.controls.find((f) => f.type === 'http.head');
    expect(head).toMatchObject({ status: 200 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    expect(Buffer.concat(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload)).toString()).toBe('hello');
  });

  it('POST 大 body 流式透传到 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('ok'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen({ method: 'POST', url: '/upload' }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    const part = Buffer.alloc(64 * 1024, 65);
    ch.onBody(part);
    ch.onBody(part);
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    expect(up.hits[0]?.body.length).toBe(128 * 1024);
  });

  it('鉴权拒绝：回自定义响应帧，不打 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('x'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const deny = async (): Promise<AuthDecision> => ({ allowed: false, status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('no') });
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: deny, logger: nullLogger, onDone: () => {} });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'http.head', status: 403 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
    expect(up.hits).toHaveLength(0);
  });

  it('auth-check 短路：放行回 204 且不打 upstream', async () => {
    const up = await startUpstream((_req, res) => res.end('x'));
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen({ url: '/__gateway__/auth-check' }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'http.head', status: 204 });
    expect(up.hits).toHaveLength(0);
  });

  it('多值响应头：upstream 的多个 Set-Cookie 以数组透传', async () => {
    const up = await startUpstream((_req, res) => { res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] }); res.end('x'); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 50));
    const head = conn.controls.find((f) => f.type === 'http.head');
    expect(head && 'headers' in head && head.headers['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('upstream 不可达：回 502 + 结束帧', async () => {
    const conn = new FakeConnection();
    const dead = new URL('http://127.0.0.1:1');
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: dead, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.controls.find((f) => f.type === 'http.head')).toMatchObject({ status: 502 });
    expect(conn.data.at(-1)?.header.kind).toBe('http.body.end');
  });

  it('背压：sendData 返回 false 时暂停 upstream 流，drain 后恢复', async () => {
    const body = 'x'.repeat(4096);
    const up = await startUpstream((_req, res) => { res.writeHead(200); res.end(body); });
    cleanup = up.server;
    const conn = new FakeConnection();
    conn.failNextSend = true;
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    ch.onBodyEnd();
    await new Promise((r) => setTimeout(r, 30));
    conn.drain();
    await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(conn.data.filter((d) => d.header.kind === 'http.body').map((d) => d.payload)).toString()).toBe(body);
  });

  it('网关取消（onPeerClose）：中止 upstream 请求，不再发帧', async () => {
    const up = await startUpstream((_req, res) => { setTimeout(() => res.end('late'), 200); });
    cleanup = up.server;
    const conn = new FakeConnection();
    const ch = new HttpChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    ch.onPeerClose({ type: 'channel.close', channelId: 1 });
    await new Promise((r) => setTimeout(r, 250));
    expect(conn.data.filter((d) => d.header.kind === 'http.body')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/http-channel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 http-channel.ts**

`packages/client/src/http-channel.ts`：

```ts
/**
 * HTTP 通道 — 隧道帧 ↔ upstream http/https 请求流的桥接。
 * 生命周期（spec §5.1）：鉴权 →（auth-check 短路）→ 转发 upstream → 流式回传。
 * 注意：Host 头删除后由 Node 按 upstream URL 重写；hop-by-hop 头双向剥离；
 * upstream 建立前到达的 body 帧暂存队列，建立后按序 flush。
 */

import http from 'node:http';
import https from 'node:https';
import { buildAuthRequest, type AuthDecision, type AuthRequest } from './authorize';
import type { Connection } from './connection';
import type { Logger } from './logger';
import { normalizeHeaders, stripHopByHop, type ChannelCloseFrame, type HttpOpenFrame } from './protocol';

export interface HttpChannelParams {
  id: number;
  open: HttpOpenFrame;
  upstream: URL;
  connection: Connection;
  authorize: (req: AuthRequest) => Promise<AuthDecision>;
  logger: Logger;
  /** 通道结束（完成/被拒/出错/取消）时回调，Client 用它从通道表移除 */
  onDone: (id: number) => void;
}

export class HttpChannel {
  private req: http.ClientRequest | null = null;
  /** upstream 请求建立前到达的 body 暂存；建立后置 null 直写 */
  private pending: Buffer[] | null = [];
  private pendingEnd = false;
  private headSent = false;
  private finished = false;

  constructor(private readonly params: HttpChannelParams) {}

  /** 入口：鉴权 → 短路/拒绝/转发。只调用一次 */
  async start(): Promise<void> {
    const { open, authorize, connection, upstream } = this.params;
    const decision = await authorize(buildAuthRequest(open, false));
    if (this.finished) return;

    if (!decision.allowed) {
      // 鉴权拒绝：响应原样回网关，不打 upstream
      connection.sendControl({ type: 'http.head', channelId: this.params.id, status: decision.status, headers: decision.headers });
      connection.sendData({ channelId: this.params.id, kind: 'http.body' }, decision.body);
      connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      this.done();
      return;
    }

    const target = new URL(open.url, upstream);
    if (target.pathname === '/__gateway__/auth-check') {
      // 服务端选择页探测短路：放行即 204，不打 upstream（spec §3.1）
      connection.sendControl({ type: 'http.head', channelId: this.params.id, status: 204, headers: {} });
      connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      this.done();
      return;
    }

    const headers = stripHopByHop(normalizeHeaders(open.headers));
    delete headers['host']; // Host 由 Node 按 upstream URL 生成（Host 重写语义，已确认）

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, { method: open.method, headers }, (res) => this.onUpstreamResponse(res));
    req.on('error', (err) => this.onUpstreamError(err));
    this.req = req;

    // flush 暂存的 body 帧
    const pending = this.pending;
    this.pending = null;
    for (const chunk of pending ?? []) req.write(chunk);
    if (this.pendingEnd) req.end();
  }

  /** 网关侧请求体帧：upstream 未就绪先排队 */
  onBody(payload: Buffer): void {
    if (this.finished) return;
    if (this.pending) this.pending.push(payload);
    else this.req?.write(payload);
  }

  /** 网关侧请求体收尾（空体规则：必有此帧） */
  onBodyEnd(): void {
    if (this.finished) return;
    if (this.pending) this.pendingEnd = true;
    else this.req?.end();
  }

  /** 网关侧取消（浏览器断开等） */
  onPeerClose(_frame: ChannelCloseFrame): void {
    this.destroyUpstream();
    this.done();
  }

  /** 隧道断开 / Client close：本地中止 */
  abort(): void {
    this.destroyUpstream();
    this.done();
  }

  /** upstream 响应：回传 http.head 后分块流式回传 body，聚合背压下 pause/resume */
  private onUpstreamResponse(res: http.IncomingMessage): void {
    if (this.finished) return;
    const { connection } = this.params;
    const headers = stripHopByHop(normalizeHeaders(res.headers));
    connection.sendControl({ type: 'http.head', channelId: this.params.id, status: res.statusCode ?? 502, headers });
    this.headSent = true;
    res.on('data', (chunk: Buffer) => {
      if (this.finished) return;
      if (!connection.sendData({ channelId: this.params.id, kind: 'http.body' }, chunk)) {
        res.pause();
        void connection.waitDrain().then(() => res.resume());
      }
    });
    res.on('end', () => {
      if (this.finished) return;
      connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      this.done();
    });
    res.on('error', (err) => this.fail(`upstream 响应流错误: ${err.message}`));
  }

  /** upstream 请求错误：未回响应头 → 502；已回 → 通道级错误帧 */
  private onUpstreamError(err: Error): void {
    if (this.finished) return;
    if (!this.headSent) {
      this.params.logger.warn('upstream 不可达', { channelId: this.params.id, error: err.message });
      this.params.connection.sendControl({
        type: 'http.head', channelId: this.params.id, status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
      this.params.connection.sendData({ channelId: this.params.id, kind: 'http.body' }, Buffer.from(`bad gateway: ${err.message}`));
      this.params.connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
    } else {
      this.fail(`upstream 请求错误: ${err.message}`);
    }
    this.done();
  }

  /** 通道级异常：channel.error 帧 + 收尾 */
  private fail(message: string): void {
    if (this.finished) return;
    this.params.logger.error('HTTP 通道异常', { channelId: this.params.id, error: message });
    this.params.connection.sendControl({ type: 'channel.error', channelId: this.params.id, message });
    this.destroyUpstream();
    this.done();
  }

  private destroyUpstream(): void {
    this.req?.destroy();
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.params.onDone(this.params.id);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/http-channel.test.ts`
Expected: PASS（全部 8 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/http-channel.ts packages/client/src/http-channel.test.ts
git commit -m "feat: gateway-client HttpChannel（鉴权/auth-check 短路/流式桥接/背压）"
```

---

### Task 5: WsChannel（WS 通道桥接）

**Files:**
- Create: `packages/client/src/ws-channel.ts`
- Create: `packages/client/src/ws-channel.test.ts`

**Interfaces:**
- Consumes: 同 Task 4
- Produces:
  - `WsChannelParams { id: number; open: WsOpenFrame; upstream: URL; connection: Connection; authorize: (req: AuthRequest) => Promise<AuthDecision>; logger: Logger; onDone: (id: number) => void }`
  - `class WsChannel`：`start(): Promise<void>`、`onMessage(dataType: 'text' | 'binary', payload: Buffer): void`、`onPeerClose(frame: ChannelCloseFrame): void`、`abort(): void`

- [ ] **Step 1: 写失败的测试**

`packages/client/src/ws-channel.test.ts`：

```ts
import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { WsChannel } from './ws-channel';
import type { Connection } from './connection';
import type { AuthDecision } from './authorize';
import type { ControlFrame, DataHeader, WsOpenFrame } from './protocol';

const nullLogger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as import('./logger').Logger;

class FakeConnection {
  controls: ControlFrame[] = [];
  data: { header: DataHeader; payload: Buffer }[] = [];
  sendControl(frame: ControlFrame): void { this.controls.push(frame); }
  sendData(header: DataHeader, payload: Buffer): boolean { this.data.push({ header, payload }); return true; }
  waitDrain(): Promise<void> { return Promise.resolve(); }
  asConnection(): Connection { return this as unknown as Connection; }
}

const ALLOW = async (): Promise<AuthDecision> => ({ allowed: true, status: 200, headers: {}, body: Buffer.alloc(0) });

function makeOpen(overrides: Partial<WsOpenFrame> = {}): WsOpenFrame {
  return { type: 'ws.open', channelId: 1, url: '/ws', headers: {}, protocols: ['chat'], ...overrides };
}

/** upstream ws echo server：可选选定子协议；记录连接数 */
function startUpstreamEcho(selectProtocol?: string): Promise<{ wss: WebSocketServer; url: URL; conns: number }> {
  const state = { conns: 0 };
  const wss = new WebSocketServer({
    port: 0,
    handleProtocols: selectProtocol ? (protocols) => (protocols.has(selectProtocol) ? selectProtocol : false) : undefined,
  });
  wss.on('connection', (ws) => {
    state.conns += 1;
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      const addr = wss.address();
      if (typeof addr === 'object' && addr) resolve({ wss, url: new URL(`http://127.0.0.1:${addr.port}`), conns: state.conns, ...state });
    });
  });
}

let cleanup: WebSocketServer | null = null;
afterEach(async () => { await new Promise<void>((r) => { cleanup?.close(() => r()); if (!cleanup) r(); }); cleanup = null; });

describe('WsChannel', () => {
  it('握手成功：回 ws.accept 且回选子协议透传', async () => {
    const up = await startUpstreamEcho('chat');
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.controls.find((f) => f.type === 'ws.accept')).toMatchObject({ type: 'ws.accept', protocol: 'chat' });
  });

  it('文本与二进制消息双向保真（echo）', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen({ protocols: [] }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    await new Promise((r) => setTimeout(r, 50));
    ch.onMessage('text', Buffer.from('hi'));
    ch.onMessage('binary', Buffer.from([0x01, 0x02]));
    await new Promise((r) => setTimeout(r, 50));
    const kinds = conn.data.map((d) => d.header.dataType);
    expect(kinds).toEqual(['text', 'binary']);
    expect(conn.data[0]?.payload.toString()).toBe('hi');
    expect(conn.data[1]?.payload).toEqual(Buffer.from([0x01, 0x02]));
  });

  it('鉴权拒绝：ws.reject 携带自定义状态与文本 body，不打 upstream', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const deny = async (): Promise<AuthDecision> => ({ allowed: false, status: 403, headers: {}, body: Buffer.from('denied') });
    const ch = new WsChannel({ id: 1, open: makeOpen(), upstream: up.url, connection: conn.asConnection(), authorize: deny, logger: nullLogger, onDone: () => {} });
    await ch.start();
    expect(conn.controls[0]).toMatchObject({ type: 'ws.reject', status: 403, body: 'denied' });
    expect(up.conns).toBe(0);
  });

  it('upstream 拒绝握手（子协议不匹配）→ ws.reject 502', async () => {
    const up = await startUpstreamEcho('only-this');
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen({ protocols: ['other'] }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.controls.find((f) => f.type === 'ws.reject')).toMatchObject({ status: 502 });
  });

  it('upstream 主动关闭：channel.close 携带 code/reason 回网关', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen({ protocols: [] }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    await ch.start();
    await new Promise((r) => setTimeout(r, 50));
    for (const ws of up.wss.clients) ws.close(1001, 'going away');
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.controls.find((f) => f.type === 'channel.close')).toMatchObject({ type: 'channel.close', code: 1001 });
  });

  it('握手完成前到达的 ws.message 排队，accept 后按序 flush', async () => {
    const up = await startUpstreamEcho();
    cleanup = up.wss;
    const conn = new FakeConnection();
    const ch = new WsChannel({ id: 1, open: makeOpen({ protocols: [] }), upstream: up.url, connection: conn.asConnection(), authorize: ALLOW, logger: nullLogger, onDone: () => {} });
    void ch.start(); // 不等待：模拟消息先于 accept 到达
    ch.onMessage('text', Buffer.from('early'));
    await new Promise((r) => setTimeout(r, 80));
    expect(conn.data[0]?.payload.toString()).toBe('early');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/ws-channel.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ws-channel.ts**

`packages/client/src/ws-channel.ts`：

```ts
/**
 * WS 通道 — 隧道 ws.message 帧 ↔ upstream ws 连接的双向透传。
 * 生命周期（spec §5.2）：握手时鉴权一次；upstream scheme 由 upstreamUrl 推导（http→ws，https→wss）；
 * 关闭码/原因双向透传；ws.reject 的 body 仅文本（控制帧无二进制体）。
 * 注意：握手协议头（sec-websocket-key/version/extensions）由 ws 库自行生成，转发会破坏握手，必须剔除。
 */

import WebSocket from 'ws';
import { buildAuthRequest, type AuthDecision, type AuthRequest } from './authorize';
import type { Connection } from './connection';
import type { Logger } from './logger';
import { normalizeHeaders, stripHopByHop, type ChannelCloseFrame, type WsOpenFrame } from './protocol';

export interface WsChannelParams {
  id: number;
  open: WsOpenFrame;
  upstream: URL;
  connection: Connection;
  authorize: (req: AuthRequest) => Promise<AuthDecision>;
  logger: Logger;
  onDone: (id: number) => void;
}

/** ws RawData 统一转 Buffer */
function toBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class WsChannel {
  private upstream: WebSocket | null = null;
  /** upstream 握手完成前到达的浏览器消息暂存；accept 后置 null 直发 */
  private pending: Array<{ dataType: 'text' | 'binary'; payload: Buffer }> | null = [];
  private accepted = false;
  private finished = false;

  constructor(private readonly params: WsChannelParams) {}

  /** 入口：握手鉴权 → 连 upstream ws。只调用一次 */
  async start(): Promise<void> {
    const { open, authorize, connection, upstream } = this.params;
    const decision = await authorize(buildAuthRequest(open, true));
    if (this.finished) return;

    if (!decision.allowed) {
      // 鉴权拒绝：body 转文本（ws.reject 无二进制体），服务端原样回浏览器
      connection.sendControl({
        type: 'ws.reject', channelId: this.params.id,
        status: decision.status, headers: decision.headers, body: decision.body.toString('utf8'),
      });
      this.done();
      return;
    }

    const wsBase = new URL(upstream);
    wsBase.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
    const target = new URL(open.url, wsBase);

    const headers = stripHopByHop(normalizeHeaders(open.headers));
    delete headers['host'];
    delete headers['sec-websocket-key'];
    delete headers['sec-websocket-version'];
    delete headers['sec-websocket-extensions'];

    const ws = new WebSocket(target, open.protocols, { headers });
    this.upstream = ws;

    ws.on('open', () => {
      if (this.finished) return;
      this.accepted = true;
      // 回选子协议透传（服务端校验其属于 ws.open.protocols，不符断通道）
      connection.sendControl({ type: 'ws.accept', channelId: this.params.id, protocol: ws.protocol || undefined });
      const pending = this.pending;
      this.pending = null;
      for (const m of pending ?? []) ws.send(m.payload, { binary: m.dataType === 'binary' });
    });

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.finished) return;
      const ok = connection.sendData(
        { channelId: this.params.id, kind: 'ws.message', dataType: isBinary ? 'binary' : 'text' },
        toBuffer(data),
      );
      if (!ok) {
        ws.pause();
        void connection.waitDrain().then(() => ws.resume());
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      // upstream 主动关闭 → 客户端→网关方向的 channel.close（双向语义，第三轮修订）
      if (!this.finished) {
        connection.sendControl({ type: 'channel.close', channelId: this.params.id, code, reason: reason.toString() });
      }
      this.done();
    });

    ws.on('error', (err: Error) => {
      if (this.finished) return;
      if (!this.accepted) {
        // 握手失败（含 unexpected-response）：统一 502
        this.params.logger.warn('upstream ws 握手失败', { channelId: this.params.id, error: err.message });
        connection.sendControl({ type: 'ws.reject', channelId: this.params.id, status: 502, body: 'bad gateway' });
      } else {
        this.params.logger.error('WS 通道异常', { channelId: this.params.id, error: err.stack ?? err.message });
        connection.sendControl({ type: 'channel.error', channelId: this.params.id, message: err.message });
      }
      this.done();
    });
  }

  /** 网关侧浏览器消息：upstream 未就绪先排队 */
  onMessage(dataType: 'text' | 'binary', payload: Buffer): void {
    if (this.finished) return;
    if (this.pending) this.pending.push({ dataType, payload });
    else this.upstream?.send(payload, { binary: dataType === 'binary' });
  }

  /** 网关侧关闭：同码透传给 upstream */
  onPeerClose(frame: ChannelCloseFrame): void {
    if (this.finished) return;
    this.upstream?.close(frame.code ?? 1000, frame.reason);
    this.done();
  }

  /** 隧道断开 / Client close：本地中止 */
  abort(): void {
    this.upstream?.terminate();
    this.done();
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.params.onDone(this.params.id);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/ws-channel.test.ts`
Expected: PASS（全部 6 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/ws-channel.ts packages/client/src/ws-channel.test.ts
git commit -m "feat: gateway-client WsChannel（握手鉴权/双向透传/关闭码透传）"
```

---

### Task 6: Client 主类与包入口

**Files:**
- Create: `packages/client/src/client.ts`
- Create: `packages/client/src/index.ts`
- Create: `packages/client/src/client.test.ts`

**Interfaces:**
- Consumes: 全部前序任务
- Produces（包公共 API）：
  - `ClientOptions { upstreamUrl: string; gatewayUrl: string; hostname: string; token?: string; defaultPath?: string; authorization?: AuthorizationHook; reconnect?: Partial<ReconnectOptions>; heartbeatIntervalMs?: number; authTimeoutMs?: number; connectTimeoutMs?: number; logger?: Logger }`
  - `class Client extends EventEmitter`：`connect(): Promise<void>`、`close(): Promise<void>`；事件 `'connected' | 'disconnected' | 'error'`
  - `index.ts` 导出：`Client`、`ClientOptions`、`AuthorizationHook`、`AuthRequest`、`AuthResponse`、`Logger`、`createConsoleLogger`、`ProtocolError`

- [ ] **Step 1: 写失败的测试**

`packages/client/src/client.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import { Client } from './client';
import { decodeControl, encodeControl, type ControlFrame } from './protocol';

/** 最小模拟网关：ack hello、记录帧、可主动发 open */
class MiniGateway {
  wss = new WebSocketServer({ port: 0 });
  ws: WsWebSocket | null = null;
  received: ControlFrame[] = [];
  constructor() {
    this.wss.on('connection', (ws) => {
      this.ws = ws;
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const frame = decodeControl(String(data));
        this.received.push(frame);
        if (frame.type === 'hello') ws.send(encodeControl({ type: 'hello.ack' }));
        if (frame.type === 'ping') ws.send(encodeControl({ type: 'pong' }));
      });
    });
  }
  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string') throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }
  send(frame: ControlFrame): void { this.ws?.send(encodeControl(frame)); }
  async close(): Promise<void> {
    this.ws?.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const BASE = { hostname: 'pc-a', heartbeatIntervalMs: 10_000, connectTimeoutMs: 2000 };

describe('Client 配置校验（进程级错误）', () => {
  it('缺 upstreamUrl / gatewayUrl / hostname → 构造即抛错', () => {
    expect(() => new Client({ ...BASE, upstreamUrl: '', gatewayUrl: 'ws://x' } as never)).toThrow(/upstreamUrl/);
    expect(() => new Client({ ...BASE, upstreamUrl: 'http://x', gatewayUrl: '' } as never)).toThrow(/gatewayUrl/);
    expect(() => new Client({ upstreamUrl: 'http://x', gatewayUrl: 'ws://x', hostname: '' })).toThrow(/hostname/);
  });

  it('URL 非法 → 抛错', () => {
    expect(() => new Client({ upstreamUrl: 'not-a-url', gatewayUrl: 'ws://x', hostname: 'a' })).toThrow();
    expect(() => new Client({ upstreamUrl: 'http://x', gatewayUrl: 'http://x', hostname: 'a' })).toThrow(/ws/);
  });
});

describe('Client 生命周期与帧路由', () => {
  it('connect 后网关收到 hello（hostname + defaultPath 默认值）', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    expect(gw.received[0]).toEqual({ type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } });
    await client.close();
    await gw.close();
  });

  it('closing 后收到新 open → 回 channel.error 且不建通道', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    const closing = client.close();
    gw.send({ type: 'http.open', channelId: 9, method: 'GET', url: '/', headers: {} });
    await closing;
    await new Promise((r) => setTimeout(r, 30));
    expect(gw.received.some((f) => f.type === 'channel.error' && f.channelId === 9)).toBe(true);
    await gw.close();
  });

  it('未知 channelId 的数据帧被丢弃不抛错', async () => {
    const gw = new MiniGateway();
    const client = new Client({ ...BASE, upstreamUrl: 'http://127.0.0.1:1', gatewayUrl: gw.url });
    client.on('error', () => {});
    await client.connect();
    gw.send({ type: 'channel.close', channelId: 999 });
    await new Promise((r) => setTimeout(r, 30));
    await client.close();
    await gw.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/client.test.ts`
Expected: FAIL（`./client` 模块不存在）

- [ ] **Step 3: 实现 client.ts 与 index.ts**

`packages/client/src/client.ts`：

```ts
/**
 * Client 主类 — 装配 Connection 与通道表，对外暴露生命周期与事件。
 * 公开 API 语义见 spec §3；配置非法 = 进程级错误，构造即抛错。
 * 注意：EventEmitter 语义下 'error' 事件必须挂监听，调用方未挂时由 CLI 兜底（见 cli.ts）。
 */

import { EventEmitter } from 'node:events';
import { runAuthorization, type AuthDecision, type AuthorizationHook, type AuthRequest } from './authorize';
import { Connection, type ReconnectOptions } from './connection';
import { HttpChannel } from './http-channel';
import { createDefaultLogger, type Logger } from './logger';
import type { ChannelErrorFrame, ControlFrame, DataHeader } from './protocol';
import { WsChannel } from './ws-channel';

export interface ClientOptions {
  /** 应用服务地址（http/https） */
  upstreamUrl: string;
  /** 网关隧道端点（ws/wss） */
  gatewayUrl: string;
  /** 选择页展示名与路由标识（全网关内唯一） */
  hostname: string;
  /** 本机接入令牌：配置后未提供 authorization 时启用内置 Bearer 校验 */
  token?: string;
  /** 用户选择成功后浏览器跳转路径，默认 '/' */
  defaultPath?: string;
  /** Express 中间件风格鉴权钩子；选择页探测（/__gateway__/auth-check）也走此钩子 */
  authorization?: AuthorizationHook;
  reconnect?: Partial<ReconnectOptions>;
  heartbeatIntervalMs?: number;
  authTimeoutMs?: number;
  connectTimeoutMs?: number;
  logger?: Logger;
}

type AnyChannel = HttpChannel | WsChannel;

export class Client extends EventEmitter {
  private readonly connection: Connection;
  private readonly channels = new Map<number, AnyChannel>();
  private readonly upstream: URL;
  private readonly authorize: (req: AuthRequest) => Promise<AuthDecision>;
  private readonly logger: Logger;
  private closing = false;

  constructor(options: ClientOptions) {
    super();
    // 配置非法 = 进程级错误（spec §7）：构造即抛错
    if (!options.upstreamUrl) throw new Error('ClientOptions.upstreamUrl 必填');
    if (!options.gatewayUrl) throw new Error('ClientOptions.gatewayUrl 必填');
    if (!options.hostname) throw new Error('ClientOptions.hostname 必填');
    this.upstream = new URL(options.upstreamUrl);
    if (this.upstream.protocol !== 'http:' && this.upstream.protocol !== 'https:') {
      throw new Error('ClientOptions.upstreamUrl 必须是 http/https');
    }
    const gateway = new URL(options.gatewayUrl);
    if (gateway.protocol !== 'ws:' && gateway.protocol !== 'wss:') {
      throw new Error('ClientOptions.gatewayUrl 必须是 ws/wss');
    }

    this.logger = options.logger ?? createDefaultLogger();
    const authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.authorize = (req) => runAuthorization(options.authorization, req, { token: options.token, timeoutMs: authTimeoutMs });

    this.connection = new Connection(
      {
        gatewayUrl: options.gatewayUrl,
        hello: { hostname: options.hostname, defaultPath: options.defaultPath ?? '/' },
        heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
        connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
        reconnect: {
          baseDelayMs: options.reconnect?.baseDelayMs ?? 1000,
          maxDelayMs: options.reconnect?.maxDelayMs ?? 30_000,
          maxRetries: options.reconnect?.maxRetries ?? Infinity,
        },
        logger: this.logger,
      },
      {
        onControl: (frame) => this.onControl(frame),
        onData: (header, payload) => this.onData(header, payload),
        onDisconnected: () => this.abortAllChannels(),
      },
    );
    this.connection.on('error', (err: Error) => {
      this.logger.error('隧道连接错误', { error: err.stack ?? err.message });
      this.emit('error', err);
    });
    this.connection.on('connected', () => this.emit('connected'));
    this.connection.on('disconnected', () => this.emit('disconnected'));
  }

  /** 建立隧道（首连失败内部退避重试，connectTimeoutMs/4409 才 reject） */
  connect(): Promise<void> {
    return this.connection.connect();
  }

  /** 优雅关闭：拒收新 open → 关隧道（服务端随即注销 hostname）→ 中止在途通道 */
  async close(): Promise<void> {
    this.closing = true;
    await this.connection.close();
    this.abortAllChannels();
  }

  /** 控制帧路由：hello.ack/ping/pong 已被 Connection 消化 */
  private onControl(frame: ControlFrame): void {
    switch (frame.type) {
      case 'http.open': {
        this.openHttp(frame);
        break;
      }
      case 'ws.open': {
        this.openWs(frame);
        break;
      }
      case 'channel.close': {
        this.channels.get(frame.channelId)?.onPeerClose(frame);
        break;
      }
      case 'channel.error': {
        this.channels.get(frame.channelId)?.abort();
        break;
      }
      default: {
        // http.head/ws.accept/hello 等客户端不应收到的帧：协议级异常由 Connection 判不了类型合法性，记 WARN 丢弃
        this.logger.warn('收到未预期控制帧，丢弃', { type: frame.type });
      }
    }
  }

  /** 数据帧路由：未知 channelId 丢弃（对端已关闭的迟到帧属正常竞态） */
  private onData(header: DataHeader, payload: Buffer): void {
    const channel = this.channels.get(header.channelId);
    if (!channel) {
      this.logger.debug('未知通道数据帧，丢弃', { channelId: header.channelId, kind: header.kind });
      return;
    }
    if (header.kind === 'http.body' && channel instanceof HttpChannel) channel.onBody(payload);
    else if (header.kind === 'http.body.end' && channel instanceof HttpChannel) channel.onBodyEnd();
    else if (header.kind === 'ws.message' && channel instanceof WsChannel) channel.onMessage(header.dataType ?? 'binary', payload);
    else this.logger.warn('数据帧与通道类型不匹配', { channelId: header.channelId, kind: header.kind });
  }

  private openHttp(frame: Extract<ControlFrame, { type: 'http.open' }>): void {
    if (this.closing) {
      this.connection.sendControl({ type: 'channel.error', channelId: frame.channelId, message: 'client closing' });
      return;
    }
    const channel = new HttpChannel({
      id: frame.channelId, open: frame, upstream: this.upstream,
      connection: this.connection, authorize: this.authorize, logger: this.logger,
      onDone: (id) => this.channels.delete(id),
    });
    this.channels.set(frame.channelId, channel);
    void channel.start().catch((err: unknown) => {
      this.logger.error('HTTP 通道启动异常', { channelId: frame.channelId, error: err instanceof Error ? err.stack : String(err) });
      channel.abort();
    });
  }

  private openWs(frame: Extract<ControlFrame, { type: 'ws.open' }>): void {
    if (this.closing) {
      this.connection.sendControl({ type: 'channel.error', channelId: frame.channelId, message: 'client closing' });
      return;
    }
    const channel = new WsChannel({
      id: frame.channelId, open: frame, upstream: this.upstream,
      connection: this.connection, authorize: this.authorize, logger: this.logger,
      onDone: (id) => this.channels.delete(id),
    });
    this.channels.set(frame.channelId, channel);
    void channel.start().catch((err: unknown) => {
      this.logger.error('WS 通道启动异常', { channelId: frame.channelId, error: err instanceof Error ? err.stack : String(err) });
      channel.abort();
    });
  }

  /** 中止全部在途通道（隧道断开/close 时调用） */
  private abortAllChannels(): void {
    const all = [...this.channels.values()];
    this.channels.clear();
    for (const channel of all) channel.abort();
  }
}

// ChannelErrorFrame 仅用于类型完备性（onControl switch 内联收窄）
export type { ChannelErrorFrame };
```

`packages/client/src/index.ts`：

```ts
/**
 * gateway-client 包入口。
 * 用法见 spec §3：new Client({ upstreamUrl, gatewayUrl, hostname, token?, defaultPath?, authorization? })
 */

export { Client, type ClientOptions } from './client';
export type { AuthRequest, AuthResponse, AuthorizationHook, AuthDecision } from './authorize';
export { ProtocolError } from './protocol';
export { createConsoleLogger, createDefaultLogger, type Logger, type LogLevel } from './logger';
```

> 注意：`client.ts` 里 `ChannelErrorFrame` 的 re-export 若被 `noUnusedLocals` 拦截，直接删除该行与 import——switch 的 inline 收窄已够用。执行时以 `tsc --noEmit` 结果为准。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/client.test.ts`
Expected: PASS（全部 5 个用例）

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/client.ts packages/client/src/index.ts packages/client/src/client.test.ts
git commit -m "feat: gateway-client Client 主类与包入口"
```

---

### Task 7: CLI（配置文件加载 + 信号处理 + bin 启动器）

**Files:**
- Create: `packages/client/src/cli.ts`
- Create: `packages/client/src/cli.test.ts`
- Create: `packages/client/bin/harness-client.mjs`

**Interfaces:**
- Consumes: `Client`、`ClientOptions`（Task 6）
- Produces:
  - `parseArgs(argv: string[]): { config: string; help: boolean }`（`--config <path>` 默认 `./client.config.mjs`，`--help`）
  - `loadConfig(configPath: string): Promise<ClientOptions>`
  - `main(argv: string[]): Promise<number>`（返回退出码；仅入口守卫处 `process.exit`）

- [ ] **Step 1: 写失败的测试**

`packages/client/src/cli.test.ts`：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, main, parseArgs } from './cli';

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

async function writeConfig(content: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'gw-client-'));
  const file = join(dir, 'client.config.mjs');
  await writeFile(file, content);
  return file;
}

describe('parseArgs', () => {
  it('默认 config 路径 ./client.config.mjs', () => {
    expect(parseArgs([]).config).toBe('./client.config.mjs');
  });
  it('--config 指定路径', () => {
    expect(parseArgs(['--config', '/tmp/c.mjs']).config).toBe('/tmp/c.mjs');
  });
  it('未知参数抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });
});

describe('loadConfig', () => {
  it('加载 export default 对象', async () => {
    const file = await writeConfig('export default { upstreamUrl: "http://x", gatewayUrl: "ws://y", hostname: "a" }');
    const cfg = await loadConfig(file);
    expect(cfg.hostname).toBe('a');
  });
  it('无 default 导出 → 抛错', async () => {
    const file = await writeConfig('export const x = 1');
    await expect(loadConfig(file)).rejects.toThrow(/export default/);
  });
});

describe('main 退出码', () => {
  it('--help → 0', async () => {
    expect(await main(['--help'])).toBe(0);
  });
  it('配置文件不存在 → 1', async () => {
    expect(await main(['--config', join(tmpdir(), 'no-such-file.mjs')])).toBe(1);
  });
  it('配置非法（缺 hostname）→ 1', async () => {
    const file = await writeConfig('export default { upstreamUrl: "http://x", gatewayUrl: "ws://y" }');
    expect(await main(['--config', file])).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/cli.test.ts`
Expected: FAIL（`./cli` 模块不存在）

- [ ] **Step 3: 实现 cli.ts 与 bin 启动器**

`packages/client/src/cli.ts`：

```ts
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
    console.error('[harness-client] 加载配置失败', err);
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
  console.info(`[harness-client] 隧道就绪 hostname=${options.hostname} gateway=${options.gatewayUrl}`);
  return 0; // 进程由活跃隧道连接保活
}

// 入口守卫：仅直接执行时运行（测试 import 不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}
```

`packages/client/bin/harness-client.mjs`：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/cli.test.ts`
Expected: PASS（全部 7 个用例）

- [ ] **Step 5: 手动验证 bin 可用**

Run: `pnpm --filter gateway-client exec node bin/harness-client.mjs --help`
Expected: 输出用法行，退出码 0

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/cli.ts packages/client/src/cli.test.ts packages/client/bin/harness-client.mjs
git commit -m "feat: gateway-client CLI（配置加载/信号处理/tsx bin 启动器）"
```

---

### Task 8: 端到端集成（模拟网关全链路）+ 全量检查

**Files:**
- Create: `packages/client/src/test-utils/mock-gateway.ts`
- Create: `packages/client/src/e2e.test.ts`

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 无新公共 API（测试辅助 `MockGateway` 仅供本包测试）

- [ ] **Step 1: 实现 MockGateway 测试辅助**

`packages/client/src/test-utils/mock-gateway.ts`：

```ts
/**
 * 内存模拟网关 — 讲隧道协议的 ws 服务端，供 e2e 测试驱动客户端。
 * 提供 request()/wsOpen() 两个浏览器侧模拟入口；autoAck 控制 hello 应答。
 */

import { WebSocketServer, type WebSocket } from 'ws';
import {
  decodeControl, decodeData, encodeControl, encodeData,
  type ControlFrame, type DataHeader, type HeadersJson,
} from '../protocol';

export interface TunnelResponse {
  status: number;
  headers: HeadersJson;
  body: Buffer;
}

export class MockGateway {
  private wss = new WebSocketServer({ port: 0 });
  private ws: WebSocket | null = null;
  private nextChannelId = 1;
  private pending = new Map<number, { resolve: (r: TunnelResponse) => void; chunks: Buffer[]; head?: { status: number; headers: HeadersJson } }>();
  private wsPending = new Map<number, { resolve: (v: { accepted: boolean; status?: number; body?: string }) => void }>();
  connectionCount = 0;

  constructor() {
    this.wss.on('connection', (ws) => {
      this.connectionCount += 1;
      this.ws = ws;
      ws.on('message', (raw, isBinary) => this.onMessage(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), isBinary));
      ws.on('close', () => { if (this.ws === ws) this.ws = null; });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}/__gateway__/tunnel`;
  }

  private onMessage(buf: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      const frame = decodeControl(buf.toString('utf8'));
      if (frame.type === 'hello') this.ws?.send(encodeControl({ type: 'hello.ack' }));
      else if (frame.type === 'ping') this.ws?.send(encodeControl({ type: 'pong' }));
      else if (frame.type === 'http.head') {
        const p = this.pending.get(frame.channelId);
        if (p) p.head = { status: frame.status, headers: frame.headers };
      } else if (frame.type === 'ws.accept') {
        this.wsPending.get(frame.channelId)?.resolve({ accepted: true });
        this.wsPending.delete(frame.channelId);
      } else if (frame.type === 'ws.reject') {
        this.wsPending.get(frame.channelId)?.resolve({ accepted: false, status: frame.status, body: frame.body });
        this.wsPending.delete(frame.channelId);
      }
      return;
    }
    const { header, payload } = decodeData(buf);
    const p = this.pending.get(header.channelId);
    if (!p) return;
    if (header.kind === 'http.body') p.chunks.push(payload);
    if (header.kind === 'http.body.end' && p.head) {
      this.pending.delete(header.channelId);
      p.resolve({ status: p.head.status, headers: p.head.headers, body: Buffer.concat(p.chunks) });
    }
  }

  /** 模拟浏览器 HTTP 请求：发 http.open + body，等客户端回完整响应 */
  request(method: string, url: string, headers: HeadersJson, body?: Buffer): Promise<TunnelResponse> {
    const channelId = this.nextChannelId++;
    return new Promise((resolve, reject) => {
      if (!this.ws) { reject(new Error('no tunnel')); return; }
      this.pending.set(channelId, { resolve, chunks: [] });
      this.ws.send(encodeControl({ type: 'http.open', channelId, method, url, headers }));
      if (body) this.ws.send(encodeData({ channelId, kind: 'http.body' }, body));
      this.ws.send(encodeData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0)));
    });
  }

  /** 模拟浏览器 WS 握手：发 ws.open，等 accept/reject */
  wsOpen(url: string, headers: HeadersJson, protocols: string[] = []): Promise<{ accepted: boolean; status?: number; body?: string }> {
    const channelId = this.nextChannelId++;
    return new Promise((resolve, reject) => {
      if (!this.ws) { reject(new Error('no tunnel')); return; }
      this.wsPending.set(channelId, { resolve });
      this.ws.send(encodeControl({ type: 'ws.open', channelId, url, headers, protocols }));
    });
  }

  /** 对当前连接上指定通道发一条 ws.message（仅 echo 场景用） */
  sendWsMessage(channelId: number, dataType: 'text' | 'binary', payload: Buffer): void {
    this.ws?.send(encodeData({ channelId, kind: 'ws.message', dataType }, payload));
  }

  /** 断开隧道（模拟网关宕机/断线） */
  drop(): void {
    this.ws?.terminate();
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
```

- [ ] **Step 2: 写 e2e 测试并确认失败（先失败在断言层面亦可）**

`packages/client/src/e2e.test.ts`：

```ts
import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from './client';
import { MockGateway } from './test-utils/mock-gateway';

let gateway: MockGateway;
let upstream: Server;
let upstreamUrl: string;
let upstreamHits: { url: string; authorization?: string | string[] }[];
let wss: WebSocketServer;

beforeEach(async () => {
  upstreamHits = [];
  upstream = createServer((req, res) => {
    upstreamHits.push({ url: req.url ?? '', authorization: req.headers.authorization });
    if (req.url === '/sse') {
      // SSE 流式：分 3 块间隔写出
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: 1\n\n');
      setTimeout(() => res.write('data: 2\n\n'), 30);
      setTimeout(() => { res.write('data: 3\n\n'); res.end(); }, 60);
      return;
    }
    if (req.url === '/multi-cookie') {
      res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    req.pipe(res); // echo 请求体
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  if (typeof addr === 'string' || !addr) throw new Error('no addr');
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws) => ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary })));
  await new Promise<void>((r) => wss.on('listening', r));
  gateway = new MockGateway();
});

afterEach(async () => {
  await gateway.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => wss.close(() => r()));
});

async function makeClient(extra: Record<string, unknown> = {}): Promise<Client> {
  const client = new Client({
    upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a', token: 't1',
    heartbeatIntervalMs: 50, connectTimeoutMs: 2000,
    reconnect: { baseDelayMs: 20, maxDelayMs: 60, maxRetries: Infinity },
    ...extra,
  });
  client.on('error', () => {});
  await client.connect();
  return client;
}

describe('e2e：隧道全链路', () => {
  it('HTTP GET：Bearer 注入到达 upstream，响应回传', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/api/x', { authorization: 'Bearer t1' });
    expect(res.status).toBe(200);
    expect(upstreamHits[0]?.authorization).toBe('Bearer t1');
    await client.close();
  });

  it('SSE 流式：响应分块到达', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/sse', { authorization: 'Bearer t1' });
    expect(res.body.toString()).toBe('data: 1\n\ndata: 2\n\ndata: 3\n\n');
    await client.close();
  });

  it('多 Set-Cookie 透传', async () => {
    const client = await makeClient();
    const res = await gateway.request('GET', '/multi-cookie', { authorization: 'Bearer t1' });
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    await client.close();
  });

  it('auth-check 探测：Bearer 对 → 204 且不打 upstream；错 → 403', async () => {
    const client = await makeClient();
    const ok = await gateway.request('GET', '/__gateway__/auth-check', { authorization: 'Bearer t1' });
    expect(ok.status).toBe(204);
    expect(upstreamHits).toHaveLength(0);
    const bad = await gateway.request('GET', '/__gateway__/auth-check', { authorization: 'Bearer wrong' });
    expect(bad.status).toBe(403);
    expect(upstreamHits).toHaveLength(0);
    await client.close();
  });

  it('WS echo：text 与 binary 保真', async () => {
    const wsPort = (wss.address() as { port: number }).port;
    const client = await makeClient({ upstreamUrl: `http://127.0.0.1:${wsPort}` });
    const opened = await gateway.wsOpen('/socket', { authorization: 'Bearer t1' });
    expect(opened.accepted).toBe(true);
    await client.close();
  });

  it('WS 鉴权拒绝：ws.reject 状态透传', async () => {
    const wsPort = (wss.address() as { port: number }).port;
    const client = await makeClient({ upstreamUrl: `http://127.0.0.1:${wsPort}` });
    const opened = await gateway.wsOpen('/socket', { authorization: 'Bearer wrong' });
    expect(opened).toMatchObject({ accepted: false, status: 403 });
    await client.close();
  });

  it('隧道断开重连：重连后新请求恢复可用', async () => {
    const client = await makeClient();
    gateway.drop();
    await new Promise<void>((r) => client.once('connected', r)); // 等自动重连
    const res = await gateway.request('GET', '/api/after', { authorization: 'Bearer t1' });
    expect(res.status).toBe(200);
    expect(upstreamHits.at(-1)?.url).toBe('/api/after');
    await client.close();
  });
});
```

> 注：WS echo 用例把 `upstreamUrl` 指到 ws echo server；`wsOpen` 只断言握手层（accept/reject），消息级保真已由 Task 5 单测覆盖。

- [ ] **Step 3: 运行 e2e 确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/e2e.test.ts`
Expected: PASS（全部 7 个用例）

- [ ] **Step 4: 全量测试**

Run: `pnpm --filter gateway-client test`
Expected: 全部测试文件 PASS

- [ ] **Step 5: 类型检查与格式化（根 CLAUDE.md 约定顺序：typecheck → format → 修复所有错误）**

Run: `pnpm --filter gateway-client typecheck`
Expected: 无错误；有错误则修复后重跑

Run: `pnpm --filter gateway-client format`
Expected: eslint --fix 无剩余错误；格式化产生的变更随本任务提交

- [ ] **Step 6: Commit**

```bash
git add packages/client
git commit -m "test: gateway-client 端到端集成测试（模拟网关全链路 + 重连）"
```

---

## Self-Review 记录（计划落盘前已执行）

- **Spec 覆盖**：帧协议（§4）→Task 1；authorization 语义（§3.1）→Task 2；连接管理（§6）→Task 3；HTTP 转发（§5.1）→Task 4；WS 转发（§5.2）→Task 5；公开 API/生命周期（§3）→Task 6；CLI（§10）→Task 7；测试计划（§9）各节→Tasks 1-8；错误分级（§7）→分散在各通道/连接任务并在 Global Constraints 重申
- **类型一致性**：`AuthDecision/AuthRequest/AuthResponse`（Task 2 定义）在 Tasks 4-6 引用一致；`ConnectionHandlers.onControl` 不上抛 hello.ack/ping/pong 在 Task 3 与 Task 6 的 switch default 注释一致；`onDone(id)` 回调签名 Tasks 4/5/6 一致
- **已知取舍**：`client.ts` 末尾的 `ChannelErrorFrame` re-export 标注了以 tsc 结果为准的处理方式；WS 消息级 e2e 保真由 Task 5 单测承担，e2e 只测握手层
