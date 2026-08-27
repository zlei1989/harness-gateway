import { describe, expect, it } from 'vitest';

import { qrModules } from './qrcode-svg';

describe('qrModules', () => {
  it('生成正方形模块矩阵，大小在合法 QR 范围内', () => {
    const m = qrModules('http://harness-gateway.7qbjs.com/__gateway__/select?tunnelId=3f6f9c40-1c6b-4a12-9a1e-3f0a1c2d4e5f');
    expect(m.size).toBeGreaterThanOrEqual(21);
    expect(m.size % 4).toBe(1); // QR version n → 21 + 4(n-1)
    // 左上角定位符区域必有深色模块
    expect(m.isDark(0, 0)).toBe(true);
    expect(m.isDark(0, 6)).toBe(true);
  });

  it('相同输入输出稳定；不同输入矩阵不同', () => {
    const a = qrModules('http://example.com/?tunnelId=aaa');
    const b = qrModules('http://example.com/?tunnelId=aaa');
    const c = qrModules('http://example.com/?tunnelId=bbb');
    let sameAB = true;
    let sameAC = true;
    for (let r = 0; r < a.size; r += 1) {
      for (let col = 0; col < a.size; col += 1) {
        if (a.isDark(r, col) !== b.isDark(r, col)) sameAB = false;
        if (c.size === a.size && a.isDark(r, col) !== c.isDark(r, col)) sameAC = false;
      }
    }
    expect(sameAB).toBe(true);
    expect(sameAC).toBe(false);
  });
});
