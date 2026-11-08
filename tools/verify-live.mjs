#!/usr/bin/env node
// 真机验证：对着「运行中的 Lumina Studio」后端做只读核对。
//
//   node tools/verify-live.mjs
//   PBS_HOST_BASE=http://127.0.0.1:8000 node tools/verify-live.mjs
//
// 前置：Lumina Studio 已启动（后端默认 127.0.0.1:8000），且模块已安装。
// 本脚本不安装、不激活、不改动宿主状态，只读取并比对：
//   1) /api/health
//   2) /api/workshop/v1/modules 里的本模块状态
//   3) /api/workshop/v1/modules/<id>/<ver>/details
//   4) /api/workshop/v1/modules/<id>/<ver>/runtime（无桌面 token 时应为 403）
//   5) /api/workshop/v1/modules/<id>/<ver>/assets/icon.png
//   6) 宿主磁盘上已安装的 ui/index.html 与本地构建产物逐字节一致

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.PBS_HOST_BASE || 'http://127.0.0.1:8000';
const MODULE_ID = 'studio.pixelborder.pixelator';
const VERSION = process.env.PBS_VERSION || '1.0.5';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const repoRoot = join(here, '..');

const rows = [];
function check(name, ok, detail) {
  rows.push({ name, ok, detail });
  const mark = ok === true ? 'PASS' : ok === null ? 'SKIP' : 'FAIL';
  console.log(`[${mark}] ${name} — ${detail}`);
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  return res;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function main() {
  // 1) 后端活着吗
  let health;
  try {
    health = await get('/api/health');
  } catch (err) {
    check('后端可达', false, `${BASE} 连接失败（${err.cause?.code || err.message}）——请先启动 Lumina Studio`);
    return summary();
  }
  check('后端可达', health.ok, `${BASE}/api/health → ${health.status}`);

  // 2) 已安装模块状态
  const listRes = await get('/api/workshop/v1/modules');
  const list = await listRes.json().catch(() => ({}));
  const modules = list.modules || list;
  const mine = Array.isArray(modules) ? modules.find((m) => m.module_id === MODULE_ID) : null;
  check('模块已安装', !!mine, mine ? `active=${mine.active_version} previous=${mine.previous_version ?? '—'} versions=${(mine.versions || []).join(',')}` : '未找到该模块');
  if (!mine) return summary();
  check('已激活目标版本', mine.active_version === VERSION, `active_version=${mine.active_version}（期望 ${VERSION}）`);
  check('模块处于启用状态', mine.enabled === true, `enabled=${mine.enabled}`);
  check('启动失败计数为 0', (mine.consecutive_start_failures ?? 0) === 0, `consecutive_start_failures=${mine.consecutive_start_failures ?? 0}`);

  // 3) 详情
  const detailsRes = await get(`/api/workshop/v1/modules/${MODULE_ID}/${VERSION}/details`);
  if (detailsRes.ok) {
    const d = await detailsRes.json();
    check('详情可读', true, `status=${detailsRes.status} version=${d.version ?? d.active_version ?? '?'} permissions=${(d.permissions || []).map((p) => p.name || p).join('/') || '—'}`);
  } else {
    check('详情可读', false, `status=${detailsRes.status}`);
  }

  // 4) 运行时 HTML 无 token 访问（设计上必须是 403）
  const runtimeRes = await get(`/api/workshop/v1/modules/${MODULE_ID}/${VERSION}/runtime`);
  check('运行时页需桌面 token', runtimeRes.status === 403, `status=${runtimeRes.status}（期望 403，只能由应用内打开）`);

  // 5) 图标资产
  try {
    const iconRes = await get(`/api/workshop/v1/modules/${MODULE_ID}/${VERSION}/assets/icon.png`);
    if (iconRes.ok) {
      const bytes = Buffer.from(await iconRes.arrayBuffer());
      const local = readFileSync(join(repoRoot, 'assets', 'icon.png'));
      check('资产图标与本地一致', sha256(bytes) === sha256(local), `${bytes.length} B sha=${sha256(bytes).slice(0, 16)}`);
    } else {
      check('资产图标可读', false, `status=${iconRes.status}`);
    }
  } catch (err) {
    check('资产图标可读', false, String(err.message || err));
  }

  // 6) 宿主磁盘字节 vs 本地构建
  const dataDir = process.env.LUMINA_WORKSHOP_DATA_DIR || join(process.env.LOCALAPPDATA || '', 'Lumina Launcher', 'shared-data', 'workshop');
  const installedHtml = join(dataDir, 'modules', MODULE_ID, VERSION, 'ui', 'index.html');
  const builtHtml = join(repoRoot, 'dist', 'ui', 'index.html');
  try {
    const a = sha256(readFileSync(installedHtml));
    const b = sha256(readFileSync(builtHtml));
    check('宿主页面 = 待发布构建', a === b, `installed=${a.slice(0, 16)} built=${b.slice(0, 16)}`);
  } catch (err) {
    check('宿主页面 = 待发布构建', false, `读取失败：${err.message}`);
  }

  // 7) 运行时健康记录（宿主自己记的最后一次启动结果）
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'install-state.json'), 'utf8'));
    const entry = (state.modules || []).find((m) => m.module_id === MODULE_ID);
    if (entry) {
      check('最近一次运行时结果', entry.consecutive_start_failures === 0 ? true : false,
        `consecutive_start_failures=${entry.consecutive_start_failures}`);
    }
  } catch { /* 非必需 */ }

  return summary();
}

function summary() {
  const pass = rows.filter((r) => r.ok === true).length;
  const fail = rows.filter((r) => r.ok === false).length;
  console.log(`\n合计 ${rows.length} 项：通过 ${pass}，失败 ${fail}`);
  if (fail) {
    console.log('\n仍需人工确认（本脚本无法代做）：在 Lumina Studio 里打开 创意工坊 → 像素工坊，确认画面正常、按钮可用、能交接回宿主。');
    process.exitCode = 1;
  } else {
    console.log('\n接口与字节层面全部一致；应用内实际打开仍需人工点一次（届时宿主日志会出现 runtime 200 + runtime-success）。');
  }
}

await main();
