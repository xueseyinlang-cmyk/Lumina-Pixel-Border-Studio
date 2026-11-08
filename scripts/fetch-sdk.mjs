/* 取 @lumina/workshop-sdk 的「不可变 Release 资产」，校验 sha256 后解出 dist/*.js。
 *
 * 用法：
 *   node scripts/fetch-sdk.mjs                # 从 GitHub Release 下载（需网络）
 *   node scripts/fetch-sdk.mjs --from <tgz>   # 用本地 tgz（离线 / CI 缓存）
 *
 * 规则（组织约定）：SDK 只经独立公开仓库的不可变 GitHub Release 分发，
 * 不发 `latest` 之类可变资产，不上 npm registry；版本号写死在 PIN 里。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..');
const sdkDir = join(repoDir, '.sdk');

const PIN = {
  version: '1.0.2',
  fileName: 'lumina-workshop-sdk-1.0.2.tgz',
  url: 'https://github.com/lumina-layer-studio/Lumina-Workshop-SDK/releases/download/v1.0.2/lumina-workshop-sdk-1.0.2.tgz',
  bytes: 6990,
  sha256: 'f23f8d0b5181116e8173c0a6f4171405980269615f429be4805973ec4efa93ad',
  license: 'GPL-3.0-or-later'
};

const WANT = [
  'package/dist/contracts.js',
  'package/dist/theme.js',
  'package/dist/client.js',
  'package/LICENSE',
  'package/package.json'
];

function fail(message, code = 1) {
  console.error('[fetch-sdk] FAIL: ' + message);
  process.exit(code);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/* 极简 tar 读取：只认普通文件（typeflag '0'），足够读本 SDK 的 11 个成员。 */
function untar(buf) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeRaw = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = sizeRaw ? parseInt(sizeRaw, 8) : 0;
    if (!Number.isFinite(size) || size < 0) fail('tar 头损坏：' + name);
    const type = String.fromCharCode(header[156] || 0x30);
    const start = offset + 512;
    if (type === '0') {
      files.set(name, Buffer.from(buf.subarray(start, start + size)));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
}

async function obtain() {
  const fromIdx = process.argv.indexOf('--from');
  if (fromIdx > 0) {
    const path = process.argv[fromIdx + 1];
    if (!path) fail('--from 需要一个 tgz 路径');
    if (!existsSync(path)) fail('找不到 ' + path);
    return { buf: readFileSync(path), origin: path };
  }

  const cachePath = join(sdkDir, PIN.fileName);
  if (existsSync(cachePath)) {
    const cached = readFileSync(cachePath);
    if (sha256(cached) === PIN.sha256) return { buf: cached, origin: 'cache ' + cachePath };
  }

  console.log('[fetch-sdk] 下载 ' + PIN.url);
  /* 需要翻墙时：NODE_USE_ENV_PROXY=1 node scripts/fetch-sdk.mjs */
  const res = await fetch(PIN.url, { redirect: 'follow' });
  if (!res.ok) fail('下载失败：HTTP ' + res.status + '（可用 --from 指定本地 tgz）', 2);
  return { buf: Buffer.from(await res.arrayBuffer()), origin: 'download' };
}

const { buf: tgz, origin } = await obtain();
const digest = sha256(tgz);
if (digest !== PIN.sha256) {
  fail('sha256 不匹配：\n  期望 ' + PIN.sha256 + '\n  实际 ' + digest, 2);
}
if (tgz.length !== PIN.bytes) {
  fail('字节数不匹配：期望 ' + PIN.bytes + '，实际 ' + tgz.length, 2);
}

const tar = gunzipSync(tgz);
const files = untar(tar);
for (const name of WANT) {
  if (!files.has(name)) fail('tgz 内缺少 ' + name);
}

mkdirSync(join(sdkDir, 'dist'), { recursive: true });
writeFileSync(join(sdkDir, PIN.fileName), tgz);

const written = [];
for (const name of WANT) {
  const short = name.replace(/^package\//, '');
  const target = join(sdkDir, short);
  writeFileSync(target, files.get(name));
  written.push({ file: short, bytes: files.get(name).length });
}

const pkg = JSON.parse(files.get('package/package.json').toString('utf8'));
console.log(JSON.stringify({
  sdk: pkg.name,
  version: pkg.version,
  license: pkg.license || PIN.license,
  pinnedVersion: PIN.version,
  bytes: tgz.length,
  sha256: digest,
  origin,
  members: tar.length ? files.size : 0,
  files: written,
  sdkDir
}, null, 2));
