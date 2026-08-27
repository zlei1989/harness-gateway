/**
 * harness-client 本地开发配置 — 根指令 `pnpm client` 默认加载本文件。
 * （CLI 默认路径 ./client.config.mjs，pnpm --filter exec 的 cwd 为本包目录）
 * 注意：本文件已在 .gitignore 中忽略，可放心填写本机 token，勿提交到仓库。
 */
export default {
  // 本机要暴露的服务地址（http/https），默认指向本地 DSH Web
  upstreamUrl: 'http://localhost:3088',
  // 网关隧道端点（ws/wss），本地开发对应 `pnpm server` 默认端口 9000
  gatewayUrl: 'ws://localhost:9080/__gateway__/tunnel',
  // gatewayUrl: 'ws://harness-gateway.7qbjs.com/__gateway__/tunnel',
  // gatewayUrl: 'ws://localhost:9000/__gateway__/tunnel',
  // 选择页展示名与路由标识，全网关内唯一
  hostname: '工位001',
  // 可选：接入令牌，配置后选择页须输入该 token；删除则全部放行（仅适合内网/测试）
  token: 'test',
  // 可选：选择成功后浏览器跳转路径，默认 '/'
  defaultPath: '/',
}
