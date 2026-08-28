/**
 * /dsh-remote-access/invoke 的方法处理器（与 Cordis/webServer 解耦，便于单测）。
 * remote-status / remote-save-config / remote-enable / remote-disable。
 */

import { defaultConfig, loadConfig, type RemoteAccessConfig, saveConfig } from './config';
import { ConnectionManager } from './connection-manager';
import { deriveGatewayEndpoints } from './gateway-url';

import type { ConnectionStatusDto, RemoteAccessConfigDto, RemoteStatusDto } from '../shared/types';

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export interface HandlerDeps {
  /** 配置所在家目录（生产为 os.homedir()，测试为临时目录） */
  homeDir: string;
  manager: ConnectionManager;
  /** 环境主机名（生产为 os.hostname()） */
  envHostname: string;
}

const LOG_PREFIX = '[dsh-remote-access]';

function toDto(cfg: RemoteAccessConfig): RemoteAccessConfigDto {
  return { hostname: cfg.hostname, token: cfg.token, gateway: cfg.gateway, compress: cfg.compress };
}

/** 从表单参数提取配置（缺省字段回落到已保存配置/默认值）。 */
function configFromParams(
  params: Record<string, unknown>,
  base: RemoteAccessConfig,
): RemoteAccessConfig {
  return {
    hostname: typeof params.hostname === 'string' ? params.hostname : base.hostname,
    token: typeof params.token === 'string' ? params.token : base.token,
    gateway: typeof params.gateway === 'string' ? params.gateway : base.gateway,
    compress: typeof params.compress === 'boolean' ? params.compress : base.compress,
  };
}

/** 校验配置（token 字符集 + 网关可解析）；非法抛 Error（message 面向用户）。 */
function validate(cfg: RemoteAccessConfig): void {
  if (!/^[0-9a-zA-Z]+$/.test(cfg.token)) throw new Error('令牌密钥仅允许 0-9 a-z A-Z 且不能为空');
  deriveGatewayEndpoints(cfg.gateway); // 非法输入在此抛错
}

export function createHandlers(deps: HandlerDeps): Map<string, Handler> {
  const handlers = new Map<string, Handler>();

  /** 读配置；yaml 损坏降级为内存默认配置（不落盘）并附 warning。 */
  const readConfig = (): { cfg: RemoteAccessConfig; warning?: string } => {
    try {
      return { cfg: loadConfig(deps.homeDir) };
    } catch (err) {
      console.warn(`${LOG_PREFIX} [WARN] 配置文件读取失败，降级为默认配置: ${String((err as Error)?.message ?? err)}`);
      return { cfg: defaultConfig(), warning: '配置文件读取失败，已使用默认配置（保存时将覆盖修复）' };
    }
  };

  handlers.set('remote-status', async (): Promise<RemoteStatusDto> => {
    const { cfg, warning } = readConfig();
    return {
      ok: true,
      config: toDto(cfg),
      envHostname: deps.envHostname,
      connection: deps.manager.status,
      ...(warning ? { warning } : {}),
    };
  });

  handlers.set('remote-save-config', async (params) => {
    try {
      const { cfg: base } = readConfig();
      const cfg = configFromParams(params, base);
      validate(cfg);
      saveConfig(deps.homeDir, cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });

  handlers.set('remote-enable', async (params) => {
    try {
      const { cfg: saved } = readConfig();
      const override = (params.override && typeof params.override === 'object'
        ? params.override : params) as Record<string, unknown>;
      const cfg = configFromParams(override, saved);
      validate(cfg);
      // 不 await 完整 enable：gateway-client 首连失败会内部退避重试直至
      // connectTimeoutMs（默认 60s），HTTP 调用不能阻塞这么久。enable 的
      // 同步前缀已把状态置为 connecting，即时返回当前状态，由 UI 轮询
      // remote-status 跟进 connected/error。连接错误由 enable 内部捕获
      // 并落状态机；这里再挂 catch 兜底防未处理拒绝。
      const enablePromise = deps.manager.enable(cfg);
      enablePromise.catch(() => undefined);
      const connection: ConnectionStatusDto = deps.manager.status;
      return { ok: true, connection };
    } catch (err) {
      return {
        ok: false,
        error: String((err as Error)?.message ?? err),
        connection: deps.manager.status,
      };
    }
  });

  handlers.set('remote-disable', async () => {
    const connection = await deps.manager.disable();
    return { ok: true, connection };
  });

  return handlers;
}
