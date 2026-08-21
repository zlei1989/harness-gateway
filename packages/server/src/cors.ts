/**
 * CORS 允许名单：环境变量 HARNESS_CORS_ORIGINS 解析 + Origin 匹配。
 * 规则：'*' 全放行；'*.jd.com' 匹配本体与任意层级子域（不限 scheme/端口）；
 * 含 ':' 的项按 host:port 精确匹配，其余按 host 精确匹配（任意端口）。
 * 名单外 Origin：网关不附 CORS 头，由浏览器自行拦截；请求转发行为不变。
 */

/** 默认放行名单（HARNESS_CORS_ORIGINS 未配置时生效）；localhost/127.0.0.1 任意端口放行，方便本地调试 */
export const DEFAULT_CORS_ORIGINS = ['*.7qbjs.com', '*.jd.com', 'localhost', '127.0.0.1'];

/** 解析逗号分隔的环境变量值；undefined/全空 → undefined（上层回落默认名单） */
export function parseCorsOrigins(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** 编译名单为 Origin 判定函数；非法 Origin 一律 false */
export function createOriginMatcher(patterns: string[]): (origin: string) => boolean {
  const allowAll = patterns.includes('*');
  const wildcards = patterns.filter((p) => p.startsWith('*.')).map((p) => p.slice(2).toLowerCase());
  const hostPorts = new Set(patterns.filter((p) => !p.startsWith('*.') && p.includes(':')).map((p) => p.toLowerCase()));
  const hosts = new Set(
    patterns.filter((p) => p !== '*' && !p.startsWith('*.') && !p.includes(':')).map((p) => p.toLowerCase()),
  );
  return (origin: string): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    const hostPort = url.host.toLowerCase(); // 含端口（默认端口被 URL 归一化剥离）
    if (allowAll) return true;
    if (hostPorts.has(hostPort)) return true;
    if (hosts.has(host)) return true;
    // 通配：本体或 .后缀 结尾（'*.jd.com' 命中 jd.com / a.b.jd.com，排除 notjd.com / jd.com.evil.com）
    return wildcards.some((base) => host === base || host.endsWith(`.${base}`));
  };
}
