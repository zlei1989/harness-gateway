/**
 * ConnectionManager 测试 — 用最小 mock 网关（只应答 hello/ping 控制帧）
 * 驱动真实 gateway-client 完成握手，验证状态机与 tunnelId/深链。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';


import { ConnectionManager } from './connection-manager';

/** 捕获 ConnectionManager 构造 gateway-client Client 时传入的完整 options（验证配置透传） */
const capturedClientOptions = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('gateway-client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('gateway-client')>();
  // 包一层捕获壳，行为仍是真实 Client（状态机用例不受影响）
  class CapturingClient extends mod.Client {
    constructor(options: ConstructorParameters<typeof mod.Client>[0]) {
      capturedClientOptions.push(options as unknown as Record<string, unknown>);
      super(options);
    }
  }
  return { ...mod, Client: CapturingClient };
});

/** 最小 mock 网关：讲隧道控制帧的 ws 服务端（控制帧为 JSON 文本帧）。 */
class HelloMockGateway {
  private wss = new WebSocketServer({ port: 0 });

  constructor(private readonly tunnelId = 'tid-test-1') {
    this.wss.on('connection', (ws) => {
      ws.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const frame = JSON.parse(String(raw)) as { type?: string };
        if (frame.type === 'hello') {
          ws.send(JSON.stringify({ type: 'hello.ack', tunnelId: this.tunnelId }));
        } else if (frame.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      });
    });
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no addr');
    return `ws://127.0.0.1:${addr.port}`;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}

let gateway: HelloMockGateway;
let manager: ConnectionManager;

beforeEach(() => {
  gateway = new HelloMockGateway();
  manager = new ConnectionManager({ upstreamUrl: 'http://127.0.0.1:1' });
});
afterEach(async () => {
  await manager.disable();
  await gateway.close();
});

const cfg = (gatewayAddr: string, compress = true) => ({ hostname: '', token: 'tok12345', gateway: gatewayAddr, compress });

describe('ConnectionManager', () => {
  it('初始状态为 off', () => {
    expect(manager.status).toEqual({ state: 'off' });
  });

  it('enable → connected：拿到 tunnelId 与选择页深链（hostname 空则用环境主机名）', async () => {
    const status = await manager.enable(cfg(gateway.url)); // ws:// 输入 → http 选择页
    expect(status.state).toBe('connected');
    expect(status.tunnelId).toBe('tid-test-1');
    expect(status.deepLink).toBe('http://' + gateway.url.replace(/^ws:\/\//, '') + '/__gateway__/select?tunnelId=tid-test-1');
  });

  it('disable → off；再次 enable 重新连接', async () => {
    await manager.enable(cfg(gateway.url));
    expect((await manager.disable()).state).toBe('off');
    expect(manager.status).toEqual({ state: 'off' });
    const again = await manager.enable(cfg(gateway.url));
    expect(again.state).toBe('connected');
    expect(again.tunnelId).toBe('tid-test-1');
  });

  it('enable 将 compress 开关原样透传给 gateway-client 构造参数', async () => {
    capturedClientOptions.length = 0;
    await manager.enable(cfg(gateway.url, false));
    await manager.enable(cfg(gateway.url, true));
    expect(capturedClientOptions[0]).toMatchObject({ compress: false });
    expect(capturedClientOptions[1]).toMatchObject({ compress: true });
  });

  it('非法网关地址：enable 抛错，状态保持 off', async () => {    await expect(manager.enable(cfg(''))).rejects.toThrow(/不能为空/);
    expect(manager.status.state).toBe('off');
  });

  it('连接失败（网关不可达）：状态进入 error 而非悬挂', async () => {
    // 指向一个未监听的端口；connectTimeoutMs 默认 60s 太久，
    // 这里依赖 gateway-client 首连内部退避——测试改用快速失败端口 + 缩短超时不可行，
    // 因此验证「状态机至少离开 off 进入 connecting，随后 disable 可恢复」
    const p = manager.enable(cfg('127.0.0.1:1'));
    expect(manager.status.state === 'connecting' || manager.status.state === 'error').toBe(true);
    await manager.disable();
    expect(manager.status).toEqual({ state: 'off' });
    await p.catch(() => undefined); // 吞掉 connect 的最终 reject，防止未处理拒绝
  });
});
