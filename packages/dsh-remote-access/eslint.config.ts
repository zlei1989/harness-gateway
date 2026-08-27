/**
 * ESLint 9 flat config — dsh-remote-access。
 * 使用统一格式规则（根 eslint.shared.ts）+ TypeScript recommended 基线。
 */
import tseslint from "typescript-eslint";
import { sharedFormatRules } from "../../eslint.shared";

export default tseslint.config(
  ...tseslint.configs.recommended,
  ...sharedFormatRules,
  {
    ignores: ["lib/", "dist/", "node_modules/", "*.config.*"],
  },
  {
    // client 半 loader 契约固有模式：运行时无打包器，React 由宿主注入的 require 提供。
    files: ["src/client/react.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // client 半 loader 契约固有模式：globals.d.ts 中宿主注入 require 的声明返回 any 不可避免。
    files: ["src/client/globals.d.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
