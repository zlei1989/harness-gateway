/**
 * 网关地址 → 隧道端点与选择页地址的协议推断（纯函数，表驱动单测）。
 * 缺省 http/ws：用户只填域名时按非公网 TLS 部署处理；
 * 填 https:// 或 wss:// 时升级为 wss/https。
 */

export interface GatewayEndpoints {
  /** 隧道 WS 端点（ws/wss） */
  gatewayUrl: string;
  /** 选择页地址（http/https，不含 query；深链由 buildSelectDeepLink 拼） */
  selectUrl: string;
}

/** 推断隧道与选择页地址；无法解析/协议不支持时抛 Error（message 面向用户，直接给 UI 展示）。 */
export function deriveGatewayEndpoints(rawInput: string): GatewayEndpoints {
  const input = rawInput.trim();
  if (!input) throw new Error('网关地址不能为空');
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`网关地址无法解析: ${input}`);
  }
  if (!url.hostname) throw new Error(`网关地址无法解析: ${input}`);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') {
    throw new Error(`网关地址协议不支持: ${url.protocol}（仅支持 http/https/ws/wss）`);
  }
  // 只取 origin（hostname[:port]），忽略误填的路径与查询串
  const origin = url.host;
  return {
    gatewayUrl: `${secure ? 'wss' : 'ws'}://${origin}/__gateway__/tunnel`,
    selectUrl: `${secure ? 'https' : 'http'}://${origin}/__gateway__/select`,
  };
}

/** 拼选择页深链（二维码内容与「立即查看」跳转地址）。 */
export function buildSelectDeepLink(selectUrl: string, tunnelId: string): string {
  return `${selectUrl}?tunnelId=${encodeURIComponent(tunnelId)}`;
}

/**
 * DSH 启动令牌 URL → 网关客户端 defaultPath（DSH 浏览器认证桥接）。
 * 取 connection.authenticatedUrl() 的 pathname + search（'/?token=…'）：网关登录成功后
 * 浏览器落在该路径上，经隧道完成 DSH 的令牌交换（铸发 dsh-auth cookie）再 303 到干净 '/'，
 * 用户无需手工把终端打印的 loopback URL 拼到网关地址上。
 * 防御规则与服务端选择页 redirect 校验一致（仅放行站内绝对路径）：输入无法解析或
 * 变形（非 '/' 开头、'//' 协议相对）一律回落 '/'——authenticatedUrl 虽来自 DSH connection
 * 服务，异常输入也不得外溢进 defaultPath。
 */
export function dshAuthDefaultPath(authenticatedUrl: string): string {
  let url: URL;
  try {
    url = new URL(authenticatedUrl);
  } catch {
    return '/';
  }
  const path = `${url.pathname}${url.search}`;
  return path.startsWith('/') && !path.startsWith('//') ? path : '/';
}

/** connection 服务的最小消费面（与 services.ts 的 ConnectionFace 结构一致；本地声明免跨模块耦合）。 */
interface AuthenticatedUrlSource {
  authenticatedUrl(baseUrl: string): string;
}

/**
 * 从 connection 服务现取 DSH 认证桥接的 defaultPath。
 * 返回 undefined = 桥接不可用（老 DSH 无 connection 服务、或 authenticatedUrl 抛错），
 * 调用方回落老行为（defaultPath '/'，DSH 浏览器认证手工拼 token URL）——
 * 服务缺席只应损失桥接便利，不得连累远程访问主功能。
 */
export function dshAuthDefaultPathFrom(
  connection: AuthenticatedUrlSource | undefined,
  upstreamUrl: string,
): string | undefined {
  if (connection === undefined) return undefined;
  try {
    return dshAuthDefaultPath(connection.authenticatedUrl(upstreamUrl));
  } catch {
    return undefined;
  }
}
