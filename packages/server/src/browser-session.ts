/**
 * 浏览器会话存储与 cookie 工具 — TTL + 快照持久化（M1）。
 * 会话生命周期：无 logout，TTL 惰性过期（无后台定时器）；快照明文 JSON + 0600 落盘，重启恢复。
 * 注意：token 只进不出——除建立会话、转发注入与快照落盘（已评审接受）外，任何日志/响应都不得携带。
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Logger } from './logger';

export interface BrowserSession {
  /** 隧道身份（服务端分配的 tunnelId；隧道断开重连复用后会话自动恢复可用） */
  tunnelId: string;
  /** 选择时的展示名快照，仅供日志（hostname 可重复，不参与路由） */
  hostname: string;
  token: string;
  /** 过期时刻（epoch ms）；get 惰性过期，无后台定时器 */
  expiresAt: number;
}

export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BrowserSessionStoreOptions {
  /** 会话生存期（默认 7 天）；cookie Max-Age 与其同源 */
  ttlMs?: number;
  /** 会话快照路径（缺省 = 纯内存，测试密封）；明文 JSON + 0600（token 落盘已评审接受） */
  persistPath?: string;
}

interface SnapshotFile {
  version: 1;
  sessions: Array<{ uuid: string; tunnelId: string; hostname: string; token: string; expiresAt: number }>;
}

export class BrowserSessionStore {
  private readonly sessions = new Map<string, BrowserSession>();
  readonly ttlMs: number;
  private readonly persistPath: string | undefined;

  constructor(options: BrowserSessionStoreOptions = {}, private readonly logger?: Logger) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
    this.persistPath = options.persistPath;
    if (this.persistPath) this.restore();
  }

  /** 建立会话，返回 uuid；低频人工动作：同步落盘（kill 窗口为零，不做防抖） */
  create(tunnelId: string, hostname: string, token: string): string {
    const uuid = randomUUID();
    this.sessions.set(uuid, { tunnelId, hostname, token, expiresAt: Date.now() + this.ttlMs });
    this.persist();
    return uuid;
  }

  /** 惰性过期：过期即删并落盘（无定时器，防悬挂进程/测试） */
  get(uuid: string): BrowserSession | undefined {
    const session = this.sessions.get(uuid);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(uuid);
      this.persist();
      return undefined;
    }
    return session;
  }

  /** 启动恢复：缺文件空表；损坏 WARN 降级空表（不崩进程）；过期条目丢弃。红线：日志只记数量 */
  private restore(): void {
    const path = this.persistPath!;
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as SnapshotFile;
      if (raw?.version !== 1 || !Array.isArray(raw.sessions)) throw new Error('快照结构非法');
      const now = Date.now();
      for (const s of raw.sessions) {
        if (typeof s.expiresAt !== 'number' || s.expiresAt <= now) continue;
        this.sessions.set(s.uuid, { tunnelId: s.tunnelId, hostname: s.hostname, token: s.token, expiresAt: s.expiresAt });
      }
      this.logger?.info('浏览器会话快照已恢复', { count: this.sessions.size });
    } catch (err) {
      // 红线：不记 err.message——旧版 Node 的 JSON.parse 报错回显输入原文，可能携带快照里的 token
      this.logger?.warn('会话快照损坏，降级空表启动', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** 原子写（临时文件 + rename）+ 0600；落盘前顺带清扫过期条目 */
  private persist(): void {
    if (!this.persistPath) return;
    const now = Date.now();
    const sessions = [...this.sessions.entries()]
      .filter(([, s]) => s.expiresAt > now)
      .map(([uuid, s]) => ({ uuid, ...s }));
    mkdirSync(dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessions } satisfies SnapshotFile), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.persistPath);
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

/** 生成 Set-Cookie 值：HttpOnly + SameSite=Lax + Path=/ + Max-Age（与服务端 TTL 同源，同时到期无悬空态） */
export function buildSessionCookie(uuid: string, maxAgeSec: number): string {
  return `${SESSION_COOKIE}=${uuid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
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
