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
