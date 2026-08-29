# dsh-remote-access

DSH（DeepSeek Harness）动态插件：在「设置」新增「远程访问」选项页，配置主机名称 /
令牌密钥 / 网关地址后手动打开「启用」，即在 DSH 进程内启动 harness-gateway 隧道
客户端，把当前 DSH web 服务接入网关；连接成功展示选择页深链二维码，移动端扫码
快速进入。

## 构建

    pnpm install
    pnpm --filter dsh-remote-access build   # tsup：host → lib/index.js（ESM），client → lib/client.js（loader 包裹）

## 安装

    pnpm build 后：dsh plugin --profile web add <本仓库>/packages/dsh-remote-access
    重启 dsh web，设置中即出现「远程访问」选项页。
    卸载：dsh plugin --profile web remove dsh-remote-access

## 使用

1. 设置 → 远程访问。
2. 按需修改主机名称（空 = 环境主机名）、令牌密钥（8 位，可点「生成」换新）、网关地址（默认 harness-gateway.7qbjs.com）。
3. 打开「启用」开始连接；每次打开本页开关均为关闭，须手动连接。
4. 连接成功后展示二维码（http://<网关>/__gateway__/select?tunnelId=xxx），
   移动端扫码或点「立即查看」新窗口打开。

## DSH 浏览器认证桥接

DSH web 自身有浏览器认证（需访问它启动时打印的 `/?token=…` URL 铸发 cookie），
经网关远程访问时该 loopback URL 打不开，直接登录网关会被 401 挡住。本插件经
`connection` 服务读取启动令牌，把隧道客户端的 `defaultPath` 置为 `/?token=…`：
网关登录成功后浏览器先落在带令牌的路径上，经隧道自动完成令牌交换再跳回干净 `/`，
全程无感（令牌每次启用时现取，随 dsh web 重启轮换）。

安全语义：经此桥接，网关令牌即为唯一有效凭证（DSH 的 401 不再构成第二因子，
与网关「客户端是唯一鉴权权威」模型一致）。启动令牌只经隧道 hello 帧与登录响应
流转，不进任何日志，也不渲染进选择页 HTML。

已知限制：

- connection 服务缺席的老 DSH 上桥接自动关闭（日志有 WARN），退回手工拼
  `http://<网关>/?token=<dsh web 终端打印的 token>` 的老流程，远程访问主功能不受影响。
- 生命周期次序天然安全：网关会话 7 天 < dsh-auth cookie 30 天，每次网关重新登录
  都会重新铸发 DSH cookie，无悬空态。
- 多台机器共用同一 upstream authority（均为 127.0.0.1:3088）时，DSH cookie 名相同，
  浏览器切换电脑会互相覆盖——因每次登录都经桥接重新铸发，切换即自愈。

## 配置

保存于 `~/.dsh/.remote-access.yaml`（hostname / token / gateway；enabled 不持久化）。

## 协议推断

裸域名 → ws 隧道 + http 选择页；https:// 或 wss:// → wss/https。只取 origin。
