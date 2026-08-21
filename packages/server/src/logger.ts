/**
 * 统一日志 —— 级别与场景约定见根 CLAUDE.md。
 * 注意：DEBUG 生产默认关闭（默认级别 info）；任何级别调用方都不得放入 token/Authorization。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 控制台 logger：context 以 JSON 附加在消息后 */
export function createConsoleLogger(level: LogLevel = 'info'): Logger {
  const emit = (lv: LogLevel, message: string, context?: Record<string, unknown>): void => {
    if (ORDER[lv] < ORDER[level]) return;
    const line = context ? `[server][${lv}] ${message} ${JSON.stringify(context)}` : `[server][${lv}] ${message}`;
    if (lv === 'error') console.error(line);
    else if (lv === 'warn') console.warn(line);
    else if (lv === 'debug') console.debug(line);
    else console.info(line);
  };
  return {
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
  };
}

/** 默认 logger：读 LOG_LEVEL 环境变量，缺省 info */
export function createDefaultLogger(): Logger {
  const lv = process.env.LOG_LEVEL?.toLowerCase();
  return createConsoleLogger(lv === 'debug' || lv === 'warn' || lv === 'error' ? lv : 'info');
}
