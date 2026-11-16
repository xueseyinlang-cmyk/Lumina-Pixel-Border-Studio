/* 构建 Lumina 创意工坊模块包（.lumina-workshop）
 * 步骤：
 *   1) 读取 dist/pixel-border-studio.html（先跑 scripts/build-web.mjs 生成）
 *   2) 内联 SDK（.sdk/dist/*.js → IIFE 挂 window.LuminaWorkshop，去 import/export）
 *   3) 拼接宿主桥接脚本 src/host-bridge.js
 *   4) 组装 dist/{manifest.json, ui/index.html, assets/icon.png, README.md, LICENSE}
 *   5) 按宿主 core/workshop 的规则做本地校验（必需文件集、HTML 外链、体积、图标尺寸、manifest 字段）
 *   6) 用内置的 zip 写入器打包成 artifacts/<module-id>-<version>.lumina-workshop（+ .sha256）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..');
const artifactsDir = join(moduleDir, 'artifacts');
const sdkDir = join(moduleDir, '.sdk');
const distDir = join(moduleDir, 'dist');

const REQUIRED = ['manifest.json', 'ui/index.html', 'assets/icon.png', 'README.md', 'LICENSE'];
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_ICON_BYTES = 2 * 1024 * 1024;
const MAX_ICON_PIXELS = 1048576;

function fail(message) {
  console.error('[build-module] FAIL: ' + message);
  process.exit(1);
}

/* ---------- 1. 输入 ---------- */
const appHtmlPath = join(distDir, 'pixel-border-studio.html');
if (!existsSync(appHtmlPath)) fail('缺少 ' + appHtmlPath + '，请先执行 node scripts/build-web.mjs');
const manifestPath = join(moduleDir, 'manifest.json');
const manifestRaw = readFileSync(manifestPath, 'utf8');
let manifest;
try { manifest = JSON.parse(manifestRaw); } catch (e) { fail('manifest.json 不是合法 JSON：' + e.message); }

/* ---------- 2. SDK → IIFE ---------- */
function sdkBundle() {
  const need = ['contracts.js', 'theme.js', 'client.js'];
  for (const f of need) {
    if (!existsSync(join(sdkDir, 'dist', f))) fail('缺少 SDK 文件 .sdk/dist/' + f + '，请先执行 python tools/fetch-sdk.py');
  }
  const strip = (src) => src
    .split('\n')
    .filter((line) => !/^\s*import\s.+from\s+["']\.\/[^"']+["'];?\s*$/.test(line))
    .join('\n')
    .replace(/^export\s+/gm, '');
  const body = need.map((f) => `/* ---- ${f} ---- */\n` + strip(readFileSync(join(sdkDir, 'dist', f), 'utf8'))).join('\n');
  /* PR 问题 2：旧实现只取 .sdk/LICENSE 的第一行，最终 ZIP 里没有任何 SDK 版权声明。
     现在把 SPDX 与版权行完整内联进构建产物注释；完整 GPL 文本由包内 LICENSE 承载（见下方 validate）。 */
  const sdkLicenseLines = existsSync(join(sdkDir, 'LICENSE'))
    ? readFileSync(join(sdkDir, 'LICENSE'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];
  const sdkSpdx = sdkLicenseLines.find((l) => /^SPDX-License-Identifier:/.test(l)) || 'SPDX-License-Identifier: GPL-3.0-or-later';
  const sdkCopyright = sdkLicenseLines.find((l) => /^Copyright/.test(l)) || 'Copyright (C) Lumina Layer Studio contributors';
  const license = sdkSpdx + '; ' + sdkCopyright + '; 版权与许可全文见包内 LICENSE';
  return `/* @lumina/workshop-sdk 1.0.2 — ${license} */\n(function () {\n'use strict';\n${body}\nwindow.LuminaWorkshop = { connectWorkshop, WorkshopClientError, WORKSHOP_API_VERSION, WORKSHOP_MANIFEST_VERSION, WORKSHOP_RPC_VERSION, WORKSHOP_PERMISSION_NAMES, applyWorkshopUiState, createRequestEnvelope };\n})();\n`;
}

/* ---------- 3. 组装 runtime HTML ---------- */
function buildHtml() {
  const appHtml = readFileSync(appHtmlPath, 'utf8');
  const sdk = sdkBundle();
  const bridge = readFileSync(join(moduleDir, 'src', 'host-bridge.js'), 'utf8')
    .replaceAll('__MODULE_ID__', manifest.id)
    .replaceAll('__MODULE_VERSION__', manifest.version);
  if (/__MODULE_(ID|VERSION)__/.test(bridge)) fail('host-bridge.js 的模块 id/version 占位符未被替换');
  for (const [name, text] of [['sdk', sdk], ['bridge', bridge]]) {
    if (/<\/script/i.test(text)) fail(name + ' 含 </script，无法安全内联');
  }
  if (!appHtml.includes('</body>')) fail('主产物缺少 </body>');
  return appHtml.replace('</body>', `<script id="workshop-sdk">\n${sdk}</script>\n<script id="workshop-bridge">\n${bridge}</script>\n</body>`);
}

/* ---------- 4. 校验 ---------- */
function validate(html, iconBuf, licenseText) {
  const problems = [];
  const names = new Set(REQUIRED);
  if (manifest.manifestVersion !== 1) problems.push('manifestVersion 必须是 1');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)*$/.test(manifest.id || '')) problems.push('module id 不符合反向域名小写规则');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) problems.push('version 不是合法 SemVer');
  if (!manifest.name || !manifest.name['zh-CN'] || !manifest.name['en-US']) problems.push('name 需要 zh-CN 与 en-US');
  if (!manifest.description || !manifest.description['zh-CN'] || !manifest.description['en-US']) problems.push('description 需要 zh-CN 与 en-US');
  // 宿主 core/workshop/models.py: LocalizedText 的 zh-CN / en-US 都是 max_length=200（按字符计），
  // 超长会让 /install/local 直接 422「package is invalid」，且报错不带具体字段，必须在此提前拦住。
  for (const locale of ['zh-CN', 'en-US']) {
    const text = (manifest.description || {})[locale] || '';
    if (text.length > 200) problems.push(`description.${locale} 长度 ${text.length} 超过宿主上限 200`);
    const name = (manifest.name || {})[locale] || '';
    if (name.length > 200) problems.push(`name.${locale} 长度 ${name.length} 超过宿主上限 200`);
  }
  if (!manifest.entrypoints || manifest.entrypoints.ui !== 'ui/index.html') problems.push('entrypoints.ui 必须是 ui/index.html');
  if (!manifest.workshopApi || !manifest.workshopApi.min || !manifest.workshopApi.maxExclusive) problems.push('workshopApi 需要 min 与 maxExclusive');
  if (!manifest.luminaVersion || !manifest.luminaVersion.min) problems.push('luminaVersion 需要 min');
  const allowed = new Set(['image.pick', 'project.storage', 'color-library.read', 'handoff.image']);
  for (const p of manifest.permissions || []) {
    if (!allowed.has(p.name)) problems.push('未知权限：' + p.name);
    if (!String(p.reason || '').trim()) problems.push('权限 ' + p.name + ' 缺少 reason');
  }
  /* runtime HTML：src/href 只能是 #、data:、blob:、about:blank；CSS url() 同规则 */
  const inlineOk = (v) => {
    const s = String(v || '').trim().replace(/^["']|["']$/g, '').trim();
    const low = s.toLowerCase();
    return !s || s.startsWith('#') || low.startsWith('data:') || low.startsWith('blob:') || low === 'about:blank';
  };
  /* 与宿主一致：只看标签属性与 <style> 里的 url()，不扫描 <script> 内的 JS 字符串 */
  const withoutScripts = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  for (const m of withoutScripts.matchAll(/\s(?:src|href)\s*=\s*(["'])(.*?)\1/gi)) {
    if (!inlineOk(m[2])) problems.push('HTML 引用了非内联资源：' + m[2].slice(0, 80));
  }
  const styleBlocks = [...withoutScripts.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  for (const m of styleBlocks.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!inlineOk(m[2])) problems.push('CSS url() 引用了非内联资源：' + m[2].slice(0, 80));
  }
  if (!iconBuf) problems.push('缺少 assets/icon.png');
  else {
    const isPng = iconBuf.length > 24 && iconBuf.readUInt32BE(0) === 0x89504e47;
    if (!isPng) problems.push('assets/icon.png 不是 PNG');
    if (iconBuf.length > MAX_ICON_BYTES) problems.push('图标超过 2 MiB');
    if (isPng) {
      const w = iconBuf.readUInt32BE(16);
      const h = iconBuf.readUInt32BE(20);
      if (w * h > MAX_ICON_PIXELS) problems.push(`图标像素 ${w}×${h} 超过 1,048,576`);
      if (w !== h) problems.push('图标建议为正方形（当前 ' + w + '×' + h + '）');
    }
  }
  /* PR 问题 2 非回归：最终包必须同时带模块与 SDK 的版权声明，并附 GPL-3.0 全文（不能只剩一个链接）。 */
  const lic = String(licenseText || '');
  if (!/Copyright \(C\) 2026 Pixel Border Studio/.test(lic)) problems.push('LICENSE 缺少模块版权声明');
  if (!/Copyright \(C\) Lumina Layer Studio contributors/.test(lic)) problems.push('LICENSE 缺少 SDK 版权声明');
  if (!/Version 3, 29 June 2007/.test(lic)) problems.push('LICENSE 缺少 GPL-3.0 标题行');
  if (lic.length < 20000) problems.push('LICENSE 未附 GPL-3.0 全文（当前 ' + lic.length + ' 字符）');

  const htmlBytes = Buffer.byteLength(html, 'utf8');
  if (htmlBytes > MAX_PACKAGE_BYTES) problems.push('ui/index.html 过大');
  for (const n of names) if (!n) problems.push('空文件名');
  return problems;
}

/* ---------- 5. 打包（纯 Node 实现 ZIP，避免子进程与额外依赖） ---------- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipPackage(rootDir, files, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of files) {
    const data = readFileSync(join(rootDir, rel));
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  writeFileSync(outPath, Buffer.concat([...locals, centralBuf, end]));
  return { files: files.length, bytes: statSync(outPath).size };
}

/* ---------- 6. 主流程 ---------- */
const html = buildHtml();
/* 只清理打包暂存目录，保留同目录下 build-web 产出的 pixel-border-studio.html */
for (const sub of ['ui', 'assets']) {
  const p = join(distDir, sub);
  if (existsSync(p)) rmSync(p, { recursive: true, force: true });
}
mkdirSync(join(distDir, 'ui'), { recursive: true });
mkdirSync(join(distDir, 'assets'), { recursive: true });

const iconPath = join(moduleDir, 'assets', 'icon.png');
if (!existsSync(iconPath)) fail('缺少 assets/icon.png');
const iconBuf = readFileSync(iconPath);

const moduleLicense = readFileSync(join(moduleDir, 'LICENSE'), 'utf8');
const problems = validate(html, iconBuf, moduleLicense);
if (problems.length) fail('本地校验未通过：\n  - ' + problems.join('\n  - '));

writeFileSync(join(distDir, 'ui', 'index.html'), html, 'utf8');
writeFileSync(join(distDir, 'manifest.json'), manifestRaw, 'utf8');
writeFileSync(join(distDir, 'assets', 'icon.png'), iconBuf);
writeFileSync(join(distDir, 'README.md'), readFileSync(join(moduleDir, 'README.md'), 'utf8'), 'utf8');
writeFileSync(join(distDir, 'LICENSE'), moduleLicense, 'utf8');

/* release 资产命名沿用组织约定：<module-id>-<version>.lumina-workshop */
const outName = `${manifest.id}-${manifest.version}.lumina-workshop`;
/* PR 问题 3：发布新补丁版本时不得覆盖旧文件。旧实现会 rmSync 整个 artifacts/，
   把上一个版本已发布的包一起删掉；这里只清理本次同名产物，历史版本原样保留。 */
mkdirSync(artifactsDir, { recursive: true });
const outPath = join(artifactsDir, outName);
for (const stale of [outPath, outPath + '.sha256']) {
  if (existsSync(stale)) rmSync(stale, { force: true });
}
const packaged = ['manifest.json', 'ui/index.html', 'assets/icon.png', 'README.md', 'LICENSE'];
const zipInfo = zipPackage(distDir, packaged, outPath);
const bytes = statSync(outPath).size;
const sha = createHash('sha256').update(readFileSync(outPath)).digest('hex');
/* sha256sum 兼容格式：<64 hex>  <filename>\n */
const shaFile = outPath + '.sha256';
writeFileSync(shaFile, sha + '  ' + outName + '\n', 'utf8');

const entries = readdirSync(distDir).sort();
console.log(JSON.stringify({
  module: manifest.id,
  version: manifest.version,
  package: outPath,
  bytes,
  sha256: sha,
  sha256File: shaFile,
  entries: entries.filter((n) => !n.endsWith('.lumina-workshop')),
  artifacts: readdirSync(artifactsDir).sort(),
  htmlBytes: Buffer.byteLength(html, 'utf8'),
  iconBytes: iconBuf.length,
  zip: zipInfo,
  budget: { maxPackageBytes: MAX_PACKAGE_BYTES, verdict: bytes <= MAX_PACKAGE_BYTES ? 'pass' : 'fail' }
}, null, 2));
