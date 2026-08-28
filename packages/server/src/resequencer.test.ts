/**
 * 与 packages/client/src/resequencer.test.ts 互为镜像，改动必须双向同步。
 */

import { describe, expect, it, vi } from 'vitest';

import { createConsoleLogger } from './logger';
import { Resequencer, type SequencedItem } from './resequencer';

const logger = createConsoleLogger('error'); // 测试静默

function makeSeq(over?: Partial<Resequencer>): { rsq: Resequencer; onOverflow: ReturnType<typeof vi.fn> } {
  const onOverflow = vi.fn();
  return { rsq: new Resequencer({ logger, onOverflow, ...over }), onOverflow };
}

function data(channelId: number, seq: number, text: string): { seq: number; item: SequencedItem } {
  return { seq, item: { kind: 'data', header: { channelId, kind: 'http.body', seq }, payload: Buffer.from(text) } };
}

describe('Resequencer', () => {
  it('有序帧直通交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    for (const f of [data(1, 0, 'a'), data(1, 1, 'b')]) {
      rsq.feed(1, f.seq, f.item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    }
    expect(got).toEqual(['a', 'b']);
  });

  it('乱序停驻，空洞补齐后按序连扫交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => { got.push(it.kind === 'data' ? it.payload.toString() : '?'); };
    rsq.feed(1, 1, data(1, 1, 'b').item, deliver); // 先到 1：停驻
    rsq.feed(1, 2, data(1, 2, 'c').item, deliver); // 先到 2：停驻
    expect(got).toEqual([]);
    rsq.feed(1, 0, data(1, 0, 'a').item, deliver); // 补洞 → 连扫
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('seq 0 空洞：数据先于 open 到达时停驻，open 到达后依次交付', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => {
      got.push(it.kind === 'control' ? 'open' : (it.payload as Buffer).toString());
    };
    rsq.feed(9, 1, data(9, 1, 'x').item, deliver);
    expect(got).toEqual([]);
    rsq.feed(9, 0, { kind: 'control', frame: { type: 'http.open', channelId: 9, seq: 0, method: 'GET', url: '/', headers: {} } }, deliver);
    expect(got).toEqual(['open', 'x']);
  });

  it('旧 seq（< expected）防御性丢弃', () => {
    const { rsq } = makeSeq();
    const got: string[] = [];
    const deliver = (it: SequencedItem): void => { got.push(it.kind === 'data' ? it.payload.toString() : '?'); };
    rsq.feed(1, 0, data(1, 0, 'a').item, deliver);
    rsq.feed(1, 0, data(1, 0, 'dup').item, deliver);
    expect(got).toEqual(['a']);
  });

  it('通道缓冲超 32MiB 触发 onOverflow 并清空该通道状态', () => {
    const { rsq, onOverflow } = makeSeq();
    const big = Buffer.alloc(16 * 1024 * 1024);
    // seq 1/2/3 停驻（expected=0 空洞），总量 48MiB 超限
    for (const s of [1, 2, 3]) rsq.feed(5, s, { kind: 'data', header: { channelId: 5, kind: 'http.body', seq: s }, payload: big }, () => undefined);
    expect(onOverflow).toHaveBeenCalledWith(5);
  });

  it('dropChannel 后 seq 空间从零重来；reset 清空全部', () => {
    const { rsq } = makeSeq();
    const deliver = (): void => undefined;
    rsq.feed(1, 5, data(1, 5, 'x').item, deliver); // 停驻
    rsq.dropChannel(1);
    const got: string[] = [];
    rsq.feed(1, 0, data(1, 0, 'a').item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    expect(got).toEqual(['a']);
    rsq.feed(2, 3, data(2, 3, 'y').item, deliver);
    rsq.reset();
    rsq.feed(2, 0, data(2, 0, 'z').item, (it) => got.push(it.kind === 'data' ? it.payload.toString() : '?'));
    expect(got).toEqual(['a', 'z']);
  });
});
