import { afterEach, describe, expect, it, vi } from 'vitest';

import { main, parseArgs, parseBytesPerSecond, parseTarget } from './cli';

afterEach(() => vi.restoreAllMocks());

describe('parseArgs', () => {
  it('默认值', () => {
    expect(parseArgs([])).toEqual({
      listen: 9080,
      targetHost: '127.0.0.1',
      targetPort: 9000,
      maxConnectionsPerSecond: 8,
      maxBytesPerSecond: 51200,
      help: false,
    });
  });

  it('覆盖值', () => {
    expect(parseArgs([
      '--listen', '8080',
      '--target', 'localhost:8000',
      '--max-connections-per-second', '16',
      '--max-bytes-per-second', '100k',
    ])).toEqual({
      listen: 8080,
      targetHost: 'localhost',
      targetPort: 8000,
      maxConnectionsPerSecond: 16,
      maxBytesPerSecond: 102400,
      help: false,
    });
  });

  it.each([
    [['--listen', 'x']],
    [['--listen', '70000']],
    [['--target', 'nohost']],
    [['--max-connections-per-second', '0']],
    [['--max-bytes-per-second', '-5']],
    [['--unknown']],
  ])('非法值抛错 %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow();
  });
});

describe('parseTarget', () => {
  it('host:port', () => {
    expect(parseTarget('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
  });
  it('IPv6 方括号写法', () => {
    expect(parseTarget('[::1]:9000')).toEqual({ host: '::1', port: 9000 });
  });
  it('非法', () => {
    expect(() => parseTarget(':8080')).toThrow();
    expect(() => parseTarget('h:abc')).toThrow();
  });
});

describe('parseBytesPerSecond', () => {
  it('裸数字与 k/m 后缀', () => {
    expect(parseBytesPerSecond('51200')).toBe(51200);
    expect(parseBytesPerSecond('50k')).toBe(51200);
    expect(parseBytesPerSecond('2M')).toBe(2097152);
  });
  it('非法', () => {
    expect(() => parseBytesPerSecond('0')).toThrow();
    expect(() => parseBytesPerSecond('1.5k')).toThrow();
  });
});

describe('main', () => {
  it('--help 打印用法并返回 0', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await main(['--help'])).toBe(0);
  });
  it('非法参数单行诊断并返回 1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--listen', 'bad'])).toBe(1);
  });
});
