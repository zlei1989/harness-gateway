/**
 * 构建产物外置依赖护栏（externals drift 回归防线）：
 * tsup 默认把 package.json dependencies 自动外置，tsup.config.ts 里"内联"注释
 * 若无 noExternal 配套就是空头支票——client bundle 残留的裸 require 在浏览器
 * 模块表里解析不到，插件整页加载失败（线上已发生一次）。此处对产物做反向断言：
 * client.js 只允许 require('react')（模块表种子词），index.js 只允许裸导入 ws/yaml。
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const root = process.cwd();
/** Node 内建模块是宿主运行时提供，不算外置漂移（裸写法与 node: 前缀都算） */
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
let failures = 0;

/** 提取产物中所有裸模块引用（require/import from 的非相对路径、非内建目标） */
function bareRefs(file, patterns) {
  const text = readFileSync(join(root, file), 'utf8');
  const refs = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const id = m[1];
      if (!id.startsWith('.') && !builtins.has(id)) refs.add(id);
    }
  }
  return [...refs];
}

const clientRefs = bareRefs('lib/client.js', [/require\(["']([^"']+)["']\)/g]);
const clientBad = clientRefs.filter((id) => id !== 'react');
if (clientBad.length > 0) {
  failures += 1;
  console.error(`[verify-bundle] lib/client.js 残留未内联依赖: ${clientBad.join(', ')}（需在 tsup client 配置 noExternal 中列出）`);
}

const hostRefs = bareRefs('lib/index.js', [
  /import\s+(?:[\w${},*\s]+\s+from\s+)?["']([^"']+)["']/g,
  /import\(["']([^"']+)["']\)/g,
]);
// host 允许的外置：ws（运行时依赖）与 yaml（纯 CJS 包，内联进 ESM 会触发 __require 垫片崩溃，见 tsup.config.ts 注释）
const hostBad = hostRefs.filter((id) => id !== 'ws' && id !== 'yaml');
if (hostBad.length > 0) {
  failures += 1;
  console.error(`[verify-bundle] lib/index.js 残留未内联依赖: ${hostBad.join(', ')}（需在 tsup host 配置 noExternal 中列出）`);
}

if (failures === 0) console.info('[verify-bundle] 产物外置依赖检查通过（client: 仅 react；host: 仅 ws/yaml）');
process.exit(failures === 0 ? 0 : 1);
