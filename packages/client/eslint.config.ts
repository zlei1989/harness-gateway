/**
 * ESLint 9 flat config — gateway-client。
 * 使用统一格式规则（根 eslint.shared.ts）+ TypeScript recommended 基线。
 */
import tseslint from "typescript-eslint";
import { sharedFormatRules } from "../../eslint.shared";

export default tseslint.config(
  ...tseslint.configs.recommended,
  // 统一格式规则 — 与 web / agent-sdk 保持一致
  ...sharedFormatRules,
  // 忽略构建产物与配置文件
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
  },
);
