# AGENT.md

用中文交流。

## 约束

- **改协议/行为前先读 `docs/superpowers/specs/` 中的两份设计文档** — 隧道帧协议字段以客户端 spec §4 + 服务端 spec §5 的 hello 扩展为准，代码与 spec 冲突时先对齐 spec
- **代码变更后、进入审查阶段前，必须先执行检查与格式化** — 顺序：`pnpm typecheck` → `pnpm format` → 修复所有错误 → 再进入代码审查；格式化产生的代码变更需随本次改动一并提交
- **仅用 pnpm** — 根 `preinstall` 会拒绝 npm/yarn 安装依赖
- **选择页为服务端直出的零依赖自包含 HTML** — 不引入前端构建链（spec §1.3-9 明确偏离常规 antd/Tailwind 规范）
- **TLS 交给前置反代（nginx/caddy）** — 网关只讲 HTTP/WS；token 随转发请求流经隧道，公网部署务必前置 TLS
- **CLI 错误只输出单行诊断** — 不打印原始 Error 对象/堆栈，避免回显可能含敏感信息的代码帧
- 启动 `harness-server` 时若默认端口 9000 被占用，先 kill 占用进程或用 `--port` 换端口再启动

## 验证（复杂功能修改后必做）

凡是涉及隧道协议、连接管理、背压/限流、鉴权等复杂修改，完成 `pnpm typecheck` → `pnpm format` → `pnpm test` 后，**必须**再按以下端到端流程验证（限流代理模拟生产弱网）：

### 拓扑

```text
浏览器 ──HTTP/WS──> [throttle-proxy :9080 准入 8 连接/s + 共享 50KB/s] ──> [server :9000] <──WS 隧道(同过 proxy)── [client] ──> upstream(DSH Web :3088)
```

浏览器流量与隧道流量共享代理的 50KB/s 全局带宽桶，大文件/高并发场景下心跳、控制帧、数据帧互相挤压——线上断连类问题只在该形态下可复现。

### 步骤

1. **启动三进程**（各开一个终端或后台任务）：`pnpm run proxy`（chaos-proxy throttle-proxy 脚本：共享 50KB/s + 准入 8/s）、`pnpm run server`、`pnpm run client`（客户端读 `packages/client/client.config.mjs`：hostname=工位001、token=test、gatewayUrl 指向 :9080）。确认客户端日志出现"隧道就绪"、服务端日志出现"隧道接入"。
2. **Playwright MCP 打开本地 Edge**，访问 `http://localhost:9080`，等待 302 重定向到 `/__gateway__/select` 选择页。
3. **点击"工位001"卡片**；不存在则每 2s 刷新重试，30s 超时——超时先检查客户端/服务端日志是否报错再排查。
4. **输入 Token `test`，点击"连接"**，等待跳转回 `/`（DSH GUI）。
5. **等待页面全部加载**（50KB/s 下 bundle 加载需 3-8 分钟，属正常）；展开左侧"工作区"中的工作区行，**逐一点击所有会话**，每次等待右侧历史加载完成再进入下一会话。
6. **检查服务端与客户端日志**：不得出现"心跳超时，判定死连接"、"隧道连接断开"(code 1006)、"等 http.head 超时"、502（除浏览器主动中止 browser-aborted 外的异常 502）；浏览器 console 不得有 pageerror。

### 判定与排查

- 大文件下载/上传中途隧道断开（客户端日志 1006 + "心跳超时"）→ 心跳/流量窗口回归，先查 `connection.ts` 心跳与 `tunnel.ack` 流量窗口（spec §4.4）。
- 资源加载间歇 502、客户端日志"upstream 不可达/socket hang up" → upstream 陈旧 keep-alive 复用，查 `http-channel.ts` 一次性重试与 Client agent `timeout: 4000`。
- 响应尾包截断（差几十~几百字节）→ 中间盒在 FIN 后丢弃了节流队列，查 `packages/chaos-proxy/src/chaos-proxy.ts` FIN 排空传播语义（sourceClosed/destEnded）。
- 会话列表/历史加载不出 → 先看服务端"请求完成"日志的 status/headMs/bodyBytes 分段，区分隧道段与 upstream 段。

## 目录

```text
harness-gateway/       # pnpm monorepo（TS 源码直出，无构建产物，经 tsx 运行）
├── packages/
│   ├── server/        # 网关服务端 — 单端口承载浏览器 HTTP/WS + 客户端隧道 WS；选择页、会话、路由、双向桥接
│   └── client/        # 网关客户端 — 主动出站连网关、hello 登记 hostname，将隧道流量还原为对本地 upstream 的请求
├── docs/superpowers/  # 设计 spec 与实施 plan
└── eslint.shared.ts   # 共享 ESLint 配置
```

依赖方向：`server` 与 `client` 互不依赖，仅通过隧道帧协议对齐（见 `docs/superpowers/specs/`）。

## 命令

| 命令 | 说明 |
|------|------|
| `pnpm typecheck` | TypeScript 类型检查（`tsc --noEmit`，`-r` 跑全部包） |
| `pnpm format` | 统一 ESLint `--fix` 自动修复（共享格式规则见根 `eslint.shared.ts`） |
| `pnpm test` | 运行 vitest 测试（`vitest run --passWithNoTests`） |
| `pnpm run server [--port 9000]` | 启动网关服务端（默认端口 9000，纯参数无配置文件；`pnpm server` 被 pnpm 内置 store server 命令占用，必须带 `run`） |
| `pnpm client [--config <path>]` | 启动网关客户端（默认读 `packages/client/client.config.mjs`，已 gitignore） |

注：根 `build`/`dev` 脚本为 `pnpm -r` 透传，但各包是 TS 源码直出、没有对应 script，无需构建。

## 注释

| 规则 | 说明 |
|------|------|
| 风格 | TS/TSX 用 JSDoc；中文，简洁，先说"做什么"再说"怎么做" |
| 文件头 | 简要说明文件职责 + 注意事项 |
| 嵌套 > 2 层 | 必须注释业务含义 |
| 功能点 | 方法、条件分支、事件处理、数据转换等独立功能单元都需说明其业务目的和关键逻辑 |
| 重要方法 | 必须注释算法思路或业务逻辑 |
| 特殊处理 | 环境判断、响应处理等需注释原因 |
| 密度 | 同文件内保持一致 |

## 日志

| 级别 | 场景 |
|------|------|
| ERROR | 业务异常、外部调用失败 — 必须打印堆栈和业务上下文 |
| WARN | 降级、重试、超时、配置缺失但可继续 |
| INFO | 请求入口、关键状态变更、外部调用耗时 >500ms |
| DEBUG | 分支走向、中间变量、循环关键节点（生产默认关闭） |

**必须打日志的点位**：请求入口（INFO + 标识）、外部调用（DEBUG 参数 + INFO 耗时）、异常捕获（ERROR + 堆栈 + 上下文）、关键分支（DEBUG + 依据）。日志实现见各包 `src/logger.ts`（`createConsoleLogger` / `createDefaultLogger`）。

## 技术栈

- **运行时** — Node.js 20 + tsx（TS 源码直出，无构建产物）；ESM、`type: module`
- **网络** — Node 原生 `http` + `ws`（noServer 模式，upgrade 按路径分发）；运行时依赖仅 `ws` + `tsx`
- **会话/存储** — 全内存（选择页 session cookie → hostname → 隧道），无数据库
- **鉴权** — 客户端是唯一鉴权权威；服务端转发时注入 `Authorization: Bearer`、剥离网关自身 cookie
- **测试** — vitest（`vitest.config.ts` 在各包内）
- **配置** — 服务端纯 CLI 参数；客户端 `client.config.mjs`（含 authorization 钩子）
- **路径别名** — 无（tsconfig 未配置 paths）
