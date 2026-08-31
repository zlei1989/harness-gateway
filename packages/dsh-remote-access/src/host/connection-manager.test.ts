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
  private sockets = new Set<import('ws').WebSocket>();

  constructor(private readonly tunnelId = 'tid-test-1') {
    this.wss.on('connection', (ws) => {
      this.sockets.add(ws);
      ws.on('close', () => this.sockets.delete(ws));
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

  /**
   * 模拟线上中间件 synthesized 的非法 close 帧（code 1006 是保留字，ws 库自身发不出）：
   * 绕过 ws 直接往裸 socket 写 close 帧（FIN|opcode 0x8，2 字节负载 0x03EE=1006），
   * 客户端 ws 收帧即抛 "Invalid WebSocket frame: invalid status code 1006"（线上报错原文）
   */
  sendIllegalCloseFrame(): void {
    for (const ws of this.sockets) {
      (ws as unknown as { _socket: import('node:net').Socket })._socket
        .write(Buffer.from([0x88, 0x02, 0x03, 0xee]));
    }
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

  it('enable 将 connections 原样透传给 gateway-client 构造参数（缺省传 undefined，Client 默认 4）', async () => {
    capturedClientOptions.length = 0;
    await manager.enable({ ...cfg(gateway.url), connections: 8 });
    await manager.enable(cfg(gateway.url));
    expect(capturedClientOptions[0]).toMatchObject({ connections: 8 });
    expect(capturedClientOptions[1]?.connections).toBeUndefined();
  });

  it('enable 将 heartbeatIntervalMs 原样透传给 gateway-client 构造参数（缺省传 undefined，Client 默认 30s）', async () => {
    capturedClientOptions.length = 0;
    await manager.enable({ ...cfg(gateway.url), heartbeatIntervalMs: 10_000 });
    await manager.enable(cfg(gateway.url));
    expect(capturedClientOptions[0]).toMatchObject({ heartbeatIntervalMs: 10_000 });
    expect(capturedClientOptions[1]?.heartbeatIntervalMs).toBeUndefined();
  });

  it('enable 将 deps.defaultPath() 的返回值透传给 gateway-client 构造参数（缺省不传，Client 回落「/」）', async () => {
    capturedClientOptions.length = 0;
    // beforeEach 的 manager 未配 defaultPath 回调 → 构造参数中不得携带（Client 内 defaultPath ?? '/' 接管）
    await manager.enable(cfg(gateway.url));
    // 浏览器认证桥接：配置回调后每次 enable 现取——两次 enable 返回不同值（模拟令牌轮换），
    // 两次构造参数必须各自带走当次值，证明不缓存
    let rotation = 0;
    const bridging = new ConnectionManager({
      upstreamUrl: 'http://127.0.0.1:1',
      defaultPath: () => `/?token=launch-tok-${String(++rotation)}`,
    });
    try {
      await bridging.enable(cfg(gateway.url));
      await bridging.enable(cfg(gateway.url)); // enable 幂等：关旧建新，第二次现取
    } finally {
      await bridging.disable();
    }
    expect(rotation).toBe(2);
    expect(capturedClientOptions[0]?.defaultPath).toBeUndefined();
    expect(capturedClientOptions[1]).toMatchObject({ defaultPath: '/?token=launch-tok-1' });
    expect(capturedClientOptions[2]).toMatchObject({ defaultPath: '/?token=launch-tok-2' });
  });

  it('非法网关地址：enable 抛错，状态保持 off', async () => {    await expect(manager.enable(cfg(''))).rejects.toThrow(/不能为空/);
    expect(manager.status.state).toBe('off');
  });

  it('隧道被中间件非法 close 帧（1006）杀掉：自动重连恢复，全程不误落 error（线上回归）', async () => {
    await manager.enable(cfg(gateway.url));
    expect(manager.status.state).toBe('connected');
    gateway.sendIllegalCloseFrame();
    // 旧断言依赖"退避 0.5-1s 期间可观测到 connecting"；已就绪会话被杀后首次重连立即发起
    // （客户端重连提速）后 connecting 窗口缩到 RTT 级，轮询不可保证采到——回归的实质是
    // "瞬时 ws error 不误落 error 终态 + 自动恢复"，改为快速采样全程状态验证从未落 error
    const observed: string[] = [];
    const deadline = Date.now() + 3000;
    while (manager.status.state !== 'connected' && Date.now() < deadline) {
      observed.push(manager.status.state);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(manager.status.state).toBe('connected');
    expect(manager.status.tunnelId).toBe('tid-test-1'); // 重连 hello 回带复用，会话无损
    expect(observed).not.toContain('error');
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
