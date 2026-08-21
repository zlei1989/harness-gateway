# AGENT.md

用中文交流。

## 约束

- **改协议/行为前先读 `docs/superpowers/specs/` 中的两份设计文档** — 隧道帧协议字段以客户端 spec §4 + 服务端 spec §5 的 hello 扩展为准，代码与 spec 冲突时先对齐 spec
- **代码变更后、进入审查阶段前，必须先执行检查与格式化** — 顺序：`pnpm typecheck` → `pnpm format` → 修复所有错误 → 再进入代码审查；格式化产生的代码变更需随本次改动一并提交
- **仅用 pnpm** — 根 `preinstall` 会拒绝 npm/yarn 安装依赖
- **选择页为服务端直出的零依赖自包含 HTML** — 不引入前端构建链（spec §1.3-9 明确偏离常规 antd/Tailwind 规范）
- **TLS 交给前置反代（nginx/caddy）** — 网关只讲 HTTP/WS；token 随转发请求流经隧道，公网部署务必前置 TLS
- **CLI 错误只输出单行诊断** — 不打印原始 Error 对象/堆栈，避免回显可能含敏感信息的代码帧
- 启动 `harness-server` 时若默认端口 3081 被占用，先 kill 占用进程或用 `--port` 换端口再启动

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
| `pnpm run server [--port 3081]` | 启动网关服务端（默认端口 3081，纯参数无配置文件；`pnpm server` 被 pnpm 内置 store server 命令占用，必须带 `run`） |
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
