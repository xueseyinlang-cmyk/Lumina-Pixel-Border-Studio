/* ============================================================
 * 自检：从已构建的单文件 HTML 中抽出 <script id="pixel-core">，
 * 在 Node 里跑纯函数断言（对应 WEB_REWRITE_PLAN.md §5.1 的 W1–W17 中可数值化部分）。
 * 用法：node test/selftest.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '..', 'dist', 'pixel-border-studio.html');
const html = readFileSync(htmlPath, 'utf8');
const m = html.match(/<script id="pixel-core">([\s\S]*?)<\/script>/);
if (!m) throw new Error('未找到 pixel-core 段');
const src = m[1];
const Core = new Function('"use strict";' + src + '\n;return Core;')();
const P = Core.Params;

let pass = 0, fail = 0;
const rows = [];
function ok(name, cond, extra) {
  if (cond) { pass++; rows.push(['PASS', name, extra || '']); }
  else { fail++; rows.push(['FAIL', name, extra || '']); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/* ---------- 测试用图片构造 ---------- */
function makeImg(w, h, fn) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      const o = (y * w + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c.length > 3 ? c[3] : 255;
    }
  }
  return { w, h, rgba };
}
const PAL = [[26, 27, 58], [244, 214, 120], [232, 122, 92], [92, 60, 120], [40, 44, 80], [200, 180, 210]];
function pixelArt(w = 512, h = 512, cell = 16) {
  const cols = Math.floor(w / cell), rows = Math.floor(h / cell);
  return makeImg(w, h, (x, y) => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const v = (cx * 7 + cy * 13 + ((cx * cy) % 5)) % PAL.length;
    const band = cy < rows * 0.45 ? 0 : (cy < rows * 0.7 ? 2 : 4);
    return PAL[(v + band) % PAL.length];
  });
}
function gradient(w = 960, h = 640) {
  /* 模拟真实照片：平滑渐变 + 抖动噪声（种子固定，保证可复现） */
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const noise = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * 7;
  return makeImg(w, h, (x, y) => {
    const t = y / h, n = noise[y * w + x];
    return [Math.round(40 + 180 * t + n), Math.round(30 + 120 * t - n), Math.round(90 + 90 * (1 - t) + n)];
  });
}

/* ================= Params ================= */
{
  const d = P.normalize({});
  ok('P1 默认值 = ParamDefaults', d.scale === 8 && d.borderWidth === 1 && d.borderStyle === 'grid' && d.borderRadius === 0 && d.borderSecondMode === 'band');
  const c = P.normalize({ scale: 0 }); ok('P2 scale 下界夹取 0→1', c.scale === 1, 'scale=' + c.scale);
  const u = P.normalize({ scale: 99 }); ok('P3 scale 上界夹取 99→16', u.scale === 16, 'scale=' + u.scale);
  const r = P.normalize({ scale: 8, borderRadius: 99 }); ok('P4 半径 clamp ≤ floor(scale/2)', r.borderRadius === 4, 'R=' + r.borderRadius);
  const e = P.normalize({ borderStyle: 'nope', borderBlend: 'nope' }); ok('P5 非法枚举回落默认', e.borderStyle === 'grid' && e.borderBlend === 'over');
  const o = P.normalize({ borderOpacity: 5 }); ok('P6 不透明度夹取 ≤1', o.borderOpacity === 1);
  const sw = P.normalize({ borderWidth: 3, borderSecondEnabled: true, borderSecondWidth: 9 }); ok('P7 次色带宽度 ≤ 主线宽', sw.borderSecondWidth === 3, 't2=' + sw.borderSecondWidth);
  const k1 = P.keys(P.normalize({ borderWidth: 1 })).renderKey;
  const k2 = P.keys(P.normalize({ borderWidth: 2 })).renderKey;
  const g1 = P.keys(P.normalize({ borderWidth: 1 })).gridKey;
  ok('P8 renderKey 含描边宽度、gridKey 不受影响', k1 !== k2 && g1 === P.keys(P.normalize({ borderWidth: 9 })).gridKey);
  ok('P9 renderKey 含 scale', P.keys(P.normalize({ scale: 3 })).renderKey !== P.keys(P.normalize({ scale: 4 })).renderKey);
  ok('P10 描述串包含位置/混合', P.describeBorder(P.normalize({})).includes('全部网格'));
}

/* ================= W1 网格检测 ================= */
{
  const img = pixelArt(512, 512, 16);
  const g = Core.Detect.detectGrid(img, { minCell: 2, maxCell: 64 });
  ok('W1a 16px 像素画检测出 16px / 32×32', g.cellW === 16 && g.cellH === 16 && g.cols === 32 && g.rows === 32, g.cellW + 'px ' + g.cols + 'x' + g.rows + ' conf=' + g.confidence.toFixed(2));
  ok('W1b 来源为 auto 且置信度 1', g.source === 'auto' && g.confidence > 0.99);
  const ph = gradient(960, 640);
  const gf = Core.Detect.detectGrid(ph, { minCell: 2, maxCell: 64 });
  ok('W1c 平滑渐变判为 fallback（confidence=0）', gf.source === 'fallback' && gf.confidence === 0, gf.notes[0] || '');
  const mg = Core.Detect.manualGrid(100, 60, 10, 12);
  ok('W1d 手动网格覆盖整数格', mg.cols === 10 && mg.rows === 5 && mg.edgesX[mg.edgesX.length - 1] === 100);
}

/* ================= W2 采样 ================= */
{
  const img = makeImg(64, 64, (x, y) => {
    const cx = (x / 16) | 0, cy = (y / 16) | 0;
    return PAL[(cx + cy * 2) % PAL.length];
  });
  const grid = Core.Detect.manualGrid(64, 64, 16, 16);
  const lg = Core.Pixelate.downsample(img, grid, 0.6);
  let exact = true;
  for (let i = 0; i < 16; i++) {
    const cx = i % 4, cy = (i / 4) | 0;
    const want = PAL[(cx + cy * 2) % PAL.length];
    const o = i * 4;
    if (Math.abs(lg.rgba[o] - want[0]) > 0 || Math.abs(lg.rgba[o + 1] - want[1]) > 0 || lg.rgba[o + 3] !== 255) exact = false;
  }
  ok('W2a 纯色块采样取回原色（RGBA 精确）', exact && lg.w === 4 && lg.h === 4);
  const alphaImg = makeImg(16, 16, () => [255, 0, 0, 0]);
  const alg = Core.Pixelate.downsample(alphaImg, Core.Detect.manualGrid(16, 16, 16, 16), 0.6);
  ok('W2b 全透明格逻辑 alpha=0', alg.rgba[3] === 0);
}

/* ================= W3 量化 ================= */
{
  const few = makeImg(20, 20, (x, y) => PAL[(x + y) % 5]);
  const q1 = Core.Pixelate.quantize(few, 8);
  let same = true;
  for (let i = 0; i < few.w * few.h; i++) {
    const o = i * 4;
    if (q1.img.rgba[o] !== few.rgba[o] || q1.img.rgba[o + 1] !== few.rgba[o + 1] || q1.img.rgba[o + 2] !== few.rgba[o + 2]) { same = false; break; }
  }
  ok('W3a distinct ≤ colors 时逐像素不变', same && q1.palette.length === 5);
  const many = makeImg(64, 64, (x, y) => [x * 4 % 256, y * 4 % 256, (x + y) * 2 % 256]);
  const q2 = Core.Pixelate.quantize(many, 2);
  const set = new Set();
  for (let i = 0; i < many.w * many.h; i++) {
    const o = i * 4; set.add(q2.img.rgba[o] + ',' + q2.img.rgba[o + 1] + ',' + q2.img.rgba[o + 2]);
  }
  ok('W3b colors=2 时输出 ≤2 色', set.size <= 2, '实际 ' + set.size + ' 色');
}

/* ================= W4 格线几何 ================= */
{
  const log = makeImg(4, 4, () => [10, 20, 30, 255]);   /* 每格 1 像素的逻辑图 */
  const p = P.normalize({ scale: 6, borderWidth: 2, borderColor: '#000000' });
  const mk = Core.Border.buildMask(log, 6, p);
  const W = mk.w;
  const at = (x, y) => mk.paint[y * W + x];
  ok('W4a 内部竖线覆盖中心两侧各 1px', at(5, 10) === 1 && at(6, 10) === 1 && at(4, 10) === 0 && at(7, 10) === 0);
  ok('W4b 外框贴边 [0,t)/[W-t,W)', at(0, 10) === 1 && at(1, 10) === 1 && at(2, 10) === 0 && at(W - 1, 10) === 1 && at(W - 2, 10) === 1);
  const p0 = P.normalize({ scale: 6, borderWidth: 0 });
  ok('W4c t=0 不产生任何描边', Core.Border.buildMask(log, 6, p0).paint.every((v) => v === 0));
  const pInner = P.normalize({ scale: 6, borderWidth: 2, borderScope: 'inner' });
  const mi = Core.Border.buildMask(log, 6, pInner);
  ok('W4d scope=inner 无外框', mi.paint[10 * W + 0] === 0 && mi.paint[10 * W + 5] === 1);
  const pOuter = P.normalize({ scale: 6, borderWidth: 2, borderScope: 'outer' });
  const mo = Core.Border.buildMask(log, 6, pOuter);
  ok('W4e scope=outer 只有外框', mo.paint[10 * W + 0] === 1 && mo.paint[10 * W + 5] === 0);
  /* edge-aware：同色块之间不画线 */
  const flat = makeImg(4, 4, () => [10, 20, 30, 255]);
  const pEA = P.normalize({ scale: 6, borderWidth: 2, borderEdgeAware: true, borderEdgeThreshold: 24 });
  const mFlat = Core.Border.buildMask(flat, 6, pEA).paint;
  ok('W4f edge-aware 同色块之间不画内部线（外框仍画）',
    mFlat[10 * W + 5] === 0 && mFlat[10 * W + 6] === 0 && mFlat[10 * W + 0] === 1);
  const differ = makeImg(4, 4, (x, y) => (x === 0 ? [200, 10, 10, 255] : [10, 20, 30, 255]));
  const mEA = Core.Border.buildMask(differ, 6, pEA);
  ok('W4g edge-aware 强对比处照画', mEA.paint[10 * W + 5] === 1);
}

/* ================= W5 混合公式 ================= */
{
  const B = Core.Border.blendChannel;
  ok('W5a over α=1 → 纯线色', B(100, 200, 1, 'over') === 200);
  ok('W5b over α=0 → 原色', B(100, 200, 0, 'over') === 100);
  ok('W5c over α=0.5 = (100+200)/2', B(100, 200, 0.5, 'over') === 150);
  ok('W5d multiply α=0.5 = 0.5*100+0.5*(100*200/255)', B(100, 200, 0.5, 'multiply') === Math.round(0.5 * 100 + 0.5 * (100 * 200 / 255)));
  ok('W5e darken 取较暗', B(30, 200, 1, 'darken') === 30 && B(200, 30, 1, 'darken') === 30);
  ok('W5f 取整为 floor(x+0.5)', B(10, 11, 0.5, 'over') === Math.floor(10.5 + 0.5));
  /* applyBorder 端到端 */
  const base = makeImg(2, 1, (x) => (x === 0 ? [100, 100, 100, 255] : [100, 100, 100, 255]));
  const mask = { w: 2, h: 1, paint: new Uint8Array([1, 0]) };
  const p = P.normalize({ borderWidth: 1, borderOpacity: 0.5, borderColor: '#000000' });
  const out = Core.Border.apply(base, mask, p);
  ok('W5g apply α=0.5 over #000 → 50', out.rgba[0] === 50 && out.rgba[3] === 255);
}

/* ================= W6 圆角 ================= */
{
  const t0 = Core.Border.buildCellTemplate(8, 0, 1, 0);
  const n0 = t0.reduce((a, b) => a + (b ? 1 : 0), 0);
  ok('W6a R=0,t=1,t2=0 → 4s−4=28 像素环', n0 === 28, 'n=' + n0);
  const t2 = Core.Border.buildCellTemplate(8, 2, 1, 1);
  const rowStr = (r) => Array.from(t2.subarray(r * 8, r * 8 + 8)).join('');
  const shape = [0, 1, 2, 3, 4, 5, 6, 7].map(rowStr);
  ok('W6b s=8,R=2,t1=1,t2=1 模板形状与文档一致',
    shape[0] === '01111110' && shape[1] === '12222221' && shape[3] === '12000021' && shape[7] === '01111110',
    shape.join(' / '));
  const t4 = Core.Border.buildCellTemplate(8, 4, 1, 0);
  const t2c = Core.Border.buildCellTemplate(8, 2, 1, 0);
  ok('W6c 圆角越大环面积不增（周长变短）',
    t4.reduce((a, b) => a + (b ? 1 : 0), 0) <= t2c.reduce((a, b) => a + (b ? 1 : 0), 0));
}

/* ================= W7 双色 ================= */
{
  const log = makeImg(4, 4, () => [10, 20, 30, 255]);
  const band = P.normalize({ scale: 6, borderWidth: 2, borderSecondEnabled: true, borderSecondWidth: 1, borderSecondMode: 'band', borderSecondColor: '#ffffff' });
  const mb = Core.Border.buildMask(log, 6, band);
  const W = mb.w;
  ok('W7a 内外色带：外色在外、内色在内', mb.paint[10 * W + 5] === 1 && mb.paint[10 * W + 6] === 2);
  const single = P.normalize({ scale: 6, borderWidth: 2, borderSecondEnabled: false });
  ok('W7b 关闭双色 → 全部主色', Core.Border.buildMask(log, 6, single).paint.every((v) => v === 0 || v === 1));
  const check = P.normalize({ scale: 6, borderWidth: 1, borderSecondEnabled: true, borderSecondMode: 'checker', borderSecondColor: '#ffffff' });
  const mc = Core.Border.buildMask(log, 6, check);
  const v0 = mc.paint[(0 * 6 + 3) * W + 6];   /* k=1,row=0 */
  const v1 = mc.paint[(1 * 6 + 3) * W + 6];   /* k=1,row=1 */
  ok('W7c 棋盘交替按 (k-1+row) 奇偶换色', v0 === 1 && v1 === 2, 'v0=' + v0 + ' v1=' + v1);
  ok('W7d 棋盘交替下外框恒主色', mc.paint[10 * W + 0] === 1 && mc.paint[3 * W + 0] === 1 && mc.paint[9 * 6 + 3 > 0 ? 0 : 0] === 1);
  const ch1 = P.normalize({ scale: 6, borderWidth: 1, borderSecondEnabled: true, borderSecondMode: 'checker', borderSecondWidth: 1 });
  const ch2 = P.normalize({ scale: 6, borderWidth: 1, borderSecondEnabled: true, borderSecondMode: 'checker', borderSecondWidth: 4 });
  const c1 = Core.Border.buildMask(log, 6, ch1).paint;
  const c2 = Core.Border.buildMask(log, 6, ch2).paint;
  ok('W7e 棋盘交替忽略 borderSecondWidth', c1.length === c2.length && c1.every((v, i) => v === c2[i]));
}

/* ================= W8 共存切换 ================= */
{
  const log = makeImg(6, 6, (x, y) => PAL[(x + y * 3) % PAL.length]);
  const gridP = P.normalize({ scale: 8, borderStyle: 'grid', borderWidth: 1 });
  const cellP = P.normalize({ scale: 8, borderStyle: 'cell', borderWidth: 1, borderRadius: 2 });
  const base = Core.Pixelate.upscale(log, 8);
  const g1 = Core.Border.apply(base, Core.Border.buildMask(log, 8, gridP), gridP);
  Core.Border.apply(base, Core.Border.buildMask(log, 8, cellP), cellP);
  const g2 = Core.Border.apply(base, Core.Border.buildMask(log, 8, gridP), gridP);
  ok('W8a grid→cell→grid 逐像素一致（无残影）', g1.rgba.every((v, i) => v === g2.rgba[i]));
  ok('W8b cell 样式产生不同的掩码', Core.Border.buildMask(log, 8, cellP).paint.some((v, i) => v !== Core.Border.buildMask(log, 8, gridP).paint[i]));
}

/* ================= 管线：W9 / W10 / W12 / W15 / W17 ================= */
{
  const img = pixelArt(256, 256, 16);   /* 16×16 逻辑 */
  const pl = Core.Pipeline.create();
  pl.setSource(img);
  const r1 = pl.run(P.normalize({ scale: 8, colors: 16 }), { previewMaxSide: 2048 });
  ok('R1 端到端输出尺寸 = 逻辑 × scale', r1.rendered.w === r1.logical.w * r1.scaleUsed && r1.logical.w === 16, r1.rendered.w + 'px');
  ok('R2 网格已被缓存（首轮 sample/palette/render 均执行）', r1.used.grid === 1 && r1.used.sample === 1 && r1.used.render === 1);

  const r2 = pl.run(P.normalize({ scale: 8, colors: 16, borderWidth: 3 }), { previewMaxSide: 2048 });
  ok('W10a 改 borderWidth 不重跑 grid/sample/palette', !r2.used.grid && !r2.used.sample && !r2.used.palette && r2.used.render === 1);

  const r3 = pl.run(P.normalize({ scale: 8, colors: 16, borderWidth: 3, scale: 9 }), { previewMaxSide: 2048 });
  ok('W17a 改 scale 只重跑 render', !r3.used.grid && !r3.used.sample && r3.used.render === 1 && r3.rendered.w === r3.logical.w * 9);

  /* W9 编辑器直连 */
  const lg = { w: r1.logical.w, h: r1.logical.h, rgba: new Uint8ClampedArray(r1.logical.rgba) };
  lg.rgba[0] = 255; lg.rgba[1] = 0; lg.rgba[2] = 0; lg.rgba[3] = 255;
  pl.setOverride(Object.assign({}, lg, { stamp: 1 }));
  const r4 = pl.run(P.normalize({ scale: 8, colors: 2 }), { previewMaxSide: 2048 });
  const center = (4 * r4.rendered.w + 4) * 4;
  ok('W9a override 逐像素参与渲染且不被量化（colors=2）', r4.rendered.rgba[center] === 255 && r4.rendered.rgba[center + 1] === 0 && r4.usingOverride);
  ok('W9b override 时 palette 来自 override 且 ≤100', r4.palette.length > 2 && r4.palette.length <= 100);
  ok('W9c override 不重跑 sample/palette', !r4.used.grid && !r4.used.sample && r4.used.render === 1);
  pl.setOverride({ w: 3, h: 3, rgba: new Uint8ClampedArray(36), stamp: 2 });
  const r5 = pl.run(P.normalize({ scale: 8 }), { previewMaxSide: 2048 });
  ok('W9d 尺寸不符 → 忽略并给 note', !r5.usingOverride && r5.notes.some((n) => n.includes('不一致')));
  pl.setOverride(null);

  /* W15 预览夹取（不改 settings.scale）与导出上限 */
  const big = makeImg(512, 512, (x, y) => PAL[((x >> 1) + (y >> 1)) % PAL.length]);
  const pl2 = Core.Pipeline.create();
  pl2.setSource(big);
  const rb = pl2.run(P.normalize({ gridMode: 'manual', cellW: 1, cellH: 1, scale: 16, borderWidth: 0 }), { previewMaxSide: 2048 });
  ok('W15a 预览按 previewMaxSide 夹有效倍率', rb.scaleUsed === 4 && rb.settings.scale === 16, 'eff=' + rb.scaleUsed);
  ok('W15b 预览夹取给 note', rb.notes.some((n) => n.includes('上限')));
  const re = pl2.run(P.normalize({ gridMode: 'manual', cellW: 1, cellH: 1, scale: 16, borderWidth: 0 }), { export: true, previewMaxSide: 2048 });
  ok('W15c 导出按 MAX_RENDER_SIDE 夹取（4096/512=8）', re.scaleUsed === 8, 'eff=' + re.scaleUsed);

  /* W12 1× 无描边（逻辑图直接输出，尺寸 = 逻辑） */
  ok('W12a 逻辑图尺寸即 1× 尺寸且无描边', r1.logical.w === 16 && r1.logical.h === 16);
}

/* ================= 缓存清理（W10b gridMode 变化） ================= */
{
  const img = pixelArt(256, 256, 16);
  const pl = Core.Pipeline.create();
  pl.setSource(img);
  pl.run(P.normalize({ scale: 4 }), { previewMaxSide: 1024 });
  const r = pl.run(P.normalize({ scale: 4, gridMode: 'manual', cellW: 8, cellH: 8 }), { previewMaxSide: 1024 });
  ok('W10b 改 gridMode 重跑 grid/sample/palette', r.used.grid === 1 && r.used.sample === 1 && r.used.palette === 1 && r.grid.source === 'manual');
}

/* ================= W16 透明度 ================= */
{
  const log = makeImg(3, 3, () => [255, 0, 0, 0]);
  const p = P.normalize({ scale: 4, borderWidth: 1, borderOpacity: 0.6, borderColor: '#000000' });
  const base = Core.Pixelate.upscale(log, 4);
  const out = Core.Border.apply(base, Core.Border.buildMask(log, 4, p), p);
  ok('W16 描边处 alpha 抬到 round(255*opacity)', out.rgba[3] === Math.round(255 * 0.6), 'a=' + out.rgba[3]);
}

/* ================= 渲染缓存转移（W18） / 滑杆上限（W19） ================= */
{
  const pl18 = Core.Pipeline.create();
  pl18.setSource(pixelArt(256, 256, 16));
  const p18 = P.normalize({ scale: 8, colors: 16, borderWidth: 2 });
  const a1 = pl18.run(p18, { previewMaxSide: 2048 });
  const snap = new Uint8ClampedArray(a1.rendered.rgba);
  const a2 = pl18.run(p18, { previewMaxSide: 2048 });
  ok('W18b 相同参数第二次 run 命中缓存（同一 rendered 对象，故不可被转移）', a2.rendered === a1.rendered);
  a1.rendered.rgba.buffer.transfer();            /* 模拟 Worker 转移后的 detach */
  const a3 = pl18.run(p18, { previewMaxSide: 2048 });
  ok('W18a 缓存被 detach 后再次 run 会重算且像素一致',
     !a3.rendered.rgba.buffer.detached && a3.rendered.rgba.length === snap.length &&
     a3.rendered.rgba.every((v, i) => v === snap[i]), a3.rendered.w + 'px');
}

{
  const b8 = P.sliderBounds(P.normalize({ scale: 8, borderWidth: 1 }));
  ok('W19a 半径滑杆上限 = floor(scale/2)，与 normalize 夹取一致',
     b8.borderRadius === 4 && P.normalize({ scale: 8, borderRadius: 99 }).borderRadius === 4);
  ok('W19b 内色带宽度上限 = 主线宽（grid 样式）',
     b8.borderSecondWidth === 1 && P.normalize({ borderWidth: 1, borderSecondWidth: 9 }).borderSecondWidth === 1);
  ok('W19c cell 样式内色带宽度上限 = min(主线宽, floor(scale/2))',
     P.sliderBounds(P.normalize({ scale: 8, borderWidth: 6, borderStyle: 'cell' })).borderSecondWidth === 4);
  const odd = P.sliderBounds(P.normalize({ scale: 3, borderWidth: 5 }));
  ok('W19d 奇数 scale 取 floor（scale=3 → 半径上限 1）', odd.borderRadius === 1 && odd.borderSecondWidth === 5);
}

/* ================= 性能（W13） =================
 * 单次采样在负载机/CI 上会被调度抖动放大，而 W13 评测的是「引擎本身能否在预算内出一帧」。
 * 因此每条先预热一次、再取 3 次中的最小值（min of 3），并打印全部采样值便于诊断。
 * 不提供环境变量放宽预算：预算属于契约，不应该在 CI 里被静默放大。
 */
function bestOf3(fn) {
  fn();                     /* 预热：JIT 与首次分配不计入 */
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    fn();
    samples.push(Math.round(performance.now() - t));
  }
  return { min: Math.min.apply(null, samples), samples: samples };
}
{
  const img = pixelArt(1000, 1000, 32);
  const base = P.normalize({ scale: 8 });
  /* 首帧：每次都用全新管线，保证是冷启动而不是命中缓存的 0ms */
  const firstFrame = bestOf3(() => {
    const pl = Core.Pipeline.create();
    pl.setSource(img);
    return pl.run(base, { previewMaxSide: 2048 });
  });
  ok('W13a 1MP → 32×32 → 256² 首帧 ≤ 300ms（min of 3）', firstFrame.min <= 300,
     firstFrame.samples.join('/') + 'ms');

  /* 改描边参数：只应重跑 render，预算 100ms */
  const pl2 = Core.Pipeline.create();
  pl2.setSource(img);
  const r1 = pl2.run(base, { previewMaxSide: 2048 });        /* 先建好缓存 */
  let w = 1;
  let n = 0;
  let last = null;
  const borderChange = bestOf3(() => {
    w = 2 + (n++);            /* 每次换一个没用过的线宽，确保不会命中缓存 */
    last = pl2.run(P.normalize(Object.assign({}, base, { borderWidth: w })), { previewMaxSide: 2048 });
    return last;
  });
  ok('W13b 改描边参数预览 ≤ 100ms（min of 3，仅重跑 render）', borderChange.min <= 100,
     borderChange.samples.join('/') + 'ms');
  /* 交叉验证「确实重渲染了、且确实换了像素」——避免预算在缓存命中时被空过 */
  const used = (last && last.used) || {};
  const changed = last && r1.rendered.rgba.some((v, i) => v !== last.rendered.rgba[i]) &&
    !!used.render && !used.grid && !used.sample && !used.palette;
  ok('W13c 改描边参数确实重渲染（used 只含 render，且输出像素变化）', !!changed,
     'used=' + Object.keys(used).join('+'));
}

/* ---------- 输出 ---------- */
for (const [st, name, extra] of rows) {
  console.log((st === 'PASS' ? '✓' : '✗') + ' ' + name + (extra ? '  [' + extra + ']' : ''));
}
console.log('\n合计 ' + (pass + fail) + ' 项：通过 ' + pass + '，失败 ' + fail);
if (fail) process.exitCode = 1;
