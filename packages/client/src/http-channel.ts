/**
 * HTTP 通道 — 隧道帧 ↔ upstream http/https 请求流的桥接。
 * 生命周期（spec §5.1）：鉴权 →（auth-check 短路）→ 转发 upstream → 流式回传。
 * 注意：Host 头删除后由 Node 按 upstream URL 重写；hop-by-hop 头双向剥离；
 * upstream 建立前到达的 body 帧暂存队列，建立后按序 flush。
 */

import http from 'node:http';
import https from 'node:https';

import { type AuthDecision, type AuthRequest, buildAuthRequest } from './authorize';
import { type ChannelCloseFrame, type HttpOpenFrame, normalizeHeaders, stripHopByHop } from './protocol';

import type { Connection } from './connection';
import type { Logger } from './logger';

export interface HttpChannelParams {
  id: number;
  open: HttpOpenFrame;
  upstream: URL;
  connection: Connection;
  authorize: (req: AuthRequest) => Promise<AuthDecision>;
  logger: Logger;
  /** 通道结束（完成/被拒/出错/取消）时回调，Client 用它从通道表移除 */
  onDone: (id: number) => void;
}

export class HttpChannel {
  private req: http.ClientRequest | null = null;
  /** upstream 请求建立前到达的 body 暂存；建立后置 null 直写 */
  private pending: Buffer[] | null = [];
  private pendingEnd = false;
  private headSent = false;
  private finished = false;

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

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(target, { method: open.method, headers },
      (res) => this.onUpstreamResponse(res));
    req.on('error', (err) => this.onUpstreamError(err));
    this.req = req;

    // flush 暂存的 body 帧
    const pending = this.pending;
    this.pending = null;
    for (const chunk of pending ?? []) req.write(chunk);
    if (this.pendingEnd) req.end();
  }

  /** 网关侧请求体帧：upstream 未就绪先排队 */
  onBody(payload: Buffer): void {
    if (this.finished) return;
    if (this.pending) this.pending.push(payload);
    else this.req?.write(payload);
  }

  /** 网关侧请求体收尾（空体规则：必有此帧） */
  onBodyEnd(): void {
    if (this.finished) return;
    if (this.pending) this.pendingEnd = true;
    else this.req?.end();
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
    if (!this.trySend(() => connection.sendControl({ type: 'http.head', channelId: this.params.id, status: res.statusCode ?? 502, headers }))) return;
    this.headSent = true;
    res.on('data', (chunk: Buffer) => {
      if (this.finished) return;
      // 无需 exceedsMaxDataFrame 护栏：chunk 来自 Node 流读取（≪100MiB），数学上不可能超隧道帧上限；
      // encodeData 的 PayloadTooLargeError 兜底由 trySend 消化为通道级中止（护栏在 ws-channel 的 WS 消息路径）
      let ok = true;
      if (!this.trySend(() => { ok = connection.sendData({ channelId: this.params.id, kind: 'http.body' }, chunk); })) return;
      if (!ok) {
        res.pause();
        void connection.waitDrain().then(() => { if (!this.finished) res.resume(); });
      }
    });
    res.on('end', () => {
      if (this.finished) return;
      this.trySend(() => connection.sendData({ channelId: this.params.id, kind: 'http.body.end' }, Buffer.alloc(0)));
      this.done();
    });
    res.on('error', (err) => this.fail(`upstream 响应流错误: ${err.message}`));
  }

  /** upstream 请求错误：未回响应头 → 502；已回 → 通道级错误帧 */
  private onUpstreamError(err: Error): void {
    if (this.finished) return;
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
  }

  private done(): void {
    if (this.finished) return;
    this.finished = true;
    this.params.onDone(this.params.id);
  }
}
