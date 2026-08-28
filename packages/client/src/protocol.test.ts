/**
 * 帧协议编解码测试 — 控制帧 JSON round-trip、数据帧二进制布局、headers 工具。
 * 注意：用例与本文件实现（protocol.ts）同包演进；改协议需同步服务端镜像实现。
 */
import { describe, expect, it } from 'vitest';

import {
  type ControlFrame, type DataHeader, decodeControl, decodeData, encodeControl,
  encodeData, exceedsMaxDataFrame, MAX_PAYLOAD_BYTES, normalizeHeaders,
  PayloadTooLargeError, ProtocolError, stripHopByHop,
} from './protocol';

describe('控制帧编解码', () => {
  it('全部控制帧类型 round-trip', () => {
    const frames: ControlFrame[] = [
      { type: 'hello', client: { hostname: 'pc-a', defaultPath: '/' } },
      { type: 'hello', client: { hostname: 'pc-a', defaultPath: '/', tunnelId: '3f6f9c40-1c6b-4a12-9a1e-3f0a1c2d4e5f' } },
      { type: 'hello.ack', tunnelId: '3f6f9c40-1c6b-4a12-9a1e-3f0a1c2d4e5f' },
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

describe('数据帧尺寸上限（线上丢帧根因修复）', () => {
  // 边界带：WS 消息过了端点 maxPayload（100MiB），但隧道帧加头后超 100MiB 会杀整条隧道
  const header: DataHeader = { channelId: 1, kind: 'ws.message', dataType: 'binary' };
  const headLen = Buffer.byteLength(JSON.stringify(header), 'utf8');
  /** 复用同一块内存构造不同总长负载，避免多次百 MB 分配 */
  const arena = Buffer.alloc(MAX_PAYLOAD_BYTES + 8);
  const payloadForTotal = (total: number): Buffer => arena.subarray(0, total - 4 - headLen);

  it('帧总长恰在上限：exceedsMaxDataFrame = false，encodeData 正常编码', () => {
    const payload = payloadForTotal(MAX_PAYLOAD_BYTES);
    expect(exceedsMaxDataFrame(header, payload)).toBe(false);
    const { payload: out } = decodeData(encodeData(header, payload));
    expect(out.length).toBe(payload.length);
  });

  it('帧总长超上限 1 字节：exceedsMaxDataFrame = true，encodeData 抛 PayloadTooLargeError', () => {
    const payload = payloadForTotal(MAX_PAYLOAD_BYTES + 1);
    expect(exceedsMaxDataFrame(header, payload)).toBe(true);
    expect(() => encodeData(header, payload)).toThrow(PayloadTooLargeError);
  });

  it('普通小帧不受限', () => {
    expect(exceedsMaxDataFrame(header, Buffer.from('x'))).toBe(false);
    expect(exceedsMaxDataFrame({ channelId: 2, kind: 'http.body.end' }, Buffer.alloc(0))).toBe(false);
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

describe('多连接协议扩展', () => {
  it('hello 携带 multiConn/attach 字段编解码往返', () => {
    const frame = {
      type: 'hello' as const,
      client: { hostname: 'pc-a', defaultPath: '/', multiConn: { count: 4 }, attach: true, tunnelId: 'tid-1' },
    };
    const decoded = decodeControl(encodeControl(frame));
    expect(decoded).toEqual(frame);
  });

  it('hello.ack 携带 multiConn.max 编解码往返', () => {
    const frame = { type: 'hello.ack' as const, tunnelId: 'tid-1', multiConn: { max: 16 } };
    expect(decodeControl(encodeControl(frame))).toEqual(frame);
  });

  it('通道级控制帧与数据帧头携带 seq 往返', () => {
    const head = { type: 'http.head' as const, channelId: 7, seq: 3, status: 200, headers: {} };
    expect(decodeControl(encodeControl(head))).toEqual(head);
    const { header, payload } = decodeData(encodeData({ channelId: 7, kind: 'http.body', seq: 4 }, Buffer.from('x')));
    expect(header).toEqual({ channelId: 7, kind: 'http.body', seq: 4 });
    expect(payload.toString()).toBe('x');
  });

  it('无 seq 的旧帧形态保持不变（legacy 兼容）', () => {
    const decoded = decodeControl(encodeControl({ type: 'http.head', channelId: 1, status: 200, headers: {} }));
    expect('seq' in decoded).toBe(false);
  });
});
