/**
 * 帧协议编解码测试 — 控制帧 JSON round-trip、数据帧二进制布局、headers 工具。
 * 注意：用例与本文件实现（protocol.ts）同包演进；改协议需同步服务端镜像实现。
 */
import { describe, expect, it } from 'vitest';

import {
  type ControlFrame, decodeControl, decodeData, encodeControl,
  encodeData, normalizeHeaders, ProtocolError, stripHopByHop,
} from './protocol';

describe('控制帧编解码', () => {
  it('全部控制帧类型 round-trip', () => {
    const frames: ControlFrame[] = [
      { type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } },
      { type: 'hello.ack' },
      { type: 'http.open', channelId: 1, method: 'GET', url: '/api/x', headers: { accept: 'application/json' } },
      { type: 'ws.open', channelId: 2, url: '/ws', headers: {}, protocols: ['chat'] },
      { type: 'channel.close', channelId: 1, code: 1000, reason: 'bye' },
      { type: 'http.head', channelId: 1, status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] } },
      { type: 'ws.accept', channelId: 2, protocol: 'chat' },
      { type: 'ws.reject', channelId: 2, status: 403, body: 'forbidden' },
      { type: 'channel.error', channelId: 1, message: 'boom' },
      { type: 'ping' },
      { type: 'pong' },
    ];
    for (const frame of frames) {
      expect(decodeControl(encodeControl(frame))).toEqual(frame);
    }
  });

  it('未知 type 抛 ProtocolError', () => {
    expect(() => decodeControl('{"type":"nope"}')).toThrow(ProtocolError);
  });

  it('非 JSON 抛 ProtocolError', () => {
    expect(() => decodeControl('not-json{')).toThrow(ProtocolError);
  });

  it('JSON 解析失败的错误消息不回显帧原文（token 红线）', () => {
    // http.open 帧可携带 authorization 头，错误消息若回显原文会泄 token 进 ERROR 日志
    const text = '{"type":"http.open","headers":{"authorization":"Bearer secret-token-xyz"}},broken';
    try {
      decodeControl(text);
      expect.unreachable('应当抛 ProtocolError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProtocolError);
      expect((err as Error).message).not.toContain('secret-token-xyz');
    }
  });

  it('多值 headers（Set-Cookie 数组）round-trip 不丢失', () => {
    const frame: ControlFrame = { type: 'http.head', channelId: 1, status: 200, headers: { 'set-cookie': ['a=1', 'b=2'] } };
    const decoded = decodeControl(encodeControl(frame));
    expect(decoded).toEqual(frame);
  });
});

describe('数据帧编解码', () => {
  it('http.body round-trip（含任意二进制字节）', () => {
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);
    const { header, payload: out } = decodeData(encodeData({ channelId: 7, kind: 'http.body' }, payload));
    expect(header).toEqual({ channelId: 7, kind: 'http.body' });
    expect(out.equals(payload)).toBe(true);
  });

  it('空负载 http.body.end round-trip（空体收尾规则）', () => {
    const { header, payload } = decodeData(encodeData({ channelId: 3, kind: 'http.body.end' }, Buffer.alloc(0)));
    expect(header.kind).toBe('http.body.end');
    expect(payload.length).toBe(0);
  });

  it('ws.message 携带 dataType', () => {
    const { header } = decodeData(encodeData({ channelId: 2, kind: 'ws.message', dataType: 'binary' }, Buffer.from('x')));
    expect(header.dataType).toBe('binary');
  });

  it('头长越界抛 ProtocolError', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(999, 0);
    expect(() => decodeData(buf)).toThrow(ProtocolError);
  });

  it('帧头 JSON 为 null 抛 ProtocolError（而非 TypeError）', () => {
    // 对端可构造头长合法但 JSON 为 null 的帧：[u32be=4]["null"]
    const head = Buffer.from('null', 'utf8');
    const buf = Buffer.alloc(4 + head.length);
    buf.writeUInt32BE(head.length, 0);
    head.copy(buf, 4);
    expect(() => decodeData(buf)).toThrow(ProtocolError);
  });
});

describe('headers 工具', () => {
  it('normalizeHeaders 小写化并丢弃 undefined', () => {
    expect(normalizeHeaders({ Host: 'a.com', 'X-Skip': undefined })).toEqual({ host: 'a.com' });
  });

  it('stripHopByHop 剥离逐跳头、保留 set-cookie 数组', () => {
    const out = stripHopByHop({ 'transfer-encoding': 'chunked', connection: 'keep-alive', 'set-cookie': ['a=1'] });
    expect(out).toEqual({ 'set-cookie': ['a=1'] });
  });
});
