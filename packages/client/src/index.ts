/**
 * gateway-client 包入口。
 * 用法见 spec §3：
 * new Client({ upstreamUrl, gatewayUrl, hostname, token?, defaultPath?, authorization? })
 */

export { Client, type ClientOptions } from './client';
export type { AuthRequest, AuthResponse, AuthorizationHook, AuthDecision } from './authorize';
export type { TunnelSender } from './connection';
export { ProtocolError } from './protocol';
export { createConsoleLogger, createDefaultLogger, type Logger, type LogLevel } from './logger';
