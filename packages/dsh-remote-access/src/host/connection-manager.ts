/**
 * 隧道连接管理 — 封装 gateway-client 的 Client 生命周期与状态机。
 * 状态：off → connecting → connected / error；disconnected 后回到
 * connecting（Connection 内建断线重连 + tunnelId 回带复用）。
 * enable 幂等：先关闭旧实例再新建（配置变更后重新启用）。
 * 错误分级（线上 1006 非法 close 帧误报修复）：ws 级瞬时 'error'（中间件
 * synthesized 非法帧、网络抖动）只诊断不落状态——内建重连随后经
 * disconnected → connecting → connected 自动收敛；仅终态 'fatal'
 * （4409 / 重连耗尽）与 enable 首连失败才落 error 态。
 */

import os from 'node:os';

import { Client } from 'gateway-client';

import { buildSelectDeepLink, deriveGatewayEndpoints, type GatewayEndpoints } from './gateway-url';
import { createPluginLogger } from './logger';

import type { RemoteAccessConfig } from './config';
import type { ConnectionStatusDto } from '../shared/types';

export interface ConnectionManagerDeps {
  /** 当前 DSH web 服务地址（http://127.0.0.1:<webServer.port>） */
  upstreamUrl: string;
  /**
   * 网关选择成功后浏览器落地路径（网关客户端 defaultPath），每次 enable 现取——
   * DSH 浏览器认证桥接要求它携带进程级启动令牌（'/?token=…'），令牌随 dsh web
   * 重启轮换，不得缓存。缺省不传，Client 内 defaultPath ?? '/' 接管。
   */
  defaultPath?: () => string;
}

const LOG_PREFIX = '[dsh-remote-access]';

export class ConnectionManager {
  private client: Client | null = null;
  private endpoints: GatewayEndpoints | null = null;
  private info: ConnectionStatusDto = { state: 'off' };

  constructor(private readonly deps: ConnectionManagerDeps) {}

  get status(): ConnectionStatusDto {
    return this.info;
  }

  /** 启用连接；非法配置/首连失败时状态落 error（非法输入的 Error 继续上抛给 UI）。 */
  async enable(cfg: RemoteAccessConfig): Promise<ConnectionStatusDto> {
    // 先校验配置：非法网关地址抛错时不改动现有状态（保持 off）
    const endpoints = deriveGatewayEndpoints(cfg.gateway);
    const hostname = cfg.hostname.trim() || os.hostname();
    // enable 幂等：先关闭旧实例再新建（配置变更后重新启用）。
    // 不复用 disable()：其同步段会把状态置 off，导致未 await enable 的
    // 调用方观察不到 connecting；这里内联旧实例清理，同步置 connecting。
    const old = this.client;
    this.client = null;
    this.info = { state: 'connecting' };
    if (old) await old.close().catch(() => undefined);
    // 构造器对非法配置同步抛错（client.ts 构造校验）——纳入 try/catch，
    // 否则状态机已置 connecting 且无人回写，会永久楔死
    let client: Client;
    try {
      client = new Client({
        upstreamUrl: this.deps.upstreamUrl,
        gatewayUrl: endpoints.gatewayUrl,
        hostname,
        token: cfg.token,
        compress: cfg.compress,
        // DSH 浏览器认证桥接：落地路径携带启动令牌（每次 enable 现取，令牌随进程轮换）；
        // 缺省传 undefined，Client 默认 '/'（与下方 connections 同一透传模式）
        defaultPath: this.deps.defaultPath?.(),
        // 隧道连接数原样透传：undefined 时 Client 默认 4（spec §8）
        connections: cfg.connections,
        logger: createPluginLogger(),
      });
      this.client = client;
      this.endpoints = endpoints;
    } catch (err) {
      this.info = { state: 'error', error: err instanceof Error ? err.message : String(err) };
      this.client = null;
      return this.info;
    }
    console.info(`${LOG_PREFIX} [INFO] 开始连接网关: ${endpoints.gatewayUrl}（hostname=${hostname}）`);

    // EventEmitter 语义：error 事件必须挂监听。
    // 瞬时 ws 错误（非法帧/抖动）不落状态——Connection 内建重连随后经
    // disconnected → connecting → connected 收敛；gateway-client 日志已记诊断。
    client.on('error', () => undefined);
    // 终态失败（已就绪后 4409 / 重连次数耗尽，不再重连）才落 error 态
    client.on('fatal', (err: Error) => {
      if (this.client === client) this.info = { state: 'error', error: err.message };
    });
    client.on('connected', () => {
      if (this.client !== client) return; // 旧实例迟到事件
      const tunnelId = client.tunnelId;
      this.info = {
        state: 'connected',
        ...(tunnelId ? { tunnelId } : {}),
        ...(tunnelId && this.endpoints
          ? { deepLink: buildSelectDeepLink(this.endpoints.selectUrl, tunnelId) }
          : {}),
      };
      console.info(`${LOG_PREFIX} [INFO] 隧道已连接: tunnelId=${tunnelId ?? '-'}`);
    });
    client.on('disconnected', () => {
      // 断线重连由 Connection 内建：只要未 disable 一律回 connecting（重连退避中）。
      // 终态断开（4409/重连耗尽）在同一 close 处理后由随后的 'fatal' 落 error，
      // 此处先置 connecting 无害；瞬时错误抢先把状态打成 error 的场景也由此归位
      if (this.client === client && this.info.state !== 'off') this.info = { state: 'connecting' };
    });

    try {
      await client.connect();
    } catch (err) {
      // 并发 disable 导致的 connect 拒绝不回写状态（保持 off）
      if (this.client === client) this.info = { state: 'error', error: err instanceof Error ? err.message : String(err) };
      await client.close().catch(() => undefined);
      if (this.client === client) this.client = null;
    }
    return this.info;
  }

  /** 关闭连接（无连接时为 no-op）。 */
  async disable(): Promise<ConnectionStatusDto> {
    const client = this.client;
    this.client = null;
    this.info = { state: 'off' };
    if (client) {
      await client.close().catch(() => undefined);
      console.info(`${LOG_PREFIX} [INFO] 隧道已关闭`);
    }
    return this.info;
  }
}
