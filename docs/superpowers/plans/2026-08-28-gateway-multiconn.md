# 隧道多连接（帧级条带化 + 每通道重排序）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端出站建立 N 条隧道 WS（默认 4）组成隧道组，通道帧条带化分发、接收端按 (channelId, 方向) 重排序，老服务端自动降级单连接。

**Architecture:** primary leg 正常 hello 声明 `multiConn.count`；协商成功后其余 leg 以 `attach: true` + 回带 tunnelId 入组。通道级帧（控制+数据）携带 per-(channelId, 方向) seq；发送端按 leg 可用容量加权选路；接收端 Resequencer 重排序后交给**现有零改动**的通道层。任一已就绪 leg 断 = 整组 teardown + 重连。

**Tech Stack:** Node.js 20+ / TypeScript（ESM 源码直出，tsx 运行）/ ws / vitest / pnpm。

**Spec:** `docs/superpowers/specs/2026-08-28-gateway-multiconn-design.md`（协议语义以 spec 为准，本计划是其任务化展开）

## Global Constraints

- 双端 `protocol.ts` 互为镜像，任何改动必须双向同步（文件头注释的既有约定）。
- 运行时依赖只用 `ws`；不新增任何依赖（devDep 仅 Task 10 的 workspace 内引用）。
- 仅用 pnpm 安装/运行（本仓库禁 npm/yarn）；无构建步骤。
- 日志安全红线：hello 帧与数据帧内容（可含 token/authorization）禁止进日志，只记 hostname/tunnelId/channelId/错误摘要。
- 注释与提交信息沿用仓库中文惯例；提交信息为中文 conventional commits。
- 每任务收尾：`pnpm typecheck` 全绿 + 本包 `pnpm test` 全绿后才 commit。
- 断连语义红线：任一已就绪 leg 断 = 整组 teardown；不做跨连接断点续传（spec §4.4）。
- 兼容红线：attach 只在 primary 协商成功后发起；`connections: 1` 走纯 legacy 路径（连 `multiConn` 都不声明）。

---

### Task 1: 协议扩展（双端镜像）

**Files:**
- Modify: `packages/client/src/protocol.ts:11-34`（HelloFrame/HelloAckFrame/通道控制帧/DataHeader）
- Modify: `packages/server/src/protocol.ts`（同位置，镜像）
- Test: `packages/client/src/protocol.test.ts`、`packages/server/src/protocol.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖）：
  - `HelloFrame.client` 新增 `multiConn?: { count: number }`、`attach?: boolean`
  - `HelloAckFrame` 新增 `multiConn?: { max: number }`
  - `DataHeader` 新增 `seq?: number`
  - 通道级控制帧（`HttpOpenFrame`/`WsOpenFrame`/`HttpHeadFrame`/`WsAcceptFrame`/`WsRejectFrame`/`ChannelCloseFrame`/`ChannelErrorFrame`）新增 `seq?: number`
  - `export const ATTACH_REJECT_CODE = 4410`

- [ ] **Step 1: 写失败测试（client 侧，server 侧镜像同内容）**

在 `packages/client/src/protocol.test.ts` 追加（server 侧文件同样追加）：

```ts
it('hello 携带 multiConn/attach 字段编解码往返', () => {
  const frame = {
    type: 'hello' as const,
    client: { hostname: 'pc-a', defaultPath: '/', multiConn: { count: 4 }, attach: true, tunnelId: 'tid-1' },
  };
  const decoded = decodeControl(encodeControl(frame));
  expect(decoded).toEqual(frame);
});

it('hello.ack 携带 multiConn.max 编解码往返', () => {
  const frame = { type: 'hello.ack' as const, tunnelId: 'tid-1', multiConn: { max: 16 } };
  expect(decodeControl(encodeControl(frame))).toEqual(frame);
});

it('通道级控制帧与数据帧头携带 seq 往返', () => {
  const head = { type: 'http.head' as const, channelId: 7, seq: 3, status: 200, headers: {} };
  expect(decodeControl(encodeControl(head))).toEqual(head);
  const { header, payload } = decodeData(encodeData({ channelId: 7, kind: 'http.body', seq: 4 }, Buffer.from('x')));
  expect(header).toEqual({ channelId: 7, kind: 'http.body', seq: 4 });
  expect(payload.toString()).toBe('x');
});

it('无 seq 的旧帧形态保持不变（legacy 兼容）', () => {
  const decoded = decodeControl(encodeControl({ type: 'http.head', channelId: 1, status: 200, headers: {} }));
  expect('seq' in decoded).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/protocol.test.ts`
Expected: FAIL（`toEqual` 因字段未定义/类型报错）

- [ ] **Step 3: 实现（两端 protocol.ts 镜像同步改）**

`packages/client/src/protocol.ts` 与 `packages/server/src/protocol.ts` 做完全相同的改动：

```ts
// HelloFrame 替换为：
export interface HelloFrame {
  type: 'hello';
  client: {
    hostname: string;
    defaultPath: string;
    tunnelId?: string;
    flowControl?: boolean;
    /** 多连接协商：期望的总连接数（含本连接，≥2 才声明）；缺省 = 单连接（老行为） */
    multiConn?: { count: number };
    /** attach 握手：请求加入 tunnelId 指定的既有隧道组而非新建隧道（仅协商成功后发送） */
    attach?: boolean;
  };
}

// HelloAckFrame 替换为：
export interface HelloAckFrame {
  type: 'hello.ack';
  tunnelId: string;
  /** 服务端支持多连接 + 本隧道允许的最大连接数；缺省 = 不支持（老服务端） */
  multiConn?: { max: number };
}

/** attach 拒绝关闭码：目标 tunnelId 不存在/组已满/会话非多连接模式（spec §3.2） */
export const ATTACH_REJECT_CODE = 4410;
```

六个通道级控制帧接口各加 `seq?: number`（紧跟 `channelId` 字段），`DataHeader` 加 `seq?: number`：

```ts
export interface DataHeader {
  channelId: number;
  kind: DataKind;
  dataType?: 'text' | 'binary';
  /** 多连接条带化的通道内序号（每 (channelId, 方向) 从 0 单调递增）；仅协商成功的隧道组携带 */
  seq?: number;
}
```

`decodeControl`/`decodeData` **不改**——两者本就不做严格字段校验，可选字段随 JSON 自然透传（注释里注明这一点）。

- [ ] **Step 4: 跑测试确认通过 + 双端镜像一致性核对**

Run: `pnpm --filter gateway-client exec vitest run src/protocol.test.ts && pnpm --filter gateway-server exec vitest run src/protocol.test.ts`
Expected: PASS。另用 `git diff --no-index packages/client/src/protocol.ts packages/server/src/protocol.ts` 确认两文件除文件头注释外一致。

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/client/src/protocol.ts packages/server/src/protocol.ts packages/client/src/protocol.test.ts packages/server/src/protocol.test.ts
git commit -m "feat: 隧道协议多连接扩展——hello multiConn/attach 协商、hello.ack max、通道帧 seq、4410 关闭码（双端镜像）"
```

---

### Task 2: Connection 多连接改造（client）

**Files:**
- Modify: `packages/client/src/connection.ts`
- Modify: `packages/client/src/test-utils/mock-gateway.ts`（支持 multiConn echo 与 attach 应答）
- Test: `packages/client/src/connection.test.ts`

**Interfaces:**
- Consumes: Task 1 的协议字段与 `ATTACH_REJECT_CODE`。
- Produces（Task 4/5 依赖）：
  - `ConnectionOptions.hello: { hostname: string; defaultPath: string; multiConn?: { count: number }; attach?: boolean; initialTunnelId?: string }`
  - `conn.serverMaxLegs: number | undefined`（hello.ack 的 multiConn.max）
  - `conn.availableCapacity(): number`（未就绪/全满 ≤ 0）
  - `conn.forceReconnect(): void`
  - `export interface TunnelSender { sendControl(frame: ControlFrame): void; sendData(header: DataHeader, payload: Buffer): boolean; waitDrain(): Promise<void> }`（Connection 天然实现）

- [ ] **Step 1: 写失败测试**

`packages/client/src/connection.test.ts` 追加（沿用文件内现有 MockGateway 接线模式）：

```ts
it('hello 携带 multiConn 声明；hello.ack 的 multiConn.max 经 serverMaxLegs 暴露', async () => {
  // mock 侧在 hello 应答里回 multiConn: { max: 16 }（Step 3 给 MockGateway 加 multiConnAck 旋钮）
  gateway.multiConnAck = { max: 16 };
  const conn = makeConn({ hello: { hostname: 'pc-a', defaultPath: '/', multiConn: { count: 4 } } });
  await conn.connect();
  expect(gateway.lastHello?.client.multiConn).toEqual({ count: 4 });
  expect(conn.serverMaxLegs).toBe(16);
  await conn.close();
});

it('4410 = attach 拒绝：connect reject 且不重连', async () => {
  gateway.closeOnHello = 4410;
  const conn = makeConn({ hello: { hostname: 'pc-a', defaultPath: '/', attach: true, initialTunnelId: 'tid-x' } });
  await expect(conn.connect()).rejects.toThrow(/4410/);
});

it('availableCapacity 未就绪为 0；就绪后等于 min(窗口剩余, 本地水位剩余)', async () => {
  const conn = makeConn({});
  expect(conn.availableCapacity()).toBe(0);
  await conn.connect();
  expect(conn.availableCapacity()).toBeGreaterThan(0);
  await conn.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/connection.test.ts`
Expected: FAIL（serverMaxLegs/availableCapacity 未定义；MockGateway 无旋钮）

- [ ] **Step 3: 实现**

`connection.ts` 改动：

```ts
// ConnectionOptions.hello 改为：
hello: {
  hostname: string;
  defaultPath: string;
  multiConn?: { count: number };
  attach?: boolean;
  /** attach leg 用：构造即植入的 tunnelId（primary 当前值），优先于进程记忆 */
  initialTunnelId?: string;
};

// 类内新增字段与方法：
private serverMaxLegsValue: number | undefined;

/** hello.ack 协商出的服务端多连接上限；undefined = 老服务端不支持 */
get serverMaxLegs(): number | undefined {
  return this.serverMaxLegsValue;
}

/** 可用容量分（加权条带化选 leg 依据）：min(端到端窗口剩余, 本地水位剩余)；未就绪/全满 ≤ 0 */
availableCapacity(): number {
  if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.readyState) return 0;
  const local = HIGH_WATER_BYTES - this.ws.bufferedAmount;
  if (!this.flowAckActive) return Math.max(0, local);
  const windowLeft = this.currentFlowWindow() - (this.dataBytesSent - this.dataBytesAcked);
  return Math.max(0, Math.min(local, windowLeft));
}

/** 整组重连触发点（TunnelGroup 用）：terminate 当前 ws 走既有 close→退避重连路径（closing 保持 false） */
forceReconnect(): void {
  this.ws?.terminate();
}
```

四处接线改动：

1. 构造函数开头：`this.lastTunnelId = opts.hello.initialTunnelId;`（attach leg 的种子）。
2. `attempt()` 的 hello 构造改为：

```ts
const client = {
  ...this.opts.hello, // hostname/defaultPath/multiConn/attach 一并下传
  flowControl: true,
  ...(this.lastTunnelId ? { tunnelId: this.lastTunnelId } : {}),
};
delete (client as { initialTunnelId?: string }).initialTunnelId; // 内部字段，不上线
```

3. `handleControl` 的 `hello.ack` 分支内追加：`this.serverMaxLegsValue = frame.multiConn?.max;`
4. `handleClose` 的 4409 分支扩展为同时吃 4410（attach 拒绝 = 终态、不重连）：

```ts
if (code === 4409 || code === ATTACH_REJECT_CODE) {
  const err = new Error(code === 4409
    ? 'hostname conflict (4409): 同名客户端已在线'
    : 'attach rejected (4410): 目标隧道不存在/已满/非多连接会话');
  // …其余与现 4409 分支相同（connectReject 或 error+fatal）
}
```

`mock-gateway.ts` 加旋钮（供本任务与 Task 4/5）：

```ts
// 类字段
multiConnAck: { max: number } | undefined;   // hello.ack 附带
closeOnHello: number | undefined;            // 收到 hello 直接以该码关闭（4410 场景）
lastHello: Extract<ControlFrame, { type: 'hello' }> | null = null;
attachOk = false;                             // true 时 attach hello 回同一 tunnelId 的 ack

// onMessage 的 hello 分支改为：
if (frame.type === 'hello') {
  this.lastHello = frame;
  if (this.closeOnHello !== undefined) { this.ws?.close(this.closeOnHello, 'mock reject'); return; }
  if (frame.client.attach === true && this.attachOk) {
    this.ws?.send(encodeControl({ type: 'hello.ack', tunnelId: frame.client.tunnelId ?? 'tid-mock-1', multiConn: this.multiConnAck }));
    return;
  }
  this.ws?.send(encodeControl({ type: 'hello.ack', tunnelId: 'tid-mock-1', multiConn: this.multiConnAck }));
}
```

（`multiConn: undefined` 时 `JSON.stringify` 丢弃该键，legacy ack 形态不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/connection.test.ts`
Expected: PASS（含文件内既有用例全绿）

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/client/src/connection.ts packages/client/src/connection.test.ts packages/client/src/test-utils/mock-gateway.ts
git commit -m "feat(gateway-client): Connection 多连接改造——hello multiConn/attach、serverMaxLegs、availableCapacity、forceReconnect、4410 终态"
```

---

### Task 3: Resequencer（client）

**Files:**
- Create: `packages/client/src/resequencer.ts`
- Test: `packages/client/src/resequencer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ControlFrame`/`DataHeader` 类型。
- Produces（Task 5 依赖；Task 6 镜像）：
  - `export type SequencedItem = { kind: 'control'; frame: ControlFrame } | { kind: 'data'; header: DataHeader; payload: Buffer }`
  - `export class Resequencer`：`feed(channelId: number, seq: number, item: SequencedItem, deliver: (item: SequencedItem) => void): void`、`dropChannel(channelId: number): void`、`reset(): void`
  - 构造：`new Resequencer({ logger, onOverflow: (channelId: number) => void })`

- [ ] **Step 1: 写失败测试**

`packages/client/src/resequencer.test.ts`（全文新建）：

```ts
import { describe, expect, it, vi } from 'vitest';

import { createDefaultLogger } from './logger';
import { Resequencer, type SequencedItem } from './resequencer';

const logger = createDefaultLogger('error'); // 测试静默

function makeSeq(over?: Partial<Resequencer>): { rsq: Resequencer; onOverflow: ReturnType<typeof vi.fn> } {
  const onOverflow = vi.fn();
  return { rsq: new Resequencer({ logger, onOverflow, ...over }), onOverflow };
}

function data(channelId: number, seq: number, text: string): { seq: number; item: SequencedItem } {
  return { seq, item: { kind: 'data', header: { channelId, kind: 'http.body', seq }, payload: Buffer.from(text) } };
}

describe('Resequencer', () => {
  it('有序帧直通交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    for (const f of [data(1, 0, 'a'), data(1, 1, 'b')]) {
      rsq.feed(1, f.seq, f.item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    }
    expect(got).toEqual(['a', 'b']);
  });

  it('乱序停驻，空洞补齐后按序连扫交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => { got.push(it.kind === 'data' ? it.payload.toString() : '?'); };
    rsq.feed(1, 1, data(1, 1, 'b').item, deliver); // 先到 1：停驻
    rsq.feed(1, 2, data(1, 2, 'c').item, deliver); // 先到 2：停驻
    expect(got).toEqual([]);
    rsq.feed(1, 0, data(1, 0, 'a').item, deliver); // 补洞 → 连扫
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('seq 0 空洞：数据先于 open 到达时停驻，open 到达后依次交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => {
      got.push(it.kind === 'control' ? 'open' : (it.payload as Buffer).toString());
    };
    rsq.feed(9, 1, data(9, 1, 'x').item, deliver);
    expect(got).toEqual([]);
    rsq.feed(9, 0, { kind: 'control', frame: { type: 'http.open', channelId: 9, seq: 0, method: 'GET', url: '/', headers: {} } }, deliver);
    expect(got).toEqual(['open', 'x']);
  });

  it('旧 seq（< expected）防御性丢弃', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => { got.push(it.kind === 'data' ? it.payload.toString() : '?'); };
    rsq.feed(1, 0, data(1, 0, 'a').item, deliver);
    rsq.feed(1, 0, data(1, 0, 'dup').item, deliver);
    expect(got).toEqual(['a']);
  });

  it('通道缓冲超 32MiB 触发 onOverflow 并清空该通道状态', () => {
    const { rsq, onOverflow } = makeSeq();
    const big = Buffer.alloc(16 * 1024 * 1024);
    // seq 1/2/3 停驻（expected=0 空洞），总量 48MiB 超限
    for (const s of [1, 2, 3]) rsq.feed(5, s, { kind: 'data', header: { channelId: 5, kind: 'http.body', seq: s }, payload: big }, () => undefined);
    expect(onOverflow).toHaveBeenCalledWith(5);
  });

  it('dropChannel 后 seq 空间从零重来；reset 清空全部', () => {
    const { rsq } = makeSeq();
    const deliver = (): void => undefined;
    rsq.feed(1, 5, data(1, 5, 'x').item, deliver); // 停驻
    rsq.dropChannel(1);
    const got: string[] = [];
    rsq.feed(1, 0, data(1, 0, 'a').item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    expect(got).toEqual(['a']);
    rsq.feed(2, 3, data(2, 3, 'y').item, deliver);
    rsq.reset();
    rsq.feed(2, 0, data(2, 0, 'z').item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    expect(got).toEqual(['a', 'z']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/resequencer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/client/src/resequencer.ts`（全文新建）：

```ts
/**
 * 接收端重排序（spec §6）：多连接条带化下，同一 (channelId, 方向) 的帧可能经不同 leg 乱序到达。
 * 本器按 seq 重排后按序交付，通道层看到的仍是与单连接逐字节一致的有序流。
 * 无 seq 的帧（单连接模式/隧道级帧）不经过本器，调用方直通。
 * 断腿=整组重建（spec §4.4）前提下 seq < expected 不可能发生，防御性丢弃 + WARN。
 */

import type { ControlFrame, DataHeader } from './protocol';
import type { Logger } from './logger';

export type SequencedItem =
  | { kind: 'control'; frame: ControlFrame }
  | { kind: 'data'; header: DataHeader; payload: Buffer };

/** 防御性每通道缓冲上限（spec §6.3）：乱序停驻帧本就是在途帧子集，超限 = 对端行为异常 */
const MAX_CHANNEL_BUFFER_BYTES = 32 * 1024 * 1024;

interface ChannelState {
  expected: number;
  buffer: Map<number, SequencedItem>;
  bufferedBytes: number;
}

function itemBytes(item: SequencedItem): number {
  return item.kind === 'data' ? item.payload.length : 0; // 控制帧极小，不计
}

export class Resequencer {
  private readonly states = new Map<number, ChannelState>();

  constructor(
    private readonly opts: {
      logger: Logger;
      /** 通道缓冲超限：调用方按隧道组级协议错误处置（1002/teardown） */
      onOverflow: (channelId: number) => void;
    },
  ) {}

  /** 喂入一帧；deliver 可能被同步回调多次（连扫停驻帧） */
  feed(channelId: number, seq: number, item: SequencedItem, deliver: (item: SequencedItem) => void): void {
    let st = this.states.get(channelId);
    if (!st) {
      st = { expected: 0, buffer: new Map(), bufferedBytes: 0 };
      this.states.set(channelId, st);
    }
    if (seq < st.expected) {
      this.opts.logger.warn('重排序收到旧 seq，防御性丢弃', { channelId, seq, expected: st.expected });
      return;
    }
    if (seq > st.expected) {
      if (st.buffer.has(seq)) return; // 防御重复（TCP 有序，不会发生）
      st.buffer.set(seq, item);
      st.bufferedBytes += itemBytes(item);
      if (st.bufferedBytes > MAX_CHANNEL_BUFFER_BYTES) {
        this.states.delete(channelId);
        this.opts.onOverflow(channelId);
      }
      return;
    }
    // seq === expected：交付并连扫
    deliver(item);
    st.expected += 1;
    let next: SequencedItem | undefined;
    while ((next = st.buffer.get(st.expected)) !== undefined) {
      st.buffer.delete(st.expected);
      st.bufferedBytes -= itemBytes(next);
      deliver(next);
      st.expected += 1;
    }
  }

  /** 通道结束清理（onDone/unregister 对应点调用） */
  dropChannel(channelId: number): void {
    this.states.delete(channelId);
  }

  /** 整组重连重置（channelId 空间随隧道重建归零） */
  reset(): void {
    this.states.clear();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/resequencer.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/client/src/resequencer.ts packages/client/src/resequencer.test.ts
git commit -m "feat(gateway-client): 接收端重排序 Resequencer——每通道 seq 停驻/连扫、32MiB 防御上限、dropChannel/reset 清理"
```

---

### Task 4: TunnelGroup（client）

**Files:**
- Create: `packages/client/src/tunnel-group.ts`
- Test: `packages/client/src/tunnel-group.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `Connection` 扩展（`serverMaxLegs`/`availableCapacity`/`forceReconnect`/hello `attach`+`initialTunnelId`）、`TunnelSender`；Task 1 的协议字段。
- Produces（Task 5 依赖）：
  - `export interface TunnelGroupOptions { gatewayUrl: string; hello: { hostname: string; defaultPath: string }; connections: number; heartbeatIntervalMs: number; connectTimeoutMs: number; reconnect: ReconnectOptions; logger: Logger }`
  - `export interface TunnelGroupHandlers { onControl(frame: ControlFrame): void; onData(header: DataHeader, payload: Buffer): void; onDisconnected(): void }`
  - `export class TunnelGroup extends EventEmitter implements TunnelSender`：`connect(): Promise<void>`、`close(): Promise<void>`、`sendControl(frame)`、`sendData(header, payload): boolean`、`waitDrain(): Promise<void>`、`forceReconnect(): void`、get `ready(): boolean`、get `tunnelId(): string | undefined`、get `readyLegCount(): number`；事件 `'error' | 'fatal' | 'connected' | 'disconnected'`

- [ ] **Step 1: 写失败测试**

`packages/client/src/tunnel-group.test.ts`（全文新建；复用 MockGateway，其 `attachOk`/`multiConnAck` 旋钮来自 Task 2）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLogger } from './logger';
import { MockGateway } from './test-utils/mock-gateway';
import { TunnelGroup } from './tunnel-group';

const logger = createDefaultLogger('error');
let gateway: MockGateway;
let group: TunnelGroup | null = null;

beforeEach(() => { gateway = new MockGateway(); });
afterEach(async () => { await group?.close(); group = null; await gateway.close(); });

function makeGroup(connections: number, handlers: Partial<{ onControl: (f: never) => void; onData: () => void; onDisconnected: () => void }> = {}): TunnelGroup {
  group = new TunnelGroup(
    {
      gatewayUrl: gateway.url,
      hello: { hostname: 'pc-a', defaultPath: '/' },
      connections,
      heartbeatIntervalMs: 30_000,
      connectTimeoutMs: 5_000,
      reconnect: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 },
      logger,
    },
    { onControl: handlers.onControl ?? (() => undefined), onData: handlers.onData ?? (() => undefined), onDisconnected: handlers.onDisconnected ?? (() => undefined) },
  );
  group.on('error', () => undefined); // EventEmitter 语义：必须挂监听
  group.on('fatal', () => undefined);
  return group;
}

describe('TunnelGroup', () => {
  it('协商成功：primary 就绪后 attach 余下 leg，readyLegCount 达到目标', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.attachOk = true;
    const g = makeGroup(4);
    await g.connect();
    await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
    expect(gateway.connectionCount).toBe(4);
  });

  it('老服务端（ack 无 multiConn）：不发起 attach，单 leg 运行', async () => {
    const g = makeGroup(4);
    await g.connect();
    await new Promise((r) => setTimeout(r, 200));
    expect(g.readyLegCount).toBe(1);
    expect(gateway.connectionCount).toBe(1);
  });

  it('attach 被 4410 拒绝：槽位退避重试 ≤3 次后降级，组保持可用', async () => {
    gateway.multiConnAck = { max: 16 };
    gateway.closeOnHello = 4410; // mock 实现仅拒 attach（Step 3 细化），primary 不带 attach 故放行
    const g = makeGroup(3);
    await g.connect();
    await vi.waitFor(() => expect(gateway.attachHelloCount).toBe(3), { timeout: 5000 }); // 首试 + 2 次重试…上限 3
    expect(g.ready).toBe(true);
    expect(g.readyLegCount).toBe(1); // 降级运行
  });
});
```

> MockGateway 的 `closeOnHello` 只拒 attach、放行 primary（否则 primary 也连不上）。Task 2 加的分支细化为：`if (this.closeOnHello !== undefined && frame.client.attach === true) { close }`；另加 `attachHelloCount` 计数器（hello 分支内 `frame.client.attach === true` 时自增）。

其余测试用例（同一文件，逐一写全再进 Step 2）：

```ts
it('发送侧加权选 leg：帧散落到多条 leg，且带单调 seq', async () => {
  gateway.multiConnAck = { max: 16 };
  gateway.attachOk = true;
  const g = makeGroup(4);
  await g.connect();
  await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
  for (let i = 0; i < 8; i++) g.sendData({ channelId: 1, kind: 'http.body' }, Buffer.alloc(64 * 1024));
  // mock 侧按 ws 连接分别记账（Step 3 给 MockGateway 加 perConnData: Map<WebSocket, Buffer[]>）
  const perConn = gateway.perConnDataSizes();
  expect(perConn.size).toBeGreaterThan(1); // 条带化生效
  const seqs = gateway.allDataSeqs(1); // 跨连接聚合 channelId=1 的 seq
  expect(seqs).toEqual([...Array(8).keys()]); // 0..7 单调
});

it('整组断连语义：任一已就绪 leg 断 → onDisconnected → 整组重连恢复', async () => {
  gateway.multiConnAck = { max: 16 };
  gateway.attachOk = true;
  let disconnected = 0;
  const g = makeGroup(4, { onDisconnected: () => { disconnected += 1; } });
  await g.connect();
  await vi.waitFor(() => expect(g.readyLegCount).toBe(4));
  gateway.dropOneConnection(); // Step 3 mock 加：随机断一条非首连接
  await vi.waitFor(() => expect(disconnected).toBe(1));
  await vi.waitFor(() => expect(g.readyLegCount).toBe(4)); // 整组重建
});
```

MockGateway 补充旋钮（本任务 Step 3 一并实现）：`perConnDataSizes(): Map<number, number>`、`allDataSeqs(channelId): number[]`、`dropOneConnection()`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/tunnel-group.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`packages/client/src/tunnel-group.ts`（全文新建）：

```ts
/**
 * 隧道组（spec §4）：N 条 Connection（leg）组成一条逻辑隧道。
 * leg 0 = primary（正常 hello 声明 multiConn.count），其余 attach（回带 tunnelId + attach: true）。
 * 发送侧：通道级帧同步打 seq（每 (channelId, client→server) 从 0 递增）后按可用容量加权选 leg；
 * 全满返回 false，任一 leg 回落 waitDrain 唤醒——通道层背压语义与单连一致。
 * 断连语义：任一已就绪 leg 断 = 整组 teardown（其余 leg close + primary forceReconnect），
 * onDisconnected 只经 primary 单点上抛；primary 重连成功后重建 attach leg。
 * attach 失败（4410/超时）不杀整组：槽位按退避重试 ≤3 次，耗尽降级到下次整组重连。
 * 接收侧不重排：各 leg 帧原样上抛（可能乱序），由 Client 持有的 Resequencer 重排（spec §6）。
 */

import { EventEmitter } from 'node:events';

import { Connection, type ReconnectOptions, type TunnelSender } from './connection';

import type { ControlFrame, DataHeader } from './protocol';
import type { Logger } from './logger';

export interface TunnelGroupOptions {
  gatewayUrl: string;
  hello: { hostname: string; defaultPath: string };
  /** 目标总连接数（含 primary，≥2 才会建组；Client 在 ==1 时直接用 Connection） */
  connections: number;
  heartbeatIntervalMs: number;
  connectTimeoutMs: number;
  reconnect: ReconnectOptions;
  logger: Logger;
}

export interface TunnelGroupHandlers {
  onControl(frame: ControlFrame): void;
  onData(header: DataHeader, payload: Buffer): void;
  /** 整组断开（含重连中的断开）：单点上抛，Client 据此中止在途通道 */
  onDisconnected(): void;
}

/** attach 槽位重试上限（spec §4.4：耗尽降级到下次整组重连） */
const MAX_ATTACH_ATTEMPTS = 3;
/** attach 单次连接超时：比首连短，避免拖慢降级判定 */
const ATTACH_CONNECT_TIMEOUT_MS = 30_000;

export class TunnelGroup extends EventEmitter implements TunnelSender {
  private readonly primary: Connection;
  /** attach 槽位表（下标即槽位号）；null = 未建立/已降级 */
  private readonly attachLegs: Array<Connection | null> = [];
  private readonly attachTimers = new Map<number, NodeJS.Timeout>();
  /** client→server 方向每通道下一个 seq */
  private readonly sendSeq = new Map<number, number>();
  private closing = false;
  private disconnected = false;

  constructor(
    private readonly opts: TunnelGroupOptions,
    private readonly handlers: TunnelGroupHandlers,
  ) {
    super();
    this.primary = this.newLeg(false, undefined);
    // onDisconnected 单点上抛：仅 primary 驱动（attach leg 断 → forceReconnect 间接触发同一路径）
    this.primary.on('connected', () => {
      this.disconnected = false;
      this.emit('connected');
      this.spawnAttachLegs();
    });
    this.primary.on('disconnected', () => {
      this.disconnected = true;
      this.sendSeq.clear(); // channelId 空间随隧道重建归零
      this.closeAttachLegs();
      this.emit('disconnected');
      this.handlers.onDisconnected();
    });
  }

  get ready(): boolean {
    return this.primary.ready;
  }

  get tunnelId(): string | undefined {
    return this.primary.tunnelId;
  }

  /** 当前已就绪 leg 数（e2e/日志观测用） */
  get readyLegCount(): number {
    return this.allLegs().filter((l) => l.ready).length;
  }

  /** 建立隧道：primary 就绪即 resolve（attach 在后台进行，不阻塞可用性） */
  connect(): Promise<void> {
    this.closing = false;
    return this.primary.connect();
  }

  /** 通道级帧：打 seq + 加权选 leg；隧道级帧（不该出现）走 primary */
  sendControl(frame: ControlFrame): void {
    const channelId = 'channelId' in frame ? frame.channelId : undefined;
    if (channelId === undefined) {
      this.primary.sendControl(frame);
      return;
    }
    const leg = this.pickLeg();
    if (leg === null) throw new Error('tunnel not ready');
    leg.sendControl({ ...frame, seq: this.nextSeq(channelId) });
  }

  /** 数据帧：打 seq + 加权选 leg；所有 ready leg 全满返回 false（帧仍发出，由调用方 pause 收敛） */
  sendData(header: DataHeader, payload: Buffer): boolean {
    const pick = this.pickLegWithCapacity();
    if (pick === null) throw new Error('tunnel not ready');
    pick.leg.sendData({ ...header, seq: this.nextSeq(header.channelId) }, payload);
    return pick.capacity > 0;
  }

  /** 任一 leg 回落即唤醒（调用方 pause/resume 语义不变） */
  waitDrain(): Promise<void> {
    const legs = this.allLegs().filter((l) => l.ready);
    if (legs.length === 0) return Promise.resolve();
    return Promise.race(legs.map((l) => l.waitDrain())).then(() => undefined);
  }

  /** Resequencer 溢出等组级协议错误处置：整组重连 */
  forceReconnect(): void {
    this.closeAttachLegs();
    this.primary.forceReconnect();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const t of this.attachTimers.values()) clearTimeout(t);
    this.attachTimers.clear();
    await Promise.all([this.primary.close(), ...this.allLegs().slice(1).map((l) => l.close())]);
  }

  // ---- 内部 ----

  private nextSeq(channelId: number): number {
    const n = this.sendSeq.get(channelId) ?? 0;
    this.sendSeq.set(channelId, n + 1);
    return n;
  }

  private allLegs(): Connection[] {
    return [this.primary, ...this.attachLegs.filter((l): l is Connection => l !== null)];
  }

  /** 加权选 leg：可用容量最高者（打平取先）；无 ready leg 返回 null */
  private pickLegWithCapacity(): { leg: Connection; capacity: number } | null {
    let best: Connection | null = null;
    let bestCap = Number.NEGATIVE_INFINITY;
    for (const leg of this.allLegs()) {
      if (!leg.ready) continue;
      const cap = leg.availableCapacity();
      if (cap > bestCap) {
        best = leg;
        bestCap = cap;
      }
    }
    return best === null ? null : { leg: best, capacity: bestCap };
  }

  private pickLeg(): Connection | null {
    return this.pickLegWithCapacity()?.leg ?? null;
  }

  /** 构造一条 leg；attach 用 primary 当前 tunnelId 作种子、禁内建重连（生命周期由组管） */
  private newLeg(attach: boolean, tunnelId: string | undefined): Connection {
    const leg = new Connection(
      {
        gatewayUrl: this.opts.gatewayUrl,
        hello: attach
          ? { ...this.opts.hello, attach: true, initialTunnelId: tunnelId }
          : { ...this.opts.hello, multiConn: { count: this.opts.connections } },
        heartbeatIntervalMs: this.opts.heartbeatIntervalMs,
        connectTimeoutMs: attach ? ATTACH_CONNECT_TIMEOUT_MS : this.opts.connectTimeoutMs,
        reconnect: attach
          ? { ...this.opts.reconnect, maxRetries: 0 }
          : this.opts.reconnect,
        logger: this.opts.logger,
      },
      {
        onControl: (f) => this.handlers.onControl(f),
        onData: (h, p) => this.handlers.onData(h, p),
        onDisconnected: () => { if (attach) this.onAttachLegDown(); },
      },
    );
    // EventEmitter 语义：'error' 必须挂监听；诊断上抛给 Client 的统一 'error'
    leg.on('error', (err: Error) => this.emit('error', err));
    leg.on('fatal', () => undefined); // attach leg 终态已由组语义覆盖，防无监听噪音
    return leg;
  }

  /** primary 就绪后按协商结果补 leg；老服务端（无 multiConn）静默单 leg */
  private spawnAttachLegs(): void {
    if (this.closing) return;
    const max = this.primary.serverMaxLegs;
    const tid = this.primary.tunnelId;
    if (max === undefined || tid === undefined) {
      this.opts.logger.info('服务端不支持多连接，单连接运行', { hostname: this.opts.hello.hostname });
      return;
    }
    const target = Math.min(this.opts.connections, max);
    for (let slot = 0; slot < target - 1; slot++) {
      if (this.attachLegs[slot] == null) this.startAttach(slot, tid, 0);
    }
  }

  private startAttach(slot: number, tunnelId: string, attemptNo: number): void {
    if (this.closing || this.disconnected) return;
    const leg = this.newLeg(true, tunnelId);
    this.attachLegs[slot] = leg;
    leg.connect().catch(() => {
      if (this.attachLegs[slot] === leg) this.attachLegs[slot] = null;
      if (this.closing || this.primary.tunnelId !== tunnelId) return; // 组已换隧道，等下轮 spawn
      if (attemptNo + 1 >= MAX_ATTACH_ATTEMPTS) {
        this.opts.logger.warn('attach 重试耗尽，该槽位降级到下次整组重连', { slot, attempts: attemptNo + 1 });
        return;
      }
      const delay = this.opts.reconnect.baseDelayMs * 2 ** attemptNo;
      const timer = setTimeout(() => {
        this.attachTimers.delete(slot);
        this.startAttach(slot, tunnelId, attemptNo + 1);
      }, Math.min(delay, this.opts.reconnect.maxDelayMs));
      this.attachTimers.set(slot, timer);
    });
  }

  /** 已就绪 attach leg 断 = 整组断（spec §4.4）：收其余 leg，primary forceReconnect 驱动重连 */
  private onAttachLegDown(): void {
    if (this.closing || this.disconnected) return;
    this.opts.logger.warn('attach leg 断开，整组重建');
    this.forceReconnect();
  }

  private closeAttachLegs(): void {
    for (const t of this.attachTimers.values()) clearTimeout(t);
    this.attachTimers.clear();
    const legs = this.attachLegs.splice(0);
    for (const leg of legs) {
      if (leg === null) continue;
      leg.close().catch(() => undefined);
    }
  }
}
```

MockGateway 按 Step 1 注释补旋钮（`closeOnHello` 只拒 attach、`perConnDataSizes`/`allDataSeqs`/`dropOneConnection`：ws 连接改存数组 `conns: WebSocket[]`，数据按连接记账）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter gateway-client exec vitest run src/tunnel-group.test.ts src/connection.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/client/src/tunnel-group.ts packages/client/src/tunnel-group.test.ts packages/client/src/test-utils/mock-gateway.ts
git commit -m "feat(gateway-client): TunnelGroup 隧道组——primary+attach leg 装配、seq 加权条带化、整组断连语义、attach 槽位重试降级"
```

---

### Task 5: Client 装配（connections 配置 + Resequencer 接线）

**Files:**
- Modify: `packages/client/src/client.ts`
- Modify: `packages/client/src/http-channel.ts:57-77`、`packages/client/src/ws-channel.ts:19-27`（`connection` 参数类型改 `TunnelSender`）
- Test: `packages/client/src/client.test.ts`

**Interfaces:**
- Consumes: Task 3 `Resequencer`、Task 4 `TunnelGroup`、Task 2 `TunnelSender`。
- Produces：
  - `ClientOptions.connections?: number`（默认 4，clamp [1,16]，NaN 按默认）
  - `client.legCount: number`（e2e/观测）
  - `HttpChannelParams.connection: TunnelSender`、`WsChannelParams.connection: TunnelSender`（Task 7 服务端镜像此接缝形态）

- [ ] **Step 1: 写失败测试**

`packages/client/src/client.test.ts` 追加：

```ts
it('connections 缺省 = 4：对 multiConn 网关建组，legCount 达到 4', async () => {
  gateway.multiConnAck = { max: 16 };
  gateway.attachOk = true;
  const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a' });
  client.on('error', () => undefined);
  await client.connect();
  await vi.waitFor(() => expect(client.legCount).toBe(4));
  await client.close();
});

it('connections: 1 = 纯 legacy：hello 不声明 multiConn', async () => {
  const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a', connections: 1 });
  client.on('error', () => undefined);
  await client.connect();
  expect(client.legCount).toBe(1);
  expect(gateway.lastHello?.client.multiConn).toBeUndefined();
  await client.close();
});

it('多连接下帧完整性与顺序：大 echo 体经 4 leg 条带化后字节一致', async () => {
  gateway.multiConnAck = { max: 16 };
  gateway.attachOk = true;
  const client = new Client({ upstreamUrl, gatewayUrl: gateway.url, hostname: 'pc-a' });
  client.on('error', () => undefined);
  await client.connect();
  await vi.waitFor(() => expect(client.legCount).toBe(4));
  const body = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i % 251; // 可校验模式
  const res = await gateway.request('POST', '/', {}, body); // upstream echo
  expect(res.body.equals(body)).toBe(true);
  await client.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-client exec vitest run src/client.test.ts`
Expected: FAIL（legCount/connections 未定义）

- [ ] **Step 3: 实现**

`client.ts` 改动（要点全列）：

1. `ClientOptions` 加字段：

```ts
/**
 * 隧道连接数（spec §8）：默认 4，clamp [1,16]。>1 时建 TunnelGroup 条带化传输；
 * 1 = 纯 legacy 单连接（连 multiConn 协商都不发）。老服务端自动降级单连接。
 */
connections?: number;
```

2. 字段与构造（替换现有 `private readonly connection: Connection` 及其构造段）：

```ts
private readonly connection: Connection | TunnelGroup;
private readonly resequencer: Resequencer;
private readonly connectionCount: number;
```

```ts
// 构造器内（原 this.connection = new Connection(...) 段替换）：
const raw = options.connections ?? 4;
this.connectionCount = Number.isFinite(raw) ? Math.min(16, Math.max(1, Math.floor(raw))) : 4;
const connOpts = {
  gatewayUrl: options.gatewayUrl,
  hello: { hostname: options.hostname, defaultPath: options.defaultPath ?? '/' },
  heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
  connectTimeoutMs: options.connectTimeoutMs ?? 60_000,
  reconnect: {
    baseDelayMs: options.reconnect?.baseDelayMs ?? 1000,
    maxDelayMs: options.reconnect?.maxDelayMs ?? 30_000,
    maxRetries: options.reconnect?.maxRetries ?? Infinity,
  },
  logger: this.logger,
};
const handlers = {
  onControl: (frame: ControlFrame) => this.ingestControl(frame),
  onData: (header: DataHeader, payload: Buffer) => this.ingestData(header, payload),
  onDisconnected: () => this.abortAllChannels(),
};
this.connection = this.connectionCount === 1 ? new Connection(connOpts, handlers) : new TunnelGroup({ ...connOpts, connections: this.connectionCount }, handlers);
this.resequencer = new Resequencer({
  logger: this.logger,
  onOverflow: (channelId) => {
    this.logger.error('重排序缓冲超限，整组重连', { channelId });
    this.connection.forceReconnect();
  },
});
```

（`connection.ts` 需补 `Connection implements TunnelSender` 声明；`forceReconnect` 两类型都有。）

3. 新增入口 `ingestControl`/`ingestData`（带 seq 的通道级帧进 Resequencer，其余直通现有分发——现有 `onControl`/`onData` 改名为 `dispatchControl`/`dispatchData` 并保持逐字不变）：

```ts
private ingestControl(frame: ControlFrame): void {
  const channelId = 'channelId' in frame ? frame.channelId : undefined;
  const seq = 'seq' in frame ? frame.seq : undefined;
  if (channelId !== undefined && typeof seq === 'number') {
    this.resequencer.feed(channelId, seq, { kind: 'control', frame }, (item) => {
      if (item.kind === 'control') this.dispatchControl(item.frame);
    });
    return;
  }
  this.dispatchControl(frame);
}

private ingestData(header: DataHeader, payload: Buffer): void {
  if (typeof header.seq === 'number') {
    this.resequencer.feed(header.channelId, header.seq, { kind: 'data', header, payload }, (item) => {
      if (item.kind === 'data') this.dispatchData(item.header, item.payload);
    });
    return;
  }
  this.dispatchData(header, payload);
}
```

4. 通道清理挂 resequencer：`openHttp`/`openWs` 的 `onDone` 改为 `(id) => { this.channels.delete(id); this.resequencer.dropChannel(id); }`；`abortAllChannels` 末尾加 `this.resequencer.reset();`。
5. 新增观测 getter：

```ts
/** 当前就绪 leg 数（多连接观测/e2e 断言用；单连接恒 1） */
get legCount(): number {
  return this.connection instanceof TunnelGroup ? this.connection.readyLegCount : 1;
}
```

6. `http-channel.ts`/`ws-channel.ts`：`Params.connection: Connection` 改为 `connection: TunnelSender`，import 相应调整（实现零改动——已核实只用 `sendControl`/`sendData`/`waitDrain`）。
7. `index.ts` 导出 `TunnelSender` 类型。

- [ ] **Step 4: 跑测试确认通过（全包回归）**

Run: `pnpm --filter gateway-client test`
Expected: PASS（含既有 e2e/单测全绿）

- [ ] **Step 5: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/client/src/client.ts packages/client/src/http-channel.ts packages/client/src/ws-channel.ts packages/client/src/index.ts packages/client/src/connection.ts packages/client/src/client.test.ts
git commit -m "feat(gateway-client): Client 装配多连接——connections 配置(默认4)、TunnelSender 接缝、Resequencer 接线与清理"
```

---

### Task 6: Resequencer（server 镜像）

**Files:**
- Create: `packages/server/src/resequencer.ts`
- Test: `packages/server/src/resequencer.test.ts`

**Interfaces:**
- Produces（Task 7 依赖）：与 Task 3 完全同名同签名（`SequencedItem`/`Resequencer`，引 server 侧 protocol/logger 类型）。

- [ ] **Step 1: 把 Task 3 的实现与测试镜像到 server 包**

复制 `packages/client/src/resequencer.ts` → `packages/server/src/resequencer.ts`（仅 import 路径不变——两包各自的 `./protocol`/`./logger`；文件头注释追加「与 packages/client/src/resequencer.ts 互为镜像，改动必须双向同步」）。测试同样镜像（server logger 工厂名是 `createDefaultLogger`/`createConsoleLogger` 以 server 侧 `logger.ts` 实际导出为准调整）。

- [ ] **Step 2: 跑测试确认通过**

Run: `pnpm --filter gateway-server exec vitest run src/resequencer.test.ts`
Expected: PASS

- [ ] **Step 3: typecheck + commit**

Run: `pnpm typecheck`
```bash
git add packages/server/src/resequencer.ts packages/server/src/resequencer.test.ts
git commit -m "feat(gateway-server): Resequencer 服务端镜像（与 gateway-client 双向同步）"
```

---

### Task 7: TunnelSession 多 leg 化（server）

**Files:**
- Modify: `packages/server/src/session.ts`
- Modify: `packages/server/src/tunnel.ts`（仅最小适配：`handleControl(frame, leg)`/`handleData(h, p, leg, bytes)` 新签名传参，attach 逻辑属 Task 8）
- Test: `packages/server/src/session.test.ts`

**Interfaces:**
- Consumes: Task 1 协议、Task 6 `Resequencer`。
- Produces（Task 8 依赖）：
  - `export class TunnelLeg`：`constructor(ws: WebSocket, flowAck: boolean, logger: Logger)`、`sendControl(frame)`、`sendData(header, payload): boolean`、`availableCapacity(): number`、`waitDrain(): Promise<void>`、`noteDataReceived(frameBytes: number)`、`close(): void`、get `ws(): WebSocket`
  - `TunnelSession` 构造 info 扩展：`{ tunnelId; hostname; defaultPath; flowAck?; striped?: boolean; maxLegs?: number }`
  - `session.striped: boolean`、`session.legCount: number`、`session.maxLegs: number`、`session.primaryLeg: TunnelLeg`、`session.attachLeg(ws: WebSocket): TunnelLeg`、`session.legDown(leg: TunnelLeg): void`
  - `handleControl(frame, leg)`/`handleData(header, payload, leg, frameBytes)` 签名带 leg（tunnel.ts 按连接传入）
  - `TunnelHandle` 公开接口（register/unregister/sendControl/sendData/waitDrain）**不变**

- [ ] **Step 1: 写失败测试**

`packages/server/src/session.test.ts` 追加（`makeSession`/`makeChannel` 沿用文件内现有 helper；双 ws 用 `new WebSocketServer`+客户端对或文件内现有假 ws 模式）：

```ts
it('striped 会话：sendData 打 seq 并散落到多条 leg', () => {
  const wsA = fakeWs(); const wsB = fakeWs(); // 文件内现有 fake/或新写最小 { send, bufferedAmount: 0, close }
  const s = new TunnelSession(wsA, { tunnelId: 't1', hostname: 'h', defaultPath: '/', striped: true, maxLegs: 4 }, logger, () => undefined);
  s.attachLeg(wsB);
  for (let i = 0; i < 4; i++) s.sendData({ channelId: 1, kind: 'http.body' }, Buffer.from('x'));
  const seqsA = wsA.sent.filter(isData).map(seqOf); const seqsB = wsB.sent.filter(isData).map(seqOf);
  expect([...seqsA, ...seqsB].sort()).toEqual([0, 1, 2, 3]); // seq 单调无洞
});

it('legacy 会话：不发 seq、只走首 leg', () => {
  const wsA = fakeWs();
  const s = new TunnelSession(wsA, { tunnelId: 't1', hostname: 'h', defaultPath: '/' }, logger, () => undefined);
  s.sendData({ channelId: 1, kind: 'http.body' }, Buffer.from('x'));
  expect(seqOf(wsA.sent[0])).toBeUndefined();
});

it('任一 leg 断 = 整组 teardown：全部通道 onTunnelDown + onDown 一次', () => {
  const wsA = fakeWs(); const wsB = fakeWs();
  let down = 0;
  const s = new TunnelSession(wsA, { tunnelId: 't1', hostname: 'h', defaultPath: '/', striped: true, maxLegs: 4 }, logger, () => { down += 1; });
  const legB = s.attachLeg(wsB);
  const torn: number[] = [];
  const id = s.register({ kind: 'http', onControl: () => undefined, onData: () => undefined, onTunnelDown: () => torn.push(1) });
  s.legDown(legB);
  expect(torn).toEqual([1]);
  expect(down).toBe(1);
  expect(wsB.closed).toBe(true);
});

it('per-leg ack：attach leg 收到的字节只在该 leg 上回执', () => {
  const wsA = fakeWs(); const wsB = fakeWs();
  const s = new TunnelSession(wsA, { tunnelId: 't1', hostname: 'h', defaultPath: '/', flowAck: true, striped: true, maxLegs: 4 }, logger, () => undefined);
  const legB = s.attachLeg(wsB);
  s.handleData({ channelId: 1, kind: 'http.body' }, Buffer.alloc(200 * 1024), legB, 200 * 1024 + 64);
  expect(wsB.sent.some((f) => f.type === 'tunnel.ack')).toBe(true);
  expect(wsA.sent.some((f) => f.type === 'tunnel.ack')).toBe(false);
});

it('乱序入站经 Resequencer 按序交付通道', () => {
  const wsA = fakeWs();
  const s = new TunnelSession(wsA, { tunnelId: 't1', hostname: 'h', defaultPath: '/', striped: true, maxLegs: 4 }, logger, () => undefined);
  const got: string[] = [];
  s.register({ kind: 'http', onControl: () => undefined, onData: (h, p) => got.push(p.toString()), onTunnelDown: () => undefined });
  const leg = s.primaryLeg;
  s.handleData({ channelId: 1, kind: 'http.body', seq: 1 }, Buffer.from('b'), leg, 10);
  s.handleData({ channelId: 1, kind: 'http.body', seq: 0 }, Buffer.from('a'), leg, 10);
  expect(got).toEqual(['a', 'b']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/session.test.ts`
Expected: FAIL（attachLeg/striped 未定义）

- [ ] **Step 3: 实现**

`session.ts` 重构（要点全列，既有逻辑逐字保留的不再重复）：

1. 新增 `TunnelLeg`（从现 TunnelSession 抽出 per-ws 部分：send 封装、HIGH/LOW 水位与 drain 轮询、ack 节拍 `noteDataReceived`/`flushAck`/`scheduleAckFlush`——逻辑逐字搬移，作用于自己的 ws）：

```ts
export class TunnelLeg {
  private dataBytesReceived = 0;
  private lastAckSentBytes = 0;
  private ackFlushTimer: NodeJS.Timeout | null = null;
  private drainWaiters: Array<() => void> = [];
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly ws: WebSocket,
    private readonly flowAck: boolean,
    private readonly logger: Logger,
  ) {}

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

  availableCapacity(): number {
    return Math.max(0, HIGH_WATER_BYTES - this.ws.bufferedAmount);
  }

  waitDrain(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
      this.startDrainPoll();
    });
  }

  /** 数据帧接收记账：flowAck 门控 + 128KiB 节拍 + 1s 兜底（与现 session 版逐字同逻辑，作用于本 leg） */
  noteDataReceived(frameBytes: number): void {
    if (!this.flowAck) return;
    this.dataBytesReceived += frameBytes;
    if (this.dataBytesReceived - this.lastAckSentBytes >= ACK_EVERY_BYTES) {
      this.flushAck();
    } else {
      this.scheduleAckFlush();
    }
  }

  close(): void {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer);
      this.ackFlushTimer = null;
    }
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
    const waiters = this.drainWaiters.splice(0);
    for (const waiter of waiters) waiter();
    this.ws.close(1000, 'tunnel teardown');
  }

  private flushAck(): void {
    if (this.ackFlushTimer) {
      clearTimeout(this.ackFlushTimer);
      this.ackFlushTimer = null;
    }
    if (this.dataBytesReceived === this.lastAckSentBytes) return;
    this.lastAckSentBytes = this.dataBytesReceived;
    try {
      this.sendControl({ type: 'tunnel.ack', bytes: this.dataBytesReceived });
    } catch {
      // ws 关闭窗内 send 抛错：隧道将断，ack 失去意义，close 事件随后自清
    }
  }

  private scheduleAckFlush(): void {
    if (this.ackFlushTimer) return;
    this.ackFlushTimer = setTimeout(() => {
      this.ackFlushTimer = null;
      this.flushAck();
    }, ACK_FLUSH_MS);
    this.ackFlushTimer.unref();
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
```

2. `TunnelSession` 改造：
   - 字段：`private legs: TunnelLeg[]`（`legs[0]` = primary）、`readonly striped: boolean`、`readonly maxLegs: number`、`private readonly sendSeq = new Map<number, number>()`、`private readonly resequencer`（构造：`onOverflow` → `logger.error` + `this.teardown()` + 全 leg `ws.close(1002)`）。
   - 构造：primary ws 包成 `new TunnelLeg(ws, flowAck, logger)` 入 `legs[0]`；`striped = info.striped === true`；`maxLegs = info.maxLegs ?? 1`。
   - `attachLeg(ws): TunnelLeg`：`const leg = new TunnelLeg(ws, this.flowAck, this.logger); this.legs.push(leg); return leg;`
   - `legDown(leg): void`：任一 leg 断 = 整组 teardown（幂等由现有 `down` latch 保证）：`this.teardown()`（teardown 内追加：遍历 `legs` 清 timer、`ws.close(1000)`——已关的幂等）。
   - 发送侧：

```ts
sendControl(frame: ControlFrame): void {
  const channelId = 'channelId' in frame ? frame.channelId : undefined;
  if (!this.striped || channelId === undefined) {
    this.legs[0].sendControl(frame);
    return;
  }
  this.legs[this.pickLeg()].sendControl({ ...frame, seq: this.nextSeq(channelId) });
}

sendData(header: DataHeader, payload: Buffer): boolean {
  if (!this.striped) return this.legs[0].sendData(header, payload);
  const idx = this.pickLeg();
  this.legs[idx].sendData({ ...header, seq: this.nextSeq(header.channelId) }, payload);
  return this.legs[idx].availableCapacity() > 0;
}

waitDrain(): Promise<void> {
  return Promise.race(this.legs.map((l) => l.waitDrain())).then(() => undefined);
}

private nextSeq(channelId: number): number { /* 同 TunnelGroup */ }
private pickLeg(): number { /* availableCapacity 最高者下标；打平取先 */ }
```

   - 接收侧（`handleControl`/`handleData` 带 leg 参数；ack 记账移到 leg）：

```ts
handleControl(frame: ControlFrame, leg: TunnelLeg): void {
  if (frame.type === 'ping') { leg.sendControl({ type: 'pong' }); return; }
  if (frame.type === 'pong') return;
  const channelId = 'channelId' in frame ? frame.channelId : undefined;
  if (channelId === undefined) { /* 现有 WARN 丢弃 */ return; }
  const seq = 'seq' in frame ? frame.seq : undefined;
  if (typeof seq === 'number') {
    this.resequencer.feed(channelId, seq, { kind: 'control', frame }, (item) => {
      if (item.kind === 'control') this.dispatchControl(item.frame);
    });
    return;
  }
  this.dispatchControl(frame);
}

handleData(header: DataHeader, payload: Buffer, leg: TunnelLeg, frameBytes: number): void {
  leg.noteDataReceived(frameBytes); // ack 记账按收到 leg（与客户端 per-leg 在途记账同口径）
  if (typeof header.seq === 'number') {
    this.resequencer.feed(header.channelId, header.seq, { kind: 'data', header, payload }, (item) => {
      if (item.kind === 'data') this.dispatchData(item.header, item.payload);
    });
    return;
  }
  this.dispatchData(header, payload);
}
```

   - 现有 `handleControl`/`handleData` 主体改名 `dispatchControl`/`dispatchData`（内容逐字不变）；`unregister` 追加 `this.resequencer.dropChannel(channelId);`；`teardown` 追加 `this.resequencer.reset();` 与 legs 清理；新增 `get primaryLeg(): TunnelLeg { return this.legs[0]; }`、`get legCount(): number { return this.legs.length; }`。
   - `noteDataReceived`（session 级旧方法）删除——由 leg 版取代（tunnel.ts 调用点见下）。

3. `TunnelHandle` 接口不动；`PendingChannel` 不动。

4. `tunnel.ts` 最小适配（保持编译与旧行为，不含 attach）：message 路由处 `session.noteDataReceived(buf.length)` + `session.handleData(header, payload)` 改为 `session.handleData(header, payload, session.primaryLeg, buf.length)`；`session.handleControl(frame)` 改为 `session.handleControl(frame, session.primaryLeg)`。

- [ ] **Step 4: 跑测试确认通过（全包回归 + typecheck）**

Run: `pnpm --filter gateway-server test && pnpm typecheck`
Expected: 全绿（tunnel.ts 最小适配已随本任务完成，attach 测试在 Task 8 才加）

- [ ] **Step 5: commit**

```bash
git add packages/server/src/session.ts packages/server/src/session.test.ts packages/server/src/tunnel.ts
git commit -m "feat(gateway-server): TunnelSession 多 leg 化——TunnelLeg 抽取、per-leg ack/背压、seq 条带化发送、Resequencer 入站、任一 leg 断全组 teardown"
```

---

### Task 8: tunnel.ts attach 握手（server）

**Files:**
- Modify: `packages/server/src/tunnel.ts`
- Test: `packages/server/src/tunnel.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `session.attachLeg/legDown/striped/maxLegs/handleControl(frame, leg)/handleData(h, p, leg, bytes)`；Task 1 的 `ATTACH_REJECT_CODE`。
- Produces：`export const MAX_LEGS_PER_TUNNEL = 16`（tunnel.ts）。

- [ ] **Step 1: 写失败测试**

`packages/server/src/tunnel.test.ts` 追加（沿用文件内真实 ws 客户端驱动模式）：

```ts
it('协商 multiConn 的 primary：hello.ack 回 multiConn.max', async () => {
  const ws = await dialTunnel({ hostname: 'pc-a', defaultPath: '/', multiConn: { count: 4 } });
  const ack = await nextControl(ws);
  expect(ack).toMatchObject({ type: 'hello.ack', multiConn: { max: 4 } });
  ws.close();
});

it('attach 成功：回带在线 striped 隧道 id → ack 同一 tunnelId 入组', async () => {
  const wsA = await dialTunnel({ hostname: 'pc-a', defaultPath: '/', multiConn: { count: 4 } });
  const ackA = await nextControl(wsA);
  const wsB = await dialTunnel({ hostname: 'pc-a', defaultPath: '/', attach: true, tunnelId: ackA.tunnelId });
  const ackB = await nextControl(wsB);
  expect(ackB.tunnelId).toBe(ackA.tunnelId);
  wsA.close(); wsB.close();
});

it('attach 目标不存在/legacy 会话/组满 → 4410', async () => {
  // 不存在
  const ws1 = await dialTunnel({ hostname: 'x', defaultPath: '/', attach: true, tunnelId: randomUUID() });
  await expect(nextClose(ws1)).resolves.toBe(4410);
  // legacy 会话（未声明 multiConn）
  const wsA = await dialTunnel({ hostname: 'pc-l', defaultPath: '/' });
  const ackA = await nextControl(wsA);
  const ws2 = await dialTunnel({ hostname: 'pc-l', defaultPath: '/', attach: true, tunnelId: ackA.tunnelId });
  await expect(nextClose(ws2)).resolves.toBe(4410);
  wsA.close();
});

it('attach leg 断开 → 整隧道注销（registry 不再持有）', async () => {
  const wsA = await dialTunnel({ hostname: 'pc-g', defaultPath: '/', multiConn: { count: 2 } });
  const ackA = await nextControl(wsA);
  const wsB = await dialTunnel({ hostname: 'pc-g', defaultPath: '/', attach: true, tunnelId: ackA.tunnelId });
  await nextControl(wsB);
  wsB.terminate();
  await vi.waitFor(() => expect(server.tunnels.has(ackA.tunnelId)).toBe(false));
  wsA.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter gateway-server exec vitest run src/tunnel.test.ts`
Expected: FAIL（attach/multiConn 未实现）

- [ ] **Step 3: 实现**

`tunnel.ts` 改动：

1. 顶部导出 `export const MAX_LEGS_PER_TUNNEL = 16;`
2. hello 解析段（现 `frame.client` 取值处）追加：`const attach = frame.client.attach === true; const multiConnCount = frame.client.multiConn?.count;`
3. `onTunnelConnection` 的 hello 分支重构为两路：

```ts
// attach 路：加入既有 striped 会话；任何一项不符 → 4410（spec §3.2）
if (attach) {
  const target = requestedId !== undefined && UUID_SHAPE.test(requestedId) ? ctx.tunnels.get(requestedId) : undefined;
  if (target === undefined || !target.striped || target.legCount >= target.maxLegs) {
    clearTimeout(helloTimer);
    ctx.logger.warn('attach 拒绝', { tunnelId: requestedId });
    ws.close(ATTACH_REJECT_CODE, 'attach rejected');
    return;
  }
  clearTimeout(helloTimer);
  const leg = target.attachLeg(ws);
  ws.send(encodeControl({ type: 'hello.ack', tunnelId: target.tunnelId, multiConn: { max: target.maxLegs } }));
  ctx.logger.info('隧道 attach 接入', { hostname: target.hostname, tunnelId: target.tunnelId, legs: target.legCount });
  session = target; // 后续 message/close 统一走下方已就绪路由（带 leg）
  activeLeg = leg;
  return;
}
// primary 路（现有逻辑）+ striped 判定与 ack 扩展：
const striped = typeof multiConnCount === 'number' && multiConnCount >= 2;
const maxLegs = striped ? Math.min(Math.floor(multiConnCount), MAX_LEGS_PER_TUNNEL) : 1;
// …new TunnelSession(ws, { tunnelId, hostname, defaultPath, flowAck, striped, maxLegs }, …)…
ws.send(encodeControl(striped
  ? { type: 'hello.ack', tunnelId, multiConn: { max: maxLegs } }
  : { type: 'hello.ack', tunnelId }));
```

4. 已就绪路由改为带 leg：primary 路建 session 后记 `activeLeg = session.primaryLeg`（Task 7 已提供该 getter；attach 路 `activeLeg = leg`）。message 处（覆盖 Task 7 的最小适配写法）：

```ts
session.noteDataReceived 改为内联于：session.handleData(header, payload, activeLeg, buf.length);
session.handleControl(frame) 改为 session.handleControl(frame, activeLeg);
```

5. close 处理：primary leg 断保持现语义（`session?.teardown()`）；attach leg 断走 `session.legDown(activeLeg)`——统一写法：

```ts
ws.on('close', () => {
  clearTimeout(helloTimer);
  if (session && activeLeg) session.legDown(activeLeg); // legDown 幂等：整组 teardown 一次
  else session?.teardown(); // 理论不可达（activeLeg 必随 session 同设），防御保留
});
```

- [ ] **Step 4: 跑测试确认通过（全包回归 + typecheck）**

Run: `pnpm --filter gateway-server test && pnpm typecheck`
Expected: 全绿（含 Task 7 遗留调用点收口）

- [ ] **Step 5: commit**

```bash
git add packages/server/src/tunnel.ts packages/server/src/tunnel.test.ts
git commit -m "feat(gateway-server): 隧道 attach 握手——multiConn 协商应答、4410 拒绝矩阵、MAX_LEGS_PER_TUNNEL=16、per-leg 帧路由"
```

---

### Task 9: 插件透传 + 文档同步

**Files:**
- Modify: `packages/dsh-remote-access/src/host/config.ts`（`RemoteAccessConfig` 加 `connections?: number`）
- Modify: `packages/dsh-remote-access/src/host/connection-manager.ts:55-67`（透传）
- Modify: `README.md:52-64`（client 配置表）
- Modify: `docs/superpowers/specs/2026-08-21-gateway-client-design.md`、`2026-08-21-gateway-server-design.md`（头部加修订行）
- Test: `packages/dsh-remote-access/src/host/connection-manager.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `ClientOptions.connections`。

- [ ] **Step 1: 写失败测试**

`connection-manager.test.ts` 仿既有「compress 开关原样透传」用例追加：

```ts
it('enable 将 connections 原样透传给 gateway-client 构造参数', async () => {
  await manager.enable({ gateway: 'gw.local:9000', token: 't', hostname: '', compress: false, connections: 8 });
  expect(clientCtorSpy).toHaveBeenCalledWith(expect.objectContaining({ connections: 8 }));
});
```

- [ ] **Step 2: 跑测试确认失败 → 实现 → 通过**

Run: `pnpm --filter dsh-remote-access exec vitest run src/host/connection-manager.test.ts`
实现：`config.ts` 的 `RemoteAccessConfig` 加 `connections?: number`（注释：隧道连接数，默认 4，详见网关 README）；`connection-manager.ts` 构造参数加 `connections: cfg.connections`（`undefined` 时 Client 默认 4，天然透传）。再跑确认 PASS。

- [ ] **Step 3: 文档**

`README.md` client 配置示例 `compress` 行后追加：

```js
  connections: 4,                          // 可选：隧道连接数（默认 4，1=单连接 legacy 模式）；
                                           // 多连接条带化提升大传输吞吐，老服务端自动降级单连接
```

两份 2026-08-21 spec 头部各加修订行：`修订：2026-08-28——多连接（帧级条带化 + 每通道重排序）：hello multiConn/attach、hello.ack max、通道帧 seq、4410，详见《2026-08-28-gateway-multiconn-design.md》。`

- [ ] **Step 4: typecheck + 全量测试 + commit**

Run: `pnpm typecheck && pnpm test`
```bash
git add packages/dsh-remote-access/src/host/config.ts packages/dsh-remote-access/src/host/connection-manager.ts packages/dsh-remote-access/src/host/connection-manager.test.ts README.md docs/superpowers/specs/2026-08-21-gateway-client-design.md docs/superpowers/specs/2026-08-21-gateway-server-design.md
git commit -m "feat(dsh-remote-access): connections 配置透传；README 与帧协议 spec 同步多连接修订"
```

---

### Task 10: 真机 e2e + 性能人工验证

**Files:**
- Modify: `packages/server/package.json`（devDependencies 加 `"gateway-client": "workspace:*"`）
- Create: `packages/server/src/multiconn.e2e.test.ts`

**Interfaces:**
- Consumes: 全部前序任务（`GatewayServer` from './server'、`Client` from 'gateway-client'）。

- [ ] **Step 1: 写 e2e 测试**

`packages/server/src/multiconn.e2e.test.ts`（全文新建——真实 GatewayServer + 真实 gateway-client + 真实 upstream 三段全链路）：

```ts
/**
 * 多连接真机 e2e：真实 server/client/upstream，验证 4 leg 条带化下大文件上传+下载的
 * 字节完整性与顺序、整组重连恢复、legacy 模式。浏览器侧用 Node http 直连网关端口。
 */
import http from 'node:http';
// …imports: GatewayServer from './server'、Client from 'gateway-client'、crypto…

// 测试 1：4 leg 大文件下载（upstream → client → server → 浏览器侧）字节完整
//   - upstream 对 GET /big 回 8MiB 模式字节（i % 251）
//   - client = new Client({ upstreamUrl, gatewayUrl: ws://127.0.0.1:<port>/__gateway__/tunnel, hostname: 'pc-e' })
//   - 等 client.legCount === 4
//   - 浏览器侧：http.get 网关 /__gateway__/select 流程太重——用 cookie 会话直接请求：
//     先 GET /__gateway__/select?tunnelId=<client.tunnelId>&token=（无 token 配置时直接建立会话），
//     再带 cookie GET /big，校验 8MiB 逐字节
// 测试 2：大文件上传（8MiB POST body 经隧道到 upstream），upstream 收集体节校验
// 测试 3：connections: 1 跑同一下载，字节完整（legacy 回归）
// 测试 4：整组重连——terminate 一条 attach leg（服务端 registry 取 session 关一条 ws），
//   等 legCount 回到 4 后再次下载校验完整
```

> 选择页会话建立的确切路径以 `select-page.ts`/`browser-session.ts` 现有测试（`browser-session.test.ts`/`e2e.test.ts`）里的会话建立方式为范本复用；若直连通道需 token 探测，Client 配置不启用 token 即可走「全部放行」路径。

- [ ] **Step 2: 跑测试至通过**

Run: `pnpm --filter gateway-server exec vitest run src/multiconn.e2e.test.ts`
Expected: PASS（不稳定时先查 leg 就绪等待与 8MiB 超时预算，必要时提到 30s）

- [ ] **Step 3: 全量回归 + typecheck + commit**

Run: `pnpm typecheck && pnpm test`
```bash
git add packages/server/package.json packages/server/src/multiconn.e2e.test.ts pnpm-lock.yaml
git commit -m "test(gateway-server): 多连接真机 e2e——4 leg 大文件双向完整性、整组重连恢复、legacy 回归"
```

- [ ] **Step 4: 性能人工验证（spec §10，非自动化）**

用 `packages/proxy`（gateway-proxy，throttle 限流验证基座）在限流链路下对比：

```bash
# 终端1：pnpm run server --port 9000
# 终端2：gateway-proxy 限流（如 5Mbps / RTT 100ms）挂在 server 与 client 之间
# 终端3：upstream 起一个返回 100MiB 文件的 http 服务；client connections=1 与 connections=4
#         各跑一次浏览器侧下载计时（服务端「请求完成」日志的 totalMs 字段）
# 预期：4 连接显著快于单连接；若无收益，回 spec 调整默认值（§1.2：确认收益后才定稿默认 4）
```

结果记入本计划文件末尾的「验证记录」小节（执行时追加）再合入主线。

---

## 验证记录

### 性能人工验证（Task 10 Step 4，spec §10）——操作步骤（合入主线前执行并回填结果）

> 状态：**待人工执行**（T10 只落地步骤，不在自动化任务内执行）。执行后把实测数据回填到本节末尾再合入主线。

1. 终端1：`pnpm run server --port 9000` 起网关服务端。
2. 终端2：`packages/proxy`（gateway-proxy，throttle 限流验证基座）挂在 server 与 client 之间，限流 5Mbps / RTT 100ms。
3. 终端3：upstream 起一个返回 100MiB 文件的 http 服务；client 分别以 `connections: 1` 与 `connections: 4`（`packages/client/client.config.mjs`）各跑一次。
4. 浏览器侧各下载一次 100MiB 文件并计时；同时对照服务端「请求完成」日志的 `totalMs`/`headMs`/`bodyBytes` 字段。
5. 预期：4 连接显著快于单连接；若无收益，回 spec §1.2 调整默认值（确认收益后才定稿默认 4）。

实测结果（执行时回填）：

| connections | totalMs | headMs | bodyBytes | 备注 |
|-------------|---------|--------|-----------|------|
| 1 | （待填） | （待填） | （待填） | |
| 4 | （待填） | （待填） | （待填） | |
