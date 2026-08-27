/**
 * 令牌桶限流（spec §4.1）。
 * TokenBucket：匀速补充 + FIFO 挂起唤醒；acquire(cost) 支持大于容量的切片累计。
 * ConnectionLimiter：新建连接准入（默认 8/s），排队中 socket close 自动取消（Promise 永挂起）。
 * BandwidthLimiter：全局带宽（默认 51200 B/s），上下行所有连接共享一个桶。
 */

import type { Socket } from 'node:net';

export interface TokenBucketOptions {
  /** 容量（突发上限），token 不超此值 */
  capacity: number;
  /** 每秒补充 token 数 */
  refillPerSecond: number;
  /** 补充节拍（毫秒）；每拍补 refillPerSecond * intervalMs / 1000 */
  intervalMs: number;
}

interface Waiter {
  cost: number;
  resolve: () => void;
}

/** 令牌桶基元：匀速补充；FIFO 严格队首唤醒（不跳过，防插队饿死） */
// 取舍说明：严格 FIFO 存在队头阻塞（HOL）——共享带宽桶下某连接的大 chunk 排队会挡在
// 其后所有连接的小 chunk 前面（默认 50KB/s 下 1MB 传输可让其它连接 stall 最长约 20s），
// 这是用跨连接瞬时公平性换取防饿死的确定性。
export class TokenBucket {
  private tokens: number;
  private readonly queue: Waiter[] = [];
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillPerSecond <= 0 || options.intervalMs <= 0) {
      throw new Error('TokenBucket 参数须为正数');
    }
    this.tokens = options.capacity;
    this.timer = setInterval(() => this.refill(), options.intervalMs);
    this.timer.unref(); // 不阻止进程退出
  }

  /**
   * 申请 cost 个 token；不足时 FIFO 挂起。
   * cost > capacity 时按容量切片累计等待（大 chunk 不死锁）。
   * onQueued：进入队列时回调取消函数（从队列剔除，Promise 永挂起）。
   */
  async acquire(cost: number, onQueued?: (cancel: () => void) => void): Promise<void> {
    let remaining = cost;
    let first = true;
    while (remaining > 0) {
      const slice = Math.min(remaining, this.options.capacity);
      await this.acquireSlice(slice, first ? onQueued : undefined);
      first = false;
      remaining -= slice;
    }
  }

  private acquireSlice(cost: number, onQueued?: (cancel: () => void) => void): Promise<void> {
    if (this.queue.length === 0 && this.tokens >= cost) {
      this.tokens -= cost;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter: Waiter = { cost, resolve };
      this.queue.push(waiter);
      onQueued?.(() => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      });
    });
  }

  private refill(): void {
    const add = (this.options.refillPerSecond * this.options.intervalMs) / 1000;
    this.tokens = Math.min(this.options.capacity, this.tokens + add);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const head = this.queue[0];
      if (head === undefined || this.tokens < head.cost) return;
      this.tokens -= head.cost;
      this.queue.shift();
      head.resolve();
    }
  }

  /** 停止补充定时器（close 后桶不再补充，挂起的 acquire 永挂起） */
  close(): void {
    clearInterval(this.timer);
  }
}

/** 新建连接准入：默认 8/s（每 125ms 补 1，容量 8） */
export class ConnectionLimiter {
  private readonly bucket: TokenBucket;

  constructor(maxPerSecond: number) {
    this.bucket = new TokenBucket({
      capacity: maxPerSecond,
      refillPerSecond: maxPerSecond,
      intervalMs: Math.max(1, Math.floor(1000 / maxPerSecond)),
    });
  }

  /** 等待准入；排队期间 socket close → 出队取消（Promise 永挂起，调用方随 close 收尾） */
  acquire(socket: Socket): Promise<void> {
    if (socket.destroyed) return new Promise(() => {});
    return this.bucket.acquire(1, (cancel) => socket.once('close', cancel));
  }

  close(): void {
    this.bucket.close();
  }
}

/** 全局带宽：默认 51200 B/s（每 100ms 补 1/10，容量为 1s 突发） */
export class BandwidthLimiter {
  private readonly bucket: TokenBucket;

  constructor(maxBytesPerSecond: number) {
    this.bucket = new TokenBucket({
      capacity: maxBytesPerSecond,
      refillPerSecond: maxBytesPerSecond,
      intervalMs: 100,
    });
  }

  acquire(bytes: number): Promise<void> {
    return this.bucket.acquire(bytes);
  }

  close(): void {
    this.bucket.close();
  }
}
