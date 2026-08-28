# dsh-remote-access 插件设计

日期：2026-08-28
状态：已批准（brainstorming 设计评审通过）
修订：2026-08-28 第二轮——新增「压缩传输」：yaml 配置 `compress` 字段（默认开）、设置面板「网关地址」下方 switch、`Client` 构造透传 gateway-client 的压缩能力（客户端 spec §5.1）。

## 1. 目标

为 DSH（DeepSeek Harness）开发一个 `dsh-remote-access` 动态插件：在 DSH「设置」中新增「远程访问」选项页，用户配置主机名称 / 令牌密钥 / 网关地址后，手动打开「启用」开关，插件即在 DSH host 进程内启动 `gateway-client` 隧道客户端，把当前 DSH web 服务接入 harness-gateway 网关；连接成功后展示二维码（内容为选择页深链），供移动端扫码快速进入。

## 2. 包形态与目录结构

新增 workspace 包 `packages/dsh-remote-access`（`pnpm-workspace.yaml` 的 `packages/*` 已覆盖，无需改 workspace 配置）。形态完全对齐参考插件 `dsh-webpage-element-picker`（D:\Github\dsh-webpage-element-picker）的 DSH bundle 插件：

- `package.json` 声明 `dsh.bundle.patch`（`cordis.patch.yml` 配置层）与 `dsh.client`（`platform: web`），`exports` 暴露 `.`（host 半）与 `./client`（浏览器半）。
- tsup 双入口构建：host 半 `src/host/index.ts` → `lib/index.js`（ESM，platform node）；client 半 `src/client/index.ts` → `lib/client.js`（CJS + `window.__ModuleLoader__.load` 包裹 banner/footer，`react` external）。
- `lib/` 为构建产物，不入库（加入 .gitignore 或包级忽略）。

```text
packages/dsh-remote-access/
  package.json          # name: dsh-remote-access；deps: gateway-client(workspace:*), ws, yaml；
                        # client 内联: qrcode-generator；devDeps: tsup, typescript, @deepseek-ai/cordis(类型), vitest…
  tsup.config.ts        # 双入口（host ESM / client CJS+loader 包裹）
  tsconfig.json
  eslint.config.ts
  cordis.patch.yml      # - insert: - id: remote-access / name: dsh-remote-access
  README.md
  src/
    host/index.ts       # Cordis 插件：Client 生命周期 + /dsh-remote-access/invoke 路由
    host/config.ts      # ~/.dsh/.remote-access.yaml 读写、缺省补全、随机密钥
    host/gateway-url.ts # 网关地址 → gatewayUrl/选择页地址 协议推断（纯函数）
    host/services.ts    # webServer 等 type-only 服务契约
    host/*.test.ts      # vitest 单测
    client/index.ts     # settings.section 注册 + 设置面板组件
    client/services.ts  # ClientCtx type-only
    client/react.ts     # 由注入 require 取得 react 的唯一入口
    client/globals.d.ts # 浏览器 bundle 运行时全局声明
    shared/types.ts     # host↔client invoke 方法/状态形状（type-only）
```

### 依赖策略

- `gateway-client` 是 TS 源码直出（`exports["."] = "./src/index.ts"`）：host bundle 由 tsup 直接编译打包其源码进 `lib/index.js`，无需 gateway-client 自身构建。必须经 tsup `noExternal` 显式内联——`workspace:*` 协议独立安装时无法解析；且 tsup 默认把 package.json dependencies 全部自动外置，不配 `noExternal` 就是 externals drift（2026-08-28 线上事故根因之一）。
- `ws`（gateway-client 的运行时依赖）与 `yaml`（配置序列化）在 host bundle 中保持 external，并声明为 `dsh-remote-access` 自身 dependency——插件以 workspace 包运行时可经 node_modules 解析。**yaml 不得内联**：它是纯 CJS 包，esbuild 打进 ESM 产物会把其内部 `require('process')` 转成 `__require` 垫片，运行时抛 "Dynamic require of process is not supported"（2026-08-28 线上事故根因之二）。
- `qrcode-generator` 必须经 `noExternal` 内联进 client bundle（纯 JS，约 20KB，离线可用）：浏览器模块表无包解析能力，残留裸 require 即插件整页加载失败；`react` 由浏览器模块表运行时提供（external）。构建后由 `scripts/verify-bundle.mjs` 对产物做反向断言兜底（client 仅允许 react；host 仅允许 ws/yaml）。

## 3. Host 半（Cordis 插件）

模块级 `export const name = 'dsh-remote-access'` 与 `export const inject = ['webServer', 'timer']`（Cordis 门控：服务激活后才运行 `apply`）。不 `export default`（Loader 的 unwrapExports 会坍缩模块并丢弃 inject）。

### 3.1 配置读写（host/config.ts）

路径：`~/.dsh/.remote-access.yaml`（`node:os.homedir()` + `node:fs`，经 `yaml` 包序列化/解析）。

```yaml
hostname: ""          # 空 = 取 os.hostname()
token: "aB3x9Kq2"     # 首次缺省时自动生成 8 位 [0-9a-zA-Z]
gateway: "harness-gateway.7qbjs.com"
compress: true        # 压缩传输（br/gzip 端到端压缩，2026-08-28 第二轮新增；旧版配置缺省补全为 true）
```

规则：

- 文件不存在/字段缺失 → 以默认值补全并立即落盘（保证 token 生成一次后稳定）。
- 不存 `enabled` 字段：启用状态不持久化，每次打开设置页开关一律为关，必须手动连接。
- token 明文存储，与 DSH 自身 `settings.yaml` 存 API 密钥的形态一致。
- 写文件用「临时文件 + rename」避免半截写入。

### 3.2 协议推断（host/gateway-url.ts，纯函数）

用户只需填域名；推断规则：

| 用户输入 | 隧道 gatewayUrl | 选择页/二维码地址 |
|---|---|---|
| `harness-gateway.7qbjs.com`（裸域名或 host:port） | `ws://<input>/__gateway__/tunnel` | `http://<input>/__gateway__/select?tunnelId=xxx` |
| `http://…` 或 `ws://…` | `ws://…/__gateway__/tunnel` | `http://…/__gateway__/select?tunnelId=xxx` |
| `https://…` 或 `wss://…` | `wss://…/__gateway__/tunnel` | `https://…/__gateway__/select?tunnelId=xxx` |

只取 origin（忽略误填的路径/查询串）；无法解析时返回错误，UI 提示。该纯函数独立成文件便于表驱动单测。

### 3.3 隧道客户端生命周期

- `remote-enable`：读取当前配置 → `new Client({ upstreamUrl, gatewayUrl, hostname: config.hostname || os.hostname(), token, compress: config.compress })`；`upstreamUrl = 'http://127.0.0.1:' + webServer.port`（当前 DSH web 服务地址，环回即可，隧道在本进程内转发）。`compress` 为 gateway-client 的压缩传输开关（见客户端 spec §5.1：为 upstream 未压缩的可压缩响应代做 br/gzip 端到端压缩）。
- 挂 `connected` / `disconnected` / `error` 监听维护状态机：`off | connecting | connected | error`；`connected` 后读取 `client.tunnelId`（hello.ack 下发）。
- `remote-disable`：`client.close()` 并置 `off`。
- 已连接时再次 `remote-enable`（如配置变更后重新打开开关）：先 close 旧实例再新建。
- 插件卸载（ctx.effect 清理）：尽力 `close()`。
- Client 的 logger 适配到插件日志前缀 `[dsh-remote-access]`。

### 3.4 HTTP 路由

注册 `POST /dsh-remote-access/invoke`（exact 路由，形态同参考插件）：body `{ method, params }` → JSON 结果。方法：

- `remote-status` → `{ ok, config: { hostname, token, gateway, compress }, connection: { state, tunnelId?, error? }, selectUrl? }`；`selectUrl` 在 connected 时给出完整深链。
- `remote-save-config` `{ hostname?, token?, gateway?, compress? }` → 校验（token 非空且符合字符集、gateway 可解析）→ 写 yaml → `{ ok }` 或 `{ ok: false, error }`；缺省字段回落已保存值。
- `remote-enable` / `remote-disable` → `{ ok, connection }` 或 `{ ok: false, error }`。

## 4. Client 半（设置页 UI）

`ctx.slots.inject('settings.section', ...)` 注册：

```ts
ctx.slots.register(
  { name: 'settings.section', id: 'remote-access', order: 100, label: '远程访问' },
  RemoteAccessSection,
)
```

面板自上而下（受控组件，值来自 `remote-status` 返回的 config）：

1. **主机名称** input —— 空值表示用环境主机名（placeholder 显示当前 `os.hostname()` 由 status 下发）。
2. **令牌密钥** input + 右侧「生成」按钮 —— 前端生成 8 位 `[0-9a-zA-Z]` 随机串填入输入框。
3. **网关地址** textarea —— 默认 `harness-gateway.7qbjs.com`。
4. **压缩传输** switch —— 默认开；切换即保存（无失焦时机），控制 gateway-client 的 br/gzip 端到端压缩。
5. **启用** switch —— 默认关；打开即调 `remote-enable`，关闭调 `remote-disable`。
6. 连接成功（state === 'connected' 且有 tunnelId）后下方展示：
   - 二维码（`qrcode-generator` 生成 SVG，内容为 `selectUrl`）；
   - 「立即查看」文字按钮 —— `window.open(selectUrl, '_blank')` 弹出新窗口。

行为：

- 字段失焦（onBlur）即调 `remote-save-config` 持久化；保存失败在字段下方显示错误。
- 面板挂载期间每 ~1.5s 轮询 `remote-status`，跟踪 connecting/connected/error 状态并展示对应文案（连接中… / 已连接 / 失败原因）。
- 每次进入面板开关一律为关（`enabled` 不持久化）。为保证语义严格成立，面板挂载时先调一次 `remote-status`：若 host 侧仍有存活连接（例如上一轮面板会话开启后未关），则自动调 `remote-disable` 清理，确保「每次打开都是关闭、必须手动连接」。面板保持打开期间，开关状态跟随用户操作与连接状态回显。
- 样式：内联 style 对象（同参考插件），不引外部 CSS。

## 5. 错误处理

- 网关地址非法 / token 为空时 `remote-enable` 直接返回错误，UI 红字提示，开关回弹为关。
- 连接失败（gateway 不可达、握手超时）：state=error，展示错误摘要；隧道自动重连由 `gateway-client` Connection 内建（断线重连 + tunnelId 回带复用），UI 轮询自然跟进状态变化。
- yaml 读写失败：`remote-status` 降级返回内存默认配置并带 warning 字段，不阻塞 UI。
- 配置在已连接状态下被修改：不自动重连；UI 提示「修改将在下次启用时生效」。

## 6. 测试

vitest（对齐仓库现有 `pnpm -r test`）：

- `config.test.ts`：round-trip 读写、缺省补全并落盘、随机密钥字符集/长度、损坏 yaml 的降级。
- `gateway-url.test.ts`：协议推断表驱动用例（裸域名、带端口、四种 scheme、非法输入）。
- host 状态机：用 mock gateway（参考 `packages/client/src/test-utils/mock-gateway.ts`）验证 enable → connected（含 tunnelId）→ disable → off。
- `pnpm typecheck`（tsc --noEmit）通过；tsup build 产物存在且 client bundle 含 loader 包裹。

## 7. 安装与分发

与参考插件一致：

```sh
pnpm install && pnpm --filter dsh-remote-access build
dsh plugin --profile web add <repo>/packages/dsh-remote-access
```

重启 `dsh web` 后「设置」出现「远程访问」选项页。卸载：`dsh plugin --profile web remove dsh-remote-access`。

## 8. 非目标（YAGNI）

- 不做启用状态持久化 / 开机自连（用户明确要求每次手动）。
- 不做多网关配置、不做 token 加密存储。
- ~~不改 harness-gateway 服务端与 client 包任何代码~~（2026-08-28 第二轮修订：压缩传输为 `gateway-client` 新增 `ClientOptions.compress` 可选字段与 `HttpChannel` 压缩协商，属向后兼容的纯增量；服务端保持透明透传零改动）。
- 不做移动端适配的选择页改造（网关侧已有）。
