/**
 * chaos-proxy — TCP 层故障注入代理（测试专用，零依赖）。
 * 保真度设计：转发经「队列 + 10ms 泵」模型——blackhole = 暂停源 socket（内核窗口填满，与真实
 * 丢包/半开逐字节一致）；throttle 超水位暂停源 socket（真实 TCP 背压）；destroy = 双端 RST。
 * 代理不懂 WS/HTTP 语义（真实中间盒也不懂），这是保真度来源。
 */

import { STATUS_CODES } from 'node:http';
import net from 'node:net';

export type ChaosDirection = 'c2s' | 's2c' | 'both';
export type ChaosThrottleMode = 'per-conn' | 'shared';
export interface ChaosProxyOptions { targetHost: string; targetPort: number }
export interface ChaosProxyStats { connections: number; destroyed: number; bytesRelayed: number }
export interface ChaosProxy {
  listen(): Promise<number>;
  close(): Promise<void>;
  destroyAll(): void;
  blackhole(direction?: ChaosDirection): void;
  heal(): void;
  setLatency(ms: number, jitterMs?: number): void;
  setThrottle(bytesPerSec: number, mode?: ChaosThrottleMode): void;
  setIdleTimeout(ms: number): void;
  flappy(intervalMs: number): void;
  stopFlappy(): void;
  rejectUpgradeWith(status: number): void;
  clearRejectUpgrade(): void;
  stats(): ChaosProxyStats;
}

interface QueueItem { chunk: Buffer; due: number }
interface Pipe {
  source: net.Socket;
  dest: net.Socket;
  queue: QueueItem[];
  queuedBytes: number;
  blackholed: boolean;
  sourcePaused: boolean;
  /** 源已 close：泵排空队列后须向 dest 传播干净 FIN（不得直接 destroy 丢数据） */
  sourceClosed: boolean;
  /** FIN 已传播（dest.end 只调一次） */
  destEnded: boolean;
}
interface ConnState {
  client: net.Socket;
  target: net.Socket | null;
  c2s: Pipe;
  s2c: Pipe;
  lastActivityAt: number;
}

const PUMP_MS = 10;
/** 队列超此水位暂停源 socket：throttle 经真实 TCP 背压生效（不是内存黑洞） */
const QUEUE_PAUSE_BYTES = 1024 * 1024;
/**
 * blackhole 全局标志：黑洞期间新建连接的 pipe 以此初始化——
 * 否则「判死后重连」拿到干净管道，黑洞被静默架空。
 */
const blackholeFlags = { c2s: false, s2c: false };

export function createChaosProxy(opts: ChaosProxyOptions): ChaosProxy {
  const conns = new Set<ConnState>();
  let destroyed = 0;
  let bytesRelayed = 0;
  let latencyMs = 0;
  let jitterMs = 0;
  let throttleBps = 0; // 0 = 不限速
  let throttleShared = false; // shared = 全连接共享一份带宽预算（模拟共享链路）
  let idleTimeoutMs = 0; // 0 = 不启用
  let rejectStatus: number | null = null;
  let flappyTimer: NodeJS.Timeout | null = null;
  let closed = false;

  /** 泵送一 pipe；返回本次实际转发字节数（shared 模式据以扣全局预算） */
  function pumpPipe(pipe: Pipe, budgetBytes: number): number {
    if (pipe.blackholed) return 0;
    let budget = budgetBytes;
    const now = Date.now();
    while (pipe.queue.length > 0 && budget > 0) {
      const head = pipe.queue[0];
      if (!head || head.due > now) break;
      if (head.chunk.length <= budget) {
        pipe.queue.shift();
        pipe.queuedBytes -= head.chunk.length;
        budget -= head.chunk.length;
        bytesRelayed += head.chunk.length;
        pipe.dest.write(head.chunk);
      } else {
        // 超本 tick 预算：只写预算内前缀，余量留队下 tick 续写（低限速不超发）
        const part = head.chunk.subarray(0, budget);
        head.chunk = head.chunk.subarray(budget);
        pipe.queuedBytes -= part.length;
        bytesRelayed += part.length;
        pipe.dest.write(part);
        budget = 0;
      }
    }
    // 源已 close 且队列排空：向对端传播干净 FIN（只一次；对端已毁则跳过）
    if (pipe.sourceClosed && pipe.queue.length === 0 && !pipe.destEnded) {
      pipe.destEnded = true;
      if (!pipe.dest.destroyed) pipe.dest.end();
    }
    if (pipe.sourcePaused && pipe.queuedBytes <= QUEUE_PAUSE_BYTES / 2 && !pipe.blackholed) {
      pipe.sourcePaused = false;
      pipe.source.resume();
    }
    return budgetBytes - budget;
  }

  const pumpTimer = setInterval(() => {
    const now = Date.now();
    const perPipeBudget =
      throttleBps > 0 ? (throttleBps * PUMP_MS) / 1000 : Number.POSITIVE_INFINITY;
    let sharedRemaining = perPipeBudget; // shared 模式：本 tick 全场共享这一份预算
    for (const conn of [...conns]) {
      if (idleTimeoutMs > 0 && now - conn.lastActivityAt > idleTimeoutMs) {
        destroyConn(conn);
        continue;
      }
      if (throttleShared) {
        sharedRemaining -= pumpPipe(conn.c2s, sharedRemaining);
        sharedRemaining -= pumpPipe(conn.s2c, sharedRemaining);
      } else {
        pumpPipe(conn.c2s, perPipeBudget);
        pumpPipe(conn.s2c, perPipeBudget);
      }
      // 双向 FIN 均已传播（或对端已毁）：连接自然终结，移出在场集合
      const done = (p: Pipe): boolean => p.destEnded || p.dest.destroyed;
      if (done(conn.c2s) && done(conn.s2c)) conns.delete(conn);
    }
  }, PUMP_MS);
  pumpTimer.unref(); // 不阻止进程退出（测试收尾另有 close 清理）

  function destroyConn(conn: ConnState): void {
    if (!conns.delete(conn)) return; // 幂等
    destroyed += 1;
    conn.client.destroy();
    conn.target?.destroy();
  }

  function wirePipe(conn: ConnState, pipe: Pipe): void {
    pipe.source.on('data', (chunk: Buffer) => {
      conn.lastActivityAt = Date.now();
      const delay = latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);
      pipe.queue.push({ chunk, due: Date.now() + delay });
      pipe.queuedBytes += chunk.length;
      if (!pipe.sourcePaused && pipe.queuedBytes > QUEUE_PAUSE_BYTES) {
        pipe.sourcePaused = true;
        pipe.source.pause();
      }
    });
    // 对端 RST/断开：消化 error（防未处理事件崩测试进程）
    pipe.source.on('error', () => undefined);
    // 源 close 不立即拆对端：泵窗口内已入队数据须先转发完，再由泵传播干净 FIN
    pipe.source.on('close', () => { pipe.sourceClosed = true; });
  }

  /** rejectUpgrade 模式：读完 HTTP 头回错误响应再关（反代 502/404 保真） */
  function wireReject(client: net.Socket, status: number): void {
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0 && head.length <= 16 * 1024) return;
      client.removeListener('data', onData);
      const body = Buffer.alloc(0);
      client.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`,
      );
    };
    client.on('data', onData);
    client.on('error', () => undefined);
    client.on('close', () => undefined);
  }

  const server = net.createServer((client) => {
    if (closed) { client.destroy(); return; }
    if (rejectStatus !== null) { wireReject(client, rejectStatus); return; }
    const target = net.createConnection({ host: opts.targetHost, port: opts.targetPort });
    // 新 pipe 以全局黑洞标志初始化：黑洞期间新建连接同样静默
    const mkPipe = (source: net.Socket, dest: net.Socket, blackholed: boolean): Pipe => ({
      source, dest, blackholed,
      queue: [], queuedBytes: 0, sourcePaused: false, sourceClosed: false, destEnded: false,
    });
    const conn: ConnState = {
      client,
      target,
      c2s: mkPipe(client, target, blackholeFlags.c2s),
      s2c: mkPipe(target, client, blackholeFlags.s2c),
      lastActivityAt: Date.now(),
    };
    conns.add(conn);
    target.on('error', () => client.destroy()); // target 不可达/被 RST → 客户端看到断开
    wirePipe(conn, conn.c2s);
    wirePipe(conn, conn.s2c);
    if (conn.c2s.blackholed) client.pause(); // 黑洞中建连：源侧即停，窗口填满
    if (conn.s2c.blackholed) target.pause();
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (typeof addr === 'string' || !addr) { reject(new Error('no addr')); return; }
          resolve(addr.port);
        });
      });
    },
    async close(): Promise<void> {
      closed = true;
      blackholeFlags.c2s = false; // 模块级标志随实例关闭复位，防跨用例污染
      blackholeFlags.s2c = false;
      clearInterval(pumpTimer);
      if (flappyTimer) { clearInterval(flappyTimer); flappyTimer = null; }
      for (const conn of [...conns]) destroyConn(conn);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    destroyAll(): void {
      for (const conn of [...conns]) destroyConn(conn);
    },
    blackhole(direction: ChaosDirection = 'both'): void {
      // 置全局标志：黑洞期间新建连接同样黑（不止作用在场连接）
      if (direction === 'c2s' || direction === 'both') blackholeFlags.c2s = true;
      if (direction === 's2c' || direction === 'both') blackholeFlags.s2c = true;
      for (const conn of conns) {
        if (direction === 'c2s' || direction === 'both') {
          conn.c2s.blackholed = true;
          conn.c2s.source.pause(); // 窗口填满 = 真实丢包/半开
        }
        if (direction === 's2c' || direction === 'both') {
          conn.s2c.blackholed = true;
          conn.s2c.source.pause();
        }
      }
    },
    heal(): void {
      blackholeFlags.c2s = false; // 清全局标志：此后新建连接干净
      blackholeFlags.s2c = false;
      for (const conn of conns) {
        for (const pipe of [conn.c2s, conn.s2c]) {
          pipe.blackholed = false;
          if (!pipe.sourcePaused) pipe.source.resume(); // 冲刷内核积压，转发恢复
        }
      }
    },
    setLatency(ms: number, jitter = 0): void { latencyMs = ms; jitterMs = jitter; },
    setThrottle(bytesPerSec: number, mode: ChaosThrottleMode = 'per-conn'): void {
      throttleBps = bytesPerSec;
      // bps=0 = 不限速：shared 分支无意义且会 Infinity−Infinity=NaN 停摆，退回 per-conn Infinity 路径
      throttleShared = bytesPerSec > 0 && mode === 'shared';
    },
    setIdleTimeout(ms: number): void { idleTimeoutMs = ms; },
    flappy(intervalMs: number): void {
      if (flappyTimer) clearInterval(flappyTimer);
      flappyTimer = setInterval(() => {
        for (const conn of [...conns]) destroyConn(conn);
      }, intervalMs);
      flappyTimer.unref();
    },
    stopFlappy(): void {
      if (flappyTimer) { clearInterval(flappyTimer); flappyTimer = null; }
    },
    rejectUpgradeWith(status: number): void { rejectStatus = status; },
    clearRejectUpgrade(): void { rejectStatus = null; },
    stats(): ChaosProxyStats {
      return { connections: conns.size, destroyed, bytesRelayed };
    },
  };
}
