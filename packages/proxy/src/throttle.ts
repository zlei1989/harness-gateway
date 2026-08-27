/**
 * 节流 Transform（spec §4.2）：每 chunk 先向全局带宽桶申请令牌再下发；
 * 令牌不足即挂起等待——上游背压暂停读取，只延迟不丢数据。
 */

import { Transform, type TransformCallback } from 'node:stream';

import type { BandwidthLimiter } from './rate-limiter';

export class ThrottleStream extends Transform {
  constructor(private readonly limiter: BandwidthLimiter) {
    super();
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.limiter.acquire(chunk.length).then(
      () => callback(null, chunk),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err))),
    );
  }
}
