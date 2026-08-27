# dsh-remote-access 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 harness-gateway 仓库新增 `packages/dsh-remote-access` DSH bundle 插件：设置页「远程访问」选项页配置主机名称/令牌密钥/网关地址，手动启用后在 DSH host 进程内启动 gateway-client 隧道客户端，连接成功展示选择页深链二维码。

**Architecture:** DSH bundle 插件形态（对齐 dsh-webpage-element-picker）：host 半为 Cordis 插件（配置读写 ~/.dsh/.remote-access.yaml + ConnectionManager 封装 gateway-client 生命周期 + /dsh-remote-access/invoke HTTP 路由）；client 半注册 `settings.section` 槽位渲染设置面板（React createElement 风格，qrcode-generator 前端动态生成二维码 SVG）。tsup 双入口构建到 lib/。

**Tech Stack:** TypeScript (strict + noUncheckedIndexedAccess)、tsup、vitest、@deepseek-ai/cordis、gateway-client (workspace:*)、ws、yaml、qrcode-generator、react（client bundle external）。

**Spec:** `docs/superpowers/specs/2026-08-28-dsh-remote-access-design.md`

## Global Constraints

- 仓库仅允许 pnpm 安装依赖（根 package.json preinstall 强制）；Node.js 20+。
- TS 配置对齐 packages/client：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`noEmit`、`moduleResolution: bundler`。
- ESLint：各包 `eslint.config.ts` 使用 `typescript-eslint` recommended + 根 `eslint.shared.ts` 的 `sharedFormatRules`。
- 代码注释/日志文案用中文，风格对齐仓库现有包与参考插件（日志前缀 `[dsh-remote-access]`）。
- **不得修改 `packages/client` 与 `packages/server` 的任何文件**；`Client` API（`connect()`/`close()`/`tunnelId`/`connected`/`disconnected`/`error` 事件）已具备全部所需能力。
- EventEmitter 语义：gateway-client 的 `Client` 实例必须挂 `error` 监听，否则未捕获异常。
- host 半不得 `export default`（Loader 的 unwrapExports 会坍缩模块丢弃 inject）；用 `export const name` + `export const inject` + `export function apply`。
- 配置存 `~/.dsh/.remote-access.yaml`，**不持久化 enabled 状态**；token 明文存储。
- 协议推断缺省 http/ws：裸域名 → `ws://…/__gateway__/tunnel` + `http://…/__gateway__/select`；https/wss 输入 → wss/https。
- 测试用 vitest（`environment: 'node'`，include `src/**/*.test.ts`）；每个测试文件自清理临时目录与服务器。

---

### Task 1: 包脚手架 + shared 模块（random-token / types）

**Files:**
- Create: `packages/dsh-remote-access/package.json`
- Create: `packages/dsh-remote-access/tsconfig.json`
- Create: `packages/dsh-remote-access/eslint.config.ts`
- Create: `packages/dsh-remote-access/vitest.config.ts`
- Create: `packages/dsh-remote-access/tsup.config.ts`
- Create: `packages/dsh-remote-access/cordis.patch.yml`
- Create: `packages/dsh-remote-access/.gitignore`
- Create: `packages/dsh-remote-access/src/shared/random-token.ts`
- Create: `packages/dsh-remote-access/src/shared/types.ts`
- Test: `packages/dsh-remote-access/src/shared/random-token.test.ts`

**Interfaces:**
- Produces:
  - `randomToken(length?: number, rand?: () => number): string` — 8 位 `[0-9a-zA-Z]` 随机串（host config 缺省生成与 client「生成」按钮共用）。
  - `RemoteAccessConfigDto { hostname: string; token: string; gateway: string }`
  - `ConnectionStatusDto { state: 'off'|'connecting'|'connected'|'error'; tunnelId?: string; error?: string; deepLink?: string }`
  - `RemoteStatusDto { ok: true; config: RemoteAccessConfigDto; envHostname: string; connection: ConnectionStatusDto; warning?: string }`
  - `RemoteInvokeResult { ok: boolean; error?: string; connection?: ConnectionStatusDto }`

- [ ] **Step 1: 写包脚手架文件**

`packages/dsh-remote-access/package.json`：

```json
{
  "name": "dsh-remote-access",
  "version": "0.1.0",
  "private": true,
  "description": "DSH 插件：远程访问——经 harness-gateway 网关把当前 DSH web 暴露到公网（设置页配置 + 手动启用 + 二维码深链）",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md"
  ],
  "scripts": {
    "build": "tsup",
    "watch": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "format": "eslint . --fix",
    "test": "vitest run --passWithNoTests"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  },
  "dependencies": {
    "gateway-client": "workspace:*",
    "qrcode-generator": "^1.4.4",
    "ws": "^8.18.0",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@types/node": "^20.19.43",
    "@types/qrcode-generator": "^1.4.8",
    "@types/react": "^18.3.31",
    "@types/ws": "^8.18.1",
    "eslint": "^9",
    "react": "^18.3.1",
    "tsup": "^8.5.1",
    "typescript": "^5",
    "typescript-eslint": "^8.61.0",
    "vitest": "^4.1.8"
  }
}
```

`packages/dsh-remote-access/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts"],
  "exclude": ["node_modules"]
}
```

`packages/dsh-remote-access/eslint.config.ts`：

```ts
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
);
```

`packages/dsh-remote-access/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

`packages/dsh-remote-access/tsup.config.ts`（对齐参考插件：host ESM；client CJS + loader 包裹，react external）：

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

// 从 cwd 读取 manifest（tsup 会把本配置重打包为临时 .mjs，import.meta.url 指向临时文件）
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string };

// Client bundle 包裹：dsh.client 包的 ./client 导出必须使用的闭包工厂格式。
// 浏览器 loader 从模块表回答 react 的 require，并读取 module.exports 作为插件表面。
const CLIENT_BANNER = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
`;
const CLIENT_FOOTER = `
    return module.exports;
  },
});
`;

export default defineConfig([
  {
    // host 半：gateway-client（workspace TS 源码）与 yaml 一并打包；ws 保持 external
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: ['ws'],
    outExtension: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    dts: false,
  },
  {
    // client 半：qrcode-generator 等全部内联；react 由浏览器模块表运行时提供
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    external: ['react'],
    outExtension: () => ({ js: '.js' }),
    clean: false,
    sourcemap: false,
    dts: false,
    banner: { js: CLIENT_BANNER },
    footer: { js: CLIENT_FOOTER },
    // 源码中的 module.exports 是 loader 契约（包裹提供局部 var module）；静默该警告
    esbuildOptions: (options) => {
      options.logOverride = { 'commonjs-variable-in-esm': 'silent' };
    },
  },
]);
```

`packages/dsh-remote-access/cordis.patch.yml`：

```yaml
# dsh-remote-access bundle 补丁层。
# 一行同时服务于包的两半：Loader 加载包 main（lib/index.js）为 host 插件；
# client-modules 扫描到同一行后按 dsh.client 声明把 lib/client.js 服务到
# /plugins/<id>/client.js。行名必须与包名完全一致。
- insert:
    - id: remote-access
      name: dsh-remote-access
```

`packages/dsh-remote-access/.gitignore`：

```
lib/
node_modules/
```

- [ ] **Step 2: 写 shared/types.ts**

`packages/dsh-remote-access/src/shared/types.ts`：

```ts
/**
 * host ↔ client 经 /dsh-remote-access/invoke 交换的形状（type-only）。
 */

/** 远程访问配置（~/.dsh/.remote-access.yaml 的字段形状）。 */
export interface RemoteAccessConfigDto {
  /** 空 = 使用环境主机名 */
  hostname: string;
  /** 8 位 [0-9a-zA-Z] 接入令牌 */
  token: string;
  /** 网关地址（裸域名缺省 http/ws；支持 http/https/ws/wss 前缀） */
  gateway: string;
}

/** 隧道连接状态。 */
export interface ConnectionStatusDto {
  state: 'off' | 'connecting' | 'connected' | 'error';
  /** hello.ack 后可用 */
  tunnelId?: string;
  /** state === 'error' 时的摘要 */
  error?: string;
  /** state === 'connected' 时的选择页深链（二维码内容） */
  deepLink?: string;
}

/** remote-status 的返回。 */
export interface RemoteStatusDto {
  ok: true;
  config: RemoteAccessConfigDto;
  /** 环境主机名（主机名称为空时的实际生效值，UI 作 placeholder） */
  envHostname: string;
  connection: ConnectionStatusDto;
  /** 配置文件读取失败等降级提示 */
  warning?: string;
}

/** remote-save-config / remote-enable / remote-disable 的返回。 */
export interface RemoteInvokeResult {
  ok: boolean;
  error?: string;
  connection?: ConnectionStatusDto;
}
```

- [ ] **Step 3: 写 random-token 的失败测试**

`packages/dsh-remote-access/src/shared/random-token.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { randomToken } from './random-token';

describe('randomToken', () => {
  it('默认生成 8 位，字符集仅 0-9a-zA-Z', () => {
    for (let i = 0; i < 200; i += 1) {
      const token = randomToken();
      expect(token).toMatch(/^[0-9a-zA-Z]{8}$/);
    }
  });

  it('支持自定义长度', () => {
    expect(randomToken(16)).toHaveLength(16);
  });

  it('注入确定性随机源时输出可复现', () => {
    // rand 恒返回 0 → 恒取字符集首字符 '0'
    expect(randomToken(8, () => 0)).toBe('00000000');
    // rand 逼近 1 → 取字符集末字符 'Z'
    expect(randomToken(4, () => 0.999999)).toBe('ZZZZ');
  });
});
```

- [ ] **Step 4: 安装依赖并运行测试确认失败**

Run: `pnpm install`（仓库根，workspace 自动链接 `gateway-client`），然后 `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './random-token'`

- [ ] **Step 5: 实现 random-token.ts**

`packages/dsh-remote-access/src/shared/random-token.ts`：

```ts
/** 令牌字符集：0-9a-zA-Z（用户需求指定）。 */
const CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 生成接入令牌（默认 8 位）。
 * rand 可注入便于测试确定性断言；生产用 Math.random（本地接入令牌，非密码学场景）。
 */
export function randomToken(length = 8, rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const idx = Math.min(Math.floor(rand() * CHARSET.length), CHARSET.length - 1);
    out += CHARSET.charAt(idx);
  }
  return out;
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS（3 个用例）

- [ ] **Step 7: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): 包脚手架 + shared random-token/types"
```

---

### Task 2: 网关地址协议推断（host/gateway-url.ts）

**Files:**
- Create: `packages/dsh-remote-access/src/host/gateway-url.ts`
- Test: `packages/dsh-remote-access/src/host/gateway-url.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `GatewayEndpoints { gatewayUrl: string; selectUrl: string }`
  - `deriveGatewayEndpoints(rawInput: string): GatewayEndpoints` — 非法输入抛 `Error`（message 面向用户）。
  - `buildSelectDeepLink(selectUrl: string, tunnelId: string): string`

- [ ] **Step 1: 写失败测试**

`packages/dsh-remote-access/src/host/gateway-url.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { buildSelectDeepLink, deriveGatewayEndpoints } from './gateway-url';

describe('deriveGatewayEndpoints', () => {
  it('裸域名 → ws 隧道 + http 选择页', () => {
    expect(deriveGatewayEndpoints('harness-gateway.7qbjs.com')).toEqual({
      gatewayUrl: 'ws://harness-gateway.7qbjs.com/__gateway__/tunnel',
      selectUrl: 'http://harness-gateway.7qbjs.com/__gateway__/select',
    });
  });

  it('带端口裸地址 → ws/http', () => {
    expect(deriveGatewayEndpoints('192.168.1.10:9000')).toEqual({
      gatewayUrl: 'ws://192.168.1.10:9000/__gateway__/tunnel',
      selectUrl: 'http://192.168.1.10:9000/__gateway__/select',
    });
  });

  it('http:// 与 ws:// 输入 → ws/http', () => {
    for (const input of ['http://gw.example.com', 'ws://gw.example.com']) {
      expect(deriveGatewayEndpoints(input)).toEqual({
        gatewayUrl: 'ws://gw.example.com/__gateway__/tunnel',
        selectUrl: 'http://gw.example.com/__gateway__/select',
      });
    }
  });

  it('https:// 与 wss:// 输入 → wss/https', () => {
    for (const input of ['https://gw.example.com', 'wss://gw.example.com']) {
      expect(deriveGatewayEndpoints(input)).toEqual({
        gatewayUrl: 'wss://gw.example.com/__gateway__/tunnel',
        selectUrl: 'https://gw.example.com/__gateway__/select',
      });
    }
  });

  it('忽略误填的路径与查询串（只取 origin）', () => {
    expect(deriveGatewayEndpoints('https://gw.example.com/some/path?x=1')).toEqual({
      gatewayUrl: 'wss://gw.example.com/__gateway__/tunnel',
      selectUrl: 'https://gw.example.com/__gateway__/select',
    });
  });

  it('首尾空白自动裁剪', () => {
    expect(deriveGatewayEndpoints('  harness-gateway.7qbjs.com  ').gatewayUrl)
      .toBe('ws://harness-gateway.7qbjs.com/__gateway__/tunnel');
  });

  it('空输入抛错', () => {
    expect(() => deriveGatewayEndpoints('')).toThrow(/不能为空/);
    expect(() => deriveGatewayEndpoints('   ')).toThrow(/不能为空/);
  });

  it('不支持的协议抛错', () => {
    expect(() => deriveGatewayEndpoints('ftp://gw.example.com')).toThrow(/协议不支持/);
  });
});

describe('buildSelectDeepLink', () => {
  it('拼 tunnelId 深链', () => {
    expect(buildSelectDeepLink('http://gw.example.com/__gateway__/select', 'tid-1'))
      .toBe('http://gw.example.com/__gateway__/select?tunnelId=tid-1');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './gateway-url'`

- [ ] **Step 3: 实现 gateway-url.ts**

`packages/dsh-remote-access/src/host/gateway-url.ts`：

```ts
/**
 * 网关地址 → 隧道端点与选择页地址的协议推断（纯函数，表驱动单测）。
 * 缺省 http/ws：用户只填域名时按非公网 TLS 部署处理；
 * 填 https:// 或 wss:// 时升级为 wss/https。
 */

export interface GatewayEndpoints {
  /** 隧道 WS 端点（ws/wss） */
  gatewayUrl: string;
  /** 选择页地址（http/https，不含 query；深链由 buildSelectDeepLink 拼） */
  selectUrl: string;
}

/** 推断隧道与选择页地址；无法解析/协议不支持时抛 Error（message 面向用户，直接给 UI 展示）。 */
export function deriveGatewayEndpoints(rawInput: string): GatewayEndpoints {
  const input = rawInput.trim();
  if (!input) throw new Error('网关地址不能为空');
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input) ? input : `http://${input}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`网关地址无法解析: ${input}`);
  }
  if (!url.hostname) throw new Error(`网关地址无法解析: ${input}`);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') {
    throw new Error(`网关地址协议不支持: ${url.protocol}（仅支持 http/https/ws/wss）`);
  }
  // 只取 origin（hostname[:port]），忽略误填的路径与查询串
  const origin = url.host;
  return {
    gatewayUrl: `${secure ? 'wss' : 'ws'}://${origin}/__gateway__/tunnel`,
    selectUrl: `${secure ? 'https' : 'http'}://${origin}/__gateway__/select`,
  };
}

/** 拼选择页深链（二维码内容与「立即查看」跳转地址）。 */
export function buildSelectDeepLink(selectUrl: string, tunnelId: string): string {
  return `${selectUrl}?tunnelId=${encodeURIComponent(tunnelId)}`;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS（含 Task 1 用例共 11 个）

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): 网关地址协议推断（缺省 http/ws）"
```

---

### Task 3: 配置读写（host/config.ts）

**Files:**
- Create: `packages/dsh-remote-access/src/host/config.ts`
- Test: `packages/dsh-remote-access/src/host/config.test.ts`

**Interfaces:**
- Consumes: `randomToken`（Task 1）、`yaml` 包。
- Produces:
  - `RemoteAccessConfig { hostname: string; token: string; gateway: string }`
  - `DEFAULT_GATEWAY = 'harness-gateway.7qbjs.com'`
  - `configPath(homeDir: string): string` — `<homeDir>/.dsh/.remote-access.yaml`
  - `defaultConfig(): RemoteAccessConfig`
  - `loadConfig(homeDir: string): RemoteAccessConfig` — 缺文件/缺字段补全并落盘；yaml 损坏抛错（调用方降级）。
  - `saveConfig(homeDir: string, cfg: RemoteAccessConfig): void` — 校验 + 临时文件 rename 原子写；校验失败抛 `Error`。

- [ ] **Step 1: 写失败测试**

`packages/dsh-remote-access/src/host/config.test.ts`：

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_GATEWAY, configPath, loadConfig, saveConfig, type RemoteAccessConfig,
} from './config';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ra-config-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('文件不存在：生成默认配置并立即落盘（token 8 位字符集）', () => {
    const cfg = loadConfig(home);
    expect(cfg.hostname).toBe('');
    expect(cfg.token).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(cfg.gateway).toBe(DEFAULT_GATEWAY);
    // 已落盘：再次读取得到同一 token（生成一次后稳定）
    expect(loadConfig(home).token).toBe(cfg.token);
  });

  it('字段缺失：以默认值补全并落盘', () => {
    const path = configPath(home);
    saveConfig(home, { hostname: 'pc-a', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    // 手工删掉 gateway 字段模拟旧版配置
    writeFileSync(path, 'hostname: pc-a\ntoken: tok12345\n', 'utf8');
    const cfg = loadConfig(home);
    expect(cfg).toEqual({ hostname: 'pc-a', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    expect(readFileSync(path, 'utf8')).toContain('gateway:');
  });

  it('yaml 损坏：抛错由调用方降级', () => {
    const path = configPath(home);
    saveConfig(home, { hostname: '', token: 'tok12345', gateway: DEFAULT_GATEWAY });
    writeFileSync(path, ': : : not yaml [', 'utf8');
    expect(() => loadConfig(home)).toThrow();
  });
});

describe('saveConfig', () => {
  it('round-trip：写入后可原样读回', () => {
    const cfg: RemoteAccessConfig = { hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com' };
    saveConfig(home, cfg);
    expect(loadConfig(home)).toEqual(cfg);
  });

  it('token 含非法字符或为空：抛错且不写文件', () => {
    expect(() => saveConfig(home, { hostname: '', token: 'bad token!', gateway: DEFAULT_GATEWAY })).toThrow(/令牌密钥/);
    expect(() => saveConfig(home, { hostname: '', token: '', gateway: DEFAULT_GATEWAY })).toThrow(/令牌密钥/);
    expect(() => loadConfig(home).token).toMatch(/^[0-9a-zA-Z]{8}$/); // 未被污染，走缺省生成
  });

  it('网关地址为空：抛错', () => {
    expect(() => saveConfig(home, { hostname: '', token: 'tok12345', gateway: '  ' })).toThrow(/网关地址/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './config'`

- [ ] **Step 3: 实现 config.ts**

`packages/dsh-remote-access/src/host/config.ts`：

```ts
/**
 * 远程访问配置读写 — ~/.dsh/.remote-access.yaml。
 * 缺文件/缺字段以默认值补全并立即落盘（保证 token 生成一次后稳定）；
 * 写文件用「临时文件 + rename」避免半截写入。不持久化 enabled 状态。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse, stringify } from 'yaml';

import { randomToken } from '../shared/random-token';

export interface RemoteAccessConfig {
  /** 空 = 使用环境主机名（os.hostname()） */
  hostname: string;
  /** 8 位 [0-9a-zA-Z] 接入令牌 */
  token: string;
  /** 网关地址 */
  gateway: string;
}

export const DEFAULT_GATEWAY = 'harness-gateway.7qbjs.com';

export function configPath(homeDir: string): string {
  return join(homeDir, '.dsh', '.remote-access.yaml');
}

/** 默认配置：主机名空（用环境主机名）、token 随机生成、网关为默认地址。 */
export function defaultConfig(): RemoteAccessConfig {
  return { hostname: '', token: randomToken(8), gateway: DEFAULT_GATEWAY };
}

/**
 * 读取配置；文件不存在/字段缺失以默认值补全并落盘。
 * yaml 损坏抛错——调用方（handlers）降级为内存默认配置并附 warning。
 */
export function loadConfig(homeDir: string): RemoteAccessConfig {
  const path = configPath(homeDir);
  if (!existsSync(path)) {
    const cfg = defaultConfig();
    saveConfig(homeDir, cfg);
    return cfg;
  }
  const doc: unknown = parse(readFileSync(path, 'utf8'));
  const raw = (doc !== null && typeof doc === 'object' ? doc : {}) as Record<string, unknown>;
  const cfg: RemoteAccessConfig = {
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    token: typeof raw.token === 'string' && /^[0-9a-zA-Z]+$/.test(raw.token) ? raw.token : randomToken(8),
    gateway: typeof raw.gateway === 'string' && raw.gateway.trim() ? raw.gateway : DEFAULT_GATEWAY,
  };
  // 补全了缺省字段则落盘（token 等默认值生成一次后稳定）
  if (cfg.hostname !== raw.hostname || cfg.token !== raw.token || cfg.gateway !== raw.gateway) {
    saveConfig(homeDir, cfg);
  }
  return cfg;
}

/** 校验 + 原子写（临时文件 + rename）。校验失败抛 Error（message 面向用户）。 */
export function saveConfig(homeDir: string, cfg: RemoteAccessConfig): void {
  if (!/^[0-9a-zA-Z]+$/.test(cfg.token)) throw new Error('令牌密钥仅允许 0-9 a-z A-Z 且不能为空');
  if (!cfg.gateway.trim()) throw new Error('网关地址不能为空');
  const path = configPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, stringify(cfg), 'utf8');
  renameSync(tmp, path);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): ~/.dsh/.remote-access.yaml 配置读写"
```

---

### Task 4: 隧道连接管理（host/connection-manager.ts）

**Files:**
- Create: `packages/dsh-remote-access/src/host/connection-manager.ts`
- Test: `packages/dsh-remote-access/src/host/connection-manager.test.ts`

**Interfaces:**
- Consumes: `Client`（gateway-client）、`RemoteAccessConfig`（Task 3）、`deriveGatewayEndpoints`/`buildSelectDeepLink`（Task 2）。
- Produces:
  - `ConnectionManager` 类：`status: ConnectionStatusDto`（getter）、`enable(cfg: RemoteAccessConfig): Promise<ConnectionStatusDto>`、`disable(): Promise<ConnectionStatusDto>`。
  - 构造：`new ConnectionManager({ upstreamUrl: string })`。

- [ ] **Step 1: 写失败测试（含最小 mock 网关）**

`packages/dsh-remote-access/src/host/connection-manager.test.ts`：

```ts
/**
 * ConnectionManager 测试 — 用最小 mock 网关（只应答 hello/ping 控制帧）
 * 驱动真实 gateway-client 完成握手，验证状态机与 tunnelId/深链。
 */

import { WebSocketServer } from 'ws';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionManager } from './connection-manager';

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

const cfg = (gatewayAddr: string) => ({ hostname: '', token: 'tok12345', gateway: gatewayAddr });

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

  it('非法网关地址：enable 抛错，状态保持 off', async () => {
    await expect(manager.enable(cfg(''))).rejects.toThrow(/不能为空/);
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './connection-manager'`

- [ ] **Step 3: 实现 connection-manager.ts**

`packages/dsh-remote-access/src/host/connection-manager.ts`：

```ts
/**
 * 隧道连接管理 — 封装 gateway-client 的 Client 生命周期与状态机。
 * 状态：off → connecting → connected / error；disconnected 后回到
 * connecting（Connection 内建断线重连 + tunnelId 回带复用）。
 * enable 幂等：先关闭旧实例再新建（配置变更后重新启用）。
 */

import os from 'node:os';

import { Client } from 'gateway-client';

import type { ConnectionStatusDto } from '../shared/types';
import type { RemoteAccessConfig } from './config';
import { buildSelectDeepLink, deriveGatewayEndpoints, type GatewayEndpoints } from './gateway-url';

export interface ConnectionManagerDeps {
  /** 当前 DSH web 服务地址（http://127.0.0.1:<webServer.port>） */
  upstreamUrl: string;
}

const LOG_PREFIX = '[dsh-remote-access]';

export class ConnectionManager {
  private client: Client | null = null;
  private endpoints: GatewayEndpoints | null = null;
  private info: ConnectionStatusDto = { state: 'off' };

  constructor(private readonly deps: ConnectionManagerDeps) {}

  get status(): ConnectionStatusDto {
    return this.info;
  }

  /** 启用连接；非法配置/首连失败时状态落 error（非法输入的 Error 继续上抛给 UI）。 */
  async enable(cfg: RemoteAccessConfig): Promise<ConnectionStatusDto> {
    await this.disable();
    // 非法网关地址抛错（message 面向用户），状态保持 off
    const endpoints = deriveGatewayEndpoints(cfg.gateway);
    const hostname = cfg.hostname.trim() || os.hostname();
    const client = new Client({
      upstreamUrl: this.deps.upstreamUrl,
      gatewayUrl: endpoints.gatewayUrl,
      hostname,
      token: cfg.token,
      logger: {
        debug: () => undefined,
        info: (m) => console.info(`${LOG_PREFIX} [INFO] ${m}`),
        warn: (m) => console.warn(`${LOG_PREFIX} [WARN] ${m}`),
        error: (m) => console.error(`${LOG_PREFIX} [ERROR] ${m}`),
      },
    });
    this.client = client;
    this.endpoints = endpoints;
    this.info = { state: 'connecting' };
    console.info(`${LOG_PREFIX} [INFO] 开始连接网关: ${endpoints.gatewayUrl}（hostname=${hostname}）`);

    // EventEmitter 语义：error 事件必须挂监听
    client.on('error', (err: Error) => {
      if (this.client === client) this.info = { state: 'error', error: err.message };
    });
    client.on('connected', () => {
      if (this.client !== client) return; // 旧实例迟到事件
      const tunnelId = client.tunnelId;
      this.info = {
        state: 'connected',
        ...(tunnelId ? { tunnelId } : {}),
        ...(tunnelId && this.endpoints ? { deepLink: buildSelectDeepLink(this.endpoints.selectUrl, tunnelId) } : {}),
      };
      console.info(`${LOG_PREFIX} [INFO] 隧道已连接: tunnelId=${tunnelId ?? '-'}`);
    });
    client.on('disconnected', () => {
      // 断线重连由 Connection 内建；曾连上后的断开回到 connecting
      if (this.client === client && this.info.state === 'connected') this.info = { state: 'connecting' };
    });

    try {
      await client.connect();
    } catch (err) {
      this.info = { state: 'error', error: err instanceof Error ? err.message : String(err) };
      await client.close().catch(() => undefined);
      if (this.client === client) this.client = null;
    }
    return this.info;
  }

  /** 关闭连接（无连接时为 no-op）。 */
  async disable(): Promise<ConnectionStatusDto> {
    const client = this.client;
    this.client = null;
    this.info = { state: 'off' };
    if (client) {
      await client.close().catch(() => undefined);
      console.info(`${LOG_PREFIX} [INFO] 隧道已关闭`);
    }
    return this.info;
  }
}
```

> 类型对齐：gateway-client 的 `Logger` 接口为 `{ debug/info/warn/error(message: string, context?): void }`（见 `packages/client/src/logger.ts`）。若实现时 tsc 报 logger 形状不匹配，改为 `import { createConsoleLogger } from 'gateway-client'` 直接复用其 console logger 工厂。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): 隧道连接管理（状态机 + gateway-client 生命周期）"
```

---

### Task 5: invoke 处理器 + host 插件入口（host/handlers.ts + host/services.ts + host/index.ts）

**Files:**
- Create: `packages/dsh-remote-access/src/host/handlers.ts`
- Create: `packages/dsh-remote-access/src/host/services.ts`
- Create: `packages/dsh-remote-access/src/host/index.ts`
- Test: `packages/dsh-remote-access/src/host/handlers.test.ts`

**Interfaces:**
- Consumes: `ConnectionManager`（Task 4）、`loadConfig`/`saveConfig`/`defaultConfig`/`RemoteAccessConfig`（Task 3）、`deriveGatewayEndpoints`（Task 2）、shared types（Task 1）。
- Produces:
  - `createHandlers(deps: HandlerDeps): Map<string, Handler>`；`Handler = (params: Record<string, unknown>) => Promise<unknown>`。
  - `HandlerDeps { homeDir: string; manager: ConnectionManager; envHostname: string }`。
  - 方法名：`remote-status` / `remote-save-config` / `remote-enable` / `remote-disable`。
  - `WebServerFace { register(route): () => void; port?: number }`（services.ts，host index 消费）。

- [ ] **Step 1: 写失败测试**

`packages/dsh-remote-access/src/host/handlers.test.ts`：

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConnectionManager } from './connection-manager';
import { loadConfig } from './config';
import { createHandlers, type Handler } from './handlers';

let home: string;
let manager: ConnectionManager;
let handlers: Map<string, Handler>;

const call = (method: string, params: Record<string, unknown> = {}) =>
  handlers.get(method)!(params) as Promise<Record<string, unknown>>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-ra-handlers-'));
  manager = new ConnectionManager({ upstreamUrl: 'http://127.0.0.1:1' });
  handlers = createHandlers({ homeDir: home, manager, envHostname: 'env-host-1' });
});
afterEach(async () => {
  await manager.disable();
  rmSync(home, { recursive: true, force: true });
});

describe('remote-status', () => {
  it('返回缺省补全的配置、环境主机名与 off 状态', async () => {
    const res = await call('remote-status');
    expect(res.ok).toBe(true);
    expect(res.envHostname).toBe('env-host-1');
    const cfg = res.config as Record<string, unknown>;
    expect(cfg.hostname).toBe('');
    expect(String(cfg.token)).toMatch(/^[0-9a-zA-Z]{8}$/);
    expect(cfg.gateway).toBe('harness-gateway.7qbjs.com');
    expect(res.connection).toEqual({ state: 'off' });
  });
});

describe('remote-save-config', () => {
  it('合法保存后 loadConfig 可读到', async () => {
    const res = await call('remote-save-config', { hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com' });
    expect(res.ok).toBe(true);
    expect(loadConfig(home)).toEqual({ hostname: 'my-pc', token: 'aB3x9Kq2', gateway: 'https://gw.example.com' });
  });

  it('非法网关地址：ok=false 且不写文件', async () => {
    const res = await call('remote-save-config', { hostname: '', token: 'aB3x9Kq2', gateway: 'ftp://x' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/协议不支持/);
  });

  it('非法 token：ok=false', async () => {
    const res = await call('remote-save-config', { hostname: '', token: 'has space', gateway: 'gw.example.com' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/令牌密钥/);
  });
});

describe('remote-enable / remote-disable', () => {
  it('网关不可达：enable 后状态为 error（不抛异常给路由层）', async () => {
    await call('remote-save-config', { hostname: '', token: 'aB3x9Kq2', gateway: '127.0.0.1:1' });
    const res = await call('remote-enable');
    expect(res.ok).toBe(true);
    const conn = res.connection as Record<string, unknown>;
    // 不可达时 connect 内部退避：要么 error 要么仍在 connecting，disable 必须能复位
    expect(['connecting', 'error']).toContain(conn.state);
    const off = await call('remote-disable');
    expect(off.connection).toEqual({ state: 'off' });
  });

  it('配置非法（未保存过且文件损坏场景以外的直接非法）: enable 返回 ok=false', async () => {
    // 先把 gateway 写成非法协议（绕过 save 校验直接改 manager 的输入路径：
    // enable 从 loadConfig 读，故先写一份合法配置再手工损坏字段不可行——
    // 这里验证 token 为空的直接调用路径）
    const res = await call('remote-enable', { override: { hostname: '', token: '', gateway: 'gw.example.com' } });
    expect(res.ok).toBe(false);
  });
});
```

> 设计说明：`remote-enable` 支持可选 `override` 参数（前端直接传当前表单值启用，未保存的编辑也能生效——避免「改了表单没失焦就点开开关」用到旧配置）。`remote-enable` 无 override 时从 yaml 读取。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './handlers'`

- [ ] **Step 3: 实现 handlers.ts / services.ts / index.ts**

`packages/dsh-remote-access/src/host/services.ts`：

```ts
/**
 * Host 侧服务契约——本插件从 harness host 服务消费的精确 API 表面（type-only）。
 * 实现位于用户的 harness（dsh-base / dsh-web-app bundle）；
 * 插件在 inject 中声明，Cordis 保持纤程挂起直到 provider 激活。
 */

/** harness webserver 上的一条 HTTP 路由注册。 */
export interface WebRouteLike {
  kind: 'exact';
  path: string;
  handler(req: WebRequestLike, res: WebResponseLike): void;
}

export interface WebRequestLike {
  on(event: 'data', cb: (chunk: unknown) => void): void;
  on(event: 'end' | 'close', cb: () => void): void;
}

export interface WebResponseLike {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

/** harness web 服务器（ctx.webServer）。 */
export interface WebServerFace {
  register(route: WebRouteLike): () => void;
  port?: number;
}
```

`packages/dsh-remote-access/src/host/handlers.ts`：

```ts
/**
 * /dsh-remote-access/invoke 的方法处理器（与 Cordis/webServer 解耦，便于单测）。
 * remote-status / remote-save-config / remote-enable / remote-disable。
 */

import type { ConnectionStatusDto, RemoteAccessConfigDto, RemoteStatusDto } from '../shared/types';
import { ConnectionManager } from './connection-manager';
import { defaultConfig, loadConfig, saveConfig, type RemoteAccessConfig } from './config';
import { deriveGatewayEndpoints } from './gateway-url';

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

export interface HandlerDeps {
  /** 配置所在家目录（生产为 os.homedir()，测试为临时目录） */
  homeDir: string;
  manager: ConnectionManager;
  /** 环境主机名（生产为 os.hostname()） */
  envHostname: string;
}

const LOG_PREFIX = '[dsh-remote-access]';

function toDto(cfg: RemoteAccessConfig): RemoteAccessConfigDto {
  return { hostname: cfg.hostname, token: cfg.token, gateway: cfg.gateway };
}

/** 从表单参数提取配置（缺省字段回落到已保存配置/默认值）。 */
function configFromParams(params: Record<string, unknown>, base: RemoteAccessConfig): RemoteAccessConfig {
  return {
    hostname: typeof params.hostname === 'string' ? params.hostname : base.hostname,
    token: typeof params.token === 'string' ? params.token : base.token,
    gateway: typeof params.gateway === 'string' ? params.gateway : base.gateway,
  };
}

/** 校验配置（token 字符集 + 网关可解析）；非法抛 Error（message 面向用户）。 */
function validate(cfg: RemoteAccessConfig): void {
  if (!/^[0-9a-zA-Z]+$/.test(cfg.token)) throw new Error('令牌密钥仅允许 0-9 a-z A-Z 且不能为空');
  deriveGatewayEndpoints(cfg.gateway); // 非法输入在此抛错
}

export function createHandlers(deps: HandlerDeps): Map<string, Handler> {
  const handlers = new Map<string, Handler>();

  /** 读配置；yaml 损坏降级为内存默认配置（不落盘）并附 warning。 */
  const readConfig = (): { cfg: RemoteAccessConfig; warning?: string } => {
    try {
      return { cfg: loadConfig(deps.homeDir) };
    } catch (err) {
      console.warn(`${LOG_PREFIX} [WARN] 配置文件读取失败，降级为默认配置: ${String((err as Error)?.message ?? err)}`);
      return { cfg: defaultConfig(), warning: '配置文件读取失败，已使用默认配置（保存时将覆盖修复）' };
    }
  };

  handlers.set('remote-status', async (): Promise<RemoteStatusDto> => {
    const { cfg, warning } = readConfig();
    return {
      ok: true,
      config: toDto(cfg),
      envHostname: deps.envHostname,
      connection: deps.manager.status,
      ...(warning ? { warning } : {}),
    };
  });

  handlers.set('remote-save-config', async (params) => {
    try {
      const { cfg: base } = readConfig();
      const cfg = configFromParams(params, base);
      validate(cfg);
      saveConfig(deps.homeDir, cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) };
    }
  });

  handlers.set('remote-enable', async (params) => {
    try {
      const { cfg: saved } = readConfig();
      const override = (params.override && typeof params.override === 'object'
        ? params.override : params) as Record<string, unknown>;
      const cfg = configFromParams(override, saved);
      validate(cfg);
      const connection: ConnectionStatusDto = await deps.manager.enable(cfg);
      return { ok: true, connection };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err), connection: deps.manager.status };
    }
  });

  handlers.set('remote-disable', async () => {
    const connection = await deps.manager.disable();
    return { ok: true, connection };
  });

  return handlers;
}
```

`packages/dsh-remote-access/src/host/index.ts`：

```ts
/**
 * dsh-remote-access — Host 半边（已安装包入口）。
 *
 * 普通 Cordis 插件模块（ESM），由 profile loader 作为 `dsh-remote-access`
 * 行加载。提供 POST /dsh-remote-access/invoke 路由（remote-status /
 * remote-save-config / remote-enable / remote-disable），并在启用时于
 * 本进程内启动 gateway-client 隧道客户端，把当前 DSH web 服务
 * （upstreamUrl = http://127.0.0.1:<webServer.port>）接入网关。
 *
 * 模块级 inject 是唯一门控：Cordis 保持此插件 PENDING 直到 webServer
 * 激活。切勿 export default（Loader 的 unwrapExports 会坍缩模块丢弃 inject）。
 */

import os from 'node:os';

import type { Context } from '@deepseek-ai/cordis';

import { ConnectionManager } from './connection-manager';
import { createHandlers } from './handlers';
import type { WebRequestLike, WebResponseLike, WebServerFace } from './services';

export const name = 'dsh-remote-access';

/** 必需服务：webServer（HTTP 路由 + 当前 DSH web 端口）。 */
export const inject = ['webServer'];

const LOG_PREFIX = '[dsh-remote-access]';

function logInfo(msg: string): void {
  console.info(`${LOG_PREFIX} [INFO] ${msg}`);
}
function logWarn(msg: string): void {
  console.warn(`${LOG_PREFIX} [WARN] ${msg}`);
}
function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined;
  const detail = e?.stack ?? String(e?.message ?? err ?? '');
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (detail ? `\n${detail}` : ''));
}

export function apply(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerFace;
  const port = typeof webServer.port === 'number' && webServer.port > 0 ? webServer.port : 0;
  if (port === 0) {
    logError('webServer.port 不可用，远程访问插件无法确定 upstreamUrl，插件停用');
    return;
  }
  const manager = new ConnectionManager({ upstreamUrl: `http://127.0.0.1:${port}` });
  const handlers = createHandlers({ homeDir: os.homedir(), manager, envHostname: os.hostname() });

  const writeJson = (res: WebResponseLike, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // 浏览器 UI 调用入口：POST { method, params } → 执行 handlers → JSON 结果
  ctx.effect(() => {
    let dispose: (() => void) | null = null;
    try {
      dispose = webServer.register({
        kind: 'exact',
        path: '/dsh-remote-access/invoke',
        handler: (req: WebRequestLike, res: WebResponseLike) => {
          let body = '';
          let overflow = false;
          req.on('data', (d) => {
            if (overflow) return;
            body += String(d);
            // 1MB 上限防滥用（UI 是唯一调用方，载荷很小）
            if (body.length > 1_000_000) {
              overflow = true;
              body = '';
              logWarn('调用载荷超过 1MB，已丢弃');
            }
          });
          req.on('end', () => {
            let msg: { method?: unknown; params?: unknown } | null = null;
            try {
              msg = JSON.parse(body || '{}') as typeof msg;
            } catch {
              // 忽略格式错误的载荷
            }
            const method = msg && typeof msg.method === 'string' ? msg.method : '';
            const params = (msg && typeof msg.params === 'object' && msg.params !== null
              ? msg.params : {}) as Record<string, unknown>;
            const handler = handlers.get(method);
            if (!handler) {
              logWarn(`未知调用方法: ${method || '(空)'}`);
              writeJson(res, 404, { ok: false, error: `未知方法: ${method}` });
              return;
            }
            Promise.resolve()
              .then(() => handler(params))
              .then((result) => writeJson(res, 200, result))
              .catch((err: unknown) => {
                logError(`调用 ${method} 失败`, err);
                writeJson(res, 200, { ok: false, error: String((err as Error)?.message ?? err) });
              });
          });
        },
      });
      logInfo('HTTP 路由已注册: /dsh-remote-access/invoke');
    } catch (err) {
      logError('路由注册失败（可能被本插件的另一个实例占用）', err);
    }
    return () => {
      try {
        dispose?.();
      } catch {
        // 尽力清理
      }
    };
  });

  // 插件卸载清理：尽力关闭隧道连接
  ctx.effect(() => () => {
    void manager.disable().then(
      () => logInfo('插件卸载，隧道已关闭'),
      () => undefined,
    );
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS

- [ ] **Step 5: 类型检查**

Run: `pnpm --filter dsh-remote-access typecheck`
Expected: 通过（`ctx.effect` 若 tsc 报不存在，检查 @deepseek-ai/cordis 的 Context 类型；参考插件用法一致，必要时 `(ctx as unknown as { effect(...) })` 的写法不允许——应修类型而非强转）

- [ ] **Step 6: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): invoke 处理器 + host 插件入口"
```

---

### Task 6: Client 半（设置页 UI + 二维码）

**Files:**
- Create: `packages/dsh-remote-access/src/client/globals.d.ts`
- Create: `packages/dsh-remote-access/src/client/react.ts`
- Create: `packages/dsh-remote-access/src/client/services.ts`
- Create: `packages/dsh-remote-access/src/client/qrcode-svg.ts`
- Create: `packages/dsh-remote-access/src/client/index.ts`
- Test: `packages/dsh-remote-access/src/client/qrcode-svg.test.ts`

**Interfaces:**
- Consumes: shared types（Task 1）、`randomToken`（Task 1）、`/dsh-remote-access/invoke` 方法（Task 5）。
- Produces:
  - `qrModules(url: string): { size: number; isDark(r: number, c: number): boolean }`（qrcode-svg.ts，纯函数可测）。
  - client bundle 导出插件表面 `{ name: 'dsh-remote-access', inject: ['slots'], apply }`。
  - 槽位注册：`settings.section`，`{ id: 'remote-access', order: 100, label: '远程访问' }`。

- [ ] **Step 1: 写 qrcode-svg 的失败测试**

`packages/dsh-remote-access/src/client/qrcode-svg.test.ts`：

```ts
import { describe, expect, it } from 'vitest';

import { qrModules } from './qrcode-svg';

describe('qrModules', () => {
  it('生成正方形模块矩阵，大小在合法 QR 范围内', () => {
    const m = qrModules('http://harness-gateway.7qbjs.com/__gateway__/select?tunnelId=3f6f9c40-1c6b-4a12-9a1e-3f0a1c2d4e5f');
    expect(m.size).toBeGreaterThanOrEqual(21);
    expect(m.size % 4).toBe(1); // QR version n → 21 + 4(n-1)
    // 左上角定位符区域必有深色模块
    expect(m.isDark(0, 0)).toBe(true);
    expect(m.isDark(0, 6)).toBe(true);
  });

  it('相同输入输出稳定；不同输入矩阵不同', () => {
    const a = qrModules('http://example.com/?tunnelId=aaa');
    const b = qrModules('http://example.com/?tunnelId=aaa');
    const c = qrModules('http://example.com/?tunnelId=bbb');
    let sameAB = true;
    let sameAC = true;
    for (let r = 0; r < a.size; r += 1) {
      for (let col = 0; col < a.size; col += 1) {
        if (a.isDark(r, col) !== b.isDark(r, col)) sameAB = false;
        if (c.size === a.size && a.isDark(r, col) !== c.isDark(r, col)) sameAC = false;
      }
    }
    expect(sameAB).toBe(true);
    expect(sameAC).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter dsh-remote-access test`
Expected: FAIL — `Cannot find module './qrcode-svg'`

- [ ] **Step 3: 实现 qrcode-svg.ts**

`packages/dsh-remote-access/src/client/qrcode-svg.ts`：

```ts
/**
 * 二维码模块矩阵生成（qrcode-generator 薄封装，纯函数便于 node 环境单测）。
 * client bundle 内联 qrcode-generator；渲染层（index.ts）按矩阵画 SVG rect。
 */

import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** 边长（模块数） */
  size: number;
  isDark(row: number, col: number): boolean;
}

/** 生成 URL 的 QR 模块矩阵（自动版本，纠错级 M）。 */
export function qrModules(url: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const size = qr.getModuleCount();
  return {
    size,
    isDark: (row, col) => qr.isDark(row, col),
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter dsh-remote-access test`
Expected: PASS

- [ ] **Step 5: 写 client 支撑文件（globals.d.ts / react.ts / services.ts）**

`packages/dsh-remote-access/src/client/globals.d.ts`：

```ts
/**
 * 浏览器 bundle 的运行时全局变量。Client 半边以 CJS 闭包形式发布，
 * 包裹在 web boot 握手中（window.__ModuleLoader__.load）：
 * React 通过注入的 require 到达，握手中的 module.exports 是 loader 读取的内容。
 */

declare function require(id: string): any;
declare var module: { exports: Record<string, unknown> };
declare var exports: Record<string, unknown>;
```

`packages/dsh-remote-access/src/client/react.ts`：

```ts
/** 浏览器模块表通过注入的 require 提供 React——从这里导入，而不是重复 require。 */

import type * as ReactNS from 'react';

export const React: typeof ReactNS = require('react');
export const h = React.createElement;
```

`packages/dsh-remote-access/src/client/services.ts`：

```ts
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
  register(registration: SlotRegistration, component: (props: Record<string, unknown>) => unknown): () => void;
}

/** settings.section 槽位组件的宿主 props（shell 拥有面板开关状态）。 */
export interface SettingsSectionProps {
  close?: () => void;
}

/** Client 上下文：cordis 加上本插件注入的服务。 */
export type ClientCtx = Context & {
  slots: SlotsService;
};
```

- [ ] **Step 6: 实现 client/index.ts（设置面板）**

`packages/dsh-remote-access/src/client/index.ts`：

```ts
/**
 * dsh-remote-access — Client 半边（已安装包 bundle 入口）。
 *
 * 在 settings.section 槽位注册「远程访问」选项页：主机名称 / 令牌密钥
 * （含「生成」按钮）/ 网关地址 / 启用开关；启用后调 host 半边的
 * remote-enable 启动隧道客户端，连接成功后展示选择页深链二维码
 * （qrcode-generator 前端动态生成 SVG）与「立即查看」按钮。
 * 通过 /dsh-remote-access/invoke（同源 fetch）与 host 半边通信。
 * enabled 不持久化：面板挂载时若 host 仍有存活连接，先 remote-disable
 * 复位——每次打开都是关闭，必须手动连接。
 */

import { qrModules } from './qrcode-svg';
import { React, h } from './react';
import type { ClientCtx } from './services';
import { randomToken } from '../shared/random-token';
import type { ConnectionStatusDto, RemoteInvokeResult, RemoteStatusDto } from '../shared/types';

const PLUGIN_ID = 'dsh-remote-access';
const INVOKE_PATH = '/dsh-remote-access/invoke';
const LOG_PREFIX = '[dsh-remote-access]';

function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined;
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (e ? `\n${e.stack ?? e.message}` : ''));
}

/** 调用 host 半边的 remote-* 处理器（POST 到 harness webserver 路由）。 */
function hostCall(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return fetch(base + INVOKE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  });
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520, padding: 16, color: '#e6e6eb' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, color: '#c9c9d1' },
  input: { background: '#121218', color: '#e6e6eb', border: '1px solid #34343e', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%' },
  tokenRow: { display: 'flex', gap: 8 },
  genBtn: { background: 'transparent', color: '#c9c9d1', border: '1px solid #34343e', borderRadius: 8, padding: '0 14px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  switchRow: { display: 'flex', alignItems: 'center', gap: 10 },
  status: { fontSize: 12, color: '#9fd0ff' },
  error: { fontSize: 12, color: '#f58b8b' },
  warn: { fontSize: 12, color: '#f5c56b' },
  qrWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 12, background: '#fff', borderRadius: 12, alignSelf: 'flex-start' },
  linkBtn: { background: 'none', border: 'none', color: '#7db4ff', fontSize: 13, cursor: 'pointer', padding: 4, textDecoration: 'underline' },
  hint: { fontSize: 11, color: '#8b8b96', lineHeight: 1.6 },
};

/** 二维码 SVG（白色衬底容器内；cell 4px + 8 模块 quiet zone）。 */
function QrImage(props: { url: string }): React.ReactNode {
  const matrix = React.useMemo(() => qrModules(props.url), [props.url]);
  const quiet = 2;
  const total = matrix.size + quiet * 2;
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.isDark(r, c)) {
        rects.push(h('rect', { key: `${r}-${c}`, x: c + quiet, y: r + quiet, width: 1, height: 1 }));
      }
    }
  }
  return h(
    'svg',
    { viewBox: `0 0 ${total} ${total}`, width: total * 4, height: total * 4, shapeRendering: 'crispEdges', role: 'img', 'aria-label': '远程访问二维码' },
    h('rect', { x: 0, y: 0, width: total, height: total, fill: '#fff' }),
    h('g', { fill: '#000' }, rects),
  );
}

/** 设置面板主体。 */
function RemoteAccessSection(): React.ReactNode {
  const el = h;
  const hostnameState = React.useState('');
  const hostname = hostnameState[0];
  const setHostname = hostnameState[1];
  const tokenState = React.useState('');
  const token = tokenState[0];
  const setToken = tokenState[1];
  const gatewayState = React.useState('');
  const gateway = gatewayState[0];
  const setGateway = gatewayState[1];
  const envHostState = React.useState('');
  const envHostname = envHostState[0];
  const setEnvHostname = envHostState[1];
  const enabledState = React.useState(false);
  const enabled = enabledState[0];
  const setEnabled = enabledState[1];
  const connState = React.useState<ConnectionStatusDto>({ state: 'off' });
  const conn = connState[0];
  const setConn = connState[1];
  const errorState = React.useState('');
  const error = errorState[0];
  const setError = errorState[1];
  const warningState = React.useState('');
  const warning = warningState[0];
  const setWarning = warningState[1];

  // st 用可变引用让轮询闭包读到最新 enabled，避免每次切换都退订重订
  const st = React.useState(() => ({ enabled: false }))[0];
  st.enabled = enabled;

  // 挂载：拉取配置与状态；若 host 仍有存活连接（上一轮面板开启未关），
  // 先 disable 复位——「每次打开都是关闭，必须手动连接」
  React.useEffect(() => {
    let cancelled = false;
    hostCall('remote-status')
      .then(async (raw) => {
        const res = raw as unknown as RemoteStatusDto;
        if (cancelled) return;
        setHostname(res.config.hostname);
        setToken(res.config.token);
        setGateway(res.config.gateway);
        setEnvHostname(res.envHostname);
        if (res.warning) setWarning(res.warning);
        if (res.connection.state !== 'off') {
          const off = (await hostCall('remote-disable')) as unknown as RemoteInvokeResult;
          if (!cancelled) setConn(off.connection ?? { state: 'off' });
        } else {
          setConn(res.connection);
        }
      })
      .catch((err) => {
        logError('读取远程访问状态失败', err);
        if (!cancelled) setError('读取配置失败：' + String((err as Error)?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启用期间轮询连接状态（连接中/已连接/失败/断线重连）
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = (): void => {
      hostCall('remote-status')
        .then((raw) => {
          if (cancelled) return;
          const res = raw as unknown as RemoteStatusDto;
          setConn(res.connection);
        })
        .catch(() => undefined); // 轮询失败静默，下一轮重试
    };
    poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  /** 失焦保存（三个字段一起提交，host 侧缺省回落已保存值）。 */
  const saveField = (): void => {
    hostCall('remote-save-config', { hostname, token, gateway })
      .then((raw) => {
        const res = raw as unknown as RemoteInvokeResult;
        setError(res.ok ? '' : (res.error ?? '保存失败'));
      })
      .catch((err) => setError('保存失败：' + String((err as Error)?.message ?? err)));
  };

  /** 开关切换：开 = remote-enable（携带当前表单值，未失焦的编辑也生效）。 */
  const onToggle = (next: boolean): void => {
    setEnabled(next);
    setError('');
    if (next) {
      setConn({ state: 'connecting' });
      hostCall('remote-enable', { hostname, token, gateway })
        .then((raw) => {
          const res = raw as unknown as RemoteInvokeResult;
          if (!res.ok) {
            setEnabled(false);
            setConn({ state: 'off' });
            setError(res.error ?? '启用失败');
            return;
          }
          if (res.connection) setConn(res.connection);
        })
        .catch((err) => {
          setEnabled(false);
          setConn({ state: 'off' });
          setError('启用失败：' + String((err as Error)?.message ?? err));
        });
    } else {
      hostCall('remote-disable')
        .then((raw) => {
          const res = raw as unknown as RemoteInvokeResult;
          if (res.connection) setConn(res.connection);
        })
        .catch(() => setConn({ state: 'off' }));
    }
  };

  const connected = enabled && conn.state === 'connected' && !!conn.deepLink;
  const statusText = !enabled
    ? ''
    : conn.state === 'connecting'
      ? '连接中…'
      : conn.state === 'connected'
        ? `已连接（tunnelId: ${conn.tunnelId ?? '-'}）`
        : conn.state === 'error'
          ? `连接失败：${conn.error ?? '未知错误'}`
          : '';

  return el(
    'div',
    { style: S.wrap },
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-hostname' }, '主机名称'),
      el('input', {
        id: 'dsh-ra-hostname',
        style: S.input,
        value: hostname,
        placeholder: envHostname ? `默认为环境主机名：${envHostname}` : '默认为环境主机名',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setHostname(e.target.value),
        onBlur: saveField,
      }),
    ),
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-token' }, '令牌密钥'),
      el(
        'div',
        { style: S.tokenRow },
        el('input', {
          id: 'dsh-ra-token',
          style: S.input,
          value: token,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value),
          onBlur: saveField,
        }),
        el(
          'button',
          {
            type: 'button',
            style: S.genBtn,
            onClick: () => {
              const next = randomToken(8);
              setToken(next);
              // 生成后立即保存（不等失焦）
              hostCall('remote-save-config', { hostname, token: next, gateway })
                .catch(() => undefined);
            },
          },
          '生成',
        ),
      ),
    ),
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-gateway' }, '网关地址'),
      el('textarea', {
        id: 'dsh-ra-gateway',
        style: { ...S.input, minHeight: 56, resize: 'vertical', lineHeight: 1.5 },
        rows: 2,
        value: gateway,
        placeholder: 'harness-gateway.7qbjs.com',
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setGateway(e.target.value),
        onBlur: saveField,
      }),
    ),
    el(
      'div',
      { style: S.switchRow },
      el('input', {
        id: 'dsh-ra-enabled',
        type: 'checkbox',
        role: 'switch',
        checked: enabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
      }),
      el('label', { style: S.label, htmlFor: 'dsh-ra-enabled' }, '启用'),
      statusText ? el('span', { style: conn.state === 'error' ? S.error : S.status }, statusText) : null,
    ),
    error ? el('div', { style: S.error }, error) : null,
    warning ? el('div', { style: S.warn }, warning) : null,
    connected
      ? el(
          'div',
          { style: S.qrWrap },
          el(QrImage, { url: conn.deepLink ?? '' }),
          el(
            'button',
            {
              type: 'button',
              style: { ...S.linkBtn, color: '#1d4ed8' },
              onClick: () => window.open(conn.deepLink, '_blank'),
            },
            '立即查看',
          ),
        )
      : null,
    el(
      'div',
      { style: S.hint },
      '打开「启用」后，本机 DSH 将接入网关；用移动端扫描二维码即可快速进入。每次打开本页开关均为关闭状态，需手动连接。',
    ),
  );
}

/**
 * 插件入口：注册 settings.section 槽位组件。
 * 经 ctx.effect 登记清理器，插件卸载时自动移除。
 */
function apply(ctx: ClientCtx): void {
  ctx.effect(function () {
    return ctx.slots.inject('settings.section', function () {
      return ctx.slots.register(
        { name: 'settings.section', id: 'remote-access', order: 100, label: '远程访问' },
        RemoteAccessSection as unknown as (props: Record<string, unknown>) => unknown,
      );
    });
  }, 'dsh-remote-access: settings section');

  console.info(LOG_PREFIX + ' [INFO] client 插件已加载（槽位 settings.section）');
}

// loader 契约：bundle 外层包裹（tsup banner）提供局部 module/exports，
// 这里导出插件表面供 window.__ModuleLoader__ 读取
module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
};
```

> 设计说明已在 Step 6 代码中直接修正，无需额外步骤。

- [ ] **Step 7: 类型检查 + 构建验证**

Run: `pnpm --filter dsh-remote-access typecheck`
Expected: 通过

Run: `pnpm --filter dsh-remote-access build`
Expected: 产出 `lib/index.js`（ESM host bundle，含 gateway-client 源码、`ws` external）与 `lib/client.js`（以 `window.__ModuleLoader__.load({` 开头、含 qrcode-generator 内联代码、`require("react")` 保留）

验证命令：

```powershell
Select-String -Path packages/dsh-remote-access/lib/client.js -Pattern '__ModuleLoader__.load' -Quiet  # 应为 True
Select-String -Path packages/dsh-remote-access/lib/index.js -Pattern 'dsh-remote-access/invoke' -Quiet  # 应为 True
```

- [ ] **Step 8: 提交**

```bash
git add packages/dsh-remote-access
git commit -m "feat(dsh-remote-access): 设置页 UI（settings.section + 二维码）"
```

---

### Task 7: README + 全仓验证

**Files:**
- Create: `packages/dsh-remote-access/README.md`
- Modify: `README.md`（根，目录结构一节加一行）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 安装/使用文档；全仓验证通过。

- [ ] **Step 1: 写 README.md**

`packages/dsh-remote-access/README.md` 内容要点（完整写入文件）：

```markdown
# dsh-remote-access

DSH（DeepSeek Harness）动态插件：在「设置」新增「远程访问」选项页，配置主机名称 /
令牌密钥 / 网关地址后手动打开「启用」，即在 DSH 进程内启动 harness-gateway 隧道
客户端，把当前 DSH web 服务接入网关；连接成功展示选择页深链二维码，移动端扫码
快速进入。

## 构建

    pnpm install
    pnpm --filter dsh-remote-access build   # tsup：host → lib/index.js（ESM），client → lib/client.js（loader 包裹）

## 安装

    pnpm build 后：dsh plugin --profile web add <本仓库>/packages/dsh-remote-access
    重启 dsh web，设置中即出现「远程访问」选项页。
    卸载：dsh plugin --profile web remove dsh-remote-access

## 使用

1. 设置 → 远程访问。
2. 按需修改主机名称（空 = 环境主机名）、令牌密钥（8 位，可点「生成」换新）、网关地址（默认 harness-gateway.7qbjs.com）。
3. 打开「启用」开始连接；每次打开本页开关均为关闭，须手动连接。
4. 连接成功后展示二维码（http://<网关>/__gateway__/select?tunnelId=xxx），
   移动端扫码或点「立即查看」新窗口打开。

## 配置

保存于 `~/.dsh/.remote-access.yaml`（hostname / token / gateway；enabled 不持久化）。

## 协议推断

裸域名 → ws 隧道 + http 选择页；https:// 或 wss:// → wss/https。只取 origin。
```

根 `README.md` 的「目录结构」代码块中在 `client/` 一行后加一行：

```
├── dsh-remote-access/   # dsh-remote-access — DSH 插件：设置页手动启用隧道接入网关（二维码深链）
```

- [ ] **Step 2: 全仓验证**

Run: `pnpm typecheck`
Expected: 全部包通过

Run: `pnpm test`
Expected: 全部包通过（dsh-remote-access 新增用例全绿）

Run: `pnpm --filter dsh-remote-access format`（ESLint --fix 统一格式）后 `git diff --stat` 确认改动符合预期

- [ ] **Step 3: 提交**

```bash
git add packages/dsh-remote-access README.md
git commit -m "docs(dsh-remote-access): README + 根目录结构更新"
```

---

## 验收清单（执行完成后逐项核对）

- [ ] `pnpm typecheck`、`pnpm test` 全仓通过
- [ ] `pnpm --filter dsh-remote-access build` 产出 lib/index.js + lib/client.js（client 含 loader 包裹）
- [ ] 首次 `remote-status` 生成 `~/.dsh/.remote-access.yaml` 且 token 稳定不变
- [ ] 启用后连上真实/本地网关时 status 返回 connected + deepLink，二维码与「立即查看」地址一致
- [ ] 重新打开设置页开关为关（host 残余连接被自动 disable）
