import { describe, expect, it } from 'vitest';

import { buildSelectDeepLink, deriveGatewayEndpoints } from './gateway-url';

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
