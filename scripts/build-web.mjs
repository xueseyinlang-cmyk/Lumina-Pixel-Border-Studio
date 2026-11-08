/* 构建：把 src/ 下的样式、core、app 内联成 dist/pixel-border-studio.html（不引入任何依赖） */
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const outFile = join(here, '..', 'dist', 'pixel-border-studio.html');

const tpl = readFileSync(join(srcDir, 'index.template.html'), 'utf8');
const style = readFileSync(join(srcDir, 'style.css'), 'utf8');
const core = readFileSync(join(srcDir, 'core.js'), 'utf8');
const app = readFileSync(join(srcDir, 'app.js'), 'utf8');

/* core / app 直接作为可执行 <script> 内联，不能出现 </script> */
if (/<\/script/i.test(core)) throw new Error('core.js 含 </script，需转义');
if (/<\/script/i.test(app)) throw new Error('app.js 含 </script，需转义');

const html = tpl
  .replace('{{STYLE}}', () => style)
  .replace('{{CORE}}', () => core)
  .replace('{{APP}}', () => app);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, html, 'utf8');
const bytes = Buffer.byteLength(html, 'utf8');
const kb = (bytes / 1024).toFixed(1);
console.log(JSON.stringify({
  file: outFile,
  bytes,
  kb,
  lines: html.split('\n').length,
  budget: { pass: 307200, warn: 512000 },
  verdict: bytes <= 307200 ? 'pass' : (bytes <= 512000 ? 'warn' : 'fail')
}, null, 2));
void statSync;

/* 本仓库不含 browser harness；产物同时供 scripts/package.mjs 内联进模块包 */
