/**
 * gateway-server 包入口。
 * 用法见 spec §3：new GatewayServer({ port, tunnelPath?, selectPath? }) → listen() → close()
 */

export { GatewayServer, type GatewayServerOptions } from './server';
export { ProtocolError } from './protocol';
export { createConsoleLogger, createDefaultLogger, type Logger, type LogLevel } from './logger';
