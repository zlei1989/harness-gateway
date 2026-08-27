import { describe, expect, it } from 'vitest';

import { randomToken } from './random-token';

describe('randomToken', () => {
  it('默认生成 8 位，字符集仅 0-9a-zA-Z', () => {
    for (let i = 0; i < 200; i += 1) {
      const token = randomToken();
      expect(token).toMatch(/^[0-9a-zA-Z]{8}$/);
    }
  });

  it('支持自定义长度', () => {
    expect(randomToken(16)).toHaveLength(16);
  });

  it('注入确定性随机源时输出可复现', () => {
    // rand 恒返回 0 → 恒取字符集首字符 '0'
    expect(randomToken(8, () => 0)).toBe('00000000');
    // rand 逼近 1 → 取字符集末字符 'Z'
    expect(randomToken(4, () => 0.999999)).toBe('ZZZZ');
  });
});
