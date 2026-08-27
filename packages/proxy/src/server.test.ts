import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { ProxyServer } from './server';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function closeServer(server: net.Server | http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** 本地 echo target：原样回写收到的字节 */
async function startEchoTarget(): Promise<{ port: number }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { port: typeof address === 'object' && address !== null ? address.port : 0 };
}

async function startProxy(options: {
  targetPort: number;
  maxConnectionsPerSecond: number;
  maxBytesPerSecond: number;
}): Promise<number> {
  const proxy = new ProxyServer({
    listenPort: 0,
    targetHost: '127.0.0.1',
    targetPort: options.targetPort,
    maxConnectionsPerSecond: options.maxConnectionsPerSecond,
    maxBytesPerSecond: options.maxBytesPerSecond,
  });
  cleanups.push(() => proxy.close());
  return proxy.listen();
}

describe('ProxyServer', () => {
  it('HTTP 请求经代理往返成功', async () => {
    const target = http.createServer((req, res) => res.end(`ok:${req.url}`));
    cleanups.push(() => closeServer(target));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({
      targetPort,
      maxConnectionsPerSecond: 1000,
      maxBytesPerSecond: 10 * 1024 * 1024,
    });
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${proxyPort}/hello?x=1`, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }).on('error', reject);
    });
    expect(body).toBe('ok:/hello?x=1');
  });

  it('WS Upgrade 握手与后续帧透传', async () => {
    const sockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        socket.on('data', (frame) => socket.write(frame)); // echo 后续帧
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(target);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({
      targetPort,
      maxConnectionsPerSecond: 1000,
      maxBytesPerSecond: 10 * 1024 * 1024,
    });

    const client = net.connect(proxyPort, '127.0.0.1');
    cleanups.push(() => {
      client.destroy();
    });
    client.write(
      'GET /chat HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    );
    let buffer = Buffer.alloc(0);
    await new Promise<void>((resolve, reject) => {
      client.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.includes('\r\n\r\n')) resolve();
      });
      client.on('error', reject);
    });
    expect(buffer.toString('utf8').startsWith('HTTP/1.1 101')).toBe(true);
    // 握手后帧透传（echo）
    const echoed = new Promise<Buffer>((resolve) => {
      client.once('data', resolve);
    });
    client.write('ping-frame');
    expect((await echoed).toString('utf8')).toBe('ping-frame');
  });

  it('连接准入节奏：容量内立即放行，超出按节拍排队', async () => {
    const { port: targetPort } = await startEchoTarget();
    const proxyPort = await startProxy({
      targetPort,
      maxConnectionsPerSecond: 4,
      maxBytesPerSecond: 10 * 1024 * 1024,
    });
    const startedAt = Date.now();
    const admittedAt: number[] = [];
    await Promise.all(Array.from({ length: 12 }, () =>
      new Promise<void>((resolve, reject) => {
        const client = net.connect(proxyPort, '127.0.0.1', () => client.write('x'));
        cleanups.push(() => {
          client.destroy();
        });
        client.once('data', () => {
          admittedAt.push(Date.now() - startedAt);
          resolve();
        });
        client.on('error', reject);
      })));
    admittedAt.sort((a, b) => a - b);
    // 前 4 个立即准入（本地 echo，远小于一拍 250ms）
    expect(admittedAt[3]).toBeLessThan(500);
    // 第 12 个需等 8 拍 × 250ms = 2000ms，断言保守下界
    expect(admittedAt[11]).toBeGreaterThanOrEqual(1500);
  }, 15000);

  it('带宽节流：共享桶下双向字节合计受限', async () => {
    // target：收满 600 字节后回 'done'（4 字节）
    const sockets = new Set<net.Socket>();
    const target = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let received = 0;
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received >= 600) socket.write('done');
      });
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await closeServer(target);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({
      targetPort,
      maxConnectionsPerSecond: 100,
      maxBytesPerSecond: 200,
    });

    const startedAt = Date.now();
    const client = net.connect(proxyPort, '127.0.0.1');
    cleanups.push(() => {
      client.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      client.once('data', () => resolve());
      client.on('error', reject);
      client.on('connect', () => client.write(Buffer.alloc(600, 1)));
    });
    // 双向合计 604B，容量 200 先行放走，余 404B 按 200B/s 补充 → 理论约 2s
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1500); // 保守下界防 CI 抖动
  }, 15000);

  it('target 优雅关闭时节流队列尾包不截断（FIN 后剩余字节全部交付）', async () => {
    // target：连接即写 4000 字节并立即 FIN；代理带宽 1000B/s → 尾包在节流队列滞留数秒，
    // 旧实现 target close 即 destroy 客户端会丢弃尾包（线上 168 字节截断复现）
    const target = net.createServer((socket) => {
      socket.end(Buffer.alloc(4000, 7));
    });
    cleanups.push(() => closeServer(target));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    const address = target.address();
    const targetPort = typeof address === 'object' && address !== null ? address.port : 0;
    const proxyPort = await startProxy({
      targetPort,
      maxConnectionsPerSecond: 100,
      maxBytesPerSecond: 1000,
    });

    const client = net.connect(proxyPort, '127.0.0.1');
    cleanups.push(() => {
      client.destroy();
    });
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      client.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      client.on('end', () => resolve()); // 优雅 FIN：全部交付后才结束
      client.on('close', () => { if (bytes < 4000) reject(new Error(`响应被截断: ${bytes}/4000 字节`)); });
      client.on('error', reject);
    });
    expect(bytes).toBe(4000);
  }, 15000);

  it('target 拒绝连接时销毁客户端 socket', async () => {
    // 起一个立即关闭的 server 以拿到一个确定未监听的端口
    const gone = net.createServer();
    await new Promise<void>((resolve) => gone.listen(0, '127.0.0.1', resolve));
    const address = gone.address();
    const gonePort = typeof address === 'object' && address !== null ? address.port : 0;
    await closeServer(gone);

    const proxyPort = await startProxy({
      targetPort: gonePort,
      maxConnectionsPerSecond: 100,
      maxBytesPerSecond: 1024 * 1024,
    });
    const client = net.connect(proxyPort, '127.0.0.1');
    await new Promise<void>((resolve) => {
      client.on('close', () => resolve());
      client.on('error', () => {}); // 消化 RST 窗口内的 ECONNRESET
    });
    // close 触发即证明 target 拒连后客户端 socket 被销毁（而非悬挂）
  });
});
