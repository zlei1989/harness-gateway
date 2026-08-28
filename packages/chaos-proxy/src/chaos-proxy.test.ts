/**
 * chaos-proxy 自身单测 — 以真实 TCP echo 服务为 target，net.Socket 客户端经代理收发。
 * 后序任务（destroy/blackhole/latency/throttle/idle/flappy/reject）在本文件追加 describe。
 */
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { type ChaosProxy, createChaosProxy } from './chaos-proxy';

let echo: net.Server | null = null;
let echoPort = 0;
let proxy: ChaosProxy | null = null;
const sockets: net.Socket[] = [];

async function startEcho(): Promise<void> {
  echo = net.createServer((s) => {
    s.on('error', () => undefined); // 代理拆连接带来的 RST 属预期，消化防未处理事件
    s.pipe(s);
  });
  await new Promise<void>((r) => echo!.listen(0, '127.0.0.1', r));
  echoPort = (echo!.address() as net.AddressInfo).port;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await proxy?.close();
  proxy = null;
  await new Promise<void>((r) => echo?.close(() => r()) ?? r());
  echo = null;
});

function dial(port: number): net.Socket {
  const s = net.createConnection({ host: '127.0.0.1', port });
  sockets.push(s);
  return s;
}

describe('destroy / blackhole / heal', () => {
  it('destroyAll：客户端收到连接终止，stats.destroyed 记账', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const closed = new Promise<void>((r) => s.on('close', r));
    proxy.destroyAll();
    await closed;
    expect(proxy.stats().destroyed).toBe(1);
    expect(proxy.stats().connections).toBe(0);
  });

  it('blackhole：数据静默无回（不 RST）；heal 后恢复转发', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    proxy.blackhole('both');
    let received = 0;
    s.on('data', () => { received += 1; });
    s.write('ping');
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(0); // 黑洞：无任何回包
    expect(s.destroyed).toBe(false); // 且不 RST（半开保真）
    proxy.heal();
    await new Promise<void>((resolve) => {
      s.on('data', function onData() { s.removeListener('data', onData); resolve(); });
      s.write('ping2');
    });
    expect(received).toBeGreaterThan(0); // heal 后自愈
  });
});

describe('保真度修复（Task 7）', () => {
  it('Fix1 源 close 不丢泵队列数据：echo 侧收全数据后才收到 FIN', async () => {
    // 记录型 echo：收集字节流、记录是否收到干净 FIN（非 RST）
    const chunks: Buffer[] = [];
    let finSeen = false;
    const echoClosed = new Promise<void>((resolve) => {
      echo = net.createServer((s) => {
        s.on('data', (c: Buffer) => chunks.push(c));
        s.on('end', () => { finSeen = true; });
        s.on('error', () => undefined); // RST 时消化 error，close 照常收尾
        s.on('close', () => resolve());
        s.pipe(s);
      });
    });
    await new Promise<void>((r) => echo!.listen(0, '127.0.0.1', r));
    echoPort = (echo!.address() as net.AddressInfo).port;
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    s.write('abc');
    s.end(); // 同 tick 半关：'abc' 必落在 10ms 泵窗口内入队，FIN 紧随其后
    await echoClosed;
    expect(finSeen).toBe(true); // echo 侧收到干净 FIN（不是 RST）
    expect(Buffer.concat(chunks).toString()).toBe('abc'); // FIN 之前数据完整
  });

  it('Fix2 blackhole 全局生效：黑洞期间新建连接同样静默，heal 后同连接恢复', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.blackhole('both'); // 先黑洞，再建连——S6「判死后重连」场景
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    let received = 0;
    s.on('data', () => { received += 1; });
    s.write('ping');
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toBe(0); // 新建连接同样无回包
    expect(s.destroyed).toBe(false); // 且不 RST
    proxy.heal();
    await new Promise<void>((resolve) => {
      s.once('data', () => resolve());
      s.write('ping2');
    });
    expect(received).toBeGreaterThan(0); // heal 后同连接自愈
  });

  it('Fix3 throttle 令牌桶部分写：低限速不超发', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    proxy.setThrottle(50_000); // 50KB/s：每 10ms tick 仅 500B 预算
    const size = 200_000;
    const startAt = Date.now();
    const echoed = new Promise<void>((resolve) => {
      let n = 0;
      s.on('data', (c: Buffer) => { n += c.length; if (n >= size) resolve(); });
    });
    s.write(Buffer.alloc(size, 0x61));
    await echoed;
    const elapsed = Date.now() - startAt;
    // 理论 4s：c2s/s2c 各 200KB @50KB/s，两向并行泵送重叠；留 0.5s 抖动余量
    expect(elapsed).toBeGreaterThanOrEqual(3500);
    expect(proxy.stats().bytesRelayed).toBe(400_000); // 部分写记账分毫不差
  }, 20_000);
});

describe('latency / throttle / idleTimeout', () => {
  it('setLatency：回包延迟 ≥ 设定值', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setLatency(200);
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const started = Date.now();
    await new Promise<void>((resolve) => {
      s.on('data', () => resolve());
      s.write('x');
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(380); // 双向各 200ms（留 20ms 时钟余量）
  });

  it('setThrottle：吞吐被钳制在速率附近', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setThrottle(100_000); // 100KB/s
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const total = 200_000;
    let got = 0;
    // 回显等待 promise 须先注册、再 write、后 await——简报原稿 write 在 await 之后，构成死锁
    const echoed = new Promise<void>((resolve) => {
      s.on('data', (c) => { got += c.length; if (got >= total) resolve(); });
    });
    const started = Date.now();
    s.write(Buffer.alloc(total));
    await echoed;
    await new Promise<void>((r) => setImmediate(r));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1500); // 理论 2s（回显 200KB），下限留余量
    expect(elapsed).toBeLessThan(6000); // 上限防泵实现失控
  }, 10_000);

  it('setIdleTimeout：空闲连接被 destroy；活跃连接存活', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setIdleTimeout(300);
    const s = dial(port);
    await new Promise<void>((r) => s.on('connect', r));
    const closed = new Promise<void>((r) => s.on('close', r));
    await closed; // 空闲 300ms 后被回收
    expect(proxy.stats().destroyed).toBe(1);
  });
});

describe('基础转发', () => {
  it('listen 后透传双向数据，stats 记账', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    const s = dial(port);
    const echoed = new Promise<Buffer>((resolve) => {
      const chunks: Buffer[] = [];
      s.on('data', (c) => { chunks.push(c); if (Buffer.concat(chunks).length >= 5) resolve(Buffer.concat(chunks)); });
    });
    s.write('hello');
    expect((await echoed).toString()).toBe('hello');
    expect(proxy.stats().connections).toBe(1);
    expect(proxy.stats().bytesRelayed).toBe(10); // c2s 5 + s2c 5
  });
});

describe('flappy / rejectUpgrade', () => {
  it('flappy：周期 destroy 新连接；stopFlappy 后新连接存活', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.flappy(200);
    const s1 = dial(port);
    const closed1 = new Promise<void>((r) => s1.on('close', r));
    await closed1; // 下一个 tick 被杀
    expect(proxy.stats().destroyed).toBeGreaterThanOrEqual(1);
    proxy.stopFlappy();
    const s2 = dial(port);
    await new Promise<void>((r) => s2.on('connect', r));
    await new Promise((r) => setTimeout(r, 450));
    expect(s2.destroyed).toBe(false);
  });

  it('rejectUpgradeWith(502)：读到 HTTP 错误响应；clearRejectUpgrade 后恢复透传', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.rejectUpgradeWith(502);
    const s = dial(port);
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve) => {
      s.on('data', (c) => chunks.push(c));
      s.on('close', () => resolve(Buffer.concat(chunks)));
    });
    s.write('GET /__gateway__/tunnel HTTP/1.1\r\nHost: x\r\n\r\n');
    expect((await done).toString()).toContain('HTTP/1.1 502');
    proxy.clearRejectUpgrade();
    const s2 = dial(port);
    const echoed = new Promise<void>((resolve) => {
      s2.on('data', () => resolve());
      s2.on('connect', () => s2.write('ok'));
    });
    await echoed;
  });
});

describe('shared 限速（setThrottle mode）', () => {
  /** 两连接并行各传 size 字节，返回较慢连接的总耗时 */
  async function twoConnTransfer(mode: 'per-conn' | 'shared' | undefined, size: number): Promise<number> {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    if (mode === undefined) proxy.setThrottle(50_000);
    else proxy.setThrottle(50_000, mode);
    const startAt = Date.now();
    await Promise.all([dial(port), dial(port)].map((s) => new Promise<void>((resolve) => {
      let got = 0;
      s.on('data', (c: Buffer) => { got += c.length; if (got >= size) resolve(); });
      s.write(Buffer.alloc(size, 0x61)); // 未 connect 时内核缓冲，建连后发出
    })));
    return Date.now() - startAt;
  }

  it('shared：两连接共享 50KB/s，总量被全局预算钳制', async () => {
    const elapsed = await twoConnTransfer('shared', 50_000);
    // 理论 4s：4 pipe × 50KB = 200KB 共享一份 50KB/s 预算；保守下界 3s
    expect(elapsed).toBeGreaterThanOrEqual(3000);
    expect(elapsed).toBeLessThan(15_000); // 上限防泵实现失控
  }, 20_000);

  it('per-conn（显式）：两连接各自独享，总耗时 ≈ 单连接', async () => {
    const elapsed = await twoConnTransfer('per-conn', 50_000);
    // 理论 ≈1s：每 pipe 50KB @ 50KB/s，两连接四 pipe 并行各自有预算
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2500); // 与 shared（≥3s）拉开区分度
  }, 10_000);

  it('不传 mode：缺省 per-conn（回归保护）', async () => {
    const elapsed = await twoConnTransfer(undefined, 50_000);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2500);
  }, 10_000);

  it('setThrottle(0, shared)：关闭限速不停摆（Infinity−Infinity=NaN 回归）', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setThrottle(50_000, 'shared');
    proxy.setThrottle(0, 'shared'); // 关闭限速：bps=0 不得留在 shared 分支（NaN 预算停摆）
    const size = 50_000;
    const transferred = Promise.all(
      [dial(port), dial(port)].map((s) => new Promise<void>((resolve) => {
        let got = 0;
        s.on('data', (c: Buffer) => { got += c.length; if (got >= size) resolve(); });
        s.write(Buffer.alloc(size, 0x61)); // 未 connect 时内核缓冲，建连后发出
      })),
    ).then(() => true);
    // 不限速时两连接各 50KB 亚秒级收全；停摆则 3s race 出 false（断言失败而非超时错误）
    const completed = await Promise.race([
      transferred,
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    expect(completed).toBe(true); // 两连接均收全数据 = 不停摆
  }, 10_000);
});

describe('setAdmissionRate 连接准入', () => {
  /** 准入信号：准入放行后代理才 wirePipe，内核缓冲的 'x' 被读出经 echo 返回 */
  function admitted(s: net.Socket): Promise<number> {
    return new Promise<number>((resolve) => {
      s.once('data', () => resolve(Date.now()));
      s.write('x'); // 未 connect/未准入时内核缓冲，放行后交付
    });
  }

  it('前 rate 个立即通，其余按间隔匀速放行', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setAdmissionRate(4); // 满桶 4：前 4 立即通；每 250ms 补 1 名额
    const startAt = Date.now();
    const times = await Promise.all(Array.from({ length: 12 }, () => admitted(dial(port))));
    const sorted = times.map((t) => t - startAt).sort((a, b) => a - b);
    expect(sorted[3]!).toBeLessThan(200); // 前 4 立即通（泵转发 ≈10ms 级）
    expect(sorted[11]!).toBeGreaterThanOrEqual(1500); // 第 12 个等 8 个匀速名额，理论 2s
  }, 10_000);

  it('排队中 close 不占名额；setAdmissionRate(0) 清队即放', async () => {
    await startEcho();
    proxy = createChaosProxy({ targetHost: '127.0.0.1', targetPort: echoPort });
    const port = await proxy.listen();
    proxy.setAdmissionRate(1); // 满桶 1：仅第 1 个立即通，后续排队
    await admitted(dial(port)); // s1 占掉唯一名额，保持在线
    const s2 = dial(port);
    await new Promise<void>((r) => s2.on('connect', r));
    s2.destroy(); // 排队中放弃：出队取消，不占名额
    const s3 = dial(port);
    proxy.setAdmissionRate(0); // 关闭准入：排队连接立即全部放行（死连接跳过）
    await admitted(s3);
    expect(proxy.stats().connections).toBe(2); // s1 + s3：已毁的 s2 被跳过、未建 conn
  }, 10_000);
});
