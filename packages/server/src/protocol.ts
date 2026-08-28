/**
 * 隧道帧协议编解码 — 服务端侧实现。
 * 注意：与客户端 packages/client/src/protocol.ts 互为镜像，任何改动必须双向同步。
 */

/** 帧内 headers 编码约定：多值头（如 Set-Cookie）必须用数组表达，禁止丢失重复头 */
export type HeadersJson = Record<string, string | string[]>;

// ---- 控制帧 ----

export interface HelloFrame {
  type: 'hello';
  client: {
    hostname: string;
    defaultPath: string;
    tunnelId?: string;
    flowControl?: boolean;
    /** 多连接协商：期望的总连接数（含本连接，≥2 才声明）；缺省 = 单连接（老行为） */
    multiConn?: { count: number };
    /** attach 握手：请求加入 tunnelId 指定的既有隧道组而非新建隧道（仅协商成功后发送） */
    attach?: boolean;
  };
}
export interface HelloAckFrame {
  type: 'hello.ack';
  tunnelId: string;
  /** 服务端支持多连接 + 本隧道允许的最大连接数；缺省 = 不支持（老服务端） */
  multiConn?: { max: number };
}

/** attach 拒绝关闭码：目标 tunnelId 不存在/组已满/会话非多连接模式（spec §3.2） */
export const ATTACH_REJECT_CODE = 4410;
/**
 * 隧道级流量确认（端到端背压 + 存活心跳载体）：服务端按收到数据帧的累计字节数定期回执，
 * 客户端据此把在途数据钳制在窗口内（内核/中间盒缓冲对应用不可见，本地 bufferedAmount 无法度量端到端在途量），
 * 且下载方向（客户端→服务端数据、服务端→客户端静默）为客户端提供规律的入站活性，心跳判死不再被拥塞蒙蔽
 */
export interface TunnelAckFrame { type: 'tunnel.ack'; bytes: number }
// 通道级控制帧统一约定：seq 为多连接条带化的通道内序号（每 (channelId, 方向) 从 0 单调递增），仅协商成功的隧道组携带；缺省保持旧帧形态
export interface HttpOpenFrame { type: 'http.open'; channelId: number; seq?: number; method: string; url: string; headers: HeadersJson }
export interface WsOpenFrame { type: 'ws.open'; channelId: number; seq?: number; url: string; headers: HeadersJson; protocols: string[] }
/** 双向：网关→客户端 = 浏览器侧关闭/取消；客户端→网关 = upstream 主动关闭/中止 */
export interface ChannelCloseFrame { type: 'channel.close'; channelId: number; seq?: number; code?: number; reason?: string }
export interface HttpHeadFrame { type: 'http.head'; channelId: number; seq?: number; status: number; headers: HeadersJson }
export interface WsAcceptFrame { type: 'ws.accept'; channelId: number; seq?: number; protocol?: string }
/** body 仅支持文本（控制帧为 JSON，无二进制体） */
export interface WsRejectFrame { type: 'ws.reject'; channelId: number; seq?: number; status: number; headers?: HeadersJson; body?: string }
export interface ChannelErrorFrame { type: 'channel.error'; channelId: number; seq?: number; message: string }
export interface PingFrame { type: 'ping' }
export interface PongFrame { type: 'pong' }

export type ControlFrame =
  | HelloFrame | HelloAckFrame | HttpOpenFrame | WsOpenFrame | ChannelCloseFrame
  | HttpHeadFrame | WsAcceptFrame | WsRejectFrame | ChannelErrorFrame | PingFrame | PongFrame
  | TunnelAckFrame;

/** 协议错误（坏帧、未知 type）：调用方按坏帧预算降级——单帧 WARN + 丢弃，连续超预算才断开（spec §8 帧级） */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const CONTROL_TYPES = new Set([
  'hello', 'hello.ack', 'http.open', 'ws.open', 'channel.close',
  'http.head', 'ws.accept', 'ws.reject', 'channel.error', 'ping', 'pong',
  'tunnel.ack',
]);

/** 编码控制帧为 JSON 文本帧 */
export function encodeControl(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

/** 解码控制帧；非对象、未知 type 抛 ProtocolError；不做严格字段校验，可选字段（multiConn/attach/seq 等）随 JSON 自然透传 */
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
  /** 多连接条带化的通道内序号（每 (channelId, 方向) 从 0 单调递增）；仅协商成功的隧道组携带 */
  seq?: number;
}

const DATA_KINDS = new Set<string>(['http.body', 'http.body.end', 'ws.message']);

/**
 * 隧道帧总长上限（线上丢帧根因修复）：与四处 ws 端点 maxPayload 对齐的显式契约
 * （原为 ws 隐式默认 100MiB）。WS 消息过了接收端 maxPayload，但隧道帧加头后
 * 可能超过对端 maxPayload（"边界带"），对端收帧即按 1009 杀整条隧道、全通道丢帧；
 * 发送侧必须先以 exceedsMaxDataFrame 判定，超限按通道级失败处理，不得入隧道。
 */
export const MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

/** 数据帧超尺寸错误：encodeData 兜底防线（正常路径应先经 exceedsMaxDataFrame 显式判定） */
export class PayloadTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`数据帧超尺寸上限: ${size} > ${MAX_PAYLOAD_BYTES}`);
    this.name = 'PayloadTooLargeError';
  }
}

/** 判定编码后隧道帧总长是否超限（4 字节头长 + JSON 头 UTF-8 长 + 负载长） */
export function exceedsMaxDataFrame(header: DataHeader, payload: Buffer): boolean {
  return 4 + Buffer.byteLength(JSON.stringify(header), 'utf8') + payload.length > MAX_PAYLOAD_BYTES;
}

/** 编码数据帧：[u32be 头长][JSON 头][payload]；帧总长超 MAX_PAYLOAD_BYTES 抛 PayloadTooLargeError */
export function encodeData(header: DataHeader, payload: Buffer): Buffer {
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const total = 4 + head.length + payload.length;
  if (total > MAX_PAYLOAD_BYTES) throw new PayloadTooLargeError(total);
  const out = Buffer.allocUnsafe(total);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  payload.copy(out, 4 + head.length);
  return out;
}

/** 解码数据帧；长度越界/头非法抛 ProtocolError；可选字段（seq 等）不做严格校验，随 JSON 自然透传 */
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
