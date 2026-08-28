# proxy 并入 chaos-proxy 设计（能力注入 + 删除 proxy 包）

**日期**：2026-08-28
**状态**：已评审（brainstorming 分节确认）
**范围**：`packages/chaos-proxy`（新增 shared 限速与连接准入原语、手动验证脚本）、`packages/proxy`（整包删除）、根 `package.json`、`AGENT.md` 验证章节、multiconn plan 手动验证步骤

---

## 1. 背景与问题

monorepo 现有两个 TCP 代理包，能力重叠且定位失衡：

- `packages/proxy`（gateway-proxy）：限流反代 CLI（bin `harness-proxy`），连接准入令牌桶（8/s FIFO）+ 全局共享带宽桶（50KB/s）。**无任何包依赖它**，仅根脚本 `pnpm proxy` 引用，实际角色是手动验证/联调工具。
- `packages/chaos-proxy`：TCP 故障注入测试库（private，client/server e2e-chaos 消费），`setThrottle` 为**每连接每方向独立限速**。

清点发现的问题：

1. **带宽限速原语重复实现**（proxy 的 TokenBucket/ThrottleStream vs chaos-proxy 的泵预算）。
2. **两个包单独都满足不了 multiconn 手动验证的需求**：plan（2026-08-28-gateway-multiconn.md Task 10 Step 4）要求「限流 5Mbps / RTT 100ms」——proxy 没有 RTT 参数；chaos-proxy 有 `setLatency` 但 throttle 是每连接独立限速（4 连接 = 4×5Mbps），模拟不了「共享链路」。
3. **proxy 只是验证场景**（用户确认），CLI 产品化形态（165 行 cli.ts、bin 启动器、单行诊断/退出码协议）无保留价值。
4. **AGENT.md 验证拓扑依赖 proxy**：「限流 8 连接/s + 全局 50KB/s」形态注明「线上断连类问题只在该形态下可复现」——准入挤压是该形态的组成部分，**不能砍**（brainstorming 中据此将准入限流从 YAGNI 翻转为迁入）。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 合并形态 | **能力注入 + 删除 proxy 包**：不是两包同居，是把 proxy 的限流语义注入 chaos-proxy 故障注入框架 |
| 带宽限速 | chaos-proxy `setThrottle(bps, mode?)` 增加 `'shared'` 模式（全局共享预算）；现有 per-conn 语义零变化 |
| 连接准入限流 | **迁入** chaos-proxy 为 `setAdmissionRate(connPerSec)`（AGENT.md 验证拓扑是消费者） |
| proxy 资产处置 | ThrottleStream / TokenBucket / ConnectionLimiter **类不迁**（泵模型天然覆盖 FIFO/背压/切片）；CLI 产品化外壳删除 |
| 手动验证工具 | 新增极简脚本 `packages/chaos-proxy/scripts/throttle-proxy.ts`（非 bin、非产品化）；根 `proxy` 脚本保留但改指向它 |
| gateway-proxy 文档 | spec 与 plan **直接删除**（不标废弃） |
| proxy CLI 参数解析 | k/m 后缀等解析逻辑随 cli.ts 删除；throttle-proxy 脚本自带极简解析 |

### proxy 资产处置总表

| proxy 资产 | 处置 | 理由 |
|---|---|---|
| 全局共享带宽桶语义 | 迁入 → `setThrottle(bps, 'shared')` | 手动验证「共享链路」需求；泵模型实现 ~15 行 |
| 连接准入限流语义 | 迁入 → `setAdmissionRate(connPerSec)` | AGENT.md 验证拓扑消费者 |
| ThrottleStream（Transform 背压） | 不迁 | 泵模型 `socket.pause()` 真实 TCP 背压，保真度更高 |
| TokenBucket / ConnectionLimiter 类 | 不迁 | 泵模型天然具备 FIFO 队列、超预算部分写、切片续发 |
| 截断修复（FIN 排空传播） | 不迁 | chaos-proxy 已有等价语义（19f03e9） |
| CLI / bin / 产品化外壳 | 删除 | 用户确认无保留价值；脚本化替代 |
| spec + plan 文档 | 删除 | 包已删，文档无独立价值 |

## 3. chaos-proxy：`setThrottle` 增加 shared 模式

```ts
setThrottle(bytesPerSec: number, mode?: 'per-conn' | 'shared'): void;
//                                     缺省 'per-conn' —— 现有行为零变化
```

- **per-conn（现状，不动）**：泵每 tick 给每个 pipe 各自一份预算（`bps × 10ms / 1000`），N 连接总吞吐可达 N×bps。S11 场景与现有单测语义锁定不变。
- **shared（新增）**：泵每 tick 的全局预算在**所有在场 pipe 间分配**，N 连接总吞吐 ≤ bps——模拟「共享链路总带宽」。分配顺序按在场集合迭代序（先到先得），不做公平轮转（YAGNI：手动验证要的是总量约束，不是公平性）。
- 两模式互斥：同设一个方法，后调用覆盖前值。
- 不用 proxy 的「1s 突发容量令牌桶」，用「匀速全局预算」：泵模型已具备 FIFO 队列与超预算部分写（19f03e9），突发行为差异不影响「4 连接 vs 1 连接」对比实验的结论（总量约束才是关键），实现只需在泵循环改 ~15 行。

## 4. chaos-proxy：`setAdmissionRate` 新原语

```ts
setAdmissionRate(connPerSec: number): void;  // 0 = 不限（缺省）
```

- 新建连接进 FIFO 队列，按速率放行：每 `1000/rate` ms 放一队首（匀速放行，非突发桶）。
- 排队中 socket close → 出队取消（proxy ConnectionLimiter 同款语义：不空耗名额）。
- 放行后才 `net.connect` target（与 proxy admit 语义一致：准入前不消耗 target 资源）。
- 与 blackhole/rejectUpgrade 的关系：准入排队在故障判定**之前**——黑洞/拒升级期间新连接照样排队，放行后按当时故障状态处理（黑洞中建连即黑、reject 中建连即拒）。`setAdmissionRate(0)` 时排队连接立即全部放行（清空队列）。

## 5. 手动验证脚本 `packages/chaos-proxy/scripts/throttle-proxy.ts`

~60 行，非产品化：

```ts
// 用法：tsx packages/chaos-proxy/scripts/throttle-proxy.ts
//   [--listen 9080] [--target 127.0.0.1:9000]
//   [--throttle 50k] [--shared] [--latency 100] [--jitter 50] [--admission 8]
```

- `createChaosProxy` + 极简参数解析（支持 k/m 后缀，非法值直接抛错退出——无单行诊断/退出码协议等产品化包装）。
- `--shared` 时 `setThrottle(bps, 'shared')`，缺省 per-conn。
- `pnpm install` 时 tsx 加为 chaos-proxy **devDependency**（库本体 zero runtime dep 红线不破；脚本只是开发工具）。
- 无 bin、无完整参数校验、无 SIGINT 协议（Ctrl-C 直接杀，泵定时器已 unref）。

## 6. 删除清单与脚本/文档处置

| 位置 | 变化 |
|---|---|
| `packages/proxy/` | **整目录删除**（5 源文件 + 4 测试 + bin + 4 配置） |
| 根 `package.json` | `"proxy"` 脚本**保留**，改为 `tsx packages/chaos-proxy/scripts/throttle-proxy.ts --throttle 50k --shared --admission 8`（默认参数对齐 AGENT.md 验证拓扑：8 连接/s + 全局 50KB/s） |
| `docs/superpowers/specs/2026-08-27-gateway-proxy-design.md` | **删除** |
| `docs/superpowers/plans/2026-08-27-gateway-proxy-plan.md` | **删除** |
| `docs/superpowers/plans/2026-08-28-gateway-multiconn.md` | Task 10 Step 4 与「验证记录」中的工具名改写：gateway-proxy → throttle-proxy 脚本（参数也终于能写全 `--throttle 5m --shared --latency 100`） |
| `pnpm-lock.yaml` | `pnpm install` 刷新 |

## 7. AGENT.md 验证章节更新

三处改动，**验证拓扑形态与判定标准不变**：

1. **拓扑描述**：`[proxy :9080 限流 8 连接/s + 全局 50KB/s]` 的工具说明从 gateway-proxy 改为 throttle-proxy 脚本（shared 模式 + admission）；「共享 50KB/s 全局带宽桶」等复现原理描述不变。
2. **步骤 1**：`pnpm run proxy` 命令形态不变（根脚本已改指向），说明文字更新。
3. **排查指引**：「响应尾包截断 → 查 `packages/proxy/src/server.ts` 优雅关闭语义」改为「→ 查 `packages/chaos-proxy/src/chaos-proxy.ts` 的 FIN 排空传播语义（sourceClosed/destEnded）」。

## 8. 测试计划（vitest）

**chaos-proxy.test.ts 追加 5 用例**（现有用例零改动）：

| # | 用例 | 断言 |
|---|---|---|
| T1 | shared 模式：2 连接并行各传 N 字节 | 总耗时 ≥ 2N/bps 保守下界（两连接竞争同一预算） |
| T2 | 对照组：per-conn 模式 2 连接各传 N 字节 | 总耗时 ≈ N/bps（各自独享）——锁死两模式语义差异 |
| T3 | `setThrottle(bps)` 不传 mode | 行为与现状一致（回归保护） |
| T4 | `setAdmissionRate(4)`：12 并发连接 | 前 4 立即通，其余按 ~250ms 间隔放行（对齐 proxy server.test.ts 准入节奏语义） |
| T5 | 准入排队中客户端 close | 出队取消、不占名额（后续连接按序放行） |

**手动 smoke**：`pnpm run proxy` 起代理 → curl 经 :9080 下载，观察吞吐 ≤ 50KB/s。

## 9. 验证策略

- `pnpm typecheck` → `pnpm format` → `pnpm test` 全绿（AGENT.md 约束顺序）。
- client/server e2e-chaos **零改动**回归不破（`setThrottle` 签名向后兼容，`setAdmissionRate` 缺省 0 不影响）。
- AGENT.md 端到端验证流程（浏览器 + Playwright）本次**不执行**——仅工具替换、拓扑形态不变，留待下一次复杂功能修改时随流程验证。

## 10. 明确不做（YAGNI）

- TokenBucket / ThrottleStream / ConnectionLimiter 类的物理迁移（语义迁入、类不迁）
- shared 模式的连接间公平轮转（总量约束即可）
- 准入限流的突发容量（匀速放行）
- throttle-proxy 脚本的产品化（bin、完整校验、单行诊断、退出码协议、SIGINT 优雅关停）
- per-conn 与 shared 混合模式；准入速率的动态调整 API（`setAdmissionRate(0)` 即关闭，够用）
- AGENT.md 端到端验证流程的本次执行（见 §9）
