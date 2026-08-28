# 网关稳健性与登录态持久化设计

**日期**：2026-08-28
**状态**：已评审（brainstorming 分节确认）
**范围**：`packages/server`（会话 TTL/快照/cookie/瞬断宽限）、`packages/dsh-remote-access`（日志修复）、`packages/chaos-proxy`（新建私有包）、双端 e2e-chaos 场景库

---

## 1. 背景与问题

真实网络环境下客户端频繁出现 `[dsh-remote-access] [ERROR] 隧道连接错误` 且无详细原因。根因分析（代码证据）：

1. **诊断丢失**：`dsh-remote-access/src/host/connection-manager.ts` 的 logger 适配层丢弃 context 参数——`gateway-client` 传入的 `err.stack`、断开 `code/reason/readyMs` 全部被吞，且 debug 完全静默。
2. **断连可能性谱系**：传输层故障（ECONNRESET/半开/黑洞/中间盒空闲超时/高延迟/限速/重连风暴）、握手失败（ECONNREFUSED/反代 502/DNS/TLS）、协议层（坏帧/巨帧）。这些故障无回归测试覆盖，系统对它们的稳健性未被验证。
3. **cookie 登录态丢失**：`browser-session.ts` 全内存 + session cookie（无 Max-Age），四场景中仅"隧道瞬断"已由 tunnelId 回带复用解决。

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 模拟环境形态 | **chaos-proxy 库 + vitest 自动化场景**；不做独立 CLI |
| tunnelId 持久化 | **不落盘**——仅进程生命周期内重连复用（现状），客户端进程退出即销毁；gateway-client 与 dsh-remote-access 在 M1 零改动 |
| 登录态覆盖 | ③ 服务端重启（快照恢复）+ ④ 浏览器重开（cookie Max-Age）；② 客户端进程重启明确放弃（进程退出 = 会话作废，重新选择） |
| token 落盘 | 明文 JSON + `0o600`（与 `~/.dsh/.remote-access.yaml` 明文存 token 的现水位一致） |
| 心跳判死参数 | 不新增旋钮——`heartbeatIntervalMs` 已可配（判死 = 3×interval），测试用短心跳 |

### 行为矩阵

| 场景 | 结果 |
|---|---|
| ① 隧道瞬断（进程活着） | ✅ 现状：回带复用，cookie 恢复 |
| ② 客户端进程退出/重启 | ❌ 明确放弃：tunnelId 销毁，会话作废重新选择；服务端孤儿会话等 TTL 过期 |
| ③ 服务端重启 | ✅ 快照恢复会话 + 客户端内存 tunnelId 回带复用（服务端重启≠客户端退出，重启后 tunnels 表为空必复用成功）→ 老 cookie 免重登 |
| ④ 浏览器重开 | ✅ Max-Age 内免重登（隧道在线或可复用回来为前提） |

## 3. 里程碑

| # | 内容 | 涉及包 |
|---|---|---|
| M0 | logger 适配层透传 context + 恢复 debug（诊断前提） | dsh-remote-access |
| M1 | 会话 TTL + 快照持久化 + cookie Max-Age | server（+ CLI 参数） |
| M2 | chaos-proxy 私有包（TCP 故障注入原语） | chaos-proxy（新建） |
| M3 | 故障场景库 + 瞬断宽限 + 场景驱动修复 | server / client e2e |

## 4. M0：日志修复（dsh-remote-access）

`connection-manager.ts` 适配层改为透传 context：

```ts
const fmt = (lv: string, m: string, c?: Record<string, unknown>) =>
  `${LOG_PREFIX} [${lv}] ${m}${c ? ' ' + JSON.stringify(c) : ''}`;
logger: {
  debug: (m, c) => console.debug(fmt('DEBUG', m, c)),
  info:  (m, c) => console.info(fmt('INFO', m, c)),
  warn:  (m, c) => console.warn(fmt('WARN', m, c)),
  error: (m, c) => console.error(fmt('ERROR', m, c)),
}
```

安全红线不变：gateway-client 日志约定本就不放 token/Authorization/hello 原文，context 透传不引入泄露面。错误语义分级不变（`'error'` 瞬时诊断 / `'fatal'` 终态），状态机行为不变。

## 5. M1：登录态持久化（server）

### 5.1 会话 TTL + 快照

- `BrowserSession` 增加 `expiresAt: number`（创建时刻 + ttl）。
- `BrowserSessionStore` 构造选项：`{ ttlMs?: number }`（默认 7 天）、`{ persistPath?: string }`（缺省 = 纯内存，现有测试全部密封零影响）。
- **过期语义**：`get()` 惰性检查，过期即删返回 undefined → 302 重选；无后台定时器（防悬挂进程/测试）；存取与落盘时顺带清扫。
- **快照格式**：`{ version: 1, sessions: [{ uuid, tunnelId, hostname, token, expiresAt }] }`。
- **写入**：create 时同步落盘（kill 窗口为零；防抖会留下"cookie 已发但快照未盘"的重启重选窗）；临时文件 + rename 原子写；`mode: 0o600`。
- **启动恢复**：文件缺失 → 空表正常启动；JSON 损坏 → WARN 降级空表（不崩进程）；过期条目加载即丢弃。
- `GatewayServerOptions` 新增 `browserSessionTtlMs?: number`（默认 7d）、`sessionStorePath?: string`；server CLI 加 `--session-store <path>` / `--browser-session-ttl <ms>` 可选参数。

### 5.2 cookie Max-Age

- `buildSessionCookie(uuid, maxAgeSec)`：`gateway_sid=<uuid>; HttpOnly; SameSite=Lax; Path=/; Max-Age=<秒>`。
- Max-Age 与 TTL 同源（`browserSessionTtlMs/1000`）——cookie 与服务端会话同时到期，无悬空态。
- TTL 与持久化正交：不配 `sessionStorePath` 时 cookie 照样带 Max-Age。
- 现有断言 `not.toMatch(/expires|max-age/i)` 改为断言 Max-Age 存在且值正确。

### 5.3 已接受残余风险与平台备注

- 服务端停机期间客户端换 token → 恢复会话 token 失效 → 首请求 502 一次 → 用户重选。不做自动修复。
- `0o600` POSIX 严格 owner-only；Windows 为 best-effort（走 ACL），文档注明。
- 无 logout、无滑动续期（固定 7 天到期重选）。

## 6. M2：chaos-proxy 包

私有 workspace 包 `packages/chaos-proxy`（`"private": true`，不发布），纯 Node `net` 实现，零运行时依赖，仅作 devDependency。**只做 TCP 层注入**（真实中间盒也不懂 WS，这是保真度来源）。

### API

```ts
interface ChaosProxy {
  listen(): Promise<number>;          // client 的 gatewayUrl 指这里
  close(): Promise<void>;
  destroyAll(): void;                 // 全部连接 RST（对端崩溃/中间盒重置）
  blackhole(direction?: 'c2s' | 's2c' | 'both'): void;  // 静默断流不 RST（半开/丢包）
  heal(): void;                       // 恢复转发
  setLatency(ms: number, jitterMs?: number): void;
  setThrottle(bytesPerSec: number): void;               // 令牌桶限速（0 = 关）
  setIdleTimeout(ms: number): void;                     // 空闲 N ms destroy（中间盒回收）
  flappy(intervalMs: number): void;   // 周期 destroy 新连接（重连风暴）
  stopFlappy(): void;
  rejectUpgradeWith(status: number): void;              // 建连回 HTTP 错误（反代 502）
  clearRejectUpgrade(): void;
  stats(): { connections: number; destroyed: number; bytesRelayed: number };
}
function createChaosProxy(opts: { targetHost: string; targetPort: number; logger?: Logger }): ChaosProxy;
```

### 实现语义（保真度来源）

- **blackhole**：`socket.pause()` 停读 + 缓冲待发——内核窗口填满、对端重传无果，与真实丢包/半开逐字节一致；`heal()` 冲刷缓冲恢复，可演"窗口内自愈"与"判死重连"两种结局。
- **destroy**：双端 `socket.destroy()`——客户端看到 `read ECONNRESET` + 1006。
- **latency/throttle**：写路径延迟队列/令牌桶，读路径不变，可叠加。
- **idleTimeout**：按连接最后活动时间 destroy。
- **rejectUpgradeWith**：读完 HTTP 头回 `HTTP/1.1 <status>\r\n\r\n` 再关 → 客户端得 `Unexpected server response: <status>`。
- 全部原语同步生效、可叠加、可复位；`stats()` 供断言；自身配独立单测。

## 7. M3：故障场景目录（每条 = 稳健行为验收标准）

图例：✅ 纯回归固化；🔧 产品改动项；⚡ 可能暴露未知缺陷（红灯后修复）。

### A. 建连期（client e2e-chaos）

| # | 场景 | 注入 | 验收 | 现状 |
|---|---|---|---|---|
| S1 | 对端不可达 | ECONNREFUSED | 首连退避重试，connectTimeoutMs 内恢复即成功；日志含错误码 | ✅ |
| S2 | 反代故障 | `rejectUpgradeWith(502)` 后清除 | error 含 `Unexpected server response: 502`；退避不炸；恢复后 connected | ✅ |
| S3 | 域名不存在 | ENOTFOUND | 诊断明确、不崩进程、退避收敛 | ✅ |

### B. 会话期传输故障（server e2e-chaos，真实 Client + chaos-proxy + 真实 GatewayServer + 真实 upstream）

| # | 场景 | 注入 | 验收 | 现状 |
|---|---|---|---|---|
| S4 | 空闲断链 | `destroyAll()` | disconnected→connecting→connected；tunnelId 复用；老 cookie 免重登 | ✅ |
| S5 | 大流量断链 | 下载中 `destroyAll()` | 在途通道 502 一次；重连后新请求正常；两端通道表清空无泄漏 | ✅ |
| S6 | 静默黑洞 | `blackhole()` 不恢复 | 判死窗口内 terminate + 自动重连成功 | ✅ |
| S7 | 黑洞自愈 | `blackhole()` → 窗口内 `heal()` | 不重连、会话无损；超窗才判死重连 | ✅ |
| S8 | 空闲回收 vs 心跳续命 | `setIdleTimeout(2s)` + ping 300ms | 存活 ≥6s（3 倍空闲周期）零断开 | ✅ |
| S9 | 回收快于心跳 | `setIdleTimeout(3s)` + ping 10s | 每次回收自动重连（观察 ≥2 周期）、cookie 可用；部署文档写明"心跳间隔必须 < 中间盒空闲超时" | ✅ |

### C. 链路品质劣化

| # | 场景 | 注入 | 验收 | 现状 |
|---|---|---|---|---|
| S10 | 高 RTT 大下载 | `setLatency(150,50)` + 5MB 下载 | headTimeout 不触发；流量窗口自适应；完成且不判死 | ⚡ |
| S11 | 限速上传 | `setThrottle(128KB/s)` + 1MB 上传（≈8s） | 聚合背压有界（内存稳定）；pong/ack 不饿死不判死 | ⚡ |
| S12 | 重连风暴 | `flappy(1s)` × 15（≈20s） | 每次恢复 connected；退避封顶；无 listener/timer 泄漏 | ⚡ |

### D. 协议健壮性

| # | 场景 | 注入 | 验收 | 现状 |
|---|---|---|---|---|
| S13 | 坏帧注入 | raw ws 冒充隧道客户端 | 5 帧预算内存活 WARN；超预算 1002；服务端不崩 | ✅ |
| S14 | 巨帧边界（可选） | 接近 100MB 单帧 | 正常透传；超限 1009 通道级杀 | ✅ |

### E. 生命周期联动（M1 验收）

| # | 场景 | 操作 | 验收 | 现状 |
|---|---|---|---|---|
| S15 | 服务端重启 | kill + 重启（带 sessionStorePath） | 快照恢复 + tunnelId 回带复用 → 老 cookie 免重登 | 🔧 M1 |
| S16 | 浏览器重开 | 新 HTTP 会话仅带持久 cookie | 免重登直达应用 | 🔧 M1 |
| S17 | 会话过期 | 短 ttl（500ms） | 302 重选；快照同步清理 | 🔧 M1 |

### F. 瞬断宽限（M3 产品行为改进）

| # | 场景 | 注入 | 验收 | 现状 |
|---|---|---|---|---|
| S18 | 瞬断中的 HTTP 请求 | 断开后发请求，5s 后重连 | grace 8s：挂起等待（非立即 502），重连后透明完成；grace 1s：超时 502 | 🔧 M3 |
| S19 | 瞬断中的 WS upgrade | 同上 | upgrade 挂起，恢复后完成握手；超时手写 HTTP 502 | 🔧 M3 |

### 工作循环

```
取场景 → 先写验收断言（红）→ 跑出现状行为
  → 绿灯：固化回归，下一个
  → 红灯：最小修复（systematic-debugging）→ 绿灯固化，下一个
```

## 8. M3 产品改动：瞬断宽限

- `GatewayServerOptions` 新增 `tunnelRestoreGraceMs?: number`（默认 30_000，0 = 关闭退回即时 502 现状）。
- `TunnelRegistry` 增加等待能力：`waitFor(tunnelId, timeoutMs): Promise<TunnelSession | null>`（隧道 set 时唤醒）。
- http-proxy：隧道离线分支由即时 502 改为 `waitFor` 挂起——恢复则正常转发；超时按原 502 路径；等待期间浏览器断开则放弃。日志 INFO（tunnelId、等待 ms）。
- ws-proxy：upgrade 前会话检查通过后隧道离线同样挂起，恢复后完成 upgrade；超时在原始 socket 手写 `HTTP/1.1 502` 后销毁。
- 语义边界：宽限只保**新**请求；断连时刻的**在途**通道仍立即失败（协议无重放，正确语义不变）。

## 9. 日志纪律（chaos 断言依赖）

| 事件 | 级别 | 必带字段 |
|---|---|---|
| 隧道断开 | WARN | `code`/`reason`/`readyMs`（现状已有，M0 后可见） |
| 隧道连接错误 | ERROR | `err.stack`（含错误码） |
| 宽限等待/恢复 | INFO | tunnelId、等待 ms |
| 快照落盘/恢复 | INFO/WARN | 会话数量、耗时（**不记 token**） |
| 会话过期 | 不记 | 302 是正常流程 |

## 10. 测试策略

- vitest（沿现有），全 in-process、127.0.0.1 回环、ephemeral 端口（`port: 0`）、真实定时器。
- A 组 → `packages/client/src/e2e-chaos.test.ts`（真实 Client + chaos-proxy + mock-gateway）；B/E/F 组 → `packages/server/src/e2e-chaos.test.ts`；server 包新增 `gateway-client` devDependency（workspace 链接）。
- 时序加速：短心跳 200–300ms（判死 600–900ms）、短 TTL 500ms；慢场景（S10/S11/S12/S18/S19）超时 30s。
- 防抖：条件轮询 `waitFor(fn, timeoutMs)` 代替固定 sleep；`afterEach` 确定性收尾（关 proxy/server/client，无悬挂句柄）。
- 预算：全部 chaos 场景累计 < 90s（client/server 两文件并行 worker 下墙钟更短），进 `pnpm test` 常规回归。
- chaos-proxy 独立单测：延迟/限速可度量、黑洞保真、destroy 语义、stats 准确。

## 11. 明确不做（YAGNI）

- 会话滑动续期；logout；会话加密存储；隧道认证（复用不互踢设计不变）
- tunnelId 落盘 / `initialTunnelId` / `'tunnelId'` 事件（用户决策：进程维度即可）
- `heartbeatDeadAfter` 新参数（`heartbeatIntervalMs` 已够）
- 客户端在途通道断线重放（协议无此能力）
- chaos-proxy 独立 CLI；toxiproxy 等外部依赖
- 多连接（tunnel-group）属另一 spec（2026-08-28-gateway-multiconn-design.md），本设计不交织
