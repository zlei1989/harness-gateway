/**
 * 浏览器会话存储与 cookie 工具 — 全内存（spec §6.1，重启即清空）。
 * 会话生命周期：无 logout，session cookie 关浏览器即失效；孤儿 uuid 留在内存（v1 非目标：TTL 清理）。
 * 注意：token 只进不出——除建立会话与转发注入外，任何日志/响应都不得携带。
 */

import { randomUUID } from 'node:crypto';

export interface BrowserSession {
  hostname: string;
  token: string;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSession>();

  /** 建立会话，返回 uuid */
  create(hostname: string, token: string): string {
    const uuid = randomUUID();
    this.sessions.set(uuid, { hostname, token });
    return uuid;
  }

  get(uuid: string): BrowserSession | undefined {
    return this.sessions.get(uuid);
  }
}

export const SESSION_COOKIE = 'gateway_sid';

/** 把 string | string[] 的 Cookie 头摊平为 "k=v; k=v" 串（Node 多 Cookie 头兼容） */
function flatten(cookieHeader: string | string[] | undefined): string {
  if (cookieHeader === undefined) return '';
  return Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
}

/** 从 Cookie 头读 gateway_sid */
export function readSessionCookie(cookieHeader: string | string[] | undefined): string | undefined {
  for (const pair of flatten(cookieHeader).split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) return pair.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

/** 生成 Set-Cookie 值：HttpOnly + SameSite=Lax + Path=/，无过期时间（session cookie，关浏览器失效） */
export function buildSessionCookie(uuid: string): string {
  return `${SESSION_COOKIE}=${uuid}; HttpOnly; SameSite=Lax; Path=/`;
}

/** 剥离 Cookie 头中的 gateway_sid，其余应用 cookie 原样透传；剥离后无剩余返回 undefined */
export function stripSessionCookie(
  cookieHeader: string | string[] | undefined,
): string | undefined {
  const kept = flatten(cookieHeader)
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair.length > 0 && !pair.startsWith(`${SESSION_COOKIE}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}
