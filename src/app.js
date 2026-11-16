/* ============================================================
 * 主线程：UI、调度、导出、编辑器
 * 依据：docs/WEB_REWRITE_PLAN.md §1.4 / §1.5 / §2.2 / §3.1 / §3.2
 * ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CORE_SRC = document.getElementById('pixel-core').textContent;
  /* 单文件下 CSP 只开 'unsafe-inline'（无 'unsafe-eval'）：core 段作为普通脚本直接执行，
     这里取全局 Core；同一段文本仍用于生成 Worker 的 blob。 */
  const Core = window.Core;
  const P = Core.Params;
  const D = Core.ParamDefaults;

  const state = {
    source: null,            /* {w,h,rgba,stamp} */
    settings: P.normalize(Object.assign({}, D)),
    override: null,          /* {w,h,rgba,stamp} */
    result: null,
    previewMaxSide: Core.PREVIEW_MAX_SIDE_DEFAULT,
    available: true,
    jobId: 0,
    pendingJob: 0,
    timer: 0,
    worker: null,
    localPipeline: null,
    rendering: false,
    dirty: false,
    lastUsed: null,
    /* 预览缩放：null = 适应窗口；数字 = 每像素显示尺寸（CSS px） */
    zoom: null,         /* R2：最近一次渲染真正重算的阶段（仅无 Worker 路径有值） */
    loadToken: 0            /* 载入竞态令牌：只允许最新一次载入写入 state.source（N10） */
  };

  /* ---------------- 存储（尽力而为） ---------------- */
  function readStorage() {
    try {
      const raw = localStorage.getItem(Core.SETTINGS_KEY);
      if (raw === null) return;
      const obj = JSON.parse(raw);
      const v = obj && obj.previewMaxSide;
      const n = Number(v);
      if (!isFinite(n)) throw new Error('bad value');
      const clamped = Math.min(Core.MAX_RENDER_SIDE, Math.max(Core.PREVIEW_MAX_SIDE_MIN, Math.round(n)));
      state.previewMaxSide = clamped;
      if (clamped !== Math.round(n)) {          /* B2：越界夹取并写回 */
        try { localStorage.setItem(Core.SETTINGS_KEY, JSON.stringify({ previewMaxSide: clamped })); } catch (e) { }
      }
    } catch (e) {
      /* B1：解析失败 → 回退默认值并修复写回；B3：不可用 → 内存态 */
      if (e && e.name === 'SyntaxError') {
        state.previewMaxSide = Core.PREVIEW_MAX_SIDE_DEFAULT;
        try { localStorage.setItem(Core.SETTINGS_KEY, JSON.stringify({ previewMaxSide: state.previewMaxSide })); } catch (e2) { }
      } else {
        state.available = false;
      }
    }
  }
  function writeStorage() {
    if (!state.available) return;
    try {
      localStorage.setItem(Core.SETTINGS_KEY, JSON.stringify({ previewMaxSide: state.previewMaxSide }));
    } catch (e) {
      state.available = false;
      updateStorageHint();
    }
  }
  function updateStorageHint() {
    const el = $('storageHint');
    if (!el) return;
    el.textContent = state.available
      ? '保存到本机设置，刷新后仍生效'
      : '当前以 file:// 打开或浏览器禁用了本地存储，设置不会被记住';
    el.className = 'hint ' + (state.available ? 'ok' : 'warn');
  }

  /* ---------------- Worker ---------------- */
  /* R7：往某个 worker 同步当前 source —— 按 stamp 幂等，同一 worker 对同一份像素只投递一次。
     loadBlob 的「载入后显式投递」与 buildWorker 的「重建后补齐」都走这里，
     这样无论两条路径以什么顺序触发（或将来有人再插一处），都不会出现重复的 source 消息
     （重复投递本身不会出错，但会让 worker 多清一次阶段缓存）。 */
  function syncWorkerSource(w) {
    if (!w || !state.source) return false;
    if (w._syncedStamp === state.source.stamp) return false;
    try {
      w.postMessage({ kind: 'source', w: state.source.w, h: state.source.h,
        rgba: state.source.rgba.buffer.slice(0), stamp: state.source.stamp }, []);
      w._syncedStamp = state.source.stamp;
      return true;
    } catch (e) {
      return false;   /* 失败无妨：随后的 render 消息会暴露具体错误 */
    }
  }

  function buildWorker() {
    try {
      const boot = CORE_SRC + '\n' + [
        'self.onmessage = function (e) {',
        '  var m = e.data;',
        '  try {',
        '    var r = Core.handle(m);',
        '    if (r && r.type === "result") {',
        '      var p = r.payload;',
        '      /* 只转移 rendered；且必须先拷一份：rendered 同时被管线缓存持有，直接转移会把缓存里的 ArrayBuffer detach */',
        '      var src = p.rendered;',
        '      p.rendered = { w: src.w, h: src.h, rgba: new Uint8ClampedArray(src.rgba) };',
        '      var t = [p.rendered.rgba.buffer];',
        '      self.postMessage({type:"result", jobId: r.jobId, payload: p, transferable: true}, t);',
        '    } else { self.postMessage(r); }',
        '  } catch (err) { self.postMessage({type:"error", jobId: m && m.jobId, message: String(err && err.message || err)}); }',
        '};'
      ].join('\n');
      const blob = new Blob([boot], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      w.onmessage = (e) => onWorkerMessage(e.data);
      w.onerror = () => { state.worker = null; renderNow(); };
      /* R1：重建的 worker 不带任何图像状态，而 onerror 里的 renderNow() 会触发
         ensureWorker() → buildWorker()，新 worker 若没有 source，run() 会抛「尚未载入图片」，
         表现为「worker 崩一次后，不重新载图就一直渲染失败」。这里在唯一确定的位置把
         source / override 同步过去（拷贝 buffer，不转移——主线程兜底管线还要用同一份像素）。 */
      syncWorkerSource(w);
      if (state.override) {
        try {
          w.postMessage({ kind: 'override', jobId: 0, override: {
            w: state.override.w, h: state.override.h,
            rgba: state.override.rgba.buffer.slice(0), stamp: state.override.stamp } }, []);
        } catch (e) { /* 同上 */ }
      }
      return w;
    } catch (e) {
      return null;
    }
  }

  function ensureWorker() {
    if (state.worker) return state.worker;
    state.worker = buildWorker();
    return state.worker;
  }

  function postToWorker(msg, transfer) {
    const w = ensureWorker();
    if (!w) return false;
    try { w.postMessage(msg, transfer || []); return true; } catch (e) { state.worker = null; return false; }
  }

  function onWorkerMessage(m) {
    if (!m) return;
    if (m.type === 'error') { setStatus('渲染失败：' + m.message, true); return; }
    if (m.type === 'result') {
      if (m.jobId !== state.pendingJob) return;   /* 丢弃过期结果 */
      applyResult(m.payload);
    }
  }

  /* ---------------- 结果落地 ---------------- */
  function applyResult(res) {
    state.rendering = false;
    state.result = {
      settings: P.normalize(res.settings), grid: res.grid,
      /* F6：结果数组由本次消息独占（Worker 侧转移前已拷副本），直接接管，不再复制 */
      logical: { w: res.logical.w, h: res.logical.h, rgba: res.logical.rgba },
      rendered: { w: res.rendered.w, h: res.rendered.h, rgba: res.rendered.rgba },
      scaleUsed: res.scaleUsed, palette: res.palette, notes: res.notes || [],
      timings: res.timings || {}, usingOverride: !!res.usingOverride
    };
    /* R2：记录本次真正重算的阶段（core 的 used），仅供 harness 断言无 Worker 路径的缓存复用；
       Worker 返回的 payload 不含 used，此时为 null。 */
    state.lastUsed = res.used || null;
    /* P1：只有真的画到 canvas 上才刷新信息栏——否则 updateInfo 会把 drawPreview 的错误提示覆盖成「渲染完成」 */
    if (drawPreview()) updateInfo();
    if (state.dirty) { state.dirty = false; scheduleRender(); }
  }

  function drawPreview() {
    const cvs = $('view');
    const r = state.result;
    if (!r || !r.rendered) return false;
    /* P1：先校验数据再动 canvas。改 width/height 会立刻清空画面（F4 只是为了省一次分配），
       如果随后 set/putImageData 抛错，用户看到的就是「图没了」且没有任何提示。
       长度不符通常意味着 buffer 已被 transfer 走（detached）或尺寸与像素不一致。 */
    const src = r.rendered.rgba;
    const need = r.rendered.w * r.rendered.h * 4;
    if (!src || src.length !== need) {
      setStatus('预览数据不可用（' + (src ? src.length : 0) + '/' + need + ' 字节），已保留上一帧', true);
      return false;
    }
    /* F4：尺寸未变时不重设 width/height——赋值会重建 backbuffer 并清空，大图每次省一次整幅分配 */
    if (cvs.width !== r.rendered.w || cvs.height !== r.rendered.h) {
      cvs.width = r.rendered.w;
      cvs.height = r.rendered.h;
    }
    try {
      const ctx = cvs.getContext('2d');
      const img = ctx.createImageData(r.rendered.w, r.rendered.h);
      img.data.set(src);
      ctx.putImageData(img, 0, 0);
      applyZoom(cvs);
      return true;
    } catch (err) {
      setStatus('预览绘制失败：' + ((err && err.message) || err), true);
      return false;
    }
  }

  /* 预览缩放：state.zoom 为 null 表示「适应窗口」，否则是「每个像素显示多少 CSS px」。
     之前只有自适应（fitCanvas）且渲染完强制重算，所以改像素格大小后显示尺寸被 fit 回去，
     看起来就是「缩放不起作用」；这里把自适应和手动倍率拆成两条路径。 */
  function applyZoom(cvs) {
    const box = $('canvasWrap');
    if (!box) return;
    const bw = box.clientWidth - 24, bh = box.clientHeight - 24;
    /* P1：工坊 iframe 首帧、面板折叠等情况下容器还没量出尺寸，
       直接 return 会让 canvas 保持旧尺寸（或 0），看起来就像「图消失了」；
       下一帧再量一次即可。 */
    if (bw <= 0 || bh <= 0) { requestAnimationFrame(() => applyZoom(cvs)); return; }
    const fit = Math.max(0.05, Math.min(Math.min(bw / cvs.width, bh / cvs.height), 8));
    const k = state.zoom == null ? fit : state.zoom;
    cvs.style.width = Math.round(cvs.width * k) + 'px';
    cvs.style.height = Math.round(cvs.height * k) + 'px';
    /* 只有放大到超出容器时才需要滚动；此时把内容对齐到左上，滚动条从内容起点开始 */
    box.classList.toggle('zoomed', cvs.width * k > bw + 1 || cvs.height * k > bh + 1);
    const label = $('zoomLabel');
    if (label) label.textContent = (state.zoom == null ? '适应 ' : '') + Math.round(k * 100) + '%';
    const fitBtn = $('btnZoomFit');
    if (fitBtn) fitBtn.classList.toggle('on', state.zoom == null);
  }

  /* 统一入口：null = 适应窗口，其它值 = 手动倍率（夹到 5%–3200%） */
  function setZoom(next) {
    state.zoom = next == null ? null : Math.max(0.05, Math.min(32, next));
    const cvs = $('view');
    if (cvs) applyZoom(cvs);
  }

  function zoomBy(factor) {
    const cvs = $('view');
    if (!cvs || !cvs.width) return;
    const cur = cvs.style.width ? parseFloat(cvs.style.width) / cvs.width : 1;
    setZoom((state.zoom == null ? cur : state.zoom) * factor);
  }

  function updateInfo() {
    const r = state.result;
    if (!r) return;
    const g = r.grid;
    const src = g.source === 'auto' ? '自动' : (g.source === 'manual' ? '手动' : '估算');
    $('gridInfo').textContent = '网格 ' + g.cols + '×' + g.rows + '（' + g.cellW + '×' + g.cellH + 'px，' +
      src + '，置信度 ' + g.confidence.toFixed(2) + '）';
    const parts = [];
    parts.push('输出 ' + r.rendered.w + '×' + r.rendered.h + '（' + r.scaleUsed + ' px/格）');
    parts.push('颜色 ' + r.palette.length);
    parts.push(P.describeBorder(r.settings));
    if (r.usingOverride) parts.push('使用编辑器结果');
    const t = r.timings || {};
    const total = Object.keys(t).reduce((a, k) => a + (t[k] || 0), 0);
    parts.push('耗时 ' + total.toFixed(0) + 'ms');
    $('renderInfo').textContent = parts.join(' · ');
    const notes = (r.notes || []).slice(-3);
    $('noteInfo').textContent = notes.join('；');
    setStatus('渲染完成 · ' + r.rendered.w + '×' + r.rendered.h + ' · ' + r.palette.length + ' 色');
  }

  function setStatus(text, isError) {
    const el = $('status');
    el.textContent = text;
    el.className = isError ? 'status err' : 'status';
  }

  /* ---------------- 渲染调度 ---------------- */
  function scheduleRender(delay) {
    clearTimeout(state.timer);
    state.timer = setTimeout(renderNow, delay === undefined ? 120 : delay);
  }

  function renderNow(exportMode) {
    if (!state.source) return;
    const jobId = ++state.jobId;
    state.pendingJob = jobId;
    state.rendering = true;
    setStatus('渲染中…');
    const msg = {
      kind: 'render', jobId: jobId, settings: state.settings,
      export: !!exportMode, previewMaxSide: state.previewMaxSide
    };
    if (postToWorker(msg)) return;
    /* 无 Worker：主线程分片前先让界面刷新一次 */
    setTimeout(() => {
      try {
        if (!state.localPipeline) state.localPipeline = Core.Pipeline.create();
        /* F7：setSource 会清空全部阶段缓存（core.js:766），仅在源图变化时才调用；
           否则调黑边/滑杆也会退化成全量重算，丢掉「仅重跑 render」的缓存收益。 */
        const cur = state.localPipeline.getSource();
        if (!cur || cur.stamp !== state.source.stamp) state.localPipeline.setSource(state.source);
        const curO = state.localPipeline.getOverride();
        const want = state.override ? state.override.stamp : 0;
        const got = curO ? (curO.stamp || 0) : 0;
        if (got !== want) state.localPipeline.setOverride(state.override);
        const res = state.localPipeline.run(state.settings, {
          export: !!exportMode, previewMaxSide: state.previewMaxSide
        });
        applyResult({
          settings: res.settings, grid: res.grid,
          logical: { w: res.logical.w, h: res.logical.h, rgba: res.logical.rgba },
          rendered: { w: res.rendered.w, h: res.rendered.h, rgba: res.rendered.rgba },
          scaleUsed: res.scaleUsed, palette: res.palette, notes: res.notes,
          timings: res.timings, usingOverride: res.usingOverride,
          used: res.used                                  /* R2：供 harness 断言「只重跑 render」 */
        });
      } catch (err) {
        setStatus('渲染失败：' + (err && err.message || err), true);
      }
    }, 0);
  }

  /* ---------------- 载入图片 ---------------- */
  /* ---------------- SVG 预处理（矢量按需栅格化） ----------------
     背景：createImageBitmap() 不支持 SVG（Chromium 抛 InvalidStateError），只能用 <img> 解码；
     而 <img> 会按 SVG 的固有尺寸栅格化——20000×20000 的 SVG 会先吃掉上百 MB 再被我们等比缩小，
     在嵌入宿主（Electron iframe）里足以把渲染进程顶到 OOM（表现为页面/工坊面板突然关闭）。
     对策：解析 SVG，把 width/height 改写成不超过 SVG_RASTER_MAX 的像素尺寸（保留 viewBox，
     坐标空间不变），再交给 <img> 解码；矢量图栅格化到 2048 已远超像素化所需。
     SVG_RASTER_MAX 取 2048：与 previewMaxSide 默认值一致，且 2048²×4B≈16MB，内存可控。 */
  const SVG_RASTER_MAX = 2048;

  function isSvgBlob(blob, name) {
    const type = (blob && blob.type || '').toLowerCase();
    if (type === 'image/svg+xml' || type === 'image/svg') return true;
    return /\.svg$/i.test(name || '');
  }

  /* 工坊 image.pick 只给字节、不带 MIME（桥接按 image/png 包装），扩展名也可能被写成
     lumina-pick.png；此时仅凭 type/name 会把 SVG 当栅格图，createImageBitmap 必然失败。
     这里再看一眼头部字节：以 XML/SVG 声明开头就按 SVG 处理。 */
  async function sniffSvg(blob, name) {
    if (isSvgBlob(blob, name)) return true;
    const type = (blob && blob.type || '').toLowerCase();
    if (type && type !== 'image/png' && type !== 'application/octet-stream') return false;
    try {
      const head = await blob.slice(0, 512).text();
      if (/^\s*<svg[\s>]/i.test(head)) return true;
      if (/^\s*<\?xml[\s\S]{0,400}?<svg[\s>]/i.test(head)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  function svgNumber(value) {
    const raw = String(value == null ? '' : value).trim();
    /* 百分比（width="100%"）没有绝对尺寸，按「未知」处理，交给 viewBox / 默认值兜底 */
    if (!raw || raw.endsWith('%')) return 0;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function clampSvgBlob(blob) {
    let text;
    try {
      text = await blob.text();
    } catch (e) {
      throw new Error('SVG 读取失败：' + ((e && e.message) || e));
    }
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc && doc.documentElement;
    if (!svg || String(svg.nodeName).toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) {
      throw new Error('SVG 解析失败：不是合法的 SVG 文档');
    }
    const box = String(svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
    /* 固有尺寸：优先 width/height 属性，其次 viewBox，最后按 HTML 默认 300×150 */
    let w = svgNumber(svg.getAttribute('width'));
    let h = svgNumber(svg.getAttribute('height'));
    if (!w || !h) {
      w = hasBox ? box[2] : 300;
      h = hasBox ? box[3] : 150;
    }
    const k = Math.min(1, SVG_RASTER_MAX / Math.max(w, h));
    const rw = Math.max(1, Math.round(w * k));
    const rh = Math.max(1, Math.round(h * k));
    svg.setAttribute('width', String(rw));
    svg.setAttribute('height', String(rh));
    /* 没有 viewBox 时补一个，保证缩小时内容按原坐标空间等比缩放而不是被裁掉 */
    if (!hasBox) svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const out = new XMLSerializer().serializeToString(svg);
    const outBlob = new Blob([out], { type: 'image/svg+xml' });
    return { blob: outBlob, w: rw, h: rh, clamped: k < 1 };
  }

  async function loadBlob(blob, name, note) {
    /* 硬上限：超限直接拒绝——不解码、不动 state.source、不清空当前渲染结果 */
    if (blob && blob.size > DROP_MAX_BYTES) {
      state.loadToken++;   /* 拦截也算一次新的载入意图：让在途解码作废（N10） */
      const mb = Math.ceil(blob.size * 10 / 1048576) / 10;   /* 向上取 0.1 MB，避免 20 MB+1B 显示成 20.0（N2） */
      setDropHint('文件太大：' + mb + ' MB（上限 20 MB）');
      setStatus('文件太大，已拒绝载入：' + mb + ' MB（上限 20 MB）', true);
      return;
    }
    /* 编辑器有未应用改动时二次确认；放在体积拦截之后——超大文件不该先问「是否丢弃编辑」（N4）
       工坊（沙箱 iframe）里 window.confirm 可能被宿主禁用（无 allow-modals），
       此时跳过询问并沿用「替换即关闭编辑器」的行为，避免永久卡住载入。 */
    const canAsk = typeof window.confirm === 'function' && !window.PBS_MODULE_MODE;
    if (editor.open && editor.undo.length > 0 && canAsk &&
        !window.confirm('当前图片在编辑器中有未应用的修改，载入新图片会丢弃这些修改。继续？')) {
      setDropHint('已取消：保留当前图片与编辑器内容');
      return;
    }
    const token = ++state.loadToken;
    try {
      setStatus('解码中…');
      let bmp = null;
      const svgInput = await sniffSvg(blob, name);
      let svgInfo = null;
      if (svgInput) {
        /* 矢量图先按 SVG_RASTER_MAX 栅格化，避免按固有尺寸撑爆内存（见上方说明） */
        svgInfo = await clampSvgBlob(blob);
        blob = svgInfo.blob;
        if (token !== state.loadToken) return;
      }
      // 依次尝试：带朝向的 createImageBitmap → 不带选项的 createImageBitmap → <img>
      // createImageBitmap 不支持 SVG（必然抛 InvalidStateError），SVG 直接走 <img>；
      // 宿主 CSP 为 img-src data: blob:，blob: 的 <img> 在沙箱里是允许的。
      if (!svgInput) {
        try {
          bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        } catch (e) {
          try {
            bmp = await createImageBitmap(blob);
          } catch (e2) {
            bmp = null;
          }
        }
      }
      if (!bmp) {
        bmp = await new Promise((res, rej) => {
          const img = new Image();
          const url = URL.createObjectURL(blob);
          img.onload = () => { URL.revokeObjectURL(url); res(img); };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            rej(new Error(svgInput
              ? 'SVG 解码失败（宿主沙箱可能禁止 img 加载，或 SVG 引用了外部资源）'
              : '图片解码失败'));
          };
          img.src = url;
        });
      }
      let w = bmp.width, h = bmp.height;
      if (!(w > 0 && h > 0)) throw new Error('图片没有可用尺寸（0×0）');
      let k = 1;
      if (w * h > Core.MAX_INPUT_PIXELS) k = Math.sqrt(Core.MAX_INPUT_PIXELS / (w * h));
      if (k < 1) { w = Math.round(w * k); h = Math.round(h * k); }
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(bmp, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      if (token !== state.loadToken) return;   /* 已被更新的载入请求取代，丢弃本次结果（N10） */
      /* ImageData.data 已是独立的 Uint8ClampedArray，直接接管可省一次整幅拷贝（大图 ~96MB） */
      state.source = { w: w, h: h, rgba: data.data, stamp: Date.now() };
      /* 换图回到「适应」：上一张设的手动倍率对新图不一定合适（4096 输出 × 496% 会非常夸张） */
      state.zoom = null;
      state.override = null;
      $('fileInfo').textContent = name ? (name + ' · ' + w + '×' + h) : (w + '×' + h);
      if (svgInfo && svgInfo.clamped) {
        setStatus('SVG 已按 ' + SVG_RASTER_MAX + 'px 上限栅格化（' + svgInfo.w + '×' + svgInfo.h + '）');
      }
      $('dropzone').classList.add('has-file');
      setDropHint(note || '');                 /* 任何入口载入成功都清掉旧提示；多文件说明经 note 传入（N1） */
      if (editor.open) closeEditor();          /* 图片已替换，编辑器里的旧逻辑图不再适用（N4 既定方案） */
      syncWorkerSource(state.worker);          /* R7：与 buildWorker 共用同一入口，按 stamp 去重 */
      if (state.localPipeline) {
        state.localPipeline.setSource(state.source);
        state.localPipeline.setOverride(null);
      }
      renderNow();
    } catch (err) {
      setStatus('载入失败：' + (err && err.message || err), true);
    }
  }

  /* ---------------- 拖放载入（包裹既有入口 loadBlob，不改参数夹取/滑杆上限） ---------------- */
  /* 多文件策略：只载入第 1 张图片，其余忽略并在 #dropHint 提示数量 */
  /* 体积上限：20 MB 硬阻断——在 loadBlob 入口统一拦截（拖放 / 打开图片 / 粘贴三入口共用）；
     解码另受 Core.MAX_INPUT_PIXELS = 24MP 约束，与本阈值互补 */
  const DROP_ACCEPT_EXT = /\.(png|jpe?g|webp|gif|svg|bmp)$/i;   /* F1：点号必须转义，否则 `apng` 这类文件名会被误判 */
  const DROP_MAX_BYTES = 20 * 1024 * 1024;

  function setDropHint(text) {
    const el = $('dropHint');
    if (el) el.textContent = text || '';
  }
  function showDropFeedback(on) {
    const ov = $('dropOverlay');
    if (ov) ov.hidden = !on;
    const dz = $('dropzone');
    if (dz) dz.classList.toggle('drag', !!on);
  }
  function isImageFile(f) {
    if (!f) return false;
    if (f.type && f.type.indexOf('image/') === 0) return true;
    return DROP_ACCEPT_EXT.test(f.name || '');   /* 部分系统拖入时 file.type 为空，退回扩展名判断 */
  }
  function installDropTargets() {
    let depth = 0;                                /* enter/leave 成对触发，用计数器避免子元素间闪烁 */
    const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0);

    const resetDrag = () => { depth = 0; showDropFeedback(false); };
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;                   /* 允许页面内拖选文字/滑杆，不干扰 */
      e.preventDefault();
      depth++;
      showDropFeedback(true);
    });
    window.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();                         /* 不阻止默认行为，浏览器会拒绝 drop */
      e.dataTransfer.dropEffect = 'copy';
      showDropFeedback(true);
    });
    window.addEventListener('dragleave', () => {
      if (depth === 0) return;                    /* 不再依赖 types：离开时 types 可能已变空，按它门控会让遮罩卡住（N6） */
      depth = Math.max(0, depth - 1);
      if (depth === 0) showDropFeedback(false);
    });
    window.addEventListener('dragend', resetDrag);   /* 拖拽被取消（Esc / 拖出窗口）时兜底复位（N6） */
    window.addEventListener('blur', resetDrag);      /* 拖到浏览器外、窗口失焦时兜底复位（N6） */
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && depth > 0) { resetDrag(); e.stopImmediatePropagation(); }   /* 拖拽态优先于编辑器 Esc，见 R1 */
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();                         /* 必须拦掉：否则浏览器会直接用图片替换整页 */
      resetDrag();
      handleDroppedFiles(e.dataTransfer.files);
    });
  }

  /* 校验 → 复用 loadBlob()；任何拒绝分支都只改状态栏/#dropHint，不动 state.source 与已渲染结果 */
  function handleDroppedFiles(fileList) {
    const files = fileList ? Array.from(fileList) : [];
    if (!files.length) {
      setDropHint('未收到文件：拖入的可能是文字、链接或文件夹');
      setStatus('没有可载入的文件（拖入的是文本、链接或文件夹）', true);
      return;
    }
    const images = files.filter(isImageFile);
    if (!images.length) {
      const name = files.length === 1 ? files[0].name : files[0].name + ' 等 ' + files.length + ' 个文件';
      setDropHint('不是图片文件：' + name);
      setStatus('不是图片文件：' + name + '（支持 PNG / JPG / WEBP / GIF / SVG）', true);
      return;
    }
    const first = images[0];
    const ignored = files.length - 1;
    /* 体积拦截在 loadBlob() 入口统一处理；多文件说明作为 note 传入，载入成功后才显示（N1） */
    const note = ignored > 0
      ? '一次只载入 1 张：已载入「' + first.name + '」，忽略其余 ' + ignored + ' 个文件'
      : '';
    loadBlob(first, first.name, note);
  }

  /* ---------------- 导出 ---------------- */
  function renderForExport() {
    return new Promise((resolve, reject) => {
      if (!state.source) { reject(new Error('尚未载入图片')); return; }
      const jobId = ++state.jobId;
      state.pendingJob = jobId;
      const msg = { kind: 'render', jobId: jobId, settings: state.settings, export: true, previewMaxSide: state.previewMaxSide };
      const w = ensureWorker();
      if (!w) {
        try {
          if (!state.localPipeline) state.localPipeline = Core.Pipeline.create();
          state.localPipeline.setSource(state.source);
          state.localPipeline.setOverride(state.override);
          const res = state.localPipeline.run(state.settings, { export: true, previewMaxSide: state.previewMaxSide });
          resolve(res);
        } catch (e) { reject(e); }
        return;
      }
      const prevHandler = w.onmessage;
      w.onmessage = (e) => {
        const m = e.data;
        if (m && m.type === 'result' && m.jobId === jobId) {
          w.onmessage = prevHandler;
          /* F2：导出只用 rendered，直接接管收到的一次性数组；不复制，也不再携带 logical */
          resolve({
            rendered: { w: m.payload.rendered.w, h: m.payload.rendered.h, rgba: m.payload.rendered.rgba },
            palette: m.payload.palette, notes: m.payload.notes, scaleUsed: m.payload.scaleUsed
          });
        } else if (m && m.type === 'error' && m.jobId === jobId) {
          w.onmessage = prevHandler;
          reject(new Error(m.message));
        }
      };
      w.postMessage(msg, []);
    });
  }

  function canvasFrom(imgData) {
    const cvs = document.createElement('canvas');
    cvs.width = imgData.w; cvs.height = imgData.h;
    /* F2：直接用已有数组包装 ImageData，省掉一次整幅拷贝（调用方传入的均为 Uint8ClampedArray） */
    cvs.getContext('2d').putImageData(new ImageData(imgData.rgba, imgData.w, imgData.h), 0, 0);
    return cvs;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* 宿主 iframe 内没有本地下载：宿主隔离会拦掉 <a download> 且不抛错，
     旧代码照样打「已导出」= 伪报成功（PR 问题 1）。
     这里统一识别宿主环境，宿主内如实反馈「不可用」，交付路径只有「交给 Lumina」。 */
  function hostEmbedded() {
    return window.PBS_MODULE_MODE === true || window.parent !== window;
  }
  function hostExportBlocked(kind) {
    setStatus('宿主内不支持本地下载：' + kind + ' 未生成。请用页头「交给 Lumina」把结果交付到工程。', true);
  }

  function baseName() {
    const s = $('fileInfo').textContent || 'pixel';
    return s.split(' · ')[0].replace(/\.[^.]+$/, '') || 'pixel';
  }

  async function exportPng() {
    if (!state.source) return;
    if (hostEmbedded()) { hostExportBlocked('导出 PNG'); return; }
    setStatus('导出中…');
    try {
      const res = await renderForExport();
      const cvs = canvasFrom(res.rendered);
      cvs.toBlob((blob) => {
        downloadBlob(blob, baseName() + '_pixel.png');
        setStatus('已导出 PNG（' + res.rendered.w + '×' + res.rendered.h + '，' + res.scaleUsed + ' px/格）');
      }, 'image/png');
    } catch (err) {
      setStatus('导出失败：' + (err && err.message || err), true);
    }
  }

  async function exportOneX() {
    if (!state.result) return;
    if (hostEmbedded()) { hostExportBlocked('导出 1×'); return; }
    const lg = state.result.logical;
    const cvs = canvasFrom(lg);
    cvs.toBlob((blob) => {
      downloadBlob(blob, baseName() + '_1x.png');
      setStatus('已导出 1×（' + lg.w + '×' + lg.h + '，无描边）');
    }, 'image/png');
  }

  function exportPalette() {
    const r = state.result;
    if (!r) return;
    if (hostEmbedded()) { hostExportBlocked('色卡'); return; }
    const pal = r.palette;
    const sw = 32, cols = Math.min(pal.length, 12), rows = Math.ceil(pal.length / cols);
    const cvs = document.createElement('canvas');
    cvs.width = cols * sw; cvs.height = rows * sw;
    const ctx = cvs.getContext('2d');
    pal.forEach((c, i) => {
      ctx.fillStyle = c.hex;
      ctx.fillRect((i % cols) * sw, Math.floor(i / cols) * sw, sw, sw);
    });
    cvs.toBlob((blob) => {
      downloadBlob(blob, baseName() + '_palette.png');
      const txt = pal.map((c) => c.hex + ' ' + c.r + ',' + c.g + ',' + c.b + ' ×' + c.count).join('\n');
      downloadBlob(new Blob([txt], { type: 'text/plain' }), baseName() + '_palette.txt');
      setStatus('已导出色卡（' + pal.length + ' 色）');
    }, 'image/png');
  }

  /* ---------------- 编辑器 ---------------- */
  const editor = {
    open: false, img: null, zoom: 12, tool: 'brush', color: [0, 0, 0],
    undo: [], redo: [], drawing: false, last: null, sym: 'none', brush: 1, start: null, preview: null,
    userZoom: false
  };

  function openEditor() {
    if (!state.result) return;
    const lg = state.result.logical;
    editor.img = { w: lg.w, h: lg.h, rgba: new Uint8ClampedArray(lg.rgba) };
    editor.undo = []; editor.redo = [];
    editor.color = [0, 0, 0];
    editor.open = true;
    $('editorPanel').hidden = false;
    buildPaletteSwatches();
    editorFit();
  }

  function closeEditor() {
    editor.open = false;
    $('editorPanel').hidden = true;
  }

  /* 编辑器缩放：canvas 尺寸 = 逻辑尺寸 × zoom，wrap 用 overflow:auto 滚动。
     之前 zoom 只在 editorFit() 里算一次，滚轮/按钮/快捷键都没有入口，
     所以「编辑器内无法缩放」= 缺少交互，不是算错。 */
  function editorSetZoom(next, anchor) {
    const old = editor.zoom;
    const z = Math.max(1, Math.min(48, Math.round(next)));
    if (!editor.img) return;
    if (z === old) return;
    const wrap = $('editorCanvasWrap');
    let keep = null;
    if (anchor) {
      /* 记下指针下的那个像素坐标，缩放后把它挪回同一屏幕位置 */
      keep = {
        x: anchor.x - wrap.getBoundingClientRect().left + wrap.scrollLeft,
        y: anchor.y - wrap.getBoundingClientRect().top + wrap.scrollTop,
        ox: anchor.x - wrap.getBoundingClientRect().left,
        oy: anchor.y - wrap.getBoundingClientRect().top
      };
    }
    editor.zoom = z;
    const cvs = $('editorCanvas');
    cvs.width = editor.img.w * z;
    cvs.height = editor.img.h * z;
    const label = $('editorZoomLabel');
    if (label) label.textContent = z + '×';
    editorDraw();
    if (keep) {
      wrap.scrollLeft = (keep.x / old) * z - keep.ox;
      wrap.scrollTop = (keep.y / old) * z - keep.oy;
    }
    editor.userZoom = true;
  }

  function editorFit() {
    const wrap = $('editorCanvasWrap');
    if (!editor.img) return;
    const bw = Math.max(180, wrap.clientWidth - 16), bh = Math.max(120, wrap.clientHeight - 16);
    const k = Math.min(bw / editor.img.w, bh / editor.img.h);
    const z = Math.max(2, Math.min(32, Math.floor(k)));
    if (z !== editor.zoom) {
      editor.zoom = z;
      const cvs = $('editorCanvas');
      cvs.width = editor.img.w * z;
      cvs.height = editor.img.h * z;
    }
    const label = $('editorZoomLabel');
    if (label) label.textContent = z + '×';
    editor.userZoom = false;
    wrap.scrollLeft = 0;
    wrap.scrollTop = 0;
    editorDraw();
  }

  function editorDraw() {
    const cvs = $('editorCanvas');
    const ctx = cvs.getContext('2d');
    /* F5：离屏 canvas 复用到逻辑图尺寸变化为止，避免每次拖拽都新建 canvas/ImageData 拷贝 */
    let off = editor._off;
    if (!off || off.width !== editor.img.w || off.height !== editor.img.h) {
      off = document.createElement('canvas');
      off.width = editor.img.w; off.height = editor.img.h;
      off._ctx = off.getContext('2d');
      editor._off = off;
    }
    off._ctx.putImageData(new ImageData(editor.img.rgba, editor.img.w, editor.img.h), 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(off, 0, 0, cvs.width, cvs.height);
    /* F5：网格线合并成单条 Path、一次 stroke（原实现每根线各一次 beginPath/stroke） */
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= editor.img.w; x++) {
      const px = x * editor.zoom + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, cvs.height);
    }
    for (let y = 0; y <= editor.img.h; y++) {
      const py = y * editor.zoom + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(cvs.width, py);
    }
    ctx.stroke();
  }

  /* F3：历史栈按「字节预算 + 步数上限」裁剪。原实现固定 60 份，512×512 逻辑图
     （1 MiB/份）最坏 60 MiB；这里保持小图原有的 60 步上限，仅对大图提前收缩到 32 MiB 预算内。 */
  const UNDO_BUDGET_BYTES = 32 * 1024 * 1024;
  const UNDO_MAX_STEPS = 60;
  const UNDO_MIN_STEPS = 10;
  function trimStack(stack) {
    const bytes = Math.max(1, editor.img.w * editor.img.h * 4);
    const cap = Math.min(UNDO_MAX_STEPS, Math.max(UNDO_MIN_STEPS, Math.floor(UNDO_BUDGET_BYTES / bytes)));
    while (stack.length > cap) stack.shift();
  }
  function pushUndo() {
    editor.undo.push(new Uint8ClampedArray(editor.img.rgba));
    trimStack(editor.undo);
    editor.redo.length = 0;
    updateEditorButtons();
  }

  function updateEditorButtons() {
    $('btnUndo').disabled = editor.undo.length === 0;
    $('btnRedo').disabled = editor.redo.length === 0;
  }

  function editorSetPixel(x, y, rgba4) {
    const pts = [[x, y]];
    if (editor.sym === 'h') pts.push([editor.img.w - 1 - x, y]);
    if (editor.sym === 'v') pts.push([x, editor.img.h - 1 - y]);
    if (editor.sym === 'quad') {
      pts.push([editor.img.w - 1 - x, y], [x, editor.img.h - 1 - y], [editor.img.w - 1 - x, editor.img.h - 1 - y]);
    }
    const b = Math.max(1, editor.brush | 0);
    for (const p of pts) {
      for (let dy = 0; dy < b; dy++) {
        for (let dx = 0; dx < b; dx++) {
          const px = p[0] + dx - ((b / 2) | 0), py = p[1] + dy - ((b / 2) | 0);
          if (px < 0 || py < 0 || px >= editor.img.w || py >= editor.img.h) continue;
          const o = (py * editor.img.w + px) * 4;
          if (rgba4 === null) { editor.img.rgba[o + 3] = 0; }
          else {
            editor.img.rgba[o] = rgba4[0]; editor.img.rgba[o + 1] = rgba4[1];
            editor.img.rgba[o + 2] = rgba4[2]; editor.img.rgba[o + 3] = 255;
          }
        }
      }
    }
  }

  function editorPickPixel(ev) {
    const cvs = $('editorCanvas');
    const rect = cvs.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / editor.zoom);
    const y = Math.floor((ev.clientY - rect.top) / editor.zoom);
    return [Math.max(0, Math.min(editor.img.w - 1, x)), Math.max(0, Math.min(editor.img.h - 1, y))];
  }

  function editorFloodFill(x, y, color) {
    const { w, h, rgba } = editor.img;
    const o0 = (y * w + x) * 4;
    const target = [rgba[o0], rgba[o0 + 1], rgba[o0 + 2], rgba[o0 + 3]];
    const same = (o) => rgba[o] === target[0] && rgba[o + 1] === target[1] && rgba[o + 2] === target[2] && rgba[o + 3] === target[3];
    if (color === null) { if (target[3] === 0) return; } else if (target[0] === color[0] && target[1] === color[1] && target[2] === color[2] && target[3] === 255) return;
    const stack = [[x, y]];
    const seen = new Uint8Array(w * h);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const idx = cy * w + cx;
      if (seen[idx]) continue;
      seen[idx] = 1;
      const o = idx * 4;
      if (!same(o)) continue;
      if (color === null) rgba[o + 3] = 0;
      else { rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = 255; }
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  function buildPaletteSwatches() {
    const host = $('editorPalette');
    host.innerHTML = '';
    const pal = (state.result && state.result.palette) || [];
    pal.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c.hex;
      b.title = c.hex;
      b.addEventListener('click', () => { editor.color = [c.r, c.g, c.b]; });
      host.appendChild(b);
    });
    const tr = document.createElement('button');
    tr.className = 'swatch transparent';
    tr.title = '透明';
    tr.addEventListener('click', () => { editor.color = null; });
    host.appendChild(tr);
  }

  function editorDown(ev) {
    if (!editor.open) return;
    const [x, y] = editorPickPixel(ev);
    const tool = editor.tool;
    if (tool === 'pick') {
      const o = (y * editor.img.w + x) * 4;
      const a = editor.img.rgba[o + 3];
      if (a === 0) editor.color = null;
      else editor.color = [editor.img.rgba[o], editor.img.rgba[o + 1], editor.img.rgba[o + 2]];
      return;
    }
    pushUndo();
    editor.drawing = true;
    editor.start = [x, y];
    editor.last = [x, y];
    if (tool === 'brush' || tool === 'eraser') {
      editorSetPixel(x, y, tool === 'eraser' ? null : editor.color);
      editorDraw();
    } else if (tool === 'fill') {
      editorFloodFill(x, y, editor.color);
      editorDraw();
    }
  }

  function editorMove(ev) {
    if (!editor.drawing) return;
    const [x, y] = editorPickPixel(ev);
    const tool = editor.tool;
    if (tool === 'brush' || tool === 'eraser') {
      const col = tool === 'eraser' ? null : editor.color;
      const [lx, ly] = editor.last;
      const steps = Math.max(Math.abs(x - lx), Math.abs(y - ly));
      for (let i = 0; i <= steps; i++) {
        const px = Math.round(lx + (x - lx) * (i / Math.max(1, steps)));
        const py = Math.round(ly + (y - ly) * (i / Math.max(1, steps)));
        editorSetPixel(px, py, col);
      }
      editor.last = [x, y];
      editorDraw();
    }
  }

  function editorUp(ev) {
    if (!editor.drawing) return;
    editor.drawing = false;
    const [x, y] = editorPickPixel(ev);
    const tool = editor.tool;
    if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
      const [x0, y0] = editor.start;
      const col = editor.color;
      const put = (px, py) => editorSetPixel(px, py, col);
      if (tool === 'line') {
        const steps = Math.max(Math.abs(x - x0), Math.abs(y - y0));
        for (let i = 0; i <= steps; i++) {
          put(Math.round(x0 + (x - x0) * (i / Math.max(1, steps))), Math.round(y0 + (y - y0) * (i / Math.max(1, steps))));
        }
      } else if (tool === 'rect') {
        for (let px = Math.min(x0, x); px <= Math.max(x0, x); px++) { put(px, y0); put(px, y); }
        for (let py = Math.min(y0, y); py <= Math.max(y0, y); py++) { put(x0, py); put(x, py); }
      } else {
        const cx = (x0 + x) / 2, cy = (y0 + y) / 2;
        const rx = Math.abs(x - x0) / 2, ry = Math.abs(y - y0) / 2;
        const steps = Math.max(24, Math.round((rx + ry) * 3));
        for (let i = 0; i < steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          put(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry));
        }
      }
      editorDraw();
    }
    updateEditorButtons();
  }

  function editorUndo() {
    if (!editor.undo.length) return;
    editor.redo.push(new Uint8ClampedArray(editor.img.rgba));
    trimStack(editor.redo);            /* F3：重做栈同样受预算约束 */
    editor.img.rgba = editor.undo.pop();
    editorDraw();
    updateEditorButtons();
  }
  function editorRedo() {
    if (!editor.redo.length) return;
    editor.undo.push(new Uint8ClampedArray(editor.img.rgba));
    trimStack(editor.undo);            /* F3 */
    editor.img.rgba = editor.redo.pop();
    editorDraw();
    updateEditorButtons();
  }

  function applyEditor() {
    if (!state.result) return;
    const g = state.result.grid;
    if (editor.img.w !== g.cols || editor.img.h !== g.rows) {
      setStatus('编辑器尺寸与当前网格不一致，已忽略', true);
      closeEditor();
      return;
    }
    state.override = { w: editor.img.w, h: editor.img.h, rgba: new Uint8ClampedArray(editor.img.rgba), stamp: Date.now() };
    if (state.worker) {
      postToWorker({ kind: 'override', jobId: ++state.jobId, override: { w: state.override.w, h: state.override.h, rgba: state.override.rgba.buffer.slice(0), stamp: state.override.stamp } }, []);
    }
    if (state.localPipeline) state.localPipeline.setOverride(state.override);
    syncDisabled();
    closeEditor();
    renderNow();
  }

  function restoreAuto() {
    state.override = null;
    if (state.worker) postToWorker({ kind: 'override', jobId: ++state.jobId, override: null }, []);
    if (state.localPipeline) state.localPipeline.setOverride(null);
    syncDisabled();
    renderNow();
    setStatus('已还原为自动结果');
  }

  /* ---------------- 参数面板 ---------------- */
  function bindRange(id, key, outId, fmt) {
    const el = $(id), out = outId ? $(outId) : null;
    const sync = () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { [key]: Number(el.value) }));
      if (out) out.textContent = fmt ? fmt(state.settings[key]) : String(state.settings[key]);
      el.value = state.settings[key];
      onSettingsChanged();
    };
    el.addEventListener('input', sync);
    el.addEventListener('change', sync);
    if (out) out.textContent = fmt ? fmt(state.settings[key]) : String(state.settings[key]);
  }
  function bindNumber(id, key) {
    const el = $(id);
    const sync = () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { [key]: Number(el.value) }));
      el.value = state.settings[key];
      onSettingsChanged();
    };
    el.addEventListener('change', sync);
    el.addEventListener('blur', sync);
  }
  function bindCheck(id, key) {
    const el = $(id);
    el.addEventListener('change', () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { [key]: el.checked }));
      onSettingsChanged();
    });
  }
  function bindSelect(id, key) {
    const el = $(id);
    el.addEventListener('change', () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { [key]: el.value }));
      onSettingsChanged();
    });
  }
  function bindColor(id, key) {
    const el = $(id);
    el.addEventListener('input', () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { [key]: el.value }));
      onSettingsChanged();
    });
  }

  function onSettingsChanged() {
    syncDisabled();
    const gk = Core.Params.keys(state.settings).gridKey;
    const prev = onSettingsChanged._k;
    if (prev !== undefined && prev !== gk && state.override) {
      state.override = null;
      if (state.worker) postToWorker({ kind: 'override', jobId: ++state.jobId, override: null }, []);
      if (state.localPipeline) state.localPipeline.setOverride(null);
    }
    onSettingsChanged._k = gk;
    scheduleRender();
  }

  function syncDisabled() {
    const s = state.settings;
    const off = !s.borderEnabled;
    ['borderWidth', 'borderColor', 'borderOpacity', 'borderScope', 'borderBlend',
      'borderStyle', 'borderRadius', 'borderSecondEnabled', 'borderSecondColor', 'borderSecondMode', 'borderSecondWidth',
      'borderEdgeAware', 'borderEdgeThreshold'].forEach((k) => {
        const el = $(k);
        if (el) el.disabled = off;
      });
    const secondOff = off || !s.borderSecondEnabled;
    ['borderSecondColor', 'borderSecondMode', 'borderSecondWidth'].forEach((k) => {
      const el = $(k);
      if (el) el.disabled = secondOff;
    });
    const cell = s.borderStyle === 'cell';
    const radiusLabel = $('radiusLabel');
    if (radiusLabel) radiusLabel.textContent = cell ? '块圆角半径' : '磨圆半径';
    /* 滑杆右端跟随参数夹取规则（半径 ≤ floor(scale/2)、内色带宽度 ≤ 主线宽），
       否则把手拖到右侧会被 normalize 夹回，表现为「拖不到最大值」。 */
    const bounds = P.sliderBounds(state.settings);
    Object.keys(bounds).forEach((k) => {
      const el = $(k);
      if (!el) return;
      const max = String(Math.max(0, bounds[k]));
      if (el.max !== max) el.max = max;
      if (Number(el.value) !== state.settings[k]) el.value = String(state.settings[k]);
      const out = $(k + 'Out');
      if (out) out.textContent = state.settings[k] + 'px';
    });
    const overrideOn = !!state.override;
    $('btnRestore').disabled = !overrideOn;
    const colorsEl = $('colors');
    if (colorsEl) colorsEl.disabled = overrideOn;
    const colorsHint = $('colorsHint');
    if (colorsHint) colorsHint.textContent = overrideOn ? '编辑器结果不参与量化，颜色数暂不可用' : '';
    updateWidthHint();
  }

  function updateWidthHint() {
    const s = state.settings;
    const el = $('widthHint');
    if (!el) return;
    if (!s.borderEnabled || s.borderWidth <= 0) { el.textContent = ''; return; }
    const pct = Math.round((s.borderWidth / s.scale) * 100);
    let text = s.borderWidth + 'px（占格 ' + pct + '%）';
    if (s.borderWidth >= s.scale && s.borderStyle === 'grid') text += ' · 已 ≥ 放大倍数，整格会被盖住';
    if (s.borderStyle === 'cell' && s.borderRadius + s.borderWidth >= Math.ceil(s.scale / 2)) {
      text += ' · 圆角+线宽已过半格，块色会被覆盖';
    }
    el.textContent = text;
  }

  function initControls() {
    const s = state.settings;
    /* 网格 */
    $('gridMode').addEventListener('change', () => {
      state.settings = P.normalize(Object.assign({}, state.settings, { gridMode: $('gridMode').value }));
      onSettingsChanged();
    });
    bindNumber('cellW', 'cellW');
    bindNumber('cellH', 'cellH');
    bindCheck('denoise', 'denoise');
    /* 输出 */
    bindRange('colors', 'colors', 'colorsOut');
    bindRange('scale', 'scale', 'scaleOut', (v) => v + ' px/格');
    /* 黑边 */
    bindCheck('borderEnabled', 'borderEnabled');
    bindRange('borderWidth', 'borderWidth', 'borderWidthOut', (v) => v + 'px');
    bindColor('borderColor', 'borderColor');
    bindRange('borderOpacity', 'borderOpacity', 'borderOpacityOut', (v) => Math.round(v * 100) + '%');
    bindSelect('borderScope', 'borderScope');
    bindSelect('borderBlend', 'borderBlend');
    bindCheck('borderEdgeAware', 'borderEdgeAware');
    bindRange('borderEdgeThreshold', 'borderEdgeThreshold', 'borderEdgeThresholdOut');
    bindSelect('borderStyle', 'borderStyle');
    bindRange('borderRadius', 'borderRadius', 'borderRadiusOut', (v) => v + 'px');
    bindCheck('borderSecondEnabled', 'borderSecondEnabled');
    bindSelect('borderSecondMode', 'borderSecondMode');
    bindRange('borderSecondWidth', 'borderSecondWidth', 'borderSecondWidthOut', (v) => v + 'px');
    bindColor('borderSecondColor', 'borderSecondColor');

    /* 预览上限（change 时写，不用定时器） */
    const pm = $('previewMaxSide');
    pm.value = state.previewMaxSide;
    pm.addEventListener('change', () => {
      const v = Math.min(Core.MAX_RENDER_SIDE, Math.max(Core.PREVIEW_MAX_SIDE_MIN, Math.round(Number(pm.value) || state.previewMaxSide)));
      state.previewMaxSide = v;
      pm.value = v;
      writeStorage();
      renderNow();
    });

    $('btnOpen').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadBlob(f, f.name);
      e.target.value = '';                /* 允许重复选择同一文件：不清空则 change 不再触发（N3） */
    });
    installDropTargets();
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type && it.type.indexOf('image/') === 0) {
          const f = it.getAsFile();
          if (f) loadBlob(f, '剪贴板图片');
          break;
        }
      }
    });

    /* 预览缩放：按钮 + 滚轮 + 双击（快捷键在下面统一处理） */
    /* 编辑器缩放控件 */
    $('btnEditorZoomIn').addEventListener('click', () => editorSetZoom(editor.zoom * 1.25, null));
    $('btnEditorZoomOut').addEventListener('click', () => editorSetZoom(editor.zoom * 0.8, null));
    $('btnEditorZoomFit').addEventListener('click', editorFit);
    $('editorCanvasWrap').addEventListener('wheel', (e) => {
      if (!editor.open) return;
      e.preventDefault();
      editorSetZoom(editor.zoom * (e.deltaY < 0 ? 1.25 : 0.8), { x: e.clientX, y: e.clientY });
    }, { passive: false });

    $('btnZoomIn').addEventListener('click', () => zoomBy(1.25));
    $('btnZoomOut').addEventListener('click', () => zoomBy(0.8));
    $('btnZoomFit').addEventListener('click', () => setZoom(null));
    $('canvasWrap').addEventListener('wheel', (e) => {
      if (!state.result) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });
    $('view').addEventListener('dblclick', () => { if (state.result) setZoom(null); });

    $('btnPng').addEventListener('click', exportPng);
    $('btn1x').addEventListener('click', exportOneX);
    $('btnPalette').addEventListener('click', exportPalette);
    $('btnEditor').addEventListener('click', openEditor);
    $('btnRestore').addEventListener('click', restoreAuto);

    /* 编辑器 */
    const ec = $('editorCanvas');
    ec.addEventListener('mousedown', editorDown);
    ec.addEventListener('mousemove', editorMove);
    window.addEventListener('mouseup', editorUp);
    ec.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = editorPickPixel(e);
      const o = (y * editor.img.w + x) * 4;
      if (editor.img.rgba[o + 3] > 0) editor.color = [editor.img.rgba[o], editor.img.rgba[o + 1], editor.img.rgba[o + 2]];
    });
    document.querySelectorAll('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        editor.tool = b.getAttribute('data-tool');
        document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x === b));
      });
    });
    document.querySelector('[data-tool="brush"]').classList.add('active');
    $('editorSym').addEventListener('change', () => { editor.sym = $('editorSym').value; });
    $('editorBrush').addEventListener('input', () => { editor.brush = Number($('editorBrush').value); $('editorBrushOut').textContent = editor.brush + 'px'; });
    $('btnUndo').addEventListener('click', editorUndo);
    $('btnRedo').addEventListener('click', editorRedo);
    $('btnEditorApply').addEventListener('click', applyEditor);
    $('btnEditorCancel').addEventListener('click', closeEditor);
    const TOOL_KEYS = { b: 'brush', e: 'eraser', i: 'pick', g: 'fill', l: 'line', u: 'rect', c: 'ellipse' };
    window.addEventListener('keydown', (e) => {
      if (!editor.open && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target && e.target.tagName) || '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
          if (e.key === '0' || e.key === 'f' || e.key === 'F') { if (state.result) { e.preventDefault(); setZoom(null); } return; }
          if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); return; }
          if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(0.8); return; }
        }
      }
      if (!editor.open) return;
      if (!e.ctrlKey && !e.metaKey && TOOL_KEYS[String(e.key).toLowerCase()]) {
        const t = TOOL_KEYS[String(e.key).toLowerCase()];
        editor.tool = t;
        document.querySelectorAll('[data-tool]').forEach((x) => x.classList.toggle('active', x.getAttribute('data-tool') === t));
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editorRedo(); else editorUndo(); }
      else if (e.key === 'Escape') closeEditor();
      else if (e.key === 'Enter') applyEditor();
    });
    window.addEventListener('resize', () => { if (state.result) applyZoom($('view')); if (editor.open && !editor.userZoom) editorFit(); });

    /* 初始 UI 同步 */
    $('gridMode').value = s.gridMode;
    $('cellW').value = s.cellW;
    $('cellH').value = s.cellH;
    $('denoise').checked = s.denoise;
    $('colors').value = s.colors;
    $('scale').value = s.scale;
    $('borderEnabled').checked = s.borderEnabled;
    $('borderWidth').value = s.borderWidth;
    $('borderColor').value = s.borderColor;
    $('borderOpacity').value = s.borderOpacity;
    $('borderScope').value = s.borderScope;
    $('borderBlend').value = s.borderBlend;
    $('borderEdgeAware').checked = s.borderEdgeAware;
    $('borderEdgeThreshold').value = s.borderEdgeThreshold;
    $('borderStyle').value = s.borderStyle;
    $('borderRadius').value = s.borderRadius;
    $('borderSecondEnabled').checked = s.borderSecondEnabled;
    $('borderSecondMode').value = s.borderSecondMode;
    $('borderSecondWidth').value = s.borderSecondWidth;
    $('borderSecondColor').value = s.borderSecondColor;
    onSettingsChanged._k = Core.Params.keys(state.settings).gridKey;
    syncDisabled();
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    readStorage();
    updateStorageHint();
    initControls();
    ensureWorker();
    setStatus('就绪 · 打开或拖入一张图片');
    $('btnRestore').disabled = true;
    $('btnUndo').disabled = true;
    $('btnRedo').disabled = true;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* 供自动化自检使用（不参与 UI） */
  /* 工坊桥接（web/module/host-bridge.js）需要导出与渲染，故把导出链路一并挂到手柄上；仅测试/集成使用。 */
  window.__PBS__ = { Core: Core, state: state, editor: editor, renderNow: renderNow, loadBlob: loadBlob, applyResult: applyResult, isImageFile: isImageFile, trimStack: trimStack, syncWorkerSource: syncWorkerSource, renderForExport: renderForExport, canvasFrom: canvasFrom, baseName: baseName };
  /* editor / isImageFile / trimStack 仅供 harness 断言，不参与业务逻辑 */
})();
