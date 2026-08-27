/**
 * dsh-remote-access — Host 半边（已安装包入口）。
 *
 * 普通 Cordis 插件模块（ESM），由 profile loader 作为 `dsh-remote-access`
 * 行加载。提供 POST /dsh-remote-access/invoke 路由（remote-status /
 * remote-save-config / remote-enable / remote-disable），并在启用时于
 * 本进程内启动 gateway-client 隧道客户端，把当前 DSH web 服务
 * （upstreamUrl = http://127.0.0.1:<webServer.port>）接入网关。
 *
 * 模块级 inject 是唯一门控：Cordis 保持此插件 PENDING 直到 webServer
 * 激活。切勿 export default（Loader 的 unwrapExports 会坍缩模块丢弃 inject）。
 */

import os from 'node:os';


import { ConnectionManager } from './connection-manager';
import { createHandlers } from './handlers';

import type { WebRequestLike, WebResponseLike, WebServerFace } from './services';
import type { Context } from '@deepseek-ai/cordis';

export const name = 'dsh-remote-access';

/** 必需服务：webServer（HTTP 路由 + 当前 DSH web 端口）。 */
export const inject = ['webServer'];

const LOG_PREFIX = '[dsh-remote-access]';

function logInfo(msg: string): void {
  console.info(`${LOG_PREFIX} [INFO] ${msg}`);
}
function logWarn(msg: string): void {
  console.warn(`${LOG_PREFIX} [WARN] ${msg}`);
}
function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined;
  const detail = e?.stack ?? String(e?.message ?? err ?? '');
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (detail ? `\n${detail}` : ''));
}

export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerFace;
  const port = typeof webServer.port === 'number' && webServer.port > 0 ? webServer.port : 0;
  if (port === 0) {
    logError('webServer.port 不可用，远程访问插件无法确定 upstreamUrl，插件停用');
    return;
  }
  const manager = new ConnectionManager({ upstreamUrl: `http://127.0.0.1:${port}` });
  const handlers = createHandlers({ homeDir: os.homedir(), manager, envHostname: os.hostname() });

  const writeJson = (res: WebResponseLike, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // 浏览器 UI 调用入口：POST { method, params } → 执行 handlers → JSON 结果
  ctx.effect(() => {
    let dispose: (() => void) | null = null;
    try {
      dispose = webServer.register({
        kind: 'exact',
        path: '/dsh-remote-access/invoke',
        handler: (req: WebRequestLike, res: WebResponseLike) => {
          let body = '';
          let overflow = false;
          req.on('data', (d) => {
            if (overflow) return;
            body += String(d);
            // 1MB 上限防滥用（UI 是唯一调用方，载荷很小）
            if (body.length > 1_000_000) {
              overflow = true;
              body = '';
              logWarn('调用载荷超过 1MB，已丢弃');
            }
          });
          req.on('end', () => {
            let msg: { method?: unknown; params?: unknown } | null = null;
            try {
              // 注：不能写 as typeof msg——type query 会取到此处被 CFA
              // 收窄后的 null，导致后续访问全部塌缩成 never（tsc TS2339）
              msg = JSON.parse(body || '{}') as { method?: unknown; params?: unknown } | null;
            } catch {
              // 忽略格式错误的载荷
            }
            const method = msg && typeof msg.method === 'string' ? msg.method : '';
            const params = (msg && typeof msg.params === 'object' && msg.params !== null
              ? msg.params : {}) as Record<string, unknown>;
            const handler = handlers.get(method);
            if (!handler) {
              logWarn(`未知调用方法: ${method || '(空)'}`);
              writeJson(res, 404, { ok: false, error: `未知方法: ${method}` });
              return;
            }
            Promise.resolve()
              .then(() => handler(params))
              .then((result) => writeJson(res, 200, result))
              .catch((err: unknown) => {
                logError(`调用 ${method} 失败`, err);
                writeJson(res, 200, { ok: false, error: String((err as Error)?.message ?? err) });
              });
          });
        },
      });
      logInfo('HTTP 路由已注册: /dsh-remote-access/invoke');
    } catch (err) {
      logError('路由注册失败（可能被本插件的另一个实例占用）', err);
    }
    return () => {
      try {
        dispose?.();
      } catch {
        // 尽力清理
      }
    };
  });

  // 插件卸载清理：尽力关闭隧道连接
  ctx.effect(() => () => {
    void manager.disable().then(
      () => logInfo('插件卸载，隧道已关闭'),
      () => undefined,
    );
  });
}
