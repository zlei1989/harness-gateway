# gateway-proxy 轻量化代理 CLI 设计

日期：2026-08-27
状态：已审定（用户已在对话中确认设计与实现方案）

## 1. 背景与目的

monorepo 新增第三个包 `packages/proxy`（包名 `gateway-proxy`，bin `harness-proxy`）：
一个轻量化本地 TCP 反向代理 CLI，把本机 9000 端口上的服务经 9080 端口对外暴露，
并在代理层施加限流。HTTP 与 WebSocket 流量都要支持。

## 2. 需求（已确认口径）

- **代理方向**：监听 `9080` → 转发到 `127.0.0.1:9000`（两端口均可 CLI 参数覆盖）
- **协议支持**：HTTP 与 WS。采用纯 TCP 透传，二者天然支持（WS Upgrade 握手只是普通字节流）
- **连接准入限流**：新建 TCP 连接（含 WS 升级）令牌桶 **8 个/秒**，容量 8；
  无令牌时进 FIFO 队列**等待**（不拒绝）；等待期间客户端断开 → 出队取消，不空耗令牌。
  准入按 TCP 连接计一次：HTTP keep-alive 同连接上的后续请求不重复计数（纯 TCP 层看不到请求边界）
- **带宽限流**：全局唯一令牌桶 **50 KB/s（51200 字节/秒）**，上下行所有连接共享，
  上下行合计 ≤ 50 KB/s；超出部分**延迟发送，不丢数据**
- **轻量化**：零运行时依赖（纯 Node 内置模块），对齐 monorepo 现有 tsx/vitest 模式

### 非目标（YAGNI）

- 不做 HTTP 层语义加工（不重写 Host、不记 method/path 日志）——纯 TCP 透传的固有取舍
- 不做 HTTPS/TLS 终止、不做配置文件、不做按 IP 限流、不做排队长度上限

## 3. 架构与数据流

```
client ──TCP──> [proxy :9080] ──TCP──> [target 127.0.0.1:9000]
                  │  ① 连接准入令牌桶（8/s，FIFO 排队）
                  │  ② 准入后 net.connect(target)
                  ▼
        client → ThrottleStream → target
        client ← ThrottleStream ← target     （两条方向流共享全局带宽桶）
```

- `net.createServer` 监听入站连接；准入成功后 `net.connect` 到 target
- 每个方向插一个 `ThrottleStream`（Transform）：`transform(chunk)` 先
  `await bandwidth.acquire(chunk.length)` 再 push；令牌不足即挂起等待，
  天然形成背压（上游 socket 暂停读取），只延迟不丢数据

## 4. 组件设计

### 4.1 `src/rate-limiter.ts`

- `TokenBucket`（内部基元）：`capacity`、`refillPerSecond`；匀速补充
  （连接桶：每 125ms 补 1；带宽桶：每 100ms 补 5120）；`acquire(cost): Promise<void>`
  不足时挂起，FIFO 唤醒。取舍：严格 FIFO 有队头阻塞（HOL）副作用——共享带宽桶下
  某连接的大 chunk 会挡在其后所有连接的小 chunk 前面（默认 50KB/s 下 1MB 传输可
  让其它连接 stall 最长约 20s），以跨连接瞬时公平性换防饿死确定性
- `ConnectionLimiter`：包装令牌桶（默认 8/s），`acquire(socket)` 在 socket
  `close` 时自动取消等待（Promise 永挂起且从队列剔除，调用方随后销毁 socket）
- `BandwidthLimiter`：包装令牌桶（默认 51200 B/s），`acquire(bytes)` 支持
  大于容量的 chunk：按容量切片累计等待，保证大 chunk 不被饿死

### 4.2 `src/throttle.ts`

- `ThrottleStream extends Transform`：构造注入 `BandwidthLimiter`；
  `_transform` 中 `await limiter.acquire(chunk.length)` 后 `callback(null, chunk)`

### 4.3 `src/server.ts`

- `ProxyServer`：`new ProxyServer({ listenPort, targetHost, targetPort, maxConnectionsPerSecond, maxBytesPerSecond, logger? })`
- `listen(): Promise<number>`（返回实际端口，支持 0 随机端口，供测试）
- `close(): Promise<void>`：停止 accept，销毁全部在途连接与排队连接
- 接线：入站 socket 先挂 `error` 消化监听（对齐 server 包裸 socket 事故修复模式）→
  准入 → `net.connect` target（失败即销毁客户端 socket）→
  `client.pipe(new ThrottleStream(bw)).pipe(target)` 与反向 →
  任一侧 `error`（RST/拒连等异常）→ 摧毁对侧；**优雅关闭（FIN）不摧毁**——
  该方向 readable 自然结束，节流队列中未交付字节随 pipe 排空后对侧才收到 end
  （2026-08-27 截断修复：旧实现 close 即双侧销毁，会把节流队列尾包直接丢弃——
  服务端 keep-alive 空闲关闭场景下响应尾包被截断）
- 连接级日志：准入/排队、建连失败、关闭（双向字节数、时长）

### 4.4 `src/cli.ts`

- 纯参数启动，对齐 `harness-server` cli 模式：`parseArgs` 纯函数可测、
  `main()` 返回退出码、单行诊断（err.message 首行）、入口守卫、
  SIGINT/SIGTERM 优雅关停 + 5s 兜底强退
- 参数：

  ```
  harness-proxy [--listen 9080] [--target 127.0.0.1:9000]
                [--max-connections-per-second 8] [--max-bytes-per-second 51200]
  ```

  - `--target` 格式 `host:port`；host 可含 IPv6 方括号写法
  - `--max-bytes-per-second` 支持 `k`/`m` 后缀（如 `50k`），整数字节
  - 非法值抛错 → 单行诊断 + usage，退出码 1

### 4.5 包文件

```
packages/proxy/
  package.json   name gateway-proxy，type module，bin harness-proxy，
                 scripts: start=tsx src/cli.ts、typecheck、format、test=vitest run --passWithNoTests
                 dependencies: tsx；devDependencies 对齐兄弟包
  tsconfig.json / vitest.config.ts / eslint.config.ts   复制 server 包
  bin/harness-proxy.mjs   复制 server 的 tsx 启动器模式（stdio 继承、退出码透传）
  src/{cli,index,server,rate-limiter,throttle}.ts + src/*.test.ts
```

## 5. 错误与边界

- target 拒绝连接 → 客户端 socket 直接销毁（TCP 层无状态码可回）
- 排队等待中的 socket：挂 `error` 消化 + `close` 出队取消
- 任一侧 `error`/`close` → 双侧 `destroy()`，幂等收尾
- 大 chunk（> 带宽桶容量）：切片累计等待，不死锁
- 进程收到 SIGINT/SIGTERM：`close()` 后退出，5s 未关闭则强制 `exit(1)`

## 6. 测试计划（vitest）

- `rate-limiter.test.ts`：fake timers 验证令牌桶补充节奏、FIFO 唤醒顺序、
  大 cost 切片、close 取消排队
- `throttle.test.ts`：小速率桶下 Transform 输出耗时与数据完整性
- `server.test.ts`（集成，随机端口 + 本地 echo/target server）：
  1. HTTP 请求经 proxy 往返成功
  2. 裸 socket 手写 WS Upgrade 握手字节，验证透传与后续双向帧
  3. 连接准入节奏：`maxConnectionsPerSecond=4` 时 12 个并发连接，
     前 4 立即通，其余按 ~250ms 间隔放行
  4. 带宽节流：`maxBytesPerSecond=200` 时传 600 字节，耗时 ≥ 1.5s
     （容量 200 先行放走后余 400 字节按 200 B/s 补充，理论约 2s，断言保守下界防 CI 抖动）
- `cli.test.ts`：parseArgs 合法/非法值、help、k/m 后缀解析
