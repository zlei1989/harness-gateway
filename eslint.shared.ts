/**
 * 统一 ESLint 格式规则 — 各 package 的 eslint 配置共享此模块。
 *
 * 职责：@stylistic 格式化 + import-x 排序 + unused-imports 清理 + sort-imports 成员排序，
 * 均为可 --fix 自动修复的规则。采用渐进收敛策略：初始 warn，模块修复后升级 error。
 *
 * 注意：插件 import 发生在本文件（仓库根目录），因此这些插件依赖声明在根 package.json
 * 的 devDependencies 中，由根 node_modules 提供解析；各 package 无需重复声明。
 */
import stylistic from "@stylistic/eslint-plugin";
import importX from "eslint-plugin-import-x";
import unusedImports from "eslint-plugin-unused-imports";
import type { Linter } from "eslint";

export const sharedFormatRules: Linter.Config[] = [
  // @stylistic 格式化规则
  {
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/indent": ["warn", 2],
      "@stylistic/quotes": ["warn", "single", { avoidEscape: true }],
      "@stylistic/semi": ["warn", "always"],
      "@stylistic/comma-dangle": ["warn", "always-multiline"],
      "@stylistic/object-curly-spacing": ["warn", "always"],
      "@stylistic/jsx-quotes": ["warn", "prefer-double"],
      "@stylistic/max-len": ["warn", { code: 100, ignoreStrings: true, ignoreTemplateLiterals: true }],
      "@stylistic/eol-last": ["warn", "always"],
      "@stylistic/jsx-sort-props": ["warn", {
        callbacksLast: true,
        shorthandFirst: true,
        ignoreCase: true,
      }],
    },
  },
  // import-x 排序规则 — --fix 自动调整顺序
  {
    plugins: { "import-x": importX },
    rules: {
      "import-x/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "type"],
          pathGroups: [{ pattern: "@/**", group: "internal" }],
          alphabetize: { order: "asc" },
          "newlines-between": "always",
        },
      ],
      "import-x/no-cycle": "warn",
    },
  },
  // unused-imports — --fix 自动删除未使用的导入和变量
  {
    plugins: { "unused-imports": unusedImports },
    rules: {
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  // 导入成员排序 — --fix 自动按名称排序 import { ... } 内的命名导出
  {
    rules: {
      "sort-imports": [
        "warn",
        {
          ignoreCase: true,
          ignoreDeclarationSort: true, // 声明排序由 import-x/order 处理
          ignoreMemberSort: false,
          memberSyntaxSortOrder: ["none", "all", "multiple", "single"],
        },
      ],
      // 未使用变量交由 unused-imports 插件处理（可 --fix 自动删除）
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
