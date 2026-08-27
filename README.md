# harness-gateway（智能体网关）

将多台电脑上的本地服务（如 DeepSeek Harness）统一暴露到一个网关入口：浏览器访问网关 → 选择目标电脑 → 输入 token → 即可远程使用该电脑上的服务。

```text
                        ┌──────────── 网关（server，单端口）────────────┐
用户浏览器 ──HTTP/WS──► │ 选择页 → 会话 → 路由 → 隧道桥接               │
                        └──▲──────────────────┬────────────────────────┘
             隧道 WS（client 主动出站，hello 登记 hostname）
                           │
        ┌──────────────────┼──────────────────┐
   客户端A(pc-a)        客户端B(pc-b)        客户端C(pc-c)
        │                  │                  │
   本地服务A           本地服务B           本地服务C
```

## 环境要求

- Node.js 20+
- pnpm（`corepack enable`，本仓库仅允许 pnpm 安装依赖）

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动网关服务端（公网/中心服务器上）

```bash
pnpm run server --port 9000   # 省略 --port 时默认 9000
```

> 注意：`pnpm server` 与 pnpm 内置 store server 命令重名，必须写作 `pnpm run server`。

服务端为纯参数启动，无配置文件：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | `9000` | 单端口承载浏览器 HTTP/WS + 客户端隧道 WS |
| `--tunnel-path` | `/__gateway__/tunnel` | 隧道接入路径（仅接受 WS upgrade） |
| `--select-path` | `/__gateway__/select` | 内置选择页路径 |
| `--tunnel-permessage-deflate` | 关闭 | 隧道 WS 开启 permessage-deflate 压缩（≥1KB 帧才压缩，SSE 小帧不受影响）；跨机房/跨境部署建议开启，显著降低高 RTT 链路传输时间，代价是两端少量 CPU |
| `--keep-alive-timeout-ms` | `5000` | 浏览器侧 HTTP keep-alive 空闲超时（毫秒，须正整数）；高 RTT 链路建议调大（如 `60000`）让浏览器连接跨页面间隙复用，减少每次新建 TCP 的握手往返。headersTimeout 自动抬到该值之上 |

慢链路排查：服务端按请求记录 `请求完成` 日志（INFO），字段含 `headMs`（入口→收到响应头，即隧道往返+upstream 首字节延迟）与 `totalMs - headMs`（≈body 流式传输耗时）、`bodyBytes`、`status`，可据此定位慢在隧道往返还是带宽。

### 3. 启动网关客户端（每台被访问的电脑上）

编辑配置文件 `packages/client/client.config.mjs`（仓库已生成模板，已 gitignore 勿提交，`export default` 一个对象）：

```js
export default {
  upstreamUrl: 'http://localhost:3080',  // 本机要暴露的应用服务地址（http/https）
  gatewayUrl: 'ws://<网关地址>:9000/__gateway__/tunnel',  // 网关隧道端点（ws/wss）
  hostname: 'pc-a',                      // 选择页展示名与路由标识，全网关内唯一
  token: 'secret-token',                 // 可选：本机接入令牌，配置后用户须输入该 token
  defaultPath: '/',                      // 可选：选择成功后浏览器跳转路径，默认 '/'
}
```

然后启动（默认加载 `packages/client/client.config.mjs`）：

```bash
pnpm client
```

### 4. 浏览器使用

1. 打开 `http://<网关地址>:9000/`，无会话时自动 302 到选择页
2. 点击目标电脑图标，输入该机的 token
3. 验证通过后跳转该电脑的 `defaultPath`，后续请求经隧道直达本机服务
4. 退出 = 关闭浏览器（session cookie 失效）

## 鉴权

客户端是唯一鉴权权威，token 不出客户端进程（服务端转发时注入 `Authorization: Bearer`，经隧道由客户端校验）：

- 配置了 `token` 且无自定义钩子 → 内置 Bearer 校验，不符回 403
- 两者都未配置 → 全部放行（仅适合内网/测试）
- 自定义钩子优先，Express 中间件风格：

```js
export default {
  // ...基础字段
  authorization: (req, res, next) => {
    // req = { method, url, headers, ip, isWebSocket }；ip 为浏览器真实 IP
    // 注意：选择页的 token 探测（/__gateway__/auth-check）也走此钩子，必须兼容
    if (req.headers.authorization === 'Bearer secret-token') return next()
    res.writeHead(403).end('forbidden')  // 写 res 即拒绝，原样透传浏览器
    // next(err) / 同步抛异常 / 悬挂超时（authTimeoutMs 默认 10s）→ 403
  },
}
```

## 公网部署注意

- **TLS 交给前置反代**（nginx/caddy）：网关只讲 HTTP/WS，此时 `gatewayUrl` 改用 `wss://`
- token 随转发请求流经隧道，公网部署**务必前置 TLS**
- 隧道接入本身无认证，公网建议再加一层前置保护

## 开发命令

| 命令 | 说明 |
|------|------|
| `pnpm run server` | 启动网关服务端（默认端口 9000；与 pnpm 内置命令重名，须带 `run`） |
| `pnpm client` | 启动网关客户端（默认读 `packages/client/client.config.mjs`） |
| `pnpm typecheck` | TypeScript 类型检查（全部包） |
| `pnpm test` | vitest 测试 |
| `pnpm format` | ESLint `--fix` 统一格式化 |

无需构建：各包为 TS 源码直出，经 tsx 直接运行。

## 目录结构

```text
packages/
├── server/   # gateway-server — 网关服务端：选择页、会话、路由、HTTP/WS 双向桥接
├── client/   # gateway-client — 网关客户端：出站连网关、鉴权、还原流量到本地 upstream
└── dsh-remote-access/   # dsh-remote-access — DSH 插件：设置页手动启用隧道接入网关（二维码深链）
docs/superpowers/specs/   # 隧道帧协议与设计文档（改协议/行为前先读）
```

两端互不依赖，仅通过隧道帧协议对齐。
