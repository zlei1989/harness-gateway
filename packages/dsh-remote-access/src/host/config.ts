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
  /** 隧道连接数（可选；默认 4，1=单连接 legacy 模式，详见网关 README） */
  connections?: number;
  /**
   * 隧道心跳间隔毫秒（可选；默认 30000）。前置反代/负载均衡的空闲超时短于 30s 时
   * 必须调小到其一半以下，否则隧道被周期性回收（表现：规律性断连重连，详见网关 README）
   */
  heartbeatIntervalMs?: number;
  /**
   * 心跳判死宽容度（可选；默认 3）。判死窗 = heartbeatIntervalMs × 本值，期间任何入站帧
   * （pong/tunnel.ack/数据）都会重置静默计时。链路长抖动被误判死时上调（代价：真死发现更慢）
   */
  heartbeatMaxMissed?: number;
  /**
   * 隧道 WS permessage-deflate 开关（可选；默认开 = 客户端提议压缩，服务端不协商则不生效）。
   * false = 不提议压缩：排查路径上中间盒误杀压缩帧（RSV1）导致的"有流量就断"时置 false 对照验证。
   */
  tunnelPerMessageDeflate?: boolean;
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
    // 可选字段：仅在 yaml 手工配置时透传（不落盘补全，缺省由 gateway-client 默认 4 接管）
    connections: typeof raw.connections === 'number' ? raw.connections : undefined,
    // 同上：非法值（非正有限数）视为未配置，由 gateway-client 默认 30s 接管
    heartbeatIntervalMs: typeof raw.heartbeatIntervalMs === 'number'
      && Number.isFinite(raw.heartbeatIntervalMs) && raw.heartbeatIntervalMs > 0
      ? raw.heartbeatIntervalMs : undefined,
    // 同上：< 1 的宽容度会让判死窗小于一个心跳周期（必然误杀），视为未配置由客户端缺省 3 接管
    heartbeatMaxMissed: typeof raw.heartbeatMaxMissed === 'number'
      && Number.isFinite(raw.heartbeatMaxMissed) && raw.heartbeatMaxMissed >= 1
      ? raw.heartbeatMaxMissed : undefined,
    // 仅 boolean 透传；缺省由 gateway-client（ws 库默认提议压缩）接管
    tunnelPerMessageDeflate: typeof raw.tunnelPerMessageDeflate === 'boolean'
      ? raw.tunnelPerMessageDeflate : undefined,
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
