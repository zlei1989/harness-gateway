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
