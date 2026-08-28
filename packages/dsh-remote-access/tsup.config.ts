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
    // host 半（Node 运行时）：只内联 gateway-client——workspace:* 协议独立安装时无法解析；
    // ws / yaml 保持外置（semver 依赖，经 node_modules 解析）。
    // 切勿内联 yaml：它是纯 CJS 包，esbuild 打进 ESM 产物会把其内部 require('process')
    // 转成 __require 垫片，运行时抛 "Dynamic require of process is not supported"（线上已发生）。
    // 注意 noExternal 必须显式列出：tsup 默认把 package.json dependencies 全部外置
    // （externals drift 根因——注释声称内联但未配 noExternal，产物残留裸导入）
    name: 'host',
    entry: { index: 'src/host/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    external: ['ws'],
    noExternal: ['gateway-client'],
    outExtension: () => ({ js: '.js' }),
    clean: true,
    sourcemap: false,
    dts: false,
  },
  {
    // client 半：qrcode-generator 等全部内联（noExternal 覆盖 tsup 的 dependencies 自动外置）；
    // react 由浏览器模块表运行时提供
    name: 'client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2020',
    external: ['react'],
    noExternal: ['qrcode-generator'],
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
