/**
 * HTTP 通道 — 隧道帧 ↔ upstream http/https 请求流的桥接。
 * 生命周期（spec §5.1）：鉴权 →（auth-check 短路）→ 转发 upstream → 流式回传。
 * 注意：Host 头删除后由 Node 按 upstream URL 重写；hop-by-hop 头双向剥离；
 * upstream 建立前到达的 body 帧暂存队列，建立后按序 flush。
 */

import http from 'node:http';
import https from 'node:https';
import { type Readable } from 'node:stream';
import zlib from 'node:zlib';

import { type AuthDecision, type AuthRequest, buildAuthRequest } from './authorize';
import { type ChannelCloseFrame, type HeadersJson, type HttpOpenFrame, normalizeHeaders, stripHopByHop } from './protocol';

import type { TunnelSender } from './connection';
import type { Logger } from './logger';

/**
 * 压缩下限：upstream 声明 content-length 且小于该值时不压缩
 * （小 body 压缩无收益还白付 CPU；chunked 流式响应无 content-length，按 content-type 判断压缩）
 */
const MIN_COMPRESS_BYTES = 1024;
/** Brotli 质量 4：与 gzip-6 相当的速度、更好的文本压缩率（15MB 级日志场景的质量/速度甜点） */
const BROTLI_QUALITY = 4;

/** 可压缩的 content-type：文本类、JSON/XML 族、SVG；SSE 显式排除（压缩会延迟事件推送） */
const COMPRESSIBLE_TYPE = new RegExp(
  '^(?:text\\/(?!event-stream)|application\\/(?:json|javascript|x-javascript|xml|x-ndjson|wasm)'
  + '|image\\/svg\\+xml|[^;]+\\+(?:json|xml)\\b)',
  'i',
);

/** 从浏览器 Accept-Encoding 协商压缩算法：br 优先（压缩率更高），其次 gzip；都不支持则不压缩 */
function negotiateEncoding(acceptEncoding: string | string[] | undefined): 'br' | 'gzip' | null {
  if (acceptEncoding === undefined) return null;
  const value = Array.isArray(acceptEncoding) ? acceptEncoding.join(', ') : acceptEncoding;
  if (/(?:^|[\s,])br(?:[\s,;]|$)/i.test(value)) return 'br';
  if (/(?:^|[\s,])gzip(?:[\s,;]|$)/i.test(value)) return 'gzip';
  return null;
}

/** 判定 content-type 是否可压缩（缺省/二进制类型不压缩，避免对图片、压缩包白费 CPU） */
function isCompressibleType(contentType: string | string[] | undefined): boolean {
  if (contentType === undefined) return false;
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  return COMPRESSIBLE_TYPE.test(value ?? '');
}

/** 在 Vary 中追加 accept-encoding（已有则不动；保证共享缓存按编码协商键隔离） */
function mergeVary(vary: string | string[] | undefined): string {
  const existing = vary === undefined ? [] : (Array.isArray(vary) ? vary : vary.split(',')).map((v) => v.trim()).filter(Boolean);
  if (!existing.some((v) => v.toLowerCase() === 'accept-encoding')) existing.push('accept-encoding');
  return existing.join(', ');
}

export interface HttpChannelParams {
  id: number;
  open: HttpOpenFrame;
  upstream: URL;
  /** 隧道发送面（多连接 TunnelGroup 条带化的 leg 抽象；只用 sendControl/sendData/waitDrain） */
  connection: TunnelSender;
  authorize: (req: AuthRequest) => Promise<AuthDecision>;
  logger: Logger;
  /**
   * upstream keep-alive 连接池（由 Client 持有并随其销毁；协议与 upstream 一致）。
   * 缺省时走 Node 全局 Agent。注意运行时实例与 upstream 协议一一对应。
   */
  agent?: http.Agent;
  /**
   * 压缩传输：为 upstream 未压缩的可压缩响应代做端到端压缩（br/gzip，按浏览器
   * Accept-Encoding 协商），一次压缩覆盖 client→server→browser 两段链路。
   * 已编码/SSE/Range/小响应/二进制类型不压（见 negotiateCompression）。默认关闭。
   */
  compress?: boolean;
  /** 通道结束（完成/被拒/出错/取消）时回调，Client 用它从通道表移除 */
  onDone: (id: number) => void;
}

export class HttpChannel {
  private req: http.ClientRequest | null = null;
  /** upstream 请求建立前到达的 body 暂存；建立后置 null 直写 */
  private pending: Buffer[] | null = [];
  /** 网关侧 body 已收尾（空体规则：必有此帧）；重试发新请求时据此补 end */
  private bodyEnded = false;
  private headSent = false;
  private finished = false;
  /** 陈旧 keep-alive 连接重试 latch：每通道至多重试一次（防循环） */
  private retried = false;
  /** 已写入 upstream 的 body 字节数：>0 说明请求体已被旧连接消费，重试会产生重复体，禁止重试 */
  private bodyBytesWritten = 0;
  /** 发起 upstream 请求的目标与加工后的 headers（陈旧连接重试时复用，start 阶段准备一次） */
  private preparedTarget: URL | null = null;
  private preparedHeaders: HeadersJson | null = null;
  /** 压缩变换流（压缩路径下位于 res 与隧道发送之间）：通道中止时随 upstream 一并销毁 */
  private compressor: zlib.BrotliCompress | zlib.Gzip | null = null;

  constructor(private readonly params: HttpChannelParams) {}

  /** 入口：鉴权 → 短路/拒绝/转发。只调用一次 */
  async start(): Promise<void> {
    const { open, authorize, connection, upstream } = this.params;
    const decision = await authorize(buildAuthRequest(open, false));
    if (this.finished) return;

    if (!decision.allowed) {
      // 鉴权拒绝：响应原样回网关，不打 upstream
      this.trySend(() => {
        connection.sendControl({ type: 'http.head', channelId: this.params.id, status: decision.status, headers: decision.headers });
        connection.sendData({ channelId: this.params.id, kind: 'http.body' }, decision.body);
        connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      });
      this.done();
      return;
    }

    const target = new URL(open.url, upstream);
    // SSRF 防护：absolute-form 请求行（如 http://169.254.169.254/）会脱离 upstream origin，
    // 借隧道探测内网/云元数据端点；origin 不符即拒绝该通道（403），不打 upstream。
    // 日志只记 channelId：URL 查询串可能携带敏感参数，不进日志。
    if (target.origin !== upstream.origin) {
      this.params.logger.warn('拒绝跨 origin 的绝对 URL 请求', { channelId: this.params.id });
      this.trySend(() => {
        connection.sendControl({
          type: 'http.head', channelId: this.params.id, status: 403,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
        connection.sendData({ channelId: this.params.id, kind: 'http.body' }, Buffer.from('Forbidden'));
        connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      });
      this.done();
      return;
    }
    if (target.pathname === '/__gateway__/auth-check') {
      // 服务端选择页探测短路：放行即 204，不打 upstream（spec §3.1）
      this.trySend(() => {
        connection.sendControl({ type: 'http.head', channelId: this.params.id, status: 204, headers: {} });
        connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      });
      this.done();
      return;
    }

    const headers = stripHopByHop(normalizeHeaders(open.headers));
    delete headers['host']; // Host 由 Node 按 upstream URL 生成（Host 重写语义，已确认）
    // Origin 与 Host 同语义重定（线上事故修复：DSH /api 403）：浏览器 Origin 描述的是
    // 浏览器↔网关的关系，Host 已重写为 upstream，原样透传 Origin 会被上游同源/反 DNS 重绑定
    // 围栏（Origin.host !== Host.host 即拒绝）挡下；缺失不伪造（无 Origin 的读请求围栏本就放行）。
    if (headers['origin'] !== undefined) headers['origin'] = upstream.origin;
    this.preparedTarget = target;
    this.preparedHeaders = headers;

    this.openUpstream(target, headers);
  }

  /**
   * 发起 upstream 请求并接线（含陈旧 keep-alive 连接的一次性重试）：
   * 经限流链路时请求间隔常被拉长到秒级，upstream 侧空闲 keep-alive socket 已被对端关闭，
   * Agent 复用即 ECONNRESET（"socket hang up"）；对幂等方法重试一次换新连接，
   * 否则插件/静态资源加载会间歇 502（生产页面加载失败根因）。
   */
  private openUpstream(target: URL, headers: HeadersJson): void {
    const { open } = this.params;
    const mod = target.protocol === 'https:' ? https : http;
    // Agent 实例协议与 target 一致（Client 按 upstream 协议创建，SSRF 护栏保证 target 与 upstream 同 origin）；
    // 统一注解为 https.Agent：它是 http.Agent 子类，可同时满足 http/https 两分支的 request 参数类型
    const agent = this.params.agent as https.Agent | undefined;
    const req = mod.request(target, { method: open.method, headers, agent },
      (res) => this.onUpstreamResponse(res));
    req.on('error', (err) => this.onUpstreamError(err));
    this.req = req;

    // flush 暂存的 body 帧
    const pending = this.pending;
    this.pending = null;
    for (const chunk of pending ?? []) {
      this.bodyBytesWritten += chunk.length;
      req.write(chunk);
    }
    if (this.bodyEnded) req.end();
  }

  /** 网关侧请求体帧：upstream 未就绪先排队 */
  onBody(payload: Buffer): void {
    if (this.finished) return;
    if (this.pending) this.pending.push(payload);
    else {
      this.bodyBytesWritten += payload.length;
      this.req?.write(payload);
    }
  }

  /** 网关侧请求体收尾（空体规则：必有此帧） */
  onBodyEnd(): void {
    if (this.finished) return;
    this.bodyEnded = true; // 陈旧连接重试发新请求时据此补 end
    if (!this.pending) this.req?.end();
  }

  /** 网关侧取消（浏览器断开等） */
  onPeerClose(_frame: ChannelCloseFrame): void {
    this.destroyUpstream();
    this.done();
  }

  /** 隧道断开 / Client close：本地中止 */
  abort(): void {
    this.destroyUpstream();
    this.done();
  }

  /** upstream 响应：回传 http.head 后分块流式回传 body，聚合背压下 pause/resume */
  private onUpstreamResponse(res: http.IncomingMessage): void {
    if (this.finished) return;
    const { connection } = this.params;
    const headers = stripHopByHop(normalizeHeaders(res.headers));

    // 压缩协商（compress 开启时）：代 upstream 做端到端压缩，一次压缩覆盖 client→server→browser。
    // 服务端对 body 与端到端头完全透明（只注入 Authorization/剥会话 cookie/剥逐跳头），
    // 改写 content-encoding + 删 content-length（压缩后长度变化，服务端自动退化 chunked）即可。
    const encoding = this.negotiateCompression(res, headers);
    let source: Readable = res;
    if (encoding !== null) {
      headers['content-encoding'] = encoding;
      delete headers['content-length'];
      headers['vary'] = mergeVary(headers['vary']);
      this.compressor = encoding === 'br'
        ? zlib.createBrotliCompress({
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
        })
        : zlib.createGzip();
      // 压缩流错误（内存不足等极端情况）：通道级失败，与 upstream 流错误同级
      this.compressor.on('error', (err) => this.fail(`压缩流错误: ${err.message}`));
      // pipe 串联背压：压缩流写入侧满时自动 pause upstream，无需手工衔接
      source = res.pipe(this.compressor);
    }

    if (!this.trySend(() => connection.sendControl({ type: 'http.head', channelId: this.params.id, status: res.statusCode ?? 502, headers }))) return;
    this.headSent = true;
    source.on('data', (chunk: Buffer) => {
      if (this.finished) return;
      // 无需 exceedsMaxDataFrame 护栏：chunk 来自 Node 流读取（≪100MiB），数学上不可能超隧道帧上限；
      // encodeData 的 PayloadTooLargeError 兜底由 trySend 消化为通道级中止（护栏在 ws-channel 的 WS 消息路径）
      let ok = true;
      if (!this.trySend(() => { ok = connection.sendData({ channelId: this.params.id, kind: 'http.body' }, chunk); })) return;
      if (!ok) {
        // 压缩路径下 pause 的是压缩流（可读侧），其内部缓冲写满后经 pipe 反压 upstream，语义等价
        source.pause();
        void connection.waitDrain().then(() => { if (!this.finished) source.resume(); });
      }
    });
    source.on('end', () => {
      if (this.finished) return;
      this.trySend(() => connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0)));
      this.done();
    });
    res.on('error', (err) => this.fail(`upstream 响应流错误: ${err.message}`));
  }

  /**
   * 压缩协商：满足全部条件才返回压缩算法，任一不满足即原样透传——
   * ① 通道开启 compress；② 浏览器 Accept-Encoding 支持 br/gzip；③ upstream 未自行编码；
   * ④ 有 body（排除 HEAD/204/304）；⑤ 非 Range 请求（压缩会破坏字节区间语义）；
   * ⑥ content-type 可压缩；⑦ content-length 缺省（流式大 body）或 ≥ 1KB。
   */
  private negotiateCompression(res: http.IncomingMessage, headers: HeadersJson): 'br' | 'gzip' | null {
    if (this.params.compress !== true) return null;
    if (headers['content-encoding'] !== undefined) return null;
    const status = res.statusCode ?? 0;
    if (status === 204 || status === 304 || this.params.open.method.toUpperCase() === 'HEAD') return null;
    if (this.params.open.headers['range'] !== undefined) return null;
    if (!isCompressibleType(headers['content-type'])) return null;
    const contentLength = headers['content-length'];
    if (contentLength !== undefined) {
      const raw = Array.isArray(contentLength) ? contentLength[0]! : contentLength;
      const size = Number.parseInt(raw, 10);
      if (Number.isFinite(size) && size < MIN_COMPRESS_BYTES) return null;
    }
    return negotiateEncoding(this.params.open.headers['accept-encoding']);
  }

  /** upstream 请求错误：陈旧 keep-alive 连接按一次性重试换新；未回响应头 → 502；已回 → 通道级错误帧 */
  private onUpstreamError(err: Error & { code?: string }): void {
    if (this.finished) return;
    // 陈旧连接判定：响应头未收到且请求体未消费（重试无重复体风险）且方法幂等
    const staleSocket = err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message.includes('socket hang up');
    const idempotent = ['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(this.params.open.method.toUpperCase());
    if (staleSocket && idempotent && !this.headSent && this.bodyBytesWritten === 0 && !this.retried
      && this.preparedTarget !== null && this.preparedHeaders !== null) {
      this.retried = true;
      this.params.logger.warn('upstream 陈旧连接（keep-alive 复用竞态），换新连接重试一次', { channelId: this.params.id, error: err.message });
      this.openUpstream(this.preparedTarget, this.preparedHeaders);
      return;
    }
    if (!this.headSent) {
      // err.message 含内网地址/端口等细节：只进日志（WARN，不含 token），不回显给浏览器侧
      this.params.logger.warn('upstream 不可达', { channelId: this.params.id, error: err.message });
      this.trySend(() => {
        this.params.connection.sendControl({
          type: 'http.head', channelId: this.params.id, status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
        this.params.connection.sendData({ channelId: this.params.id, kind: 'http.body' }, Buffer.from('Bad Gateway'));
        this.params.connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0));
      });
    } else {
      this.fail(`upstream 请求错误: ${err.message}`);
    }
    this.done();
  }

  /** 通道级异常：channel.error 帧 + 收尾 */
  private fail(message: string): void {
    if (this.finished) return;
    this.params.logger.error('HTTP 通道异常', { channelId: this.params.id, error: message });
    this.trySend(() => this.params.connection.sendControl({ type: 'channel.error', channelId: this.params.id, message }));
    this.destroyUpstream();
    this.done();
  }

  /**
   * 隧道发送兜底（线上崩溃修复）：隧道 ws 的 'error'→'close' 之间存在竞态窗（如收到非法 close
   * 帧后 ws 已非 OPEN，但 onDisconnected/abortAllChannels 要等 'close' 才触发）；窗内
   * Connection.sendControl/sendData 抛 'tunnel not ready'，而通道的上游事件回调
   * （response/data/end/error）由 Node 事件循环独立调度，无法与该窗口同步，异常外溢即
   * uncaughtException 崩进程。发送失败 = 隧道已断、通道不可交付：消化异常 + 中止 upstream +
   * 结束通道（均幂等；隧道 'close' 后的 abortAllChannels 对已完成通道无感）。
   */
  private trySend(send: () => void): boolean {
    try {
      send();
      return true;
    } catch (err) {
      this.params.logger.warn('隧道断开竞态：发送失败，中止本通道', {
        channelId: this.params.id,
        error: err instanceof Error ? err.message : String(err),
      });
      this.destroyUpstream();
      this.done();
      return false;
    }
  }

  private destroyUpstream(): void {
    this.req?.destroy();
    // 压缩流随 upstream 一并销毁：pipe 不会自动关目的端，残留变换流会滞留内部缓冲
    this.compressor?.destroy();
    this.compressor = null;
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.params.onDone(this.params.id);
  }
}
