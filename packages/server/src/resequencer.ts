/**
 * 与 packages/client/src/resequencer.ts 互为镜像，改动必须双向同步。
 *
 * 接收端重排序（spec §6）：多连接条带化下，同一 (channelId, 方向) 的帧可能经不同 leg 乱序到达。
 * 本器按 seq 重排后按序交付，通道层看到的仍是与单连接逐字节一致的有序流。
 * 无 seq 的帧（单连接模式/隧道级帧）不经过本器，调用方直通。
 * 断腿=整组重建（spec §4.4）前提下 seq < expected 不可能发生，防御性丢弃 + WARN。
 */

import type { ControlFrame, DataHeader } from './protocol';
import type { Logger } from './logger';

export type SequencedItem =
  | { kind: 'control'; frame: ControlFrame }
  | { kind: 'data'; header: DataHeader; payload: Buffer };

/** 防御性每通道缓冲上限（spec §6.3）：乱序停驻帧本就是在途帧子集，超限 = 对端行为异常 */
const MAX_CHANNEL_BUFFER_BYTES = 32 * 1024 * 1024;

interface ChannelState {
  expected: number;
  buffer: Map<number, SequencedItem>;
  bufferedBytes: number;
}

function itemBytes(item: SequencedItem): number {
  return item.kind === 'data' ? item.payload.length : 0; // 控制帧极小，不计
}

export class Resequencer {
  private readonly states = new Map<number, ChannelState>();

  constructor(
    private readonly opts: {
      logger: Logger;
      /** 通道缓冲超限：调用方按隧道组级协议错误处置（1002/teardown） */
      onOverflow: (channelId: number) => void;
    },
  ) {}

  /** 喂入一帧；deliver 可能被同步回调多次（连扫停驻帧） */
  feed(channelId: number, seq: number, item: SequencedItem, deliver: (item: SequencedItem) => void): void {
    let st = this.states.get(channelId);
    if (!st) {
      st = { expected: 0, buffer: new Map(), bufferedBytes: 0 };
      this.states.set(channelId, st);
    }
    if (seq < st.expected) {
      this.opts.logger.warn('重排序收到旧 seq，防御性丢弃', { channelId, seq, expected: st.expected });
      return;
    }
    if (seq > st.expected) {
      if (st.buffer.has(seq)) return; // 防御重复（TCP 有序，不会发生）
      st.buffer.set(seq, item);
      st.bufferedBytes += itemBytes(item);
      if (st.bufferedBytes > MAX_CHANNEL_BUFFER_BYTES) {
        this.states.delete(channelId);
        this.opts.onOverflow(channelId);
      }
      return;
    }
    // seq === expected：交付并连扫
    deliver(item);
    st.expected += 1;
    let next: SequencedItem | undefined;
    while ((next = st.buffer.get(st.expected)) !== undefined) {
      st.buffer.delete(st.expected);
      st.bufferedBytes -= itemBytes(next);
      deliver(next);
      st.expected += 1;
    }
  }

  /** 通道结束清理（onDone/unregister 对应点调用） */
  dropChannel(channelId: number): void {
    this.states.delete(channelId);
  }

  /** 整组重连重置（channelId 空间随隧道重建归零） */
  reset(): void {
    this.states.clear();
  }
}
