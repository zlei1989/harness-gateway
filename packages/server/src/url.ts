/**
 * req.url 安全解析 — 畸形请求目标（如 `GET http://[::1 HTTP/1.1`，llhttp 放行但 URL 拒绝）
 * 使 new URL 抛 TypeError；分发回调中未捕获即 uncaughtException 崩进程（未认证单请求 DoS）。
 * 统一入口 safePathname：解析失败返回 null，由调用方按 HTTP 400 / upgrade socket.destroy 处置。
 * 日志同样只记 pathname：查询串是常见 token 携带位，任何级别不得打印完整 req.url。
 */

/** 安全提取 pathname；req.url 畸形（new URL 抛错）返回 null */
export function safePathname(url: string | undefined): string | null {
  try {
    return new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}
