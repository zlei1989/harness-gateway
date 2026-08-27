import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configPath, DEFAULT_GATEWAY, loadConfig, type RemoteAccessConfig, saveConfig,
} from './config';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ra-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('文件不存在：生成默认配置并立即落盘（token 8 位字符集）', () => {
    const cfg = loadConfig(home);
    expect(cfg.hostname).toBe('');
    expect(cfg.token).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(cfg.gateway).toBe(DEFAULT_GATEWAY);
    // 已落盘：再次读取得到同一 token（生成一次后稳定）
    expect(loadConfig(home).token).toBe(cfg.token);
  });

  it('字段缺失：以默认值补全并落盘', () => {
    const path = configPath(home);
    saveConfig(home, { hostname: 'pc-a', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    // 手工删掉 gateway 字段模拟旧版配置
    writeFileSync(path, 'hostname: pc-a\ntoken: tok12345\n', 'utf8');
    const cfg = loadConfig(home);
    expect(cfg).toEqual({ hostname: 'pc-a', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    expect(readFileSync(path, 'utf8')).toContain('gateway:');
  });

  it('yaml 损坏：抛错由调用方降级', () => {
    const path = configPath(home);
    saveConfig(home, { hostname: '', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    writeFileSync(path, ': : : not yaml [', 'utf8');
    expect(() => loadConfig(home)).toThrow();
  });
});

describe('saveConfig', () => {
  it('round-trip：写入后可原样读回', () => {
    const cfg: RemoteAccessConfig = { hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com' };
    saveConfig(home, cfg);
    expect(loadConfig(home)).toEqual(cfg);
  });

  it('token 含非法字符或为空：抛错且不写文件', () => {
    expect(() => saveConfig(home, { hostname: '', token: 'bad token!', gateway: DEFAULT_GATEWAY })).toThrow(/令牌密钥/);
    expect(() => saveConfig(home, { hostname: '', token: '', gateway: DEFAULT_GATEWAY })).toThrow(/令牌密钥/);
    expect(loadConfig(home).token).toMatch(/^[0-9a-zA-Z]{8}$/); // 未被污染，走缺省生成
  });

  it('网关地址为空：抛错', () => {
    expect(() => saveConfig(home, { hostname: '', token: 'tok12345', gateway: '  ' })).toThrow(/网关地址/);
  });
});
