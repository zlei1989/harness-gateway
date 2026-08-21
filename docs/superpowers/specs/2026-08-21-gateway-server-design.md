# 智能体网关 · 服务端（packages/server）设计

- 日期：2026-08-21
- 状态：已确认（brainstorming 逐节评审通过）
- 范围：仅服务端包。客户端设计见《2026-08-21-gateway-client-design.md》；隧道帧协议由两份文档共同定义，字段以客户端文档 §4 加本文档 §5 的 hello 扩展为准。
- 修订：2026-08-21（设计评审修订）——协议保真改为「HTTP/WS 语义保真」消除与客户端 `upstreamUrl` 的歧义；headers 三处加工增加 `X-Forwarded-For` 注入并约定 `string | string[]` 编码；无 body 请求强制空载 `http.body.end` 收尾；`ws.accept` 子协议回选校验；4409 客户端不重连；token 流经隧道的安全提示。

## 1. 背景与目标

### 1.1 系统定位

```text
                        ┌────────────── 网关（服务端，单端口）──────────────┐
用户浏览器 ──HTTP/WS──► │ 选择页/会话管理 → 路由 → 隧道桥接                 │
                        └──▲───────────────────┬───────────────────────────┘
             隧道 WS（客户端主动出站，hello 登记 hostname）
                           │
        ┌──────────────────┼──────────────────┐
   客户端A(hostname=pc-a)  客户端B(pc-b)      客户端C(pc-c)   ……多台电脑
        │                  │                  │
   应用服务A           应用服务B           应用服务C
```

**完整用户旅程**：

1. 各电脑上的客户端主动连网关，`hello` 上报 `{ hostname, defaultPath }`
2. 浏览器首次访问网关任意路径 → 无有效 cookie → 302 到内置选择页（电脑图标列表）
3. 用户点击电脑图标、输入 token → 服务端经隧道向该客户端发探测请求验证
4. 验证通过 → 写 session cookie（uuid）→ 302 跳转到该电脑的 `defaultPath`
5. 后续请求带 cookie → 路由到对应隧道 → 注入 `Authorization: Bearer {token}` → 客户端鉴权 → upstream
6. 退出 = 关闭浏览器（session cookie 失效）

### 1.2 服务端职责

- 单端口承载三类流量：浏览器 HTTP、浏览器 WS upgrade、客户端隧道 WS
- 多客户端隧道接入管理（hello 握手、hostname 唯一性仲裁）
- 内置选择页与浏览器会话管理（全内存）
- 浏览器请求 ↔ 隧道通道的双向桥接（HTTP 全双工流式、WS 文本/二进制保真）
- 转发时注入 `Authorization: Bearer` 请求头、剥离网关自身 cookie
- **不做权限管控**：鉴权权威在客户端，服务端只做映射与路由

### 1.3 已确认决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 交付形态 | Node.js 库 + 独立 CLI；CLI 纯参数无配置文件（服务端无函数型选项） |
| 2 | 端口拓扑 | 单端口 + 路径区分：`/__gateway__/` 为保留命名空间，其余路径全是浏览器流量 |
| 3 | 协议保真 | HTTP/WS 语义保真：浏览器的 HTTP 请求与 WS 升级分别经隧道还原为对 upstream 的同类请求；upstream 的 scheme（http/https）由客户端 `upstreamUrl` 决定 |
| 4 | TLS | 交给前置反代（nginx/caddy），网关只讲 HTTP/WS |
| 5 | HTTP 框架 | Node 原生 http + ws（noServer 模式 + upgrade 按路径分发，沿用 `packages/web/server.ts` / `ws-gateway.ts` 范式） |
| 6 | 多客户端路由 | cookie uuid → hostname → 隧道；hello 帧承载 hostname/defaultPath |
| 7 | token 校验位置 | 选择时经隧道向客户端发探测请求，客户端是唯一鉴权权威；配置 token 不出客户端进程 |
| 8 | 隧道连接认证 | 无认证（token 是用户级凭证，非隧道接入凭证）；公网部署需自行加前置保护——**token 随转发请求（Bearer 注入）流经隧道，公网务必前置 TLS** |
| 9 | 选择页技术栈 | 服务端直出零依赖自包含 HTML（**明确偏离** CLAUDE.md 的 antd/Tailwind/DESIGN.md 规范，理由：零依赖转发网关不引入前端构建链；已获确认） |

## 2. 包结构

```text
packages/server/
├── package.json        # gateway-server，ESM，运行时依赖仅 ws
├── tsconfig.json
├── eslint.config.ts
├── vitest.config.ts
└── src/
    ├── index.ts        # 导出 GatewayServer 类与公共类型
    ├── server.ts       # 主类：http.Server 装配、request/upgrade 按路径分发
    ├── tunnel.ts       # 隧道接入：upgrade 校验、hello 握手、hostname 唯一性仲裁
    ├── session.ts      # TunnelSession：隧道连接、channelId 分配、通道表
    ├── select-page.ts  # 内置选择页：GET 渲染 / POST 处理、会话建立
    ├── browser-session.ts # sessions/tunnels 两张内存映射
    ├── http-proxy.ts   # 浏览器 HTTP ↔ 隧道通道（流式桥接）
    ├── ws-proxy.ts     # 浏览器 WS ↔ 隧道 ws 通道
    ├── protocol.ts     # 帧协议编解码（服务端侧实现）
    ├── cli.ts          # CLI 入口（bin: harness-server，纯参数）
    └── logger.ts
```

## 3. 公开 API 与 CLI

```ts
import { GatewayServer } from 'gateway-server'

const server = new GatewayServer({
  port: 3081,                             // 单端口：浏览器流量 + 隧道共用
  tunnelPath: '/__gateway__/tunnel',      // 隧道接入路径（默认值）
  selectPath: '/__gateway__/select',      // 选择页路径（默认值）
  // helloTimeoutMs: 15000,               // 等 hello 帧超时
  // headTimeoutMs: 120000,               // 等 http.head / ws.accept / 探测响应超时
  // logger: Logger
})

await server.listen()
await server.close()  // 关所有隧道 + 失败全部在途通道 + 关 http.Server
```

CLI：`harness-server --port 3081 [--tunnel-path ...] [--select-path ...]`；非法参数打印用法，退出码 1。SIGINT/SIGTERM 触发 `close()`。

## 4. 单端口流量分发

| 入口 | 路径 | 处理 |
|------|------|------|
| HTTP 请求 | 命中 `tunnelPath` | 404（隧道只接受 WS upgrade） |
| HTTP 请求 | 命中 `selectPath` | → 选择页（§6） |
| HTTP 请求 | 其余 `/__gateway__/` 前缀路径 | 404（保留命名空间不转发） |
| HTTP 请求 | 其余所有路径 | → http-proxy（§7.1） |
| WS upgrade | 命中 `tunnelPath` | → 隧道接入（§5） |
| WS upgrade | 其余 `/__gateway__/` 前缀路径 | 404 + destroy |
| WS upgrade | 其余所有路径 | → ws-proxy（§7.2） |

upgrade 分发沿用 `ws-gateway.ts` 范式：`WebSocketServer({ noServer: true })` + 手动 `server.on('upgrade')` 按 `url.pathname` 分发，非本网关路径交还其他监听者。

## 5. 隧道接入（tunnel.ts）

```text
客户端 WS upgrade 命中 tunnelPath
  → 接受 → 等 hello 控制帧（helloTimeoutMs 15s，超时断开）
       { type:'hello', client:{ hostname, defaultPath } }     ← 不含 token
  → hostname 与在线隧道重名 → 沿用仓库范式：先 handleUpgrade 再 close(4409, 'hostname conflict')
     （客户端视 4409 为进程级错误，不会重连，无需防重名互踢）
  → 回 { type:'hello.ack' }，登记 tunnels: Map<hostname, TunnelSession>
  → 隧道就绪，开始接受浏览器流量
```

- `channelId`：服务端按隧道会话内递增整数分配；隧道重连后旧会话通道已全部清理，编号空间重置无冲突
- 隧道断开：该隧道全部在途通道失败（HTTP 502 / WS 断开），`tunnels` 注销 hostname；**`sessions` 保留**——隧道重连后老 cookie 自动恢复可用，免重新选择
- 心跳：响应客户端 `ping` 控制帧回 `pong`

## 6. 选择页与浏览器会话（select-page.ts / browser-session.ts）

### 6.1 内部状态（全内存，重启即清空）

```ts
tunnels:  Map<hostname, TunnelSession>     // 在线隧道
sessions: Map<uuid, { hostname, token }>   // 浏览器会话
```

### 6.2 GET 选择页

- 服务端直出**零依赖自包含 HTML**（字符串模板 + 内联样式）：电脑图标列表（在线 tunnels 的 hostname）+ token 输入框 + 错误提示位
- 已带有效 cookie 也允许访问（用于切换电脑）

### 6.3 POST 选择提交（表单：hostname + token）

```text
hostname 不在线 → 400，重渲染选择页 + 错误提示
在线 → 服务端开一条临时隧道通道发探测请求：
       GET /__gateway__/auth-check
       Authorization: Bearer {用户输入的 token}
  ├─ 客户端回 204（其 authorization 放行）→ 建立会话：
  │    uuid = crypto.randomUUID()
  │    sessions.set(uuid, { hostname, token })
  │    Set-Cookie: gateway_sid=uuid; HttpOnly; SameSite=Lax; Path=/   ← session cookie
  │    302 → 该电脑的 defaultPath
  ├─ 客户端回 403（钩子拒绝）→ 重渲染选择页 + "token 错误"
  └─ 探测超时（headTimeoutMs）→ 504 错误提示
```

### 6.4 会话生命周期

无 logout 端点，"退出 = 关闭浏览器"（session cookie 随浏览器关闭失效）；孤儿 uuid 留在内存至重启（见非目标）。

## 7. 转发流程

### 7.1 浏览器 HTTP 请求（http-proxy.ts）

```text
cookie 检查：无/失效 gateway_sid → 302 selectPath
有效 → sessions[uuid] → tunnels[hostname]
  隧道已离线 → 502 'tunnel offline'
  在线 → 分配 channelId → http.open { method, url, headers }
    headers 三处加工：
      ① 注入 Authorization: Bearer {会话 token}（覆盖浏览器原值，网关为权威）
      ② 从 Cookie 头剥离 gateway_sid（其余应用 cookie 原样透传）
      ③ 注入 X-Forwarded-For: {浏览器 remoteAddress}（已有值则追加，供客户端钩子取真实 IP）
    headers 编码约定 string | string[]（多值头如 Set-Cookie 用数组，见客户端 spec §4.1）
浏览器请求体 → http.body 数据帧（流式，不缓冲；无 body 也必须发空载 http.body.end 收尾）
等 http.head（headTimeoutMs 120s 超时 → 504 + channel.close）
  → 回写 status/headers（含应用的 Set-Cookie 原样透传回浏览器）
  → http.body 帧 → 浏览器响应流；http.body.end → 收尾
浏览器中途断开 → channel.close 通知客户端取消
```

### 7.2 浏览器 WS upgrade（ws-proxy.ts）

- cookie 检查同上；**无/失效 cookie → HTTP 401 + destroy**（WS 握手无法 302）
- 有效 → `ws.open`（headers 同样注入 Authorization、剥离 gateway_sid、注入 X-Forwarded-For；子协议透传）
- 等 `ws.accept` → **校验回选 protocol 属于 ws.open.protocols，不符即断通道** → `handleUpgrade` 回 101（透传子协议）→ 双向消息透传（text/binary 类型保真）
- **`ws.reject {status, headers?, body?}` → 把该 HTTP 响应手写回浏览器升级请求后 destroy**——客户端鉴权拒绝的自定义响应由此原样到达浏览器
- 任一侧关闭 → 透传关闭码/原因，通道清理

## 8. 超时与错误分级

| 参数 | 默认 | 说明 |
|------|------|------|
| `helloTimeoutMs` | 15s | 隧道 upgrade 后等 hello 帧 |
| `headTimeoutMs` | 120s | 等 http.head / ws.accept / 选择页探测响应 |
| body / WS 消息阶段 | 无总超时 | SSE 与长连接 WS 需要；空闲超时 v1 不设 |

| 级别 | 场景 | 行为 |
|------|------|------|
| 请求级 | 无 cookie / 隧道离线 / 等 head 超时 / 探测失败 | 单个浏览器请求 302/401/502/504，不影响其他会话 |
| 通道级 | 客户端回 channel.error | 对应浏览器请求 502 / WS 断开 |
| 隧道级 | 隧道断开 | §5：在途通道失败、tunnels 注销、sessions 保留 |
| 进程级 | 端口占用 / 配置非法 | listen() 抛错；CLI 退出码 1 |

## 9. 日志

沿用仓库日志级别约定（INFO 接入/断开/请求入口，DEBUG 帧流转，ERROR 堆栈+上下文，WARN 重试/超时）。

**安全红线：任何级别日志都不打印 token 与 Authorization 头**——隧道接入只记 hostname，会话建立只记 uuid + hostname。

## 10. 测试计划（vitest）

- **单测**：cookie 解析与剥离 gateway_sid、sessions/tunnels 映射、帧编解码
- **端到端集成**（同进程起真实 upstream + GatewayServer + Client）：
  1. 无 cookie → 302 → 选择页含 hostname
  2. POST 选择：错误 token → 403 提示；正确 token → Set-Cookie + 302 defaultPath
  3. 带 cookie GET/POST → upstream 收到 Bearer 注入、无 gateway_sid
  4. SSE 流式端到端
  5. 浏览器 WS echo（text+binary）；客户端鉴权拒绝 → 浏览器收到自定义拒绝响应
  6. hostname 冲突 → 4409
  7. 隧道断开 → 在途请求 502 → 重连 → 老 cookie 恢复可用
- **CLI**：`--port` 启动、非法参数退出码 1

## 11. 非目标（v1）

- 会话 TTL 与孤儿 uuid 清理、logout 端点
- Secure cookie（生产 TLS 反代场景后续再加）、CSRF token（SameSite=Lax 已缓解）
- WS upgrade 无 cookie 时的 302（协议做不到，用 401）
- 选择页美化
- 多网关节点共享会话（内存态，单进程）
- 隧道连接认证（token/mTLS）
- 逐通道背压、通道迁移（同客户端 spec §4.3）
