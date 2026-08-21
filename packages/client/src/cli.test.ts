/**
 * cli.test.ts — CLI（参数解析 / 配置加载 / main 退出码）测试。
 * 注意：配置文件写入系统临时目录并在 afterEach 清理；不依赖真实网关连接。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, main, parseArgs } from './cli';

let dir: string | null = null;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

async function writeConfig(content: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'gw-client-'));
  const file = join(dir, 'client.config.mjs');
  await writeFile(file, content);
  return file;
}

describe('parseArgs', () => {
  it('默认 config 路径 ./client.config.mjs', () => {
    expect(parseArgs([]).config).toBe('./client.config.mjs');
  });
  it('--config 指定路径', () => {
    expect(parseArgs(['--config', '/tmp/c.mjs']).config).toBe('/tmp/c.mjs');
  });
  it('未知参数抛错', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/未知参数/);
  });
});

describe('loadConfig', () => {
  it('加载 export default 对象', async () => {
    const file = await writeConfig('export default { upstreamUrl: "http://x", gatewayUrl: "ws://y", hostname: "a" }');
    const cfg = await loadConfig(file);
    expect(cfg.hostname).toBe('a');
  });
  it('无 default 导出 → 抛错', async () => {
    const file = await writeConfig('export const x = 1');
    await expect(loadConfig(file)).rejects.toThrow(/export default/);
  });
});

describe('main 退出码', () => {
  it('--help → 0', async () => {
    expect(await main(['--help'])).toBe(0);
  });
  it('配置文件不存在 → 1', async () => {
    expect(await main(['--config', join(tmpdir(), 'no-such-file.mjs')])).toBe(1);
  });
  it('配置非法（缺 hostname）→ 1', async () => {
    const file = await writeConfig('export default { upstreamUrl: "http://x", gatewayUrl: "ws://y" }');
    expect(await main(['--config', file])).toBe(1);
  });

  // 安全红线：token 行带语法错误时，加载失败的诊断输出不得回显 token 值（代码帧泄漏）
  it('配置语法错误时诊断不得泄漏 token 值', async () => {
    const file = await writeConfig(
      'export default { upstreamUrl: "http://x", gatewayUrl: "ws://y", hostname: "a", token: "SECRET-TOKEN-DO-NOT-LEAK }',
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--config', file])).toBe(1);
      // 汇总全部 console.error 实参（含 Error 的 name/message/stack）做子串断言
      const printed = spy.mock.calls
        .flat()
        .map((a) => (a instanceof Error ? `${a.name}: ${a.message}\n${a.stack ?? ''}` : String(a)))
        .join('\n');
      expect(printed).not.toContain('SECRET-TOKEN-DO-NOT-LEAK');
      // 诊断必须收窄为单行字符串实参：不得把原始 Error 对象（message/stack 可能含代码帧）透传给 console.error
      const allSingleLineStrings = spy.mock.calls
        .flat()
        .every((a) => typeof a === 'string' && !a.includes('\n'));
      expect(allSingleLineStrings).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
