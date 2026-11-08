/* Lumina 创意工坊桥接（模块专用，独立打开 HTML 时不生效）
 * - 仅在宿主 iframe 内启用：window.parent !== window
 * - SDK：@lumina/workshop-sdk 1.0.2（GPL-3.0-or-later），由 tools/build-module.mjs 内联为 window.LuminaWorkshop
 * - 职责：image.pick 选图 → 复用主应用 loadBlob；导出 PNG 字节 → handoff.image 交回 Lumina
 */
(function () {
  'use strict';

  /* 由 tools/build-module.mjs 从 manifest.json 注入；改了 manifest.version 必须重新打包，
     否则握手与 handoff 里报的还是旧版本，宿主会认成「未知版本模块」。 */
  var MODULE_ID = '__MODULE_ID__';
  var MODULE_VERSION = '__MODULE_VERSION__';
  var MAX_ATTEMPTS = 6;
  var RETRY_MS = 900;

  if (window.parent === window) return;   /* 双击打开：保持单机行为，不注入任何 UI */
  window.PBS_MODULE_MODE = true;

  var host = { client: null, connected: false };
  var pending = false;
  var projectId = newProjectId();

  function newProjectId() {
    return 'pbs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function pbs() { return window.__PBS__ || null; }
  function $(id) { return document.getElementById(id); }

  function badge(text, kind) {
    var el = $('workshopBadge');
    if (!el) return;
    el.textContent = text;
    el.className = 'sub' + (kind === 'ok' ? ' ws-ok' : kind === 'warn' ? ' ws-warn' : '');
  }

  function mount() {
    if ($('btnLuminaPick')) return true;
    var header = document.querySelector('header');
    if (!header || !pbs()) return false;
    var spacer = header.querySelector('.spacer');

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.id = 'btnLuminaPick';
    pick.textContent = '从 Lumina 选图';
    pick.disabled = true;
    pick.addEventListener('click', onPick);

    var hand = document.createElement('button');
    hand.type = 'button';
    hand.id = 'btnLuminaHandoff';
    hand.className = 'primary';
    hand.textContent = '交给 Lumina';
    hand.disabled = true;
    hand.addEventListener('click', onHandoff);

    var b = document.createElement('span');
    b.id = 'workshopBadge';
    b.className = 'sub';
    b.textContent = '工坊：连接中…';

    header.insertBefore(pick, spacer);
    header.insertBefore(hand, spacer);
    header.appendChild(b);
    badge('工坊：连接中…');
    return true;
  }

  function enableButtons() {
    var pick = $('btnLuminaPick');
    var hand = $('btnLuminaHandoff');
    if (pick) pick.disabled = false;
    if (hand) hand.disabled = false;
  }

  /* image.pick 的返回结构在不同宿主小版本上有差异，按已安装模块的约定逐个兜底 */
  function blobFromPick(res) {
    if (!res) return null;
    var raw = res.pngBytes || res.bytes || res.data;
    if (raw instanceof ArrayBuffer) return new Blob([raw], { type: 'image/png' });
    /* P2：宿主可能返回 Uint8Array 的「视图」（Buffer/subarray 常见），
       直接用 raw.buffer 会把视图之外的整块内存一起塞进 Blob，PNG 立刻错位 → 解码失败 → 预览空白。 */
    if (ArrayBuffer.isView(raw)) {
      var view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      return new Blob([view], { type: 'image/png' });
    }
    if (Array.isArray(raw)) return new Blob([new Uint8Array(raw)], { type: 'image/png' });
    /* 有些宿主只回 base64 字符串（不带 data: 前缀） */
    if (typeof raw === 'string' && raw.length > 0 && !/[^A-Za-z0-9+/=\s]/.test(raw)) {
      try {
        var bin64 = atob(raw.replace(/\s+/g, ''));
        var buf64 = new Uint8Array(bin64.length);
        for (var j = 0; j < bin64.length; j++) buf64[j] = bin64.charCodeAt(j);
        return new Blob([buf64], { type: 'image/png' });
      } catch (e) { /* 落到下面的 null */ }
    }
    if (typeof res.dataUrl === 'string') {
      var base64 = res.dataUrl.split(',')[1] || '';
      var bin = atob(base64);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return new Blob([out], { type: 'image/png' });
    }
    return null;
  }

  async function onPick() {
    var api = pbs();
    if (!host.client || !api) return;
    try {
      badge('工坊：选择图片…');
      var res = await host.client.image.pick();
      var blob = blobFromPick(res);
      if (!blob) { badge('工坊：宿主未返回可用图片', 'warn'); return; }
      await api.loadBlob(blob, 'lumina-pick.png');
      badge('工坊：已载入所选图片', 'ok');
    } catch (err) {
      badge('工坊：选图失败（' + ((err && err.code) || 'unknown') + '）', 'warn');
    }
  }

  function toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('PNG 编码失败'));
      }, 'image/png');
    });
  }

  async function onHandoff() {
    var api = pbs();
    if (!host.client || !api || pending) return;
    if (!api.state.source) { badge('工坊：请先载入一张图片', 'warn'); return; }
    pending = true;
    var hand = $('btnLuminaHandoff');
    if (hand) hand.disabled = true;
    try {
      badge('工坊：导出中…');
      var res = await api.renderForExport();
      var canvas = api.canvasFrom(res.rendered);
      var blob = await toBlob(canvas);
      var bytes = await blob.arrayBuffer();
      var w = res.rendered.w;
      var h = res.rendered.h;
      var settings = Object.assign({}, api.state.settings);
      var out = await host.client.handoff.image({
        moduleId: MODULE_ID,
        moduleVersion: MODULE_VERSION,
        projectId: projectId,
        pngBytes: bytes,
        pixelWidth: w,
        pixelHeight: h,
        /* 96 dpi 换算成毫米，仅作转换器初值，用户仍可在 Lumina 里改 */
        recommendedWidthMm: Math.round((w * 25.4 / 96) * 10) / 10,
        recommendedHeightMm: Math.round((h * 25.4 / 96) * 10) / 10,
        preserveCanvasBounds: true,
        colorLibraryId: null,
        recipeSource: {
          manifestSchemaVersion: 1,
          moduleId: MODULE_ID,
          moduleVersion: MODULE_VERSION,
          projectSchemaVersion: 'pixelborder.settings/1',
          renderSchemaVersion: 'pixelborder.pixelate/1',
          payload: {
            settings: settings,
            logical: { w: api.state.result ? api.state.result.logical.w : null, h: api.state.result ? api.state.result.logical.h : null },
            output: { w: w, h: h }
          }
        }
      });
      var status = out && out.status;
      if (status === 'needs-confirmation') {
        badge('工坊：目标图片已存在，再点一次「交给 Lumina」确认替换', 'warn');
      } else if (status === 'completed') {
        projectId = newProjectId();
        badge('工坊：已交给 Lumina（' + w + '×' + h + '）', 'ok');
      } else {
        badge('工坊：交接返回 ' + (status || '未知状态'), 'warn');
      }
    } catch (err) {
      badge('工坊：交接失败（' + ((err && err.code) || (err && err.message) || 'unknown') + '）', 'warn');
    } finally {
      pending = false;
      if (hand) hand.disabled = false;
    }
  }

  function connect(attempt) {
    var sdk = window.LuminaWorkshop;
    if (!sdk || typeof sdk.connectWorkshop !== 'function') {
      if (attempt < MAX_ATTEMPTS) { setTimeout(function () { connect(attempt + 1); }, RETRY_MS); }
      return;
    }
    sdk.connectWorkshop({ moduleId: MODULE_ID, moduleVersion: MODULE_VERSION })
      .then(function (client) {
        host.client = client;
        host.connected = true;
        var mounted = mount();
        enableButtons();
        badge(mounted ? '工坊：已连接' : '工坊：已连接（界面未就绪）', 'ok');
        try {
          if (client.ui && client.ui.subscribeState) {
            client.ui.subscribeState(function (st) {
              try { sdk.applyWorkshopUiState(st); } catch (e) { /* 主题可选 */ }
            });
          }
        } catch (e) { /* 可选能力 */ }
        try { if (client.lifecycle && client.lifecycle.ready) client.lifecycle.ready(); } catch (e) { /* 可选能力 */ }
      })
      .catch(function (err) {
        if (attempt < MAX_ATTEMPTS) { setTimeout(function () { connect(attempt + 1); }, RETRY_MS); return; }
        badge('工坊：连接失败（' + ((err && err.code) || 'unknown') + '）', 'warn');
      });
  }

  function start() {
    /* 主应用是普通脚本，先于本脚本执行；这里只做一次就绪轮询，避免时序假设 */
    var tries = 0;
    (function waitApp() {
      if (mount() && window.__PBS__) { connect(1); return; }
      if (++tries < 40) { setTimeout(waitApp, 50); return; }
      connect(1);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
