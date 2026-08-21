/**
 * 内置选择页 — 零依赖自包含 HTML（spec §6；明确偏离 antd/DESIGN.md 规范，零依赖网关不引入前端构建链）。
 * POST 处理：解析表单 → hostname 在线校验 → 经隧道探测 token（客户端是唯一鉴权权威）→ 建会话 + 302。
 * 安全注意：hostname 是客户端可控输入，渲染必须 HTML 转义；表单体限 64KB 防内存放大；
 * token 只在内存与隧道帧中流转，任何日志/响应都不得打印。
 */

import { type BrowserSessionStore, buildSessionCookie } from './browser-session';

import type { Logger } from './logger';
import type { TunnelHandle, TunnelRegistry } from './session';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface SelectContext {
  tunnels: TunnelRegistry;
  sessions: BrowserSessionStore;
  headTimeoutMs: number;
  logger: Logger;
}

/** HTML 转义（选择页唯一用户可控输出点） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 渲染选择页：在线电脑图标列表 + token 输入；error 非空时展示错误条 */
export function renderSelectPage(computers: { hostname: string }[], error?: string): string {
  const items = computers.map((c) => {
    const name = escapeHtml(c.hostname);
    return `
      <form class="card" method="post" action="/__gateway__/select">
        <div class="icon">🖥️</div>
        <div class="name">${name}</div>
        <input type="hidden" name="hostname" value="${name}" />
        <input type="password" name="token" placeholder="请输入 token" required autocomplete="off" />
        <button type="submit">连接</button>
      </form>`;
  }).join('\n');
  const errorBar = error ? `<div class="error">${escapeHtml(error)}</div>` : '';
  const empty = computers.length === 0 ? '<p class="empty">暂无在线电脑</p>' : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>选择电脑 - 智能体网关</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f6f7; margin: 0; display: flex; justify-content: center; padding-top: 64px; }
  main { width: 640px; }
  h1 { font-size: 20px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 8px; padding: 24px 16px; text-align: center; }
  .icon { font-size: 40px; }
  .name { margin: 8px 0 12px; font-weight: 500; word-break: break-all; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 6px 8px; margin-bottom: 8px; border: 1px solid #e5e6eb; border-radius: 4px; }
  button { width: 100%; padding: 6px 0; border: none; border-radius: 4px; background: #165dff; color: #fff; cursor: pointer; }
  .error { background: #ffece8; color: #cb2634; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
  .empty { color: #86909c; }
</style>
</head>
<body>
<main>
  <h1>选择要连接的电脑</h1>
  ${errorBar}
  ${empty}
  <div class="grid">
    ${items}
  </div>
</main>
</body>
</html>`;
}

/** GET 选择页 */
export function handleSelectGet(res: ServerResponse, tunnels: TunnelRegistry): void {
  const body = renderSelectPage(tunnels.list());
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

/**
 * 选择页 token 探测：经隧道向客户端发 GET /__gateway__/auth-check（Bearer 注入），
 * 客户端 authorization 链放行 → 204 = pass；拒绝 → deny；超时 → timeout。
 */
export function probeAuthCheck(tunnel: TunnelHandle, token: string, timeoutMs: number): Promise<'pass' | 'deny' | 'timeout'> {
  return new Promise((resolve) => {
    let channelId = 0;
    const timer = setTimeout(() => {
      tunnel.unregister(channelId);
      resolve('timeout');
    }, timeoutMs);
    const finish = (result: 'pass' | 'deny'): void => {
      clearTimeout(timer);
      tunnel.unregister(channelId);
      resolve(result);
    };
    channelId = tunnel.register({
      kind: 'http',
      onControl: (frame) => {
        if (frame.type === 'http.head') finish(frame.status === 204 ? 'pass' : 'deny');
      },
      onData: () => {},
      onTunnelDown: () => {
        clearTimeout(timer);
        resolve('deny'); // 隧道断开视为拒绝（选择页报 token 错误即可重试）
      },
    });
    tunnel.sendControl({
      type: 'http.open',
      channelId,
      method: 'GET',
      url: '/__gateway__/auth-check',
      headers: { authorization: `Bearer ${token}` },
    });
    // 空体规则：无 body 也必须空载 http.body.end 收尾
    tunnel.sendData({ channelId, kind: 'http.body.end' }, Buffer.alloc(0));
  });
}

/** 读取表单体（application/x-www-form-urlencoded），限 64KB */
function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        // 超限只拒绝、不在此销毁 socket：调用方须先把 400 响应写出去，
        // 否则客户端收到的是连接重置而非 400 状态行（内存防线是上方的计数器，不依赖 destroy）
        reject(new Error('form too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

/** POST 选择提交：hostname 在线校验 → 隧道探测 → 建会话 + 302 defaultPath */
export async function handleSelectPost(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: SelectContext,
): Promise<void> {
  let form: URLSearchParams;
  try {
    form = await readFormBody(req);
  } catch {
    // 先写 400 响应，待刷新完成后再销毁 socket 中止上传：顺序反了客户端只会收到连接重置
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad form', () => req.destroy());
    return;
  }
  const hostname = form.get('hostname') ?? '';
  const token = form.get('token') ?? '';
  const tunnel = ctx.tunnels.get(hostname);
  if (!tunnel) {
    ctx.logger.warn('选择失败：hostname 不在线', { hostname });
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderSelectPage(ctx.tunnels.list(), '该电脑不在线'));
    return;
  }
  const result = await probeAuthCheck(tunnel, token, ctx.headTimeoutMs);
  if (result === 'pass') {
    const uuid = ctx.sessions.create(hostname, token);
    ctx.logger.info('会话建立', { uuid, hostname }); // 红线：不记录 token
    // defaultPath 是客户端可控输入：仅放行站内绝对路径（'/' 开头且非 '//'），
    // 站外 URL/协议相对 URL 回落 '/'，防 302 开放重定向
    const target = tunnel.defaultPath.startsWith('/') && !tunnel.defaultPath.startsWith('//')
      ? tunnel.defaultPath
      : '/';
    res.writeHead(302, {
      'set-cookie': buildSessionCookie(uuid),
      location: target,
    });
    res.end();
    return;
  }
  if (result === 'timeout') {
    res.writeHead(504, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderSelectPage(ctx.tunnels.list(), '探测超时，请重试'));
    return;
  }
  res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
  res.end(renderSelectPage(ctx.tunnels.list(), 'token 错误'));
}
