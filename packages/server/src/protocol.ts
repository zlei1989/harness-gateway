/**
 * 隧道帧协议编解码 — 服务端侧实现。
 * 注意：与客户端 packages/client/src/protocol.ts 互为镜像，任何改动必须双向同步。
 */

/** 帧内 headers 编码约定：多值头（如 Set-Cookie）必须用数组表达，禁止丢失重复头 */
export type HeadersJson = Record<string, string | string[]>;

// ---- 控制帧 ----

export interface HelloFrame { type: 'hello'; client: { hostname: string; defaultPath: string } }
export interface HelloAckFrame { type: 'hello.ack' }
export interface HttpOpenFrame { type: 'http.open'; channelId: number; method: string; url: string; headers: HeadersJson }
export interface WsOpenFrame { type: 'ws.open'; channelId: number; url: string; headers: HeadersJson; protocols: string[] }
/** 双向：网关→客户端 = 浏览器侧关闭/取消；客户端→网关 = upstream 主动关闭/中止 */
export interface ChannelCloseFrame { type: 'channel.close'; channelId: number; code?: number; reason?: string }
export interface HttpHeadFrame { type: 'http.head'; channelId: number; status: number; headers: HeadersJson }
export interface WsAcceptFrame { type: 'ws.accept'; channelId: number; protocol?: string }
/** body 仅支持文本（控制帧为 JSON，无二进制体） */
export interface WsRejectFrame { type: 'ws.reject'; channelId: number; status: number; headers?: HeadersJson; body?: string }
export interface ChannelErrorFrame { type: 'channel.error'; channelId: number; message: string }
export interface PingFrame { type: 'ping' }
export interface PongFrame { type: 'pong' }

export type ControlFrame =
  | HelloFrame | HelloAckFrame | HttpOpenFrame | WsOpenFrame | ChannelCloseFrame
  | HttpHeadFrame | WsAcceptFrame | WsRejectFrame | ChannelErrorFrame | PingFrame | PongFrame;

/** 协议错误（坏帧、未知 type）：连接级错误，调用方断开重连 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const CONTROL_TYPES = new Set([
  'hello', 'hello.ack', 'http.open', 'ws.open', 'channel.close',
  'http.head', 'ws.accept', 'ws.reject', 'channel.error', 'ping', 'pong',
]);

/** 编码控制帧为 JSON 文本帧 */
export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** 解码控制帧；非对象、未知 type 抛 ProtocolError */
export function decodeControl(text: string): ControlFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 安全红线：不得回显帧原文（http.open 帧可携带 authorization 头，ERROR 日志含堆栈会泄 token）；
    // 只保留非内容诊断信息
    throw new ProtocolError(`控制帧 JSON 解析失败（帧长 ${text.length} 字节）`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new ProtocolError('控制帧非 JSON 对象');
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !CONTROL_TYPES.has(type)) {
    throw new ProtocolError(`未知控制帧 type: ${String(type)}`);
  }
  return parsed as ControlFrame;
}

// ---- 数据帧 ----

export type DataKind = 'http.body' | 'http.body.end' | 'ws.message';

export interface DataHeader {
  channelId: number;
  kind: DataKind;
  /** 仅 kind === 'ws.message' 使用，保持 WS 消息类型保真 */
  dataType?: 'text' | 'binary';
}

const DATA_KINDS = new Set<string>(['http.body', 'http.body.end', 'ws.message']);

/** 编码数据帧：[u32be 头长][JSON 头][payload] */
export function encodeData(header: DataHeader, payload: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(4 + head.length + payload.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  payload.copy(out, 4 + head.length);
  return out;
}

/** 解码数据帧；长度越界/头非法抛 ProtocolError */
export function decodeData(buf: Buffer): { header: DataHeader; payload: Buffer } {
  if (buf.length < 4) throw new ProtocolError('数据帧过短');
  const headLen = buf.readUInt32BE(0);
  if (4 + headLen > buf.length) throw new ProtocolError(`数据帧头长越界: ${headLen}`);
  let header: DataHeader;
  try {
    header = JSON.parse(buf.subarray(4, 4 + headLen).toString('utf8')) as DataHeader;
  } catch {
    throw new ProtocolError('数据帧头 JSON 解析失败');
  }
  // JSON 合法但为 null/标量（如 "null"）时，取字段会抛 TypeError，须先按 ProtocolError 契约拦截
  if (typeof header !== 'object' || header === null) {
    throw new ProtocolError('数据帧头非 JSON 对象');
  }
  if (typeof header.channelId !== 'number' || !DATA_KINDS.has(header.kind)) {
    throw new ProtocolError('数据帧头字段非法');
  }
  return { header, payload: buf.subarray(4 + headLen) };
}

// ---- headers 工具 ----

/** 规范化 headers：key 统一小写、丢弃 undefined（兼容 Node req.headers） */
export function normalizeHeaders(
  input: Record<string, string | string[] | undefined>,
): HeadersJson {
  const out: HeadersJson = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** RFC 2616 逐跳头，转发前后各剥离一次 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** 剥离逐跳头 */
export function stripHopByHop(headers: HeadersJson): HeadersJson {
  const out: HeadersJson = {};
  for (const [key, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(key)) continue;
    out[key] = value;
  }
  return out;
}
