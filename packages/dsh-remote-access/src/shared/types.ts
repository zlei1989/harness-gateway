/**
 * host ↔ client 经 /dsh-remote-access/invoke 交换的形状（type-only）。
 */

/** 远程访问配置（~/.dsh/.remote-access.yaml 的字段形状）。 */
export interface RemoteAccessConfigDto {
  /** 空 = 使用环境主机名 */
  hostname: string;
  /** 8 位 [0-9a-zA-Z] 接入令牌 */
  token: string;
  /** 网关地址（裸域名缺省 http/ws；支持 http/https/ws/wss 前缀） */
  gateway: string;
  /** 压缩传输（br/gzip 端到端压缩，默认开） */
  compress: boolean;
}

/** 隧道连接状态。 */
export interface ConnectionStatusDto {
  state: 'off' | 'connecting' | 'connected' | 'error';
  /** hello.ack 后可用 */
  tunnelId?: string;
  /** state === 'error' 时的摘要 */
  error?: string;
  /** state === 'connected' 时的选择页深链（二维码内容） */
  deepLink?: string;
}

/** remote-status 的返回。 */
export interface RemoteStatusDto {
  ok: true;
  config: RemoteAccessConfigDto;
  /** 环境主机名（主机名称为空时的实际生效值，UI 作 placeholder） */
  envHostname: string;
  connection: ConnectionStatusDto;
  /** 配置文件读取失败等降级提示 */
  warning?: string;
}

/** remote-save-config / remote-enable / remote-disable 的返回。 */
export interface RemoteInvokeResult {
  ok: boolean;
  error?: string;
  connection?: ConnectionStatusDto;
}
