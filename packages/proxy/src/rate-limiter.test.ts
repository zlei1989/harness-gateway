import { Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionLimiter, TokenBucket } from './rate-limiter';

describe('TokenBucket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('容量内立即放行', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 2, intervalMs: 500 });
    await bucket.acquire(1);
    await bucket.acquire(2); // 恰好清空
    bucket.close();
  });

  it('耗尽后按节拍补充并严格 FIFO 唤醒', async () => {
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 2, intervalMs: 500 }); // 每拍补 1
    const order: string[] = [];
    await bucket.acquire(2); // 清空
    void bucket.acquire(1).then(() => order.push('a'));
    void bucket.acquire(1).then(() => order.push('b'));
    await vi.advanceTimersByTimeAsync(499);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); // 第 500ms 补 1 → a
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(500); // 再补 1 → b
    expect(order).toEqual(['a', 'b']);
    bucket.close();
  });

  it('cost 超容量时按容量切片累计等待', async () => {
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 10, intervalMs: 100 }); // 每拍补 1
    let done = false;
    const p = bucket.acquire(25).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0); // t0 立即扣 10（容量），余 15 排队
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); // +10 → 第二片
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(500); // +5 → 第三片
    await p;
    expect(done).toBe(true);
    bucket.close();
  });

  it('onQueued 取消：从队列剔除且永挂起，token 留给后来者', async () => {
    const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 10, intervalMs: 100 });
    await bucket.acquire(1); // 清空
    let cancel: (() => void) | undefined;
    let resolved = false;
    void bucket.acquire(1, (c) => {
      cancel = c;
    }).then(() => {
      resolved = true;
    });
    cancel?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
    await bucket.acquire(1); // token 未被偷走，立即可得
    bucket.close();
  });
});

describe('ConnectionLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('容量内立即准入，超出按节拍放行；排队中 socket close 取消', async () => {
    const limiter = new ConnectionLimiter(4); // 容量 4，每 250ms 补 1
    const admitted: number[] = [];
    const sockets = Array.from({ length: 6 }, () => new Socket());
    sockets.forEach((s, i) => void limiter.acquire(s).then(() => admitted.push(i)));
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toEqual([0, 1, 2, 3]);
    sockets[5]?.emit('close'); // 第 6 个排队中断开 → 出队
    await vi.advanceTimersByTimeAsync(250); // 补 1 → 第 5 个放行
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    await vi.advanceTimersByTimeAsync(1000); // 再补 4；已取消者永不放行
    expect(admitted).toEqual([0, 1, 2, 3, 4]);
    limiter.close();
  });
});
