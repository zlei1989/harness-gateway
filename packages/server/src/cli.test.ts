/**
 * CLI 测试 — parseArgs 参数解析与 main() 退出码语义。
 * 注意：--help / 参数非法用例不触碰网络；main() 返回退出码而非 process.exit，可直接断言。
 */

import { describe, expect, it } from 'vitest';

import { main, parseArgs } from './cli';

describe('parseArgs', () => {
  it('默认 port 3081', () => {
    expect(parseArgs([]).port).toBe(3081);
  });
  it('--port / --tunnel-path / --select-path', () => {
    const args = parseArgs(['--port', '9090', '--tunnel-path', '/t', '--select-path', '/s']);
    expect(args).toMatchObject({ port: 9090, tunnelPath: '/t', selectPath: '/s' });
  });
  it('端口非法抛错', () => {
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/port/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/port/);
  });
  it('未知参数抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });
});

describe('main', () => {
  it('--help → 0', async () => {
    expect(await main(['--help'])).toBe(0);
  });
  it('参数非法 → 1', async () => {
    expect(await main(['--port', 'abc'])).toBe(1);
  });
});
