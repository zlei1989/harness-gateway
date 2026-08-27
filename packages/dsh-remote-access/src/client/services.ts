/**
 * Client 侧服务契约——本插件从 harness web 半边消费的精确 API 表面（type-only）。
 * 槽位注册通过 ctx.slots 到达。
 */

import type { Context } from '@deepseek-ai/cordis';

/** 一条 settings.section 槽位注册描述符。 */
export interface SlotRegistration {
  name: string;
  id: string;
  order: number;
  label?: string | (() => string);
}

/** harness 槽位服务（ctx.slots），此处消费的接口。 */
export interface SlotsService {
  inject(name: string, callback: () => unknown): () => void;
  register(
    registration: SlotRegistration,
    component: (props: Record<string, unknown>) => unknown,
  ): () => void;
}

/** settings.section 槽位组件的宿主 props（shell 拥有面板开关状态）。 */
export interface SettingsSectionProps {
  close?: () => void;
}

/** Client 上下文：cordis 加上本插件注入的服务。 */
export type ClientCtx = Context & {
  slots: SlotsService;
};
