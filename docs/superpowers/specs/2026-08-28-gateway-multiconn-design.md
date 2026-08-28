# 隧道多连接（帧级条带化 + 每通道重排序）设计

- 日期：2026-08-28
- 状态：已确认（brainstorming 逐节评审通过）
- 范围：`packages/server`（隧道接入/TunnelSession）、`packages/client`（Connection/Client）、双端 `protocol.ts` 镜像、`packages/dsh-remote-access`（配置透传一行）。选择页、http-proxy、ws-proxy、HttpChannel、WsChannel 均零改动。
- 前置阅读：《2026-08-21-gateway-client-design.md》《2026-08-21-gateway-server-design.md》的帧协议章节（本文修订其协议约定，实现时同步修订这两份文档）。

## 1. 背景与目标

### 1.1 现状

每个客户端与网关之间只建**一条**隧道 WS：全部 HTTP/WS 通道复用在单一 TCP 连接上（帧协议见双端 `protocol.ts`）。在高 BDP（高 RTT × 高带宽）链路、丢包敏感链路上，单条 TCP 的拥塞窗口限制了可达吞吐；大传输还会占用整条连接的发送队列。

### 1.2 目标

客户端出站建立 **N 条隧道连接（默认 4）组成一个隧道组**，通道帧**条带化**分发到组内连接，接收端按通道重排序：

- **单个大传输也要加速**：一个通道的数据帧可并行跑满多条连接（用户已确认，通道亲和方案不满足）。
- **双向对称**：client→server（响应体/上行 WS 消息）与 server→client（请求体/下行 WS 消息）都做条带化 + 重排序。
- **自动降级**：老服务端不支持时静默退回单连接，行为与现状逐字节一致。
- 瓶颈尚未实测：设计自带性能验证步骤（§10），确认收益后才定稿默认值 4。

### 1.3 非目标（v1 明确不做）

- **跨连接断点续传**：断腿上的在途帧永久丢失，seq 空洞不可弥补（§4.4）。
- server→client 方向的端到端流量窗口（维持现状：仅本地 bufferedAmount 背压）。
- 自适应连接数（按链路实测动态调 N）：固定配置，复杂度与收益不匹配。
- 服务端 `MAX_LEGS_PER_TUNNEL` 的 CLI 旗标（常量即可）。

## 2. 已确认决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 方案 | 帧级条带化 + 每通道重排序（方案 A）；通道亲和（B）不满足单流加速，HTTP 层并行（C）覆盖面太窄，均否决 |
| 2 | 条带化方向 | 双向对称 |
| 3 | 连接数 | client 配置 `connections`，默认 4，clamp [1,16]；老服务端自动降级为 1 |
| 4 | 断连语义 | 任一 leg 断 = 整组 teardown + 整组重连（与单连语义逐字一致） |
| 5 | seq 空间 | 每 (channelId, 方向) 从 0 单调递增；通道级控制帧与数据帧同一空间 |
| 6 | 通道层改动 | 零——发送接口签名不变，接收侧重排序后交付与今天相同的有序流 |
| 7 | 兼容门控 | attach 只发生在 primary 协商成功之后，老服务端永远收不到 attach |

## 3. 协议变更

双端 `protocol.ts` 互为镜像，任何改动双向同步（既有惯例）。

### 3.1 能力协商（primary 连接的 hello）

- `hello.client` 新增 `multiConn?: { count: number }`：客户端声明期望的总连接数（含 primary）。
- `hello.ack` 新增 `multiConn?: { max: number }`：服务端回声明"支持 + 本隧道允许的最大连接数"。
- ack **缺省**该字段 = 老服务端不支持 → 客户端不发起任何 attach，保持单 leg、不发 seq。
- 兼容性已核实：老服务端 hello 解析只取 `hostname`/`defaultPath`/`tunnelId`/`flowControl`，未知字段静默忽略，不进坏帧预算。

### 3.2 attach 握手（第 2..N 条连接）

- `hello.client` 新增 `attach?: true`，与回带的 `tunnelId` 同发：请求**加入**既有隧道组，而非新建/复用隧道。
- 成功：`hello.ack` 回同一个 tunnelId（附 `multiConn`）。
- 失败：服务端 close 新码 **`4410`**（attach 目标不存在/组已满/attach 与 tunnelId 缺失等参数组合非法）。
- 服务端上限 `MAX_LEGS_PER_TUNNEL = 16`（常量），防滥用。
- `connections: 1` 时客户端连 `multiConn` 都不声明（纯 legacy 路径）。

### 3.3 帧序号 seq

- 数据帧头 `DataHeader` 新增 `seq?: number`。
- **通道级**控制帧新增 `seq?: number`：`http.open`/`ws.open`/`http.head`/`ws.accept`/`ws.reject`/`channel.close`/`channel.error`。
- seq 空间：**每 (channelId, 方向) 从 0 单调递增**，不回绕（number，2^53 实际不可达）。
  - `http.open`/`ws.open` 是该通道 server→client 方向的 seq 0；
  - `http.head`/`ws.accept`/`ws.reject` 是 client→server 方向的 seq 0。
- 隧道级帧（`hello`/`hello.ack`/`ping`/`pong`/`tunnel.ack`）不带 seq、不参与重排序。
- **仅协商成功的隧道组才带 seq**；单连接模式任何帧都不带，接收端对无 seq 帧直通。
- 解码容忍：两端 `decodeControl`/`decodeData` 本就不做严格字段校验，`seq` 对旧端是透明字段。

## 4. 连接分组模型

### 4.1 客户端：TunnelGroup（新类）

持有 N 条现有 `Connection`（下称 leg）：

- leg 0 = **primary**：正常 hello（带 `multiConn.count`）拿 tunnelId；
- leg 1..N-1 = **attach**：hello 回带 tunnelId + `attach: true`；
- 对外暴露与今天 `Connection` **相同的接口**：`sendControl`/`sendData`/`waitDrain`/`ready`/上行帧回调。`Client`、`HttpChannel`、`WsChannel` 构造注入的对象从 Connection 换成 TunnelGroup，代码零改动。

### 4.2 服务端：TunnelSession 多 leg 化

- session 持有 `legs: TunnelLeg[]`；每条 leg = 自己的 ws + 独立的 tunnel.ack 记账/背压水位状态。
- `register`/`unregister`/`sendControl`/`sendData`/`waitDrain` 签名不变 → `http-proxy`/`ws-proxy`/`select-page` 零改动（已核实 `TunnelHandle` 是它们的唯一接触面）。
- `TunnelRegistry` 仍以 tunnelId → session 为唯一映射，attach 不产生新注册项，选择页数据源不变。

### 4.3 按 leg 复用的既有机制

hello 超时 4408、坏帧预算（连续 5 帧 1002）、应用层心跳判死（30s × 3）、指数退避，全部按 leg 独立执行，逻辑原样。

### 4.4 断连语义

- **任一 leg 断 = 整组 teardown**：所有通道中止（与今天单连断开语义逐字一致），服务端关闭其余 leg、注销注册表；客户端整组重连，primary 回带 `lastTunnelId` 复用隧道（浏览器老会话随之恢复）。
- 理由：断腿上的在途帧随 TCP 断开永久丢失，对应通道的 seq 出现不可弥补的空洞；挂起等待的通道无法界定"哪些有洞"，只有全组重建才正确。跨连接续传列入非目标。
- **attach 失败自愈**：单条 attach 失败（4410/超时）**不杀整组**；该槽位按既有退避重试 ≤3 次，耗尽则组降级运行至下次整组重连。

## 5. 发送侧条带化与背压

### 5.1 seq 分配

发送端在 `sendControl`/`sendData` 入口**同步**打序号（每方向一张 `Map<channelId, nextSeq>`），先于选 leg。seq 只表达逻辑顺序，不绑定物理连接。

### 5.2 leg 选择（加权条带化）

每条 ready leg 计算可用容量分，取最高；打平轮转：

- 客户端 leg：`min(currentFlowWindow − inFlight, HIGH_WATER − bufferedAmount)`——流量窗口与本地水位机制今天就在 `Connection` 内，天然按 leg 独立；
- 服务端 leg：`HIGH_WATER − bufferedAmount`（server→client 方向现状无端到端窗口，不扩大 v1 范围）。

效果：快的连接自然分到更多帧，慢的少分，无需显式权重。attach 未就绪的 leg 不参与分发（组按实际 leg 数降级运行）。

### 5.3 背压语义不变

- 所有 ready leg 都满 → `sendData` 返回 false；任一 leg 回落到恢复水位 → `waitDrain()` 唤醒。
- `HttpChannel`/`WsChannel`/`http-proxy`/`ws-proxy` 现有 pause/resume 逻辑原样复用。
- 每帧 100MiB `MAX_PAYLOAD_BYTES` 护栏不变。

### 5.4 tunnel.ack 下沉到 leg

服务端把 `noteDataReceived`/回执节拍（128KiB 节拍 + 1s 兜底）从 session 移到 leg：每条 leg 只为自己收到的字节回执；客户端对应 leg 的在途记账（`dataBytesSent − dataBytesAcked`、EWMA 自适应窗口）不变。心跳"静默判死"的入站活性语义随之按 leg 保持。

## 6. 接收侧重排序（Resequencer）

每端各一个 `Resequencer`，插在 **leg 消息入口**与**现有分发层**之间：

```text
leg.onMessage → resequencer.feed(frame) → 按序交付 → 现有 dispatch
（client：Client.onControl/onData；server：session.handleControl/handleData）
```

### 6.1 状态与 feed 规则

每 (channelId, 方向) 一份 `{ expected, buffer: Map<seq, frame> }`，首个带 seq 帧惰性创建：

- `seq === expected` → 交付，然后连扫 buffer 中的连续帧；
- `seq > expected` → 停驻 buffer；
- `seq < expected` → 防御性丢弃 + WARN（TCP 有序 + 断腿=全组重建的前提下不可能发生）；
- **无 seq** → 直通（单连接模式/隧道级帧），与今天路径完全重合。

### 6.2 跨腿竞态天然化解

attach leg 上的数据帧可能比 primary 上的 `http.open` 先到——这只是"seq 0 处有空洞"，停驻等 open 到达即可，无需特判。

### 6.3 缓冲有界

乱序停驻帧是在途帧的子集：client→server 方向被各 leg 流量窗口钳住（≤ N × 窗口上限），server→client 方向被各 leg 本地高水位钳住（≤ N × HIGH_WATER）。另设防御性每通道上限 **32MiB**，超限 = 对端行为异常 → 隧道组级协议错误 teardown（1002）。

### 6.4 清理

- 通道结束（client 侧 `onDone` / server 侧 `unregister`）即删该通道的重排序状态；
- 整组重连时全部重置（channelId 空间本就随隧道重建归零）。

### 6.5 对通道层的承诺

所有 handler 看到的仍是与今天逐字节一致的有序流——`HttpChannel`/`WsChannel`/`http-proxy`/`ws-proxy` 接收路径零改动。

## 7. 兼容矩阵

| 组合 | 行为 |
|------|------|
| 新 client + 新 server | 协商成功，N leg + seq 条带化 |
| 新 client + 老 server | 老 server 忽略 `multiConn` → ack 无此字段 → client 单 leg、不发 seq，与现状逐字节一致 |
| 老 client + 新 server | hello 无 `multiConn` → server 建单 leg 会话、不发 seq，与现状逐字节一致 |
| attach 目标已消失（竞态） | 4410 → 槽位退避重试 ≤3 次 → 降级运行 |
| 部分 attach 成功 | 组按实际 leg 数运行，不阻塞可用 |

关键点：attach 只发生在协商成功之后——老服务端永远收不到 attach hello，选择页不会出现僵尸重复卡片。服务端按会话记录是否协商了 multiConn：未协商的会话任何帧都不带 seq（纯 legacy 路径）。

## 8. 配置与可观测

- **client 配置**：`connections?: number`，默认 4，clamp [1, 16]；`1` = 不协商（纯 legacy）。
- **dsh-remote-access 插件**：透传 `connections` 字段（一行），默认随 client = 4。
- **日志**：隧道接入/断开日志带 `legIndex`/`legs`；attach 成功/失败、降级运行、重排序防御性丢弃各有独立 WARN/INFO；现有 `请求完成` 日志不变。
- **文档**：README 配置表 + 两份 2026-08-21 spec 的协议章节同步修订。

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| attach hello 参数非法/目标不存在/组满 | 服务端 close 4410；client 槽位退避重试 ≤3 次 |
| 任一 leg 断开（任意码） | 整组 teardown + 整组重连（primary 回带 tunnelId 复用） |
| 重排序收到 `seq < expected` | 丢弃 + WARN，不影响组 |
| 重排序缓冲超 32MiB/通道 | 组级协议错误 teardown（1002） |
| 协商失败（ack 无 multiConn） | 静默单 leg，无错误日志（INFO 一条） |
| leg 上坏帧连续超预算（5） | 该 leg 1002 → 触发整组语义（同"任一 leg 断"） |
| 发送兜底竞态（ws CLOSING 窗内 send） | 沿用现有 `trySend` 通道级消化模式 |

## 10. 测试策略（vitest，沿用仓库现有模式）

- **协议双端镜像**：multiConn/attach 编解码、数据帧头与控制帧 seq 往返、4410。
- **Resequencer 单测**：有序直通 / 乱序停驻连扫 / seq 0 空洞（数据先于 open）/ 旧 seq 防御丢弃 / 缓冲超限升级 teardown / 通道结束清理 / 无 seq 直通。
- **组发送单测**：加权选 leg 偏向空闲者 / 全满返回 false + 任一 leg 回落唤醒 / 未就绪 leg 不参与分发。
- **attach 集成**：成功入组 / 未知 tunnelId → 4410 / 超上限 → 4410 / 老 server 式 ack（无 multiConn）→ 静默单 leg。
- **session 多 leg**：per-leg ack 记账、teardown 关闭全部 leg、registry 身份校验不变。
- **e2e**：4 leg 隧道 + 人为 leg 间延迟差（可复用 `chaos-proxy` 的 setLatency/setThrottle）跑大文件上传+下载，校验字节完整性与顺序；整组重连后 tunnelId 复用、浏览器会话恢复；`connections: 1` legacy 模式 e2e。
- **回归**：现有全部测试在默认配置下通过（现有 e2e 自动覆盖多 leg 路径）。
- **性能验证（人工步骤）**：throttle 链路下 1 vs 4 连接大文件传输耗时对比，确认收益后定稿默认值 4。

## 11. 影响面与文件清单

| 文件 | 改动 |
|------|------|
| `packages/client/src/protocol.ts` / `packages/server/src/protocol.ts` | hello/hello.ack 新字段、attach、seq、4410（镜像同步） |
| `packages/client/src/tunnel-group.ts`（新） | TunnelGroup：leg 装配、seq 分配、加权选 leg、聚合背压、整组重连 |
| `packages/client/src/resequencer.ts`（新）/ `packages/server/src/resequencer.ts`（新） | 接收端重排序；两端互不依赖（README 约定），双端各自实现、镜像对齐（同 protocol.ts 惯例） |
| `packages/client/src/connection.ts` | hello 带 multiConn/attach；暴露容量分接口；4410 处理 |
| `packages/client/src/client.ts` | 构造 TunnelGroup 替代 Connection；`connections` 配置 |
| `packages/server/src/tunnel.ts` | attach 识别与入组、4410、MAX_LEGS_PER_TUNNEL |
| `packages/server/src/session.ts` | 多 leg 化、per-leg ack、发送侧 seq + 条带化 |
| `packages/dsh-remote-access/src/host/connection-manager.ts` | `connections` 透传（一行） |
| `README.md` + 两份 2026-08-21 spec | 配置表与协议章节同步 |
