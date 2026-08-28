# 智能体网关 · 客户端（packages/client）设计

- 日期：2026-08-21
- 状态：已确认（ brainstorming 逐节评审通过）
- 范围：仅客户端包。服务端（packages/server）设计见《2026-08-21-gateway-server-design.md》。
- 修订：2026-08-21 第二轮——补充多客户端路由配套：hostname/token/defaultPath 三属性、hello 握手帧、默认鉴权、`/__gateway__/auth-check` 短路。
- 修订：2026-08-21 第三轮（设计评审修订）——`channel.close` 改双向；4409 定为进程级错误不重连；空体强制 `http.body.end` 收尾；headers 编码 `string | string[]`；`X-Forwarded-For` 注入与 `req.ip` 语义；`connect()` 首连重试 + `connectTimeoutMs`；`close()` 先关隧道再中止在途；token 流经隧道的安全提示；子协议回选校验。
- 修订：2026-08-24——隧道身份改为服务端分配的 **tunnelId（uuid）**：`hello.ack` 携带 tunnelId，客户端进程内存记住并在重连时经 `hello` 回带，服务端空闲即复用（浏览器会话随之恢复）；hostname 降为纯展示名、**同名并存**，4409 同名仲裁移除（客户端 4409 处理保留作旧版服务端兼容，变为不可达分支）；CLI 就绪日志打印 tunnelId 供拼 `select?tunnelId=` 深链。
- 修订：2026-08-28 第二轮——**压缩传输**：`ClientOptions.compress`（默认关）为 upstream 未压缩的可压缩响应代做 br/gzip 端到端压缩，一次压缩覆盖 client→server→browser 两段链路（§5.1）。
- 修订：2026-08-28——多连接（帧级条带化 + 每通道重排序）：hello multiConn/attach、hello.ack max、通道帧 seq、4410，详见《2026-08-28-gateway-multiconn-design.md》。

## 1. 背景与目标

### 1.1 系统定位

一套网关系统，分客户端与服务端两个独立 package。整体网络链路：

```text
用户浏览器 ──HTTP 或 WS──► 网关（服务端）──隧道协议──► 下游客户端 ──HTTP 或 WS──► 应用服务
用户浏览器 ◄──响应──────────────────────────────────────────────┘
```

网关接收公网浏览器请求，通过与客户端之间的持久 WebSocket 隧道把请求转发给部署在应用服务旁的客户端；客户端再向应用服务发起真实 HTTP/WS 请求，并把响应沿原路带回。客户端部署在被代理应用的内网侧，出站连接网关，天然穿透 NAT/防火墙。

### 1.2 客户端职责

- 主动向网关建立并维持一条持久 WS 隧道（含自动重连、心跳）
- 在单条隧道上多路复用并发 HTTP 请求与 WS 连接（自定义帧协议）
- 把隧道通道桥接为对应用服务（upstream）的真实 HTTP/WS 请求，全双工流式透传
- **权限管控**：所有请求（HTTP 与 WS 握手）在客户端经 `authorization` 钩子鉴权后才允许触达应用服务

### 1.3 已确认决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 运行形态 | Node.js 库 + 独立 CLI |
| 2 | 隧道协议 | 单条持久 WS + 自定义多路复用帧协议 |
| 3 | authorization 语义 | Express 中间件风格 `(req, res, next)` |
| 4 | 客户端↔网关认证 | 隧道连接本身无认证（公网部署需自行加前置保护）；token 是用户级凭证，非隧道接入凭证——**但 token 会随转发请求（Bearer 注入）流经隧道，公网部署务必 `wss://` 或前置加密** |
| 5 | 转发保真度 | 全双工流式：HTTP 体流式转发（支持 SSE/大文件），WS 文本+二进制透传 |
| 6 | CLI 配置 | JS 配置文件（`export default {…}`） |
| 7 | 帧编码 | 混合帧：控制帧 JSON 文本 + 数据帧二进制 `[头长][JSON 头][原始负载]` |
| 8 | 多客户端 | 多台电脑各跑一个 Client 实例同时连网关（hostname 可重复）；路由由服务端按 cookie uuid → tunnelId → 隧道完成（选择页流程见服务端设计文档 §6） |
| 9 | token 校验位置 | 客户端是唯一鉴权权威：服务端选择页收到的 token 经隧道探测请求（`/__gateway__/auth-check`）由本包 authorization 链校验；**配置 token 不出客户端进程** |

## 2. 包结构

```text
packages/client/
├── package.json        # gateway-client，ESM（"type": "module"），TS 源码直出
├── tsconfig.json
├── eslint.config.ts    # 共享根 eslint.shared.ts
├── vitest.config.ts
└── src/
    ├── index.ts        # 导出 Client 类与公共类型
    ├── client.ts       # Client 主类：装配各模块、生命周期
    ├── connection.ts   # 网关 WS 连接管理：重连/心跳/通道表路由
    ├── protocol.ts     # 帧协议编解码（客户端侧实现）
    ├── http-channel.ts # HTTP 通道：隧道帧 ↔ upstream http/https 流
    ├── ws-channel.ts   # WS 通道：隧道帧 ↔ upstream ws 连接
    ├── authorize.ts    # authorization 执行器（Express 风格适配层）
    ├── cli.ts          # CLI 入口（bin: harness-client）
    └── logger.ts       # 统一日志
```

约定：遵循 monorepo 现有规范——ESM、TS 源码直出无构建步骤、vitest、`tsc --noEmit` 类型检查。运行时依赖只用 `ws`（HTTP 请求用 Node 原生 `http`/`https` 模块）。

## 3. 公开 API

```ts
import { Client } from 'gateway-client'

const client = new Client({
  upstreamUrl: 'https://localhost:3080',  // 应用服务地址
  gatewayUrl: 'ws://server:9000/tunnel',  // 网关隧道端点
  hostname: 'pc-a',                       // 必填：选择页展示名（可重复；路由身份由服务端分配的 tunnelId 承担）
  token: 'secret-token',                  // 可选：本机接入令牌（见 §3.1 默认鉴权）
  defaultPath: '/',                       // 可选：用户选择成功后浏览器跳转路径（默认 '/'）
  authorization: (req, res, next) => {    // 可选；Express 中间件风格
    // 注意：选择页探测（/__gateway__/auth-check）也走此钩子，自定义钩子必须兼容
    if (req.headers.cookie?.includes('session=')) return next()
    res.writeHead(403).end('forbidden')
  },
  // 以下为可选字段，均有默认值：
  // reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, maxRetries: Infinity }
  // heartbeatIntervalMs: 30000
  // authTimeoutMs: 30000
  // connectTimeoutMs: 60000
  // compress: false —— 压缩传输：为 upstream 未压缩的可压缩响应代做 br/gzip 端到端压缩（§5.1）
  // logger: Logger
})

await client.connect()  // 建立隧道（内部含自动重连循环）
await client.close()    // 优雅关闭
client.tunnelId         // 服务端分配的隧道标识（hello.ack 后可用；重连经 hello 回带复用）
```

### 3.1 authorization 执行语义

Express 中间件风格在隧道场景的精确适配：

- `req`：只读请求信息对象 `{ method, url, headers, ip, isWebSocket }`；HTTP 请求与 WS 握手共用同一钩子。`ip` 为**浏览器真实 IP**（取服务端注入的 `X-Forwarded-For` 首项，缺省为 `null`；不是隧道对端地址）
- **放行**：调用 `next()`
- **拒绝**：直接写 `res`（`writeHead` + `end`），该响应原样透传回用户浏览器；或调用 `next(err)` → 默认 403
- **悬挂兜底**：钩子既不调 `next` 也不写 `res`，超过 `authTimeoutMs`（默认 30s）按拒绝处理，防止悬挂通道堆积
- **默认鉴权（第二轮修订）**：配置了 `token` 且未提供 `authorization` → 内置校验 `Authorization: Bearer === token`，不符回 403；`token` 与钩子都未配置 → 全部放行（"预留"语义）；自定义钩子优先于默认校验（钩子内可自行读 `req.headers.authorization` 再校验）
- **保留路径短路**：隧道 HTTP 通道 `path === '/__gateway__/auth-check'`（服务端选择页的 token 探测）照常走 authorization 链；放行则直接回 204 **不打 upstream**，拒绝则回钩子响应
- WS 只在握手时鉴权一次；握手成功后的消息体不再逐条鉴权

### 3.2 生命周期

- `connect()`：发起连接，首次隧道就绪（收到 `hello.ack`）后 resolve。失败按 §6 重连循环继续、不 reject；超过 `connectTimeoutMs`（默认 60s）仍未就绪则 reject。收到 4409 立即 reject 且**不再重连**（旧版服务端 hostname 冲突码；现行服务端同名并存不会发出，本分支为兼容保留）
- `close()`：停心跳与重连 → 拒收新 open 帧 → **关闭隧道 WS**（服务端随即注销 hostname，后续请求 502）→ 中止在途通道并释放资源（可配超时强制关闭）→ 销毁 upstream keep-alive 连接池（空闲 socket 不泄漏到 Client 生命周期之外）
- **upstream 连接复用**：Client 持有一个与 upstream 协议对应的显式 keep-alive Agent（`keepAlive: true, keepAliveMsecs: 1000, timeout: 4000`），所有 HTTP 通道共用——高 RTT 链路下每条新建 TCP 都是一次完整握手往返，连接池把 upstream 侧连接成本降为"首次一次"；`timeout: 4000` 让空闲池内 socket 先于 upstream（Node 默认 keepAliveTimeout 5s）自毁，从源头减少陈旧连接复用竞态（2026-08-27 补记，一次性重试兜底见 §5.1）；Agent 随 `close()` 销毁，重连期间连接池保持温热（不随隧道断开重置）
- 事件：`client.on('connected' | 'disconnected' | 'error', …)`；**必须挂 `error` 监听**（EventEmitter 语义：无监听时 error 事件会抛异常）

## 4. 隧道帧协议（v1）

单条持久 WS 上多路复用，通道以 `channelId`（网关侧生成）标识。

### 4.1 控制帧（JSON 文本帧）

| 方向 | type | 载荷 | 用途 |
|------|------|------|------|
| 客户端→网关 | `hello` | `{client:{hostname, defaultPath, tunnelId?, flowControl?}}` | 连接建立后首帧发送（**不含 token**）；收到 `hello.ack` 才算隧道就绪；`tunnelId` 仅重连时回带上次分到的 id 请求复用；`flowControl: true` 声明支持 `tunnel.ack` 端到端流量窗口（§4.4） |
| 网关→客户端 | `hello.ack` | `{tunnelId}` | 隧道就绪确认，携带服务端决定的 tunnelId（回带空闲则复用，否则新分配 uuid）；旧版服务端 hostname 冲突时改为 WS 关闭码 4409（客户端视为进程级错误：connect() reject、**不重连**） |
| 网关→客户端 | `tunnel.ack` | `{bytes}` | 端到端流量回执（§4.4）：服务端收到数据帧累计达 128KiB 回一次累计字节数；仅在客户端 hello 声明 `flowControl` 后发送（老客户端未声明不发——未知帧会消耗其坏帧预算） |
| 网关→客户端 | `http.open` | `{channelId, method, url, headers}` | 新 HTTP 请求；headers 含服务端注入的 `X-Forwarded-For`（浏览器真实 IP） |
| 网关→客户端 | `ws.open` | `{channelId, url, headers, protocols}` | 新 WS 握手；headers 同样含 `X-Forwarded-For` |
| 双向 | `channel.close` | `{channelId, code?, reason?}` | 网关→客户端：对端关闭/取消；客户端→网关：upstream 主动关闭/中止 |
| 客户端→网关 | `http.head` | `{channelId, status, headers}` | HTTP 响应头（含鉴权拒绝响应） |
| 客户端→网关 | `ws.accept` | `{channelId, protocol?}` | WS 握手成功 |
| 客户端→网关 | `ws.reject` | `{channelId, status, headers?, body?}` | WS 握手被拒（鉴权拒绝 / upstream 失败）；`body` 仅支持文本（控制帧为 JSON，无二进制体） |
| 双向 | `channel.error` | `{channelId, message}` | 通道级异常 |
| 双向 | `ping` / `pong` | `{}` | 应用层心跳 |

**headers 编码约定**：所有帧内的 `headers` 为 JSON 对象，值为 `string | string[]`——多值头（如 `Set-Cookie`）必须用数组表达，接收方按 Node `http` 的约定展开/合并，禁止丢失重复头。

### 4.2 数据帧（二进制）

单条二进制 WS 消息：`[u32 头长（大端）][JSON 头 {channelId, kind, dataType?}][原始负载]`

- `kind: 'http.body' | 'http.body.end' | 'ws.message'`
- `dataType: 'text' | 'binary'`，仅 `ws.message` 使用，保证 WS 消息类型保真
- HTTP 请求体/响应体均以 `http.body` 分块流式传输，`http.body.end` 收尾
- **空体规则**：无论有无 body，发送方都必须以 `http.body.end` 收尾（GET 等无体请求为唯一一帧，负载为空）；接收方凭此帧结束对应流，未收到前不得结束
- **尺寸上限**：隧道帧总长（4 字节头长 + JSON 头 + 负载）不得超过 `MAX_PAYLOAD_BYTES = 100MiB`（与四处 ws 端点 maxPayload 显式对齐，原为 ws 隐式默认）。WS 消息过了接收端 maxPayload 但隧道帧加 ≈60B 头后可能超对端上限（"边界带"），对端收帧即按 1009 杀整条隧道、全通道丢帧；发送侧必须先判定（`exceedsMaxDataFrame`），超限按**通道级**失败：本通道以 1009 `message too large` 关闭并回 `channel.close{reason:'message too large'}`，绝不升级为连接级（2026-08-24 线上丢帧根因补记）

### 4.3 已知边界（v1 明确不做）

- **逐通道背压**：多路复用共享一条 TCP 流，v1 只尊重整体 WS 连接的 `bufferedAmount` + 端到端在途窗口（§4.4）；单通道洪峰会挤占其他通道
- **通道迁移**：重连后在途通道不可迁移（见 §6）
- **逐消息鉴权**：WS 握手后的消息不鉴权（见 §3.1）

### 4.4 端到端流量窗口（tunnel.ack，2026-08-27 线上断连根因补记）

- **问题**：`ws.bufferedAmount` 只度量本机队列；内核 TCP 缓冲与中间盒（限流代理等）的缓冲对应用不可见——大流量时限流链路的"在途数据"可达数 MiB，ping/pong 与数据帧共享同一条 WS 发送 FIFO，心跳帧合法地排队于数据之后，往返远超 90s 判死窗，"静默判死"误杀健康隧道（高并发/大文件/长连接下客户端反复断开、浏览器会话失效）。
- **机制**：客户端 hello 声明 `flowControl: true`；服务端按收到数据帧的累计字节（含帧头，与发送侧记账同口径）每 128KiB 回 `{type:'tunnel.ack', bytes}`；客户端以 `dataBytesSent - dataBytesAcked` 度量**端到端在途量**，超 2MiB 高窗口即暂停生产（`sendData` 返回 false），ack 推进到 512KiB 低窗口内唤醒恢复（与本地水位滞回同构）。
- **双重作用**：① 把在途数据钳制在窗口内（真实端到端背压，中间盒/内核不再无界吸纳）；② 下载方向（客户端→服务端数据、反向静默）ack 每 ~128KiB 规律到达，为心跳提供入站活性——50KB/s 链路下 ack 间隔 ≈2.6s ≪ 90s 判死窗。
- **兼容**：老服务端忽略 hello 的 flowControl 字段、不回 ack——客户端收到首个 `tunnel.ack` 前窗口不生效（回退本地水位背压）；老客户端不声明 flowControl，服务端不回执（未知帧会消耗坏帧预算）。
- **窗口取值**：2MiB 高窗口保证最劣 50KB/s 链路下 ack 往返 ≈40s < 90s 判死窗；高吞吐链路 2MiB 在途亦足以吃满带宽时延积。

## 5. 转发流程

### 5.1 HTTP 通道

```text
网关 http.open ──► authorization 钩子 ──拒绝──► http.head(自定义状态) + body 帧 + 结束帧，通道关闭
                       │放行
                       ▼
              向 upstreamUrl 发起 http/https.request
              （Host 头重写为 upstream 主机；剥离 hop-by-hop 头，其余透传）
                       │
        网关 http.body 数据帧 ──► 逐块写入 request 流（流式，不缓冲）
                       │
        upstream 响应头 ──► http.head(status, headers) 回网关
        upstream 响应体 ──► 分块 http.body 数据帧，流尽发 http.body.end
                       │
              upstream 不可达/超时 ──► http.head(502) + 错误说明 + 结束
```

已确认细节：**Host 头重写为 upstream 主机**（不透传浏览器原始 Host）；**Origin 头同步重写为 upstream origin**（2026-08-23 线上事故补记：浏览器 Origin 描述的是浏览器↔网关的关系，原样透传会被上游同源/反 DNS 重绑定围栏以 Origin.host ≠ Host.host 拒绝——DSH `/api/*` 一律 403；浏览器未携带 Origin 时不伪造。WS 握手浏览器同样携带 Origin，ws 通道同一规则）。**陈旧 keep-alive 连接一次性重试**（2026-08-27 线上 502 根因补记）：限流链路把请求间隔拉长到秒级后，Agent 复用的空闲 socket 可能已被 upstream 关闭（复用即 ECONNRESET/socket hang up）；幂等方法（GET/HEAD/OPTIONS/DELETE）且响应头未收到、请求体未写入时自动换新连接重试一次（带 body 的请求不重试，防重复体）。

**压缩传输（compress，2026-08-28 第二轮修订）**：开启后，HTTP 通道在回传前对响应做压缩协商，满足全部条件才压缩，任一不满足即原样透传——

1. 浏览器 `Accept-Encoding`（随 `http.open` 透传）支持 `br` 或 `gzip`，br 优先（质量 4：与 gzip-6 相当的速度、更高的文本压缩率）；
2. upstream 响应未自带 `content-encoding`（已编码直接透传，浏览器原生可解 gzip/deflate/br，**不做编码转换**——转换是纯 CPU 浪费）；
3. 有 body（排除 HEAD/204/304）且非 Range 请求（压缩会破坏字节区间语义）；
4. `content-type` 可压缩（text/*、JSON/XML 族、SVG、wasm；SSE `text/event-stream` 显式排除——压缩会延迟事件推送）；
5. `content-length` 缺省（流式大 body）或 ≥ 1KB（小 body 压缩无收益）。

压缩时改写 `http.head`：置 `content-encoding`、删 `content-length`（长度已变，服务端回写时由 Node 自动退化 chunked）、`Vary` 并入 `accept-encoding`；响应体经 `zlib` Brotli/Gzip 变换流后再切数据帧，`pipe` 天然串联背压（压缩流写满自动反压 upstream）。服务端对 body 与端到端头完全透明，压缩一次即覆盖 client→server→browser 两段链路；与隧道 `--tunnel-permessage-deflate` 不冲突但语义重复，开启 compress 后无需再开隧道帧压缩。

### 5.2 WS 通道

```text
网关 ws.open ──► authorization 钩子 ──拒绝──► ws.reject{status, body}（HTTP 状态原样回浏览器）
                    │放行
                    ▼
          向 upstream 建立 ws 连接
          （upstreamUrl 的 http(s) 自动推导为 ws(s)；子协议与非 hop-by-hop 头透传）
                    │
        成功 ──► ws.accept{protocol?}，进入双向透传：
                 （回选的 protocol 必须属于 ws.open.protocols 之一，服务端校验不符即断通道）
                 网关 ws.message 数据帧 ◄──► upstream ws 消息（text/binary 类型保真）
        失败 ──► ws.reject{502}
                    │
        任一侧关闭 ──► 透传关闭码/原因，对侧执行同样关闭，通道清理
```

## 6. 连接管理（connection.ts）

- **自动重连**：指数退避 1s → 30s 封顶 + 随机抖动，默认无限重试（`reconnect.maxRetries` 可配）
- **重连语义**：重连成功是全新会话，旧 `channelId` 全部作废；在途通道本地失败销毁——**502 由服务端在隧道断开时统一回给浏览器，客户端无需也无法补发**。**通道不可迁移**（隧道类系统常规取舍，已确认）。**tunnelId 复用**：客户端进程内存记住最近一次 `hello.ack` 的 tunnelId，重连时经 `hello` 回带——服务端确认空闲即复用（浏览器老会话恢复），被占用则分新 id（以 ack 为准更新本地记忆）；进程重启即遗忘（新 id 新会话）
- **心跳**：每 30s 发应用层 `ping` 控制帧；连续 3 个周期（90s）无任何入站消息判定死连接，主动断开走重连。大流量下的入站活性由 `tunnel.ack` 兜底（§4.4：下载方向反向链路本无流量，ack 随数据帧接收进度规律回执），"静默"重新等价于"真死"，无需对拥塞做启发式豁免（2026-08-27 线上断连根因补记）
- **优雅关闭**（`close()`）：停心跳、拒收新 open 帧、关闭隧道 WS、中止在途通道（可配超时强制关闭）——服务端在隧道关闭时即注销 hostname，不存在"排空间隙继续路由"的竞态

## 7. 错误处理分级

| 级别 | 场景 | 行为 |
|------|------|------|
| 帧级 | 单条畸形帧（坏 JSON / 未知 type / 坏数据帧头） | WARN + 丢帧：隧道与全部在途通道不受影响（隧道跑在 WS 消息分帧之上，每条 WS 消息就是一个完整隧道帧，坏消息不会造成帧边界错位，丢弃安全）；被丢帧若属某通道的关键帧，该通道的后续清理由其自身超时/错误路径负责（如服务端 headTimeoutMs 120s 兜底 504），不波及其他通道 |
| 通道级 | upstream 不可达、单通道异常、WS 消息超隧道帧上限（边界带护栏，§4.2） | 只影响该通道：HTTP 回 502 / WS 断开 |
| 连接级 | 连续 5 帧畸形（系统性损坏/协议版本不匹配）、心跳超时、WS 传输层错误（如非法 close 帧） | ERROR 日志 + 断开重连 |
| 进程级 | 配置非法、connect 超时、4409（旧版服务端 hostname 冲突，现行服务端不发出） | 抛错给调用方；CLI 退出码 1 |

## 8. 日志

遵循仓库日志级别约定：

- INFO：隧道连接状态变更（connected/disconnected/reconnecting）、请求入口（含 channelId）
- DEBUG：帧级流转、分支走向
- ERROR：异常捕获，必须带堆栈与业务上下文（channelId、upstream 地址）
- WARN：重试、超时、降级

## 9. 测试计划（vitest）

- **单测**：帧协议编解码（含二进制帧往返、多值 headers 数组编解码、空体 `http.body.end` 收尾）；authorization 执行器四条路径（放行 / 写 res 拒绝 / next(err) / 悬挂超时）
- **集成测试**：起真实 upstream http server + ws server + 内存模拟网关，跑通 HTTP GET/POST 大 body、SSE 流式响应、WS echo（text+binary）、鉴权拒绝链路、多 Set-Cookie 透传
- **auth-check 链路**：探测放行回 204 且**不打 upstream**；探测被钩子拒绝回钩子自定义响应；默认 Bearer 校验的放行/拒绝
- **重连测试**：kill 模拟网关 → 断言在途通道失败（HTTP 502 / WS 断开）→ 重启 → 断言自动重连恢复、重连 hello 回带上次 tunnelId；**4409 → connect() reject 且不重连**（旧服务端兼容分支）

## 10. CLI

```bash
harness-client --config ./client.config.mjs
```

- 配置文件的 `export default` 对象直接传给 `new Client()`，与库 API 完全一致
- 隧道就绪后打印 `hostname` 与 `tunnelId`（用户据此拼 `网关地址/__gateway__/select?tunnelId=xxx` 深链直达对应电脑的 token 对话框）
- bin 名 `harness-client` 与产品名 harness-gateway 对齐（包名 `gateway-client` 沿用 monorepo scope），属刻意
- 加载配置失败 / 配置非法：打印错误，退出码 1
- SIGINT/SIGTERM：触发 `close()` 优雅退出

## 11. 非目标（本期不做）

- 隧道连接认证（mTLS 等）——已明确选择无认证
- 逐通道背压与流控
- WS 消息级鉴权
- 多 upstream 路由（单 Client 实例只代理一个 upstreamUrl）
