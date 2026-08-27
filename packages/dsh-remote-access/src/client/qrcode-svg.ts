/**
 * 二维码模块矩阵生成（qrcode-generator 薄封装，纯函数便于 node 环境单测）。
 * client bundle 内联 qrcode-generator；渲染层（index.ts）按矩阵画 SVG rect。
 */

import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** 边长（模块数） */
  size: number;
  isDark(row: number, col: number): boolean;
}

/** 生成 URL 的 QR 模块矩阵（自动版本，纠错级 M）。 */
export function qrModules(url: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount();
  return {
    size,
    isDark: (row, col) => qr.isDark(row, col),
  };
}
