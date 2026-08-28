/**
 * 插件日志适配层测试 — context 必须透传（线上"隧道连接错误无详情"根因修复的回归锁）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPluginLogger } from './logger';

describe('createPluginLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  it('error 透传 context JSON（err.stack 不再被吞）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = 'Error: read ECONNRESET';
    createPluginLogger().error('隧道连接错误', { error });
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [ERROR] 隧道连接错误 ${JSON.stringify({ error })}`);
  });

  it('warn 透传断开诊断 code/reason/readyMs', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = { code: 1006, reason: undefined, readyMs: 1234 };
    createPluginLogger().warn('隧道连接断开', ctx);
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [WARN] 隧道连接断开 ${JSON.stringify(ctx)}`);
  });

  it('无 context 时不带 JSON 尾巴', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    createPluginLogger().info('隧道就绪');
    expect(spy).toHaveBeenCalledWith('[dsh-remote-access] [INFO] 隧道就绪');
  });

  it('debug 恢复透传（原为完全静默）', () => {
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    createPluginLogger().debug('未知通道数据帧，丢弃', { channelId: 7 });
    expect(spy).toHaveBeenCalledWith(`[dsh-remote-access] [DEBUG] 未知通道数据帧，丢弃 ${JSON.stringify({ channelId: 7 })}`);
  });
});
