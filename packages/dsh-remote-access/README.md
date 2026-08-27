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

## 配置

保存于 `~/.dsh/.remote-access.yaml`（hostname / token / gateway；enabled 不持久化）。

## 协议推断

裸域名 → ws 隧道 + http 选择页；https:// 或 wss:// → wss/https。只取 origin。
