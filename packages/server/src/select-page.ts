/**
 * 内置选择页 — 零依赖自包含 HTML（spec §6；明确偏离 antd/DESIGN.md 规范，零依赖网关不引入前端构建链）。
 * 页面形态：在线电脑图标矩阵（卡片仅图标+hostname，携带 data-tunnel-id；同名并存以 tunnelId 区分）+
 * 隐藏模态对话框（token 输入）；点击卡片弹框，?tunnelId=xxx 深链自动弹框；登录走 fetch ajax，
 * 成功按响应 JSON 的 redirect 跳转，失败把 error 显示在对话框内（不重载页面）。
 * POST 处理：解析表单（tunnelId + token）→ tunnelId 在线校验 → 经隧道探测 token（客户端是唯一鉴权权威）
 * → 建会话 + 200 JSON（Set-Cookie）；全部响应为 JSON，不再重渲染整页。
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

/** HTML 转义（选择页唯一用户可控输出点；同时覆盖属性与文本两处插入位） */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * 渲染选择页：电脑图标矩阵 + 隐藏模态对话框 + 页内脚本。
 * 脚本插入位全部为静态文本；动态数据（hostname/tunnelId）只经 data 属性入 DOM，
 * 脚本侧用 textContent 读取展示，不构成 HTML/JS 注入面。
 */
export function renderSelectPage(computers: { tunnelId: string; hostname: string }[]): string {
  const items = computers.map((c) => {
    const name = escapeHtml(c.hostname);
    return `
      <button type="button" class="card" data-tunnel-id="${escapeHtml(c.tunnelId)}" data-name="${name}">
        <div class="icon">🖥️</div>
        <div class="name">${name}</div>
      </button>`;
  }).join('\n');
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
  .card { background: #fff; border: 1px solid #e5e6eb; border-radius: 8px; padding: 24px 16px; text-align: center; cursor: pointer; font: inherit; color: inherit; }
  .card:hover { border-color: #165dff; }
  .icon { font-size: 40px; }
  .name { margin-top: 8px; font-weight: 500; word-break: break-all; }
  .error { background: #ffece8; color: #cb2634; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
  .empty { color: #86909c; }
  .mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; }
  /* author 的 display:flex 会盖掉 hidden 属性的 UA 默认样式（[hidden]{display:none}），
     缺了这条遮罩常驻全屏：弹窗始终可见且拦截全部卡片点击（线上 bug 回归防线） */
  .mask[hidden] { display: none; }
  .dialog { background: #fff; border-radius: 8px; padding: 24px; width: 320px; }
  .dialog-title { font-size: 16px; font-weight: 500; margin-bottom: 16px; word-break: break-all; }
  .dialog input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid #e5e6eb; border-radius: 4px; }
  .dialog-error { color: #cb2634; font-size: 13px; margin-top: 8px; }
  .dialog-actions { display: flex; gap: 8px; margin-top: 16px; }
  .dialog-actions button { flex: 1; padding: 6px 0; border: none; border-radius: 4px; cursor: pointer; }
  .btn-primary { background: #165dff; color: #fff; }
  .btn-cancel { background: #f2f3f5; color: #4e5969; }
  .dialog-actions button[disabled] { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
<main>
  <h1>选择要连接的电脑</h1>
  <div class="error" id="pageError" hidden></div>
  ${empty}
  <div class="grid">
    ${items}
  </div>
</main>
<div class="mask" id="mask" hidden>
  <div class="dialog" role="dialog" aria-modal="true">
    <div class="dialog-title" id="dialogTitle"></div>
    <input type="password" id="tokenInput" placeholder="请输入 token" autocomplete="off" />
    <div class="dialog-error" id="dialogError" hidden></div>
    <div class="dialog-actions">
      <button type="button" class="btn-cancel" id="cancelBtn">取消</button>
      <button type="button" class="btn-primary" id="okBtn">连接</button>
    </div>
  </div>
</div>
<script>
(function () {
  var mask = document.getElementById('mask');
  var title = document.getElementById('dialogTitle');
  var input = document.getElementById('tokenInput');
  var dialogError = document.getElementById('dialogError');
  var pageError = document.getElementById('pageError');
  var okBtn = document.getElementById('okBtn');
  var cancelBtn = document.getElementById('cancelBtn');
  var cards = Array.prototype.slice.call(document.querySelectorAll('.card'));
  var currentId = null;
  var submitting = false;

  /** 打开对话框：标题为电脑名（textContent 写入，无注入面），清空上次的 token 与错误 */
  function openDialog(id, name) {
    currentId = id;
    title.textContent = name;
    dialogError.hidden = true;
    dialogError.textContent = '';
    input.value = '';
    mask.hidden = false;
    input.focus();
  }
  function closeDialog() {
    mask.hidden = true;
    currentId = null;
  }
  /** 错误直接显示在对话框内（不关框，用户改 token 后可立即重试） */
  function showDialogError(msg) {
    dialogError.textContent = msg;
    dialogError.hidden = false;
  }

  cards.forEach(function (card) {
    card.addEventListener('click', function () {
      openDialog(card.getAttribute('data-tunnel-id'), card.getAttribute('data-name'));
    });
  });
  cancelBtn.addEventListener('click', closeDialog);
  // 点击遮罩空白处关框（点对话框内部不关）
  mask.addEventListener('click', function (ev) { if (ev.target === mask) closeDialog(); });
  document.addEventListener('keydown', function (ev) {
    if (mask.hidden) return;
    if (ev.key === 'Escape') closeDialog();
    // 输入框内回车 = 提交（对话框非 form，需手动绑定）
    if (ev.key === 'Enter' && document.activeElement === input) submit();
  });
  okBtn.addEventListener('click', submit);

  /** ajax 登录：POST 当前路径（选择页路径）；200 → 跳 redirect；其余状态 → 错误入对话框 */
  function submit() {
    if (submitting || currentId === null) return;
    var token = input.value;
    if (!token) { showDialogError('请输入 token'); return; }
    submitting = true;
    okBtn.disabled = true;
    fetch(location.pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tunnelId: currentId, token: token }),
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: '服务响应异常' }; }).then(function (data) {
        if (res.status === 200 && data.ok && data.redirect) {
          location.assign(data.redirect); // Set-Cookie 已随响应落盘，跳转即带会话
          return;
        }
        showDialogError(data.error || '登录失败（HTTP ' + res.status + '）');
      });
    }).catch(function () {
      showDialogError('网络错误，请重试');
    }).finally(function () {
      submitting = false;
      okBtn.disabled = false;
    });
  }

  // 深链：?tunnelId=xxx 直接弹出对应对话框；不在线则顶部错误条提示
  var deepId = new URLSearchParams(location.search).get('tunnelId');
  if (deepId) {
    var hit = null;
    cards.forEach(function (card) {
      if (card.getAttribute('data-tunnel-id') === deepId) hit = card;
    });
    if (hit) {
      openDialog(deepId, hit.getAttribute('data-name'));
    } else {
      pageError.textContent = '该电脑不在线或已断开';
      pageError.hidden = false;
    }
  }
})();
</script>
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

/** 写 JSON 响应（选择页 ajax 契约：全部响应 JSON，前端按 status + ok/error/redirect 分发） */
function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(body));
}

/** POST 选择提交：tunnelId 在线校验 → 隧道探测 → 建会话 + 200 JSON redirect（全 JSON 响应，不重渲染整页） */
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
  const tunnelId = form.get('tunnelId') ?? '';
  const token = form.get('token') ?? '';
  const tunnel = ctx.tunnels.get(tunnelId);
  if (!tunnel) {
    ctx.logger.warn('选择失败：tunnelId 不在线', { tunnelId });
    sendJson(res, 409, { ok: false, error: '该电脑不在线或已断开' });
    return;
  }
  const result = await probeAuthCheck(tunnel, token, ctx.headTimeoutMs);
  if (result === 'pass') {
    const uuid = ctx.sessions.create(tunnelId, tunnel.hostname, token);
    ctx.logger.info('会话建立', { uuid, tunnelId, hostname: tunnel.hostname }); // 红线：不记录 token
    // defaultPath 是客户端可控输入：仅放行站内绝对路径（'/' 开头且非 '//'），
    // 站外 URL/协议相对 URL 回落 '/'，防开放重定向（经 JSON redirect 到达前端 location.assign）
    const target = tunnel.defaultPath.startsWith('/') && !tunnel.defaultPath.startsWith('//')
      ? tunnel.defaultPath
      : '/';
    sendJson(res, 200, { ok: true, redirect: target }, { 'set-cookie': buildSessionCookie(uuid) });
    return;
  }
  if (result === 'timeout') {
    sendJson(res, 504, { ok: false, error: '探测超时，请重试' });
    return;
  }
  sendJson(res, 403, { ok: false, error: 'token 错误' });
}
