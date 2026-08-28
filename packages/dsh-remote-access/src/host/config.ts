/**
 * 远程访问配置读写 — ~/.dsh/.remote-access.yaml。
 * 缺文件/缺字段以默认值补全并立即落盘（保证 token 生成一次后稳定）；
 * 写文件用「临时文件 + rename」避免半截写入。不持久化 enabled 状态。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse, stringify } from 'yaml';

import { randomToken } from '../shared/random-token';

export interface RemoteAccessConfig {
  /** 空 = 使用环境主机名（os.hostname()） */
  hostname: string;
  /** 8 位 [0-9a-zA-Z] 接入令牌 */
  token: string;
  /** 网关地址 */
  gateway: string;
  /** 压缩传输：为 upstream 未压缩的可压缩响应代做 br/gzip 端到端压缩 */
  compress: boolean;
}

export const DEFAULT_GATEWAY = 'harness-gateway.7qbjs.com';

export function configPath(homeDir: string): string {
  return join(homeDir, '.dsh', '.remote-access.yaml');
}

/** 默认配置：主机名空（用环境主机名）、token 随机生成、网关为默认地址、压缩传输开启。 */
export function defaultConfig(): RemoteAccessConfig {
  return { hostname: '', token: randomToken(8), gateway: DEFAULT_GATEWAY, compress: true };
}

/**
 * 读取配置；文件不存在/字段缺失以默认值补全并落盘。
 * yaml 损坏抛错——调用方（handlers）降级为内存默认配置并附 warning。
 */
export function loadConfig(homeDir: string): RemoteAccessConfig {
  const path = configPath(homeDir);
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    saveConfig(homeDir, cfg);
    return cfg;
  }
  const doc: unknown = parse(readFileSync(path, 'utf8'));
  const raw = (doc !== null && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const cfg: RemoteAccessConfig = {
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    token: typeof raw.token === 'string' && /^[0-9a-zA-Z]+$/.test(raw.token) ? raw.token : randomToken(8),
    gateway: typeof raw.gateway === 'string' && raw.gateway.trim() ? raw.gateway : DEFAULT_GATEWAY,
    compress: typeof raw.compress === 'boolean' ? raw.compress : true,
  };
  // 补全了缺省字段则落盘（token 等默认值生成一次后稳定）
  if (cfg.hostname !== raw.hostname || cfg.token !== raw.token || cfg.gateway !== raw.gateway
    || cfg.compress !== raw.compress) {
    saveConfig(homeDir, cfg);
  }
  return cfg;
}

/** 校验 + 原子写（临时文件 + rename）。校验失败抛 Error（message 面向用户）。 */
export function saveConfig(homeDir: string, cfg: RemoteAccessConfig): void {
  if (!/^[0-9a-zA-Z]+$/.test(cfg.token)) throw new Error('令牌密钥仅允许 0-9 a-z A-Z 且不能为空');
  if (!cfg.gateway.trim()) throw new Error('网关地址不能为空');
  const path = configPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringify(cfg), 'utf8');
  renameSync(tmp, path);
}
