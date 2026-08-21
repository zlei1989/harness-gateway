/**
 * 日志测试 — 级别过滤与 context 输出格式。
 * 注意：通过替换 console.info 捕获输出，finally 中恢复，避免污染其他用例。
 */
import { describe, expect, it } from 'vitest';

import { createConsoleLogger, type Logger } from './logger';

/** 捕获 console 输出的测试辅助 */
function capture(): { lines: string[]; logger: Logger; restore: () => void } {
  const lines: string[] = [];
  const orig = console.info;
  console.info = (msg?: unknown) => lines.push(String(msg));
  return { lines, logger: createConsoleLogger('info'), restore: () => { console.info = orig; } };
}

describe('logger', () => {
  it('info 级别输出 info、过滤 debug', () => {
    const { lines, logger, restore } = capture();
    try {
      logger.debug('不应出现');
      logger.info('连接建立', { hostname: 'pc-a' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('连接建立');
      expect(lines[0]).toContain('pc-a');
    } finally {
      restore();
    }
  });
});
