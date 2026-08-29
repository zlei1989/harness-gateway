import { describe, expect, it } from 'vitest';

import { buildSelectDeepLink, deriveGatewayEndpoints, dshAuthDefaultPath, dshAuthDefaultPathFrom } from './gateway-url';

describe('deriveGatewayEndpoints', () => {
  it('裸域名 → ws 隧道 + http 选择页', () => {
    expect(deriveGatewayEndpoints('harness-gateway.7qbjs.com')).toEqual({
      gatewayUrl: 'ws://harness-gateway.7qbjs.com/__gateway__/tunnel',
      selectUrl: 'http://harness-gateway.7qbjs.com/__gateway__/select',
    });
  });

  it('带端口裸地址 → ws/http', () => {
    expect(deriveGatewayEndpoints('192.168.1.10:9000')).toEqual({
      gatewayUrl: 'ws://192.168.1.10:9000/__gateway__/tunnel',
      selectUrl: 'http://192.168.1.10:9000/__gateway__/select',
    });
  });

  it('http:// 与 ws:// 输入 → ws/http', () => {
    for (const input of ['http://gw.example.com', 'ws://gw.example.com']) {
      expect(deriveGatewayEndpoints(input)).toEqual({
        gatewayUrl: 'ws://gw.example.com/__gateway__/tunnel',
        selectUrl: 'http://gw.example.com/__gateway__/select',
      });
    }
  });

  it('https:// 与 wss:// 输入 → wss/https', () => {
    for (const input of ['https://gw.example.com', 'wss://gw.example.com']) {
      expect(deriveGatewayEndpoints(input)).toEqual({
        gatewayUrl: 'wss://gw.example.com/__gateway__/tunnel',
        selectUrl: 'https://gw.example.com/__gateway__/select',
      });
    }
  });

  it('忽略误填的路径与查询串（只取 origin）', () => {
    expect(deriveGatewayEndpoints('https://gw.example.com/some/path?x=1')).toEqual({
      gatewayUrl: 'wss://gw.example.com/__gateway__/tunnel',
      selectUrl: 'https://gw.example.com/__gateway__/select',
    });
  });

  it('首尾空白自动裁剪', () => {
    expect(deriveGatewayEndpoints('  harness-gateway.7qbjs.com  ').gatewayUrl)
      .toBe('ws://harness-gateway.7qbjs.com/__gateway__/tunnel');
  });

  it('空输入抛错', () => {
    expect(() => deriveGatewayEndpoints('')).toThrow(/不能为空/);
    expect(() => deriveGatewayEndpoints('   ')).toThrow(/不能为空/);
  });

  it('不支持的协议抛错', () => {
    expect(() => deriveGatewayEndpoints('ftp://gw.example.com')).toThrow(/协议不支持/);
  });
});

describe('buildSelectDeepLink', () => {
  it('拼 tunnelId 深链', () => {
    expect(buildSelectDeepLink('http://gw.example.com/__gateway__/select', 'tid-1'))
      .toBe('http://gw.example.com/__gateway__/select?tunnelId=tid-1');
  });
});

describe('dshAuthDefaultPath', () => {
  it('DSH 启动令牌 URL → 带 token 的站内路径', () => {
    expect(dshAuthDefaultPath('http://127.0.0.1:3088/?token=abc-DEF_123'))
      .toBe('/?token=abc-DEF_123');
  });

  it('无 query 的 URL → 裸 /', () => {
    expect(dshAuthDefaultPath('http://127.0.0.1:3088/')).toBe('/');
  });

  it('无法解析的输入 → 回落 /', () => {
    expect(dshAuthDefaultPath('not a url')).toBe('/');
    expect(dshAuthDefaultPath('')).toBe('/');
  });

  it('双斜杠路径 → 回落 /（与服务端选择页 redirect 开放重定向防线同规则）', () => {
    expect(dshAuthDefaultPath('http://127.0.0.1:3088//evil.example.com?token=x')).toBe('/');
  });
});

describe('dshAuthDefaultPathFrom', () => {
  const upstream = 'http://127.0.0.1:3088';

  it('connection 服务正常 → 带 token 的站内路径', () => {
    const connection = { authenticatedUrl: (base: string) => `${base}/?token=tok-1` };
    expect(dshAuthDefaultPathFrom(connection, upstream)).toBe('/?token=tok-1');
  });

  it('connection 服务缺席（老 DSH 无此服务）→ undefined，调用方回落老行为', () => {
    expect(dshAuthDefaultPathFrom(undefined, upstream)).toBeUndefined();
  });

  it('connection 服务抛错 → undefined，不炸 enable 流程', () => {
    const connection = { authenticatedUrl: (): string => { throw new Error('boom'); } };
    expect(dshAuthDefaultPathFrom(connection, upstream)).toBeUndefined();
  });

  it('connection 服务返回变形 URL → 回落 /（与 dshAuthDefaultPath 防线一致）', () => {
    const connection = { authenticatedUrl: () => 'not a url' };
    expect(dshAuthDefaultPathFrom(connection, upstream)).toBe('/');
  });
});
