/**
 * 插件日志适配 — 把 gateway-client 的 Logger context 透传到控制台（JSON 附加）。
 * 线上事故修复：原内联适配层丢弃 context，"隧道连接错误/断开"的 err.stack 与 close code 全被吞。
 * 红线不变：gateway-client 日志约定本不放 token，context 透传不引入泄露面。
 */

import type { Logger } from 'gateway-client';

const LOG_PREFIX = '[dsh-remote-access]';

const fmt = (lv: string, m: string, c?: Record<string, unknown>): string =>
  `${LOG_PREFIX} [${lv}] ${m}${c ? ' ' + JSON.stringify(c) : ''}`;

export function createPluginLogger(): Logger {
  return {
    debug: (m, c) => console.debug(fmt('DEBUG', m, c)),
    info: (m, c) => console.info(fmt('INFO', m, c)),
    warn: (m, c) => console.warn(fmt('WARN', m, c)),
    error: (m, c) => console.error(fmt('ERROR', m, c)),
  };
}
