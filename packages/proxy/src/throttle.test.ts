import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { BandwidthLimiter } from './rate-limiter';
import { ThrottleStream } from './throttle';

describe('ThrottleStream', () => {
  it('数据完整透传，且受带宽桶节流', async () => {
    const limiter = new BandwidthLimiter(100); // 容量 100，每 100ms 补 10
    const chunks = [Buffer.alloc(50, 1), Buffer.alloc(50, 2), Buffer.alloc(50, 3)];
    const startedAt = Date.now();
    const received: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const throttle = new ThrottleStream(limiter);
      Readable.from(chunks)
        .pipe(throttle)
        .on('data', (chunk: Buffer) => received.push(chunk))
        .on('end', resolve)
        .on('error', reject);
    });
    limiter.close();
    expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
    // 前两片吃容量（100B），第三片 50B 需等 50/10 = 5 拍 = 500ms
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400); // 保守下界防抖动
  });
});
