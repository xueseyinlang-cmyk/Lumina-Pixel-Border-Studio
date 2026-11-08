/* ============================================================
 * pixel-core —— 纯数值内核（主线程与 Worker 共用同一份源码）
 * 依据：docs/WEB_REWRITE_PLAN.md §1.2 / §1.3 / §3.3 / §4
 * 约束：不触碰 DOM、不发网络请求、不写任何存储
 * ============================================================ */
var Core = (function () {
  'use strict';

  /* ---------------- 常量（§1.3，阈值一律沿用，不得改动） ---------------- */
  const MAX_LOGICAL_SIDE = 512;
  const MAX_SCALE = 16;
  const MAX_BORDER_WIDTH = 64;
  const MAX_RENDER_SIDE = 4096;
  const MAX_INPUT_PIXELS = 24000000;   /* 24MP 上限 */
  const MAX_CELL = 256;
  const F_MIN = 20.0;                  /* 网格检测 F 阈值 */
  const F_FULL = 60.0;
  /* 显著性门槛：无真实格线时"按相位取最大值"会随样本量虚高 F（n=640、R²≈0.04 也能到 F≈24），
     故额外要求解释度 R² ≥ 0.15，才能把"平滑渐变"判为 fallback（W1c）。
     桌面端只用 F 阈值；此处为 Web 侧补充，已在交付说明中标注。 */
  const R2_MIN = 0.15;
  const TARGET_CELLS = 96;
  const SETTINGS_KEY = 'pbs.settings';
  const PREVIEW_MAX_SIDE_DEFAULT = 2048;
  const PREVIEW_MAX_SIDE_MIN = 512;

  /* ---------------- 小工具 ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clampInt(v, lo, hi, dflt) {
    let n = Number(v);
    if (!isFinite(n)) n = dflt;
    n = Math.round(n);
    return Math.min(hi, Math.max(lo, n));
  }
  function clampNum(v, lo, hi, dflt) {
    let n = Number(v);
    if (!isFinite(n)) n = dflt;
    return Math.min(hi, Math.max(lo, n));
  }
  function pickEnum(v, allowed, dflt) {
    return allowed.indexOf(v) >= 0 ? v : dflt;
  }
  function hexToRgb(hex) {
    let s = String(hex || '').trim();
    if (s.charAt(0) === '#') s = s.slice(1);
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 0, g: 0, b: 0 };
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
  }
  function rgbToHex(r, g, b) {
    const h = (n) => ('0' + Math.round(clamp(n, 0, 255)).toString(16)).slice(-2);
    return '#' + h(r) + h(g) + h(b);
  }

  /* ---------------- Params（§1.2 契约） ---------------- */
  const ParamDefaults = {
    gridMode: 'auto', cellW: 8, cellH: 8, minCell: 2, maxCell: 64,
    coreRatio: 0.6, denoise: true,
    colors: 24, scale: 8,
    borderEnabled: true, borderWidth: 1, borderColor: '#000000', borderOpacity: 1.0,
    borderScope: 'grid', borderBlend: 'over', borderEdgeAware: false, borderEdgeThreshold: 24,
    borderStyle: 'grid', borderRadius: 0,
    borderSecondEnabled: false, borderSecondWidth: 1, borderSecondColor: '#ffffff',
    borderSecondMode: 'band'
  };

  const SCOPE_LABELS = { grid: '全部网格', inner: '仅内部', outer: '仅外框' };
  const BLEND_LABELS = { over: '覆盖', multiply: '正片叠底', darken: '压暗' };
  const STYLE_LABELS = { grid: '格线黑边', cell: '块状描边' };
  const SECOND_MODE_LABELS = { band: '内外色带', checker: '棋盘交替' };

  function normalize(input) {
    const p = Object.assign({}, ParamDefaults, input || {});
    const out = {};
    out.gridMode = pickEnum(p.gridMode, ['auto', 'manual'], 'auto');
    out.cellW = clampInt(p.cellW, 1, MAX_CELL, 8);
    out.cellH = clampInt(p.cellH, 1, MAX_CELL, 8);
    out.minCell = clampInt(p.minCell, 2, 64, 2);
    out.maxCell = clampInt(p.maxCell, out.minCell, 128, 64);
    out.coreRatio = clampNum(p.coreRatio, 0.1, 1, 0.6);
    out.denoise = !!p.denoise;
    out.colors = clampInt(p.colors, 0, 64, 24);
    out.scale = clampInt(p.scale, 1, MAX_SCALE, 8);
    out.borderEnabled = !!p.borderEnabled;
    out.borderWidth = clampInt(p.borderWidth, 0, MAX_BORDER_WIDTH, 1);
    out.borderColor = hexToRgb(p.borderColor) && String(p.borderColor).trim() ? p.borderColor : '#000000';
    out.borderOpacity = clampNum(p.borderOpacity, 0, 1, 1);
    out.borderScope = pickEnum(p.borderScope, ['grid', 'inner', 'outer'], 'grid');
    out.borderBlend = pickEnum(p.borderBlend, ['over', 'multiply', 'darken'], 'over');
    out.borderEdgeAware = !!p.borderEdgeAware;
    out.borderEdgeThreshold = clampInt(p.borderEdgeThreshold, 0, 255, 24);
    out.borderStyle = pickEnum(p.borderStyle, ['grid', 'cell'], 'grid');
    /* §4.2：半径 clamp ≤ floor(scale/2)（几何容量，不是圆点退化阈值） */
    out.borderRadius = clampInt(p.borderRadius, 0, Math.floor(out.scale / 2), 0);
    out.borderSecondEnabled = !!p.borderSecondEnabled;
    out.borderSecondWidth = clampInt(p.borderSecondWidth, 0, out.borderWidth, 1);
    out.borderSecondColor = String(p.borderSecondColor || '#ffffff').trim() || '#ffffff';
    out.borderSecondMode = pickEnum(p.borderSecondMode, ['band', 'checker'], 'band');
    return out;
  }

  /* 滑杆上限：与 normalize / 渲染期夹取保持一致，供 UI 设置 input.max。
     否则 DOM 的 max（16）大于实际生效上限，把手拖到右侧会被夹回，看起来「拖不到最大值」。 */
  function sliderBounds(input) {
    const s = normalize(input || ParamDefaults);
    const half = Math.max(0, Math.floor(s.scale / 2));
    const cell = s.borderStyle === 'cell';
    return {
      borderRadius: half,
      borderSecondWidth: cell ? Math.min(s.borderWidth, half) : s.borderWidth
    };
  }

  function signatureOfGrid(g) {
    return g.cols + 'x' + g.rows + ':' + g.cellW + 'x' + g.cellH + ':' + g.phaseX + ',' + g.phaseY;
  }

  function keys(p) {
    const q = normalize(p);
    const gridKey = 'grid|' + q.gridMode + '|' + q.cellW + 'x' + q.cellH + '|' + q.minCell + '-' + q.maxCell;
    const logicalKey = 'logical|' + gridKey + '|' + q.coreRatio + '|' + (q.denoise ? 1 : 0);
    const paletteKey = 'quant|' + logicalKey + '|' + q.colors;
    const renderKey = 'render|' + paletteKey + '|' + q.scale + '|' + q.borderStyle + '|' + q.borderRadius +
      '|' + (q.borderEnabled ? 1 : 0) + '|' + q.borderWidth + '|' + q.borderColor + '|' + q.borderOpacity +
      '|' + q.borderScope + '|' + q.borderBlend + '|' + (q.borderEdgeAware ? 1 : 0) + '|' + q.borderEdgeThreshold +
      '|' + (q.borderSecondEnabled ? 1 : 0) + '|' + q.borderSecondWidth + '|' + q.borderSecondColor + '|' + q.borderSecondMode;
    return { gridKey: gridKey, logicalKey: logicalKey, paletteKey: paletteKey, renderKey: renderKey };
  }

  function describeBorder(p) {
    if (!p.borderEnabled || p.borderWidth <= 0) return '无描边';
    const parts = [];
    parts.push(p.borderWidth + 'px');
    parts.push(p.borderColor);
    parts.push(Math.round(p.borderOpacity * 100) + '%');
    parts.push(SCOPE_LABELS[p.borderScope] || p.borderScope);
    parts.push(BLEND_LABELS[p.borderBlend] || p.borderBlend);
    if (p.borderStyle === 'cell') {
      parts.push('块状描边' + (p.borderRadius > 0 ? '·圆角' + p.borderRadius : ''));
    } else if (p.borderRadius > 0) {
      parts.push('交叉点磨圆' + p.borderRadius);
    }
    if (p.borderSecondEnabled) {
      parts.push(p.borderSecondMode === 'checker' ? '棋盘交替' : ('内外色带 ' + p.borderSecondWidth + 'px ' + p.borderSecondColor));
    }
    return parts.join(' · ');
  }

  /* ---------------- Detect（§1.2；算法与桌面端 detect.py 同构） ---------------- */
  function toGray(rgba, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, n = w * h; i < n; i++) {
      const o = i * 4;
      g[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    }
    return g;
  }

  /* 边界强度曲线：profile[x] = x-1 与 x 之间的竖直边界强度（profile[0]=0） */
  function boundaryProfile(gray, w, h, vertical) {
    const len = vertical ? w : h;
    const prof = new Float32Array(len);
    if (vertical) {
      for (let x = 1; x < w; x++) {
        let s = 0;
        for (let y = 0; y < h; y++) {
          const i = y * w + x;
          s += Math.abs(gray[i] - gray[i - 1]);
        }
        prof[x] = s / h;
      }
    } else {
      for (let y = 1; y < h; y++) {
        let s = 0;
        const row = y * w, prev = (y - 1) * w;
        for (let x = 0; x < w; x++) s += Math.abs(gray[row + x] - gray[prev + x]);
        prof[y] = s / w;
      }
    }
    /* 归一化到 0..1，便于跨尺寸比较（仅影响 R²/coverage，不影响 F 的排序） */
    let mx = 0;
    for (let i = 0; i < len; i++) if (prof[i] > mx) mx = prof[i];
    if (mx > 0) for (let i = 0; i < len; i++) prof[i] /= mx;
    return prof;
  }

  /* ANOVA F 检验：把曲线分成「格线位置 on / 非格线 off」两组 */
  function estimateAxis(prof, minCell, maxCell) {
    const len = prof.length;
    const lower = Math.max(2, minCell);
    const upper = Math.min(maxCell, Math.max(4, Math.floor(len / 3)));
    const cands = [];
    for (let period = lower; period <= upper; period++) {
      let bestOffset = 0, bestSum = -1;
      for (let off = 0; off < period; off++) {
        let s = 0;
        for (let i = off; i < len; i += period) s += prof[i];
        if (s > bestSum) { bestSum = s; bestOffset = off; }
      }
      const start = bestOffset > 0 ? bestOffset : period;
      let sOn = 0, nn = 0;
      const inOn = new Uint8Array(len);
      for (let i = start; i < len; i += period) { sOn += prof[i]; nn++; inOn[i] = 1; }
      if (nn < 2 || nn > len - 2) continue;
      let sOff = 0, nOff = 0;
      for (let i = 1; i < len; i++) if (!inOn[i]) { sOff += prof[i]; nOff++; }
      if (nOff < 2) continue;
      const onM = sOn / nn, offM = sOff / nOff, grand = (sOn + sOff) / (nn + nOff);
      let ssW = 0;
      for (let i = start; i < len; i += period) { const d = prof[i] - onM; ssW += d * d; }
      for (let i = 1; i < len; i++) if (!inOn[i]) { const d = prof[i] - offM; ssW += d * d; }
      const ssB = nn * (onM - grand) * (onM - grand) + nOff * (offM - grand) * (offM - grand);
      const dfW = nn + nOff - 2;
      /* 曲线近似常数（无对比度）时不存在"格线/非格线"差异，判为不可用 */
      const sd = Math.sqrt((ssB + ssW) / Math.max(1, nn + nOff - 1));
      const degenerate = sd < 1e-4;
      const F = degenerate ? 0 : (ssW < 1e-9 ? 1e6 : ssB / (ssW / Math.max(1, dfW)));
      const r2 = (ssB + ssW) > 0 ? ssB / (ssB + ssW) : 0;
      let total = 0;
      for (let i = 1; i < len; i++) total += prof[i];
      const coverage = total > 0 ? sOn / total : 0;
      cands.push({ period: period, phase: bestOffset, f: F, r2: r2, coverage: coverage });
    }
    if (!cands.length) return { period: 0, phase: 0, f: 0, r2: 0, coverage: 0 };
    let best = cands[0];
    for (const c of cands) if (c.f > best.f) best = c;
    /* 抑制 p → 2p 二倍周期：取 F 达到峰值 90% 的最小周期 */
    let pick = best;
    for (const c of cands) if (c.f >= 0.9 * best.f && c.period < pick.period) pick = c;
    return pick;
  }

  function edgesFromAxis(phase, period, len) {
    const edges = [];
    if (period <= 0) { edges.push(0, len); return edges; }
    edges.push(0);
    const start = phase > 0 ? phase : period;
    for (let x = start; x < len; x += period) edges.push(x);
    if (edges[edges.length - 1] !== len) edges.push(len);
    /* 去重/排序（phase 可能使 start 接近 len） */
    const uniq = [];
    for (const e of edges) if (!uniq.length || e !== uniq[uniq.length - 1]) uniq.push(e);
    return uniq;
  }

  function manualGrid(w, h, cellW, cellH) {
    const cx = clampInt(cellW, 1, MAX_CELL, 8), cy = clampInt(cellH, 1, MAX_CELL, 8);
    const ex = [0], ey = [0];
    for (let x = cx; x < w; x += cx) ex.push(x);
    if (ex[ex.length - 1] !== w) ex.push(w);
    for (let y = cy; y < h; y += cy) ey.push(y);
    if (ey[ey.length - 1] !== h) ey.push(h);
    return {
      cols: ex.length - 1, rows: ey.length - 1, cellW: cx, cellH: cy,
      edgesX: ex, edgesY: ey, phaseX: 0, phaseY: 0, confidence: 1, source: 'manual',
      notes: ['手动格子 ' + cx + '×' + cy + 'px']
    };
  }

  function detectGrid(img, opts) {
    const o = opts || {};
    const minCell = Math.max(2, o.minCell || 2), maxCell = Math.max(minCell, o.maxCell || 64);
    const w = img.w, h = img.h;
    const gray = toGray(img.rgba, w, h);
    const px = estimateAxis(boundaryProfile(gray, w, h, true), minCell, maxCell);
    const py = estimateAxis(boundaryProfile(gray, w, h, false), minCell, maxCell);
    const okX = px.period > 0 && px.f >= F_MIN && px.r2 >= R2_MIN;
    const okY = py.period > 0 && py.f >= F_MIN && py.r2 >= R2_MIN;
    const conf = (f) => clamp(f / F_FULL, 0, 1);
    let cellW, cellH, phaseX, phaseY, confidence, source, notes = [];
    if (okX && okY && Math.abs(px.period - py.period) <= 1) {
      cellW = px.period; cellH = py.period; phaseX = px.phase; phaseY = py.phase;
      confidence = Math.min(conf(px.f), conf(py.f)); source = 'auto';
      notes.push('自动检测 ' + cellW + '×' + cellH + 'px（F ' + px.f.toFixed(0) + '/' + py.f.toFixed(0) +
        '，R² ' + px.r2.toFixed(2) + '/' + py.r2.toFixed(2) + '）');
    } else if (okX || okY) {
      const strong = okX && (!okY || px.f >= py.f) ? px : py;
      cellW = cellH = strong.period;
      phaseX = okX ? px.phase : (strong === px ? px.phase : 0);
      phaseY = okY ? py.phase : 0;
      if (!okX) phaseX = strong.phase;
      if (!okY) phaseY = strong.phase;
      confidence = conf(strong.f) * 0.8; source = 'auto';
      notes.push('单轴检测到 ' + strong.period + 'px 周期，另一轴按方格假设沿用');
    } else {
      const cell = Math.max(minCell, Math.round(Math.max(w, h) / TARGET_CELLS));
      cellW = cellH = cell;
      phaseX = phaseY = 0; confidence = 0; source = 'fallback';
      notes.push('未检测到规则网格（最高 F ' + Math.max(px.f, py.f).toFixed(1) + ' < ' + F_MIN +
        '），回退为长边约 ' + TARGET_CELLS + ' 格的估算（格子 ' + cell + 'px）');
    }
    const edgesX = edgesFromAxis(phaseX, cellW, w);
    const edgesY = edgesFromAxis(phaseY, cellH, h);
    return {
      cols: edgesX.length - 1, rows: edgesY.length - 1, cellW: cellW, cellH: cellH,
      edgesX: edgesX, edgesY: edgesY, phaseX: phaseX, phaseY: phaseY,
      confidence: confidence, source: source, notes: notes
    };
  }

  function gridFor(img, p) {
    if (p.gridMode === 'manual') {
      const g = manualGrid(img.w, img.h, p.cellW, p.cellH);
      return g;
    }
    return detectGrid(img, { minCell: p.minCell, maxCell: p.maxCell });
  }

  /* ---------------- Pixelate（§1.3 / §3.3） ---------------- */
  /* 可分离 3×3 中值（先横后纵），O(n) */
  function denoise(img) {
    const w = img.w, h = img.h, src = img.rgba;
    const tmp = new Uint8ClampedArray(src.length);
    const out = new Uint8ClampedArray(src.length);
    const buf = new Uint8Array(3);
    for (let c = 0; c < 4; c++) {
      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const i = (row + x) * 4 + c;
          const a = (row + Math.max(0, x - 1)) * 4 + c;
          const b = (row + Math.min(w - 1, x + 1)) * 4 + c;
          const v0 = src[a], v1 = src[i], v2 = src[b];
          buf[0] = v0; buf[1] = v1; buf[2] = v2;
          let mn = v0, mx = v0;
          if (v1 < mn) mn = v1; if (v1 > mx) mx = v1;
          if (v2 < mn) mn = v2; if (v2 > mx) mx = v2;
          tmp[i] = v0 + v1 + v2 - mn - mx;
        }
      }
      for (let y = 0; y < h; y++) {
        const yUp = Math.max(0, y - 1) * w, yDn = Math.min(h - 1, y + 1) * w, yC = y * w;
        for (let x = 0; x < w; x++) {
          const i = (yC + x) * 4 + c;
          const v0 = tmp[(yUp + x) * 4 + c], v1 = tmp[i], v2 = tmp[(yDn + x) * 4 + c];
          let mn = v0, mx = v0;
          if (v1 < mn) mn = v1; if (v1 > mx) mx = v1;
          if (v2 < mn) mn = v2; if (v2 > mx) mx = v2;
          out[i] = v0 + v1 + v2 - mn - mx;
        }
      }
    }
    return { w: w, h: h, rgba: out };
  }

  function coreBounds(e0, e1, ratio) {
    const len = Math.max(1, e1 - e0);
    const core = Math.max(1, Math.round(len * ratio));
    const start = e0 + Math.max(0, Math.round((len - core) / 2));
    const end = Math.min(e1, start + core);
    return [start, Math.max(start + 1, end)];
  }

  function downsample(img, grid, coreRatio) {
    const w = grid.cols, h = grid.rows;
    const out = new Uint8ClampedArray(w * h * 4);
    const src = img.rgba, sw = img.w;
    const ex = grid.edgesX, ey = grid.edgesY;
    for (let row = 0; row < h; row++) {
      const [y0, y1] = coreBounds(ey[row], ey[row + 1], coreRatio);
      for (let col = 0; col < w; col++) {
        const [x0, x1] = coreBounds(ex[col], ex[col + 1], coreRatio);
        let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          let p = (y * sw + x0) * 4;
          for (let x = x0; x < x1; x++, p += 4) {
            const a = src[p + 3];
            ar += src[p] * a; ag += src[p + 1] * a; ab += src[p + 2] * a; aa += a; n++;
          }
        }
        const o = (row * w + col) * 4;
        if (aa > 0) {
          out[o] = ar / aa; out[o + 1] = ag / aa; out[o + 2] = ab / aa;
        }
        out[o + 3] = aa / Math.max(1, n);
      }
    }
    return { w: w, h: h, rgba: out };
  }

  /* 手写 median-cut（与 Pillow MEDIANCUT 非逐像素一致，按 W3 放宽） */
  function quantize(logical, colors) {
    const w = logical.w, h = logical.h, n = w * h, rgba = logical.rgba;
    const out = new Uint8ClampedArray(rgba);
    if (colors <= 0) return { img: { w: w, h: h, rgba: out }, palette: paletteOf({ w: w, h: h, rgba: out }, 100) };
    /* 直方图 */
    const hist = new Map();
    let sumR = 0, sumG = 0, sumB = 0, cnt = 0, hasAlpha = false;
    for (let i = 0; i < n; i++) {
      const o = i * 4, a = rgba[o + 3];
      if (a === 0) { hasAlpha = true; continue; }
      if (a < 255) hasAlpha = true;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      sumR += r; sumG += g; sumB += b; cnt++;
      const key = (r << 16) | (g << 8) | b;
      hist.set(key, (hist.get(key) || 0) + 1);
    }
    if (cnt === 0) return { img: { w: w, h: h, rgba: out }, palette: paletteOf({ w: w, h: h, rgba: out }, 100) };
    const meanR = Math.round(sumR / cnt), meanG = Math.round(sumG / cnt), meanB = Math.round(sumB / cnt);
    const uniq = Array.from(hist.keys());
    let palette;
    if (uniq.length <= colors) {
      palette = uniq.map((k) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 }));
    } else {
      palette = medianCut(uniq, hist, colors);
    }
    /* 最近色映射 */
    const lutR = new Uint8Array(256 * 256 * 2); /* 不用大表，直接逐像素线性扫描（≤64 色） */
    void lutR;
    const pr = palette.map((c) => c.r), pg = palette.map((c) => c.g), pb = palette.map((c) => c.b);
    const nn = palette.length;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const a = rgba[o + 3];
      let sr = rgba[o], sg = rgba[o + 1], sb = rgba[o + 2];
      if (a === 0) { sr = meanR; sg = meanG; sb = meanB; }
      let best = 0, bestD = 1e18;
      for (let k = 0; k < nn; k++) {
        const dr = sr - pr[k], dg = sg - pg[k], db = sb - pb[k];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = k; }
      }
      out[o] = pr[best]; out[o + 1] = pg[best]; out[o + 2] = pb[best];
      out[o + 3] = a;
    }
    return { img: { w: w, h: h, rgba: out }, palette: paletteOf({ w: w, h: h, rgba: out }, 100) };
  }

  function medianCut(uniq, hist, maxColors) {
    const idx = Int32Array.from(uniq);
    const counts = new Float64Array(uniq.length);
    for (let i = 0; i < idx.length; i++) counts[i] = hist.get(idx[i]);
    const channel = (k, ch) => ch === 0 ? (k >> 16) & 255 : (ch === 1 ? (k >> 8) & 255 : k & 255);
    function bounds(start, end) {
      let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0, total = 0;
      for (let i = start; i < end; i++) {
        const k = idx[i], r = channel(k, 0), g = channel(k, 1), b = channel(k, 2);
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (g < g0) g0 = g; if (g > g1) g1 = g;
        if (b < b0) b0 = b; if (b > b1) b1 = b;
        total += counts[i];
      }
      return { r0: r0, r1: r1, g0: g0, g1: g1, b0: b0, b1: b1, total: total };
    }
    let boxes = [{ start: 0, end: idx.length }];
    boxes[0].b = bounds(0, idx.length);
    while (boxes.length < maxColors) {
      let pick = -1, pickScore = -1;
      for (let i = 0; i < boxes.length; i++) {
        const bx = boxes[i];
        if (bx.end - bx.start < 2) continue;
        const b = bx.b;
        const vol = Math.max(b.r1 - b.r0, b.g1 - b.g0, b.b1 - b.b0) * Math.cbrt(b.total || 1);
        if (vol > pickScore) { pickScore = vol; pick = i; }
      }
      if (pick < 0) break;
      const bx = boxes[pick], b = bx.b;
      const dr = b.r1 - b.r0, dg = b.g1 - b.g0, db = b.b1 - b.b0;
      const ch = dr >= dg && dr >= db ? 0 : (dg >= db ? 1 : 2);
      const slice = Array.from(idx.subarray(bx.start, bx.end));
      slice.sort((x, y) => channel(x, ch) - channel(y, ch));
      for (let i = 0; i < slice.length; i++) idx[bx.start + i] = slice[i];
      let acc = 0, split = bx.start + 1;
      for (let i = bx.start; i < bx.end - 1; i++) {
        acc += counts[i];
        if (acc >= b.total / 2) { split = i + 1; break; }
      }
      if (split <= bx.start) split = bx.start + 1;
      if (split >= bx.end) split = bx.end - 1;
      boxes[pick] = { start: bx.start, end: split, b: bounds(bx.start, split) };
      boxes.push({ start: split, end: bx.end, b: bounds(split, bx.end) });
    }
    return boxes.map((bx) => {
      let sr = 0, sg = 0, sb = 0, tot = 0;
      for (let i = bx.start; i < bx.end; i++) {
        const k = idx[i], c = counts[i];
        sr += channel(k, 0) * c; sg += channel(k, 1) * c; sb += channel(k, 2) * c; tot += c;
      }
      tot = tot || 1;
      return { r: Math.round(sr / tot), g: Math.round(sg / tot), b: Math.round(sb / tot) };
    });
  }

  function upscale(logical, scale) {
    const w = logical.w * scale, h = logical.h * scale;
    const src = logical.rgba, out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy = (y / scale) | 0;
      const srow = sy * logical.w;
      const drow = y * w;
      for (let x = 0; x < w; x++) {
        const si = (srow + ((x / scale) | 0)) * 4, di = (drow + x) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
      }
    }
    return { w: w, h: h, rgba: out };
  }

  function paletteOf(img, limit) {
    const lim = limit || 100;
    const map = new Map();
    const total = img.w * img.h;
    for (let i = 0; i < total; i++) {
      const o = i * 4, a = img.rgba[o + 3];
      if (a === 0) continue;
      const r = img.rgba[o], g = img.rgba[o + 1], b = img.rgba[o + 2];
      const key = (r << 16) | (g << 8) | b;
      map.set(key, (map.get(key) || 0) + 1);
    }
    const list = Array.from(map.entries()).map((e) => ({
      r: (e[0] >> 16) & 255, g: (e[0] >> 8) & 255, b: e[0] & 255, count: e[1],
      hex: rgbToHex((e[0] >> 16) & 255, (e[0] >> 8) & 255, e[0] & 255)
    }));
    list.sort((a, b) => b.count - a.count);
    return list.slice(0, lim);
  }

  /* ---------------- Border（§4 几何 / §4.5 混合） ---------------- */
  function inside(ax, ay, half, r) {
    if (ax > half || ay > half) return false;
    const cx = Math.max(ax - (half - r), 0), cy = Math.max(ay - (half - r), 0);
    return cx * cx + cy * cy <= r * r + 1e-9;
  }

  /* 单块模板：0=块色，1=外色带，2=内色带 */
  function buildCellTemplate(s, R, t1, t2) {
    const tpl = new Uint8Array(s * s);
    const hw = s / 2;
    const hw1 = hw, R1 = R;
    const hw2 = hw - t1, R2 = Math.max(R - t1, 0);
    const hw3 = hw2 - t2, R3 = Math.max(R2 - t2, 0);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const ax = Math.abs(x + 0.5 - hw), ay = Math.abs(y + 0.5 - hw);
        let v = 0;
        if (t1 > 0 && inside(ax, ay, hw1, R1) && !inside(ax, ay, hw2, R2)) v = 1;
        else if (t2 > 0 && inside(ax, ay, hw2, R2) && !inside(ax, ay, hw3, R3)) v = 2;
        tpl[y * s + x] = v;
      }
    }
    return tpl;
  }

  function blockColorAt(logical, col, row) {
    const o = (row * logical.w + col) * 4;
    return [logical.rgba[o], logical.rgba[o + 1], logical.rgba[o + 2]];
  }

  function diff2(a, b) {
    const d0 = Math.abs(a[0] - b[0]), d1 = Math.abs(a[1] - b[1]), d2 = Math.abs(a[2] - b[2]);
    return Math.max(d0, Math.max(d1, d2));
  }

  /* 返回 {w,h,paint}：paint 值 0=不画 1=主色 2=次色 */
  function buildMask(logical, scale, p) {
    const bw = logical.w, bh = logical.h;
    const W = bw * scale, H = bh * scale;
    const paint = new Uint8Array(W * H);
    if (!p.borderEnabled || p.borderWidth <= 0) return { w: W, h: H, paint: paint };
    const t = Math.min(p.borderWidth, MAX_BORDER_WIDTH);
    const t2 = p.borderSecondEnabled && p.borderSecondMode === 'band' ? p.borderSecondWidth : 0;
    const t1 = Math.max(0, t - t2);
    const half = Math.floor(t / 2);

    if (p.borderStyle === 'grid') {
      const applyChecker = p.borderSecondEnabled && p.borderSecondMode === 'checker';
      const color2 = hexToRgb(p.borderSecondColor);
      const colorVal = (j, a0, a1, outerHigh) => {
        if (applyChecker) return 1;
        if (t2 > 0) {
          /* t1 永远在外侧 */
          if (outerHigh) return j >= t2 ? 1 : 2;
          return j < t1 ? 1 : 2;
        }
        return 1;
      };
      void color2;
      /* 竖直格线 */
      for (let k = 0; k <= bw; k++) {
        let x0, spanOuter;
        if (k === 0) { x0 = 0; }
        else if (k === bw) { x0 = W - t; }
        else { x0 = k * scale - half; }
        if (x0 < 0) x0 = 0;
        if (x0 + t > W) x0 = Math.max(0, W - t);
        const isOuterLine = (k === 0 || k === bw);
        if (p.borderScope === 'inner' && isOuterLine) continue;
        if (p.borderScope === 'outer' && !isOuterLine) continue;
        for (let row = 0; row < bh; row++) {
          if (!isOuterLine && p.borderEdgeAware) {
            const a = blockColorAt(logical, k - 1, row), b = blockColorAt(logical, k, row);
            if (diff2(a, b) < p.borderEdgeThreshold) continue;
          }
          let c1 = 1;
          if (applyChecker && !isOuterLine) {
            c1 = ((k - 1 + row) & 1) === 0 ? 1 : 2;
          }
          const y0 = row * scale, y1 = y0 + scale;
          for (let j = 0; j < t; j++) {
            const x = x0 + j;
            if (x < 0 || x >= W) continue;
            const v = (t2 > 0 && !applyChecker) ? colorVal(j, x0, x0 + t, isOuterLine && k === bw) : c1;
            for (let y = y0; y < y1; y++) paint[y * W + x] = v;
          }
        }
      }
      /* 水平格线 */
      for (let k = 0; k <= bh; k++) {
        let y0;
        if (k === 0) y0 = 0;
        else if (k === bh) y0 = H - t;
        else y0 = k * scale - half;
        if (y0 < 0) y0 = 0;
        if (y0 + t > H) y0 = Math.max(0, H - t);
        const isOuterLine = (k === 0 || k === bh);
        if (p.borderScope === 'inner' && isOuterLine) continue;
        if (p.borderScope === 'outer' && !isOuterLine) continue;
        for (let col = 0; col < bw; col++) {
          if (!isOuterLine && p.borderEdgeAware) {
            const a = blockColorAt(logical, col, k - 1), b = blockColorAt(logical, col, k);
            if (diff2(a, b) < p.borderEdgeThreshold) continue;
          }
          let c1 = 1;
          if (applyChecker && !isOuterLine) {
            c1 = ((col + k - 1) & 1) === 0 ? 1 : 2;
          }
          const x0 = col * scale, x1 = x0 + scale;
          for (let j = 0; j < t; j++) {
            const y = y0 + j;
            if (y < 0 || y >= H) continue;
            const v = (t2 > 0 && !applyChecker) ? colorVal(j, y0, y0 + t, isOuterLine && k === bh) : c1;
            for (let x = x0; x < x1; x++) paint[y * W + x] = v;
          }
        }
      }
      /* 交叉点磨圆（默认 R=0，逐像素与现状一致） */
      if (p.borderRadius > 0) crossRound(paint, W, H, scale, t, p, bw, bh);
      return { w: W, h: H, paint: paint };
    }

    /* cell 样式 */
    const R = Math.min(p.borderRadius, Math.floor(scale / 2));
    const tt = Math.min(t, Math.floor(scale / 2));
    const tt2 = p.borderSecondEnabled && p.borderSecondMode === 'band' ? Math.min(t2, tt) : 0;
    const tt1 = Math.max(0, tt - tt2);
    if (tt <= 0) return { w: W, h: H, paint: paint };
    const tplKey = scale + '|' + R + '|' + tt1 + '|' + tt2;
    if (!templateCache[tplKey]) templateCache[tplKey] = buildCellTemplate(scale, R, tt1, tt2);
    const tpl = templateCache[tplKey];
    const applyChecker = p.borderSecondEnabled && p.borderSecondMode === 'checker';
    for (let row = 0; row < bh; row++) {
      for (let col = 0; col < bw; col++) {
        const isBoundary = (col === 0 || row === 0 || col === bw - 1 || row === bh - 1);
        if (p.borderScope === 'inner' && isBoundary) continue;
        if (p.borderScope === 'outer' && !isBoundary) continue;
        let allowed = null;
        if (p.borderEdgeAware) {
          const c = blockColorAt(logical, col, row);
          allowed = [false, false, false, false]; /* 左 上 右 下 */
          if (col > 0 && diff2(blockColorAt(logical, col - 1, row), c) >= p.borderEdgeThreshold) allowed[0] = true;
          if (row > 0 && diff2(blockColorAt(logical, col, row - 1), c) >= p.borderEdgeThreshold) allowed[1] = true;
          if (col < bw - 1 && diff2(blockColorAt(logical, col + 1, row), c) >= p.borderEdgeThreshold) allowed[2] = true;
          if (row < bh - 1 && diff2(blockColorAt(logical, col, row + 1), c) >= p.borderEdgeThreshold) allowed[3] = true;
          if (!allowed[0] && !allowed[1] && !allowed[2] && !allowed[3]) continue;
        }
        let c1 = 1;
        if (applyChecker) c1 = ((col + row) & 1) === 0 ? 1 : 2;
        const x0 = col * scale, y0 = row * scale;
        const hw = scale / 2;
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const v = tpl[y * scale + x];
            if (v === 0) continue;
            if (allowed) {
              const u = x + 0.5 - hw, w2 = y + 0.5 - hw;
              const ax = Math.abs(u), ay = Math.abs(w2);
              const near = Math.min(scale - x, x + 1) <= Math.min(scale - y, y + 1);
              /* 归到哪条边：比较 ax/ay 与四邻域掩码 */
              const sideX = u >= 0 ? 2 : 0, sideY = w2 >= 0 ? 3 : 1;
              let okSide = false;
              if (ax > ay) okSide = allowed[sideX];
              else if (ay > ax) okSide = allowed[sideY];
              else okSide = allowed[sideX] || allowed[sideY];
              void near;
              if (!okSide) continue;
            }
            const val = applyChecker ? c1 : v;
            paint[(y0 + y) * W + (x0 + x)] = val;
          }
        }
      }
    }
    return { w: W, h: H, paint: paint };
  }

  const templateCache = Object.create(null);

  /* 交叉点磨圆：在四个凹角处按半径 R 做圆角填充（R=0 时不调用） */
  function crossRound(paint, W, H, scale, t, p, bw, bh) {
    const R = Math.min(p.borderRadius, Math.floor(scale / 2));
    if (R <= 0) return;
    const half = t / 2;
    for (let k = 1; k < bw; k++) {
      for (let m = 1; m < bh; m++) {
        const cx = k * scale, cy = m * scale;
        const r0 = Math.ceil(half + R);
        for (let dy = -r0; dy <= r0; dy++) {
          const y = cy + dy;
          if (y < 0 || y >= H) continue;
          for (let dx = -r0; dx <= r0; dx++) {
            const x = cx + dx;
            if (x < 0 || x >= W) continue;
            const ax = Math.abs(dx + 0.5), ay = Math.abs(dy + 0.5);
            /* 仅在「四角空隙」区域补圆角：两条线带都未覆盖，且落在以凹角为圆心的 R 圆内 */
            if (ax < half || ay < half) continue;
            const ox = ax - half, oy = ay - half;
            if (ox * ox + oy * oy <= R * R) {
              if (paint[y * W + x] === 0) paint[y * W + x] = 1;
            }
          }
        }
      }
    }
  }

  function blendChannel(c, color, alpha, mode) {
    const over = (1 - alpha) * c + alpha * color;
    if (mode === 'multiply') return Math.round((1 - alpha) * c + alpha * (c * color / 255));
    if (mode === 'darken') return Math.round(Math.min(c, over));
    return Math.round(over);
  }

  function applyBorder(base, mask, p) {
    const W = base.w, H = base.h;
    const out = new Uint8ClampedArray(base.rgba);
    if (!p.borderEnabled || p.borderWidth <= 0) return { w: W, h: H, rgba: out };
    const c1 = hexToRgb(p.borderColor);
    const c2 = hexToRgb(p.borderSecondColor);
    const a = p.borderOpacity;
    const a8 = Math.round(255 * a);
    for (let i = 0, n = W * H; i < n; i++) {
      const v = mask.paint[i];
      if (!v) continue;
      const col = v === 2 ? c2 : c1;
      const o = i * 4;
      out[o] = blendChannel(base.rgba[o], col.r, a, p.borderBlend);
      out[o + 1] = blendChannel(base.rgba[o + 1], col.g, a, p.borderBlend);
      out[o + 2] = blendChannel(base.rgba[o + 2], col.b, a, p.borderBlend);
      out[o + 3] = Math.max(base.rgba[o + 3], a8);
    }
    return { w: W, h: H, rgba: out };
  }

  /* ---------------- Pipeline（§3.3 阶段与缓存） ---------------- */
  function createPipeline() {
    const cache = Object.create(null);
    let source = null;
    let override = null;
    let overrideStamp = 0;
    const timings = {};

    function clear(what) {
      if (!what) { for (const k in cache) delete cache[k]; return; }
      delete cache[what];
    }
    function setSource(img) { source = img; clear(); }
    function getSource() { return source; }
    function setOverride(o) { override = o; overrideStamp++; clear('render'); }
    function getOverride() { return override; }

    function time(name, fn) {
      const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const r = fn();
      const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      timings[name] = t1 - t0;
      return r;
    }

    function run(pIn, opts) {
      const p = normalize(pIn);
      const o = opts || {};
      const notes = [];
      const used = Object.create(null);
      const k = keys(p);
      if (!source) throw new Error('尚未载入图片');

      /* 1) 去噪（denoise 段） */
      const srcKey = source.stamp || 0;
      let work = source;
      const dKey = 'denoise|' + srcKey + '|' + (p.denoise ? 1 : 0);
      if (p.denoise) {
        if (!cache[dKey]) { cache[dKey] = time('denoise', () => denoise(source)); used.denoise = 1; }
        work = cache[dKey];
      }

      /* 2) 网格（grid 段） */
      const gKey = 'grid|' + srcKey + '|' + p.gridMode + '|' + p.cellW + 'x' + p.cellH + '|' + p.minCell + '-' + p.maxCell + '|' + (p.denoise ? 1 : 0);
      if (!cache[gKey]) { cache[gKey] = time('grid', () => gridFor(work, p)); used.grid = 1; }
      const grid = cache[gKey];
      for (const n of grid.notes) notes.push(n);

      /* 3) 采样（sample 段，键 'logical'） */
      const lKey = 'logical|' + gKey + '|' + p.coreRatio;
      let logical;
      let usingOverride = false;
      if (override && override.w === grid.cols && override.h === grid.rows && override.rgba && override.rgba.length === grid.cols * grid.rows * 4) {
        logical = { w: override.w, h: override.h, rgba: new Uint8ClampedArray(override.rgba) };
        usingOverride = true;
        notes.push('使用编辑器结果作为逻辑像素图（跳过采样与量化）');
      } else {
        if (override) notes.push('编辑器结果与当前网格尺寸不一致，已忽略手工编辑');
        if (!cache[lKey]) { cache[lKey] = time('sample', () => downsample(work, grid, p.coreRatio)); used.sample = 1; }
        logical = cache[lKey];
      }

      /* 4) 调色板 / 量化（palette 段，键 'quant'） */
      let quantized;
      let palette;
      if (usingOverride) {
        quantized = logical;
        palette = paletteOf(logical, 100);
        used.palette = 1;
      } else {
        const qKey = 'quant|' + lKey + '|' + p.colors;
        if (!cache[qKey]) { cache[qKey] = time('palette', () => quantize(logical, p.colors)); used.palette = 1; }
        quantized = cache[qKey].img;
        palette = cache[qKey].palette;
      }

      /* 5) 渲染（render 段） */
      const limit = o.export ? MAX_RENDER_SIDE : (o.previewMaxSide || PREVIEW_MAX_SIDE_DEFAULT);
      const longest = Math.max(quantized.w, quantized.h);
      const effScale = Math.max(1, Math.min(p.scale, Math.floor(limit / Math.max(1, longest))));
      if (effScale < p.scale) {
        notes.push((o.export ? '导出' : '预览') + '已按上限降低到 ' + effScale + ' px/格（上限 ' + limit + 'px）');
      }
      const rKey = 'render|' + lKey + '|' + p.colors + '|' + JSON.stringify(p) + '|' + effScale + '|' + (usingOverride ? ('ov' + overrideStamp) : 'auto');
      /* 缓存键必须含全部描边字段：直接用 normalize 后的完整参数串（见 §3.3） */
      let r = cache[rKey];
      /* 防御：缓存里的 rendered 有可能已被转移（detach）——detached 的 ArrayBuffer 无法再绘制/回传，此时重算一份 */
      if (r && r.rgba && r.rgba.buffer && r.rgba.buffer.detached) r = null;
      if (!r) { used.render = 1;
        r = time('render', () => {
          const base = upscale(quantized, effScale);
          if (p.borderEnabled && p.borderWidth > 0) {
            const mask = buildMask(quantized, effScale, p);
            return applyBorder(base, mask, p);
          }
          return base;
        });
        cache[rKey] = r;
      }

      return {
        settings: p, grid: grid, logical: quantized, rendered: r, scaleUsed: effScale,
        palette: palette, notes: notes, timings: Object.assign({}, timings), used: used,
        sourceSize: { w: source.w, h: source.h }, usingOverride: usingOverride
      };
    }

    return {
      setSource: setSource, getSource: getSource, run: run, clear: clear,
      setOverride: setOverride, getOverride: getOverride
    };
  }

  /* ---------------- Worker 入口 ---------------- */
  function handle(msg) {
    /* msg: {kind:'render', pipeline handles state externally}：Worker 内维护单例管线 */
    if (!handle._pipeline) handle._pipeline = createPipeline();
    const pl = handle._pipeline;
    if (msg.kind === 'source') {
      pl.setSource({ w: msg.w, h: msg.h, rgba: new Uint8ClampedArray(msg.rgba), stamp: msg.stamp || 0 });
      return { type: 'source-ok', jobId: msg.jobId };
    }
    if (msg.kind === 'override') {
      if (msg.override) {
        pl.setOverride({
          w: msg.override.w, h: msg.override.h,
          rgba: new Uint8ClampedArray(msg.override.rgba), stamp: msg.override.stamp || 0
        });
      } else pl.setOverride(null);
      return { type: 'override-ok', jobId: msg.jobId };
    }
    if (msg.kind === 'clear') { pl.clear(msg.what); return { type: 'clear-ok', jobId: msg.jobId }; }
    if (msg.kind === 'render') {
      const t0 = Date.now();
      const res = pl.run(msg.settings, { export: !!msg.export, previewMaxSide: msg.previewMaxSide });
      const out = {
        type: 'result', jobId: msg.jobId, settings: res.settings, grid: res.grid,
        logical: { w: res.logical.w, h: res.logical.h, rgba: res.logical.rgba },
        rendered: { w: res.rendered.w, h: res.rendered.h, rgba: res.rendered.rgba },
        scaleUsed: res.scaleUsed, palette: res.palette, notes: res.notes, timings: res.timings,
        usingOverride: res.usingOverride, ms: Date.now() - t0
      };
      return { type: 'result', jobId: msg.jobId, payload: out };
    }
    throw new Error('未知消息 ' + msg.kind);
  }

  return {
    MAX_LOGICAL_SIDE: MAX_LOGICAL_SIDE, MAX_SCALE: MAX_SCALE, MAX_BORDER_WIDTH: MAX_BORDER_WIDTH,
    MAX_RENDER_SIDE: MAX_RENDER_SIDE, MAX_INPUT_PIXELS: MAX_INPUT_PIXELS, MAX_CELL: MAX_CELL,
    SETTINGS_KEY: SETTINGS_KEY, PREVIEW_MAX_SIDE_DEFAULT: PREVIEW_MAX_SIDE_DEFAULT,
    PREVIEW_MAX_SIDE_MIN: PREVIEW_MAX_SIDE_MIN,
    ParamDefaults: ParamDefaults, SCOPE_LABELS: SCOPE_LABELS, BLEND_LABELS: BLEND_LABELS,
    STYLE_LABELS: STYLE_LABELS, SECOND_MODE_LABELS: SECOND_MODE_LABELS,
    Params: { normalize: normalize, keys: keys, describeBorder: describeBorder, sliderBounds: sliderBounds, defaults: ParamDefaults },
    Detect: { detectGrid: detectGrid, manualGrid: manualGrid, gridFor: gridFor, estimateAxis: estimateAxis, boundaryProfile: boundaryProfile },
    Pixelate: { denoise: denoise, downsample: downsample, quantize: quantize, upscale: upscale, paletteOf: paletteOf },
    Border: { buildMask: buildMask, apply: applyBorder, buildCellTemplate: buildCellTemplate, inside: inside, blendChannel: blendChannel },
    Pipeline: { create: createPipeline },
    handle: handle,
    hexToRgb: hexToRgb, rgbToHex: rgbToHex
  };
})();
