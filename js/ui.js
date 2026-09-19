/* =============================================================
 * ui.js — 取景器 HUD / 控制 / 诊断 / 挑战 / 成片
 * ============================================================= */
window.UI = (function () {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };
  const O = window.OPT;

  let cb = {};
  let shots = [];
  let lastLearnKey = '';
  let toastTimer = null;
  let doneSet = {};
  let changedKey = null;
  let reviewedIdx = -1;
  let reviewTimer = null;
  let reviewHeld = false;          // 用户一旦开始缩放/拖动, 就不再自动返回取景
  const REVIEW_MS = 4000;          // 即时回放自动淡出时长(ms)
  let zoomReview = null;
  let zoomLightbox = null;

  /* ---------------- 挑战 ---------------- */
  const CHALLENGES = [
    {
      id: 'bokeh',
      t: '做出<b>奶油般的焦外</b>：焦距 ≥ 85mm、光圈大于 f/5.6、对焦距离 ≤ 5m',
      ok: function (s) { return s.focal >= 85 && s.ap <= 5.6 && s.focus <= 5; },
      p: function (s) { return O.focalLabel(s.focal) + ' · ' + O.apertureLabel(s.ap) + ' · ' + O.focusLabel(s.focus); }
    },
    {
      id: 'freeze',
      t: '把<b>旋转的风车凝固</b>：快门 1/500 或更快',
      ok: function (s) { return s.t <= 1 / 500; },
      p: function (s) { return '当前 ' + O.shutterLabel(s.t); }
    },
    {
      id: 'trail',
      t: '拍出<b>车灯拖影</b>：快门 1/2s 或更慢，并且画面不糊（上脚架，或开启防抖）',
      ok: function (s) {
        return s.t >= 0.5 && (!s.handheld || O.shake(s, 1000).ok);
      },
      p: function (s) { return O.shutterLabel(s.t) + ' · ' + (s.handheld ? '手持' : '脚架'); }
    },
    {
      id: 'night',
      t: '夜晚也<b>干净通透</b>：夜晚预设下噪点 ≤ 低，且曝光误差 ≤ 1EV',
      ok: function (s) {
        return s.preset === 'night' && O.noiseLevel(s) <= 0.19 && Math.abs(O.deltaEV(s)) <= 1;
      },
      p: function (s) {
        return 'ISO' + s.iso + ' · 噪点' + noiseWord(O.noiseLevel(s)) + ' · ' + O.deltaEV(s).toFixed(1) + 'EV';
      }
    },
    {
      id: 'deep',
      t: '做一次<b>泛焦</b>：焦距 ≤ 35mm 且光圈 f/16 或更小，从近处到远景都清晰',
      ok: function (s) { return s.focal <= 35 && s.ap >= 16; },
      p: function (s) { return O.focalLabel(s.focal) + ' · ' + O.apertureLabel(s.ap); }
    }
  ];

  // 阈值对应 grainAmt: 0.005 / 0.0095 / 0.016 / 0.028 (即 ISO 约 400 / 2000 / 6400 / 25600)
  function noiseWord(v) {
    if (v < 0.10) return '极低';
    if (v < 0.19) return '低';
    if (v < 0.32) return '中';
    if (v < 0.56) return '高';
    return '很高';
  }

  /* ---------------- 缩放 / 平移 (即时回放与放大预览共用) ----------------
   * 用 transform: translate(...) scale(...) 实现, 不改变布局;
   * 滚轮以光标为锚点缩放, 按住拖动平移, 双击在"适应/2.5 倍"之间切换。
   * —— 为什么不用 CSS zoom: zoom 会触发重新布局, 拖动时会抖。
   */
  const ZOOM_MIN = 1, ZOOM_MAX = 8, ZOOM_STEP = 1.35;

  function makeZoom(stage, img, levelEl, outBtn, inBtn) {
    let z = 1, px = 0, py = 0, drag = null;

    function sync() {
      // 按"图片自身布局尺寸 × 缩放"与舞台尺寸的差值来限制平移,
      // 这样图片比舞台小时(z=1 或灯光箱里的信箱边)就不会被拖动出多余的空白
      const w = img.offsetWidth || stage.clientWidth;
      const h = img.offsetHeight || stage.clientHeight;
      const mx = Math.max(0, (w * z - stage.clientWidth) / 2);
      const my = Math.max(0, (h * z - stage.clientHeight) / 2);
      px = Math.max(-mx, Math.min(mx, px));
      py = Math.max(-my, Math.min(my, py));
      img.style.transform = z === 1
        ? 'none'
        : 'translate(' + px.toFixed(1) + 'px,' + py.toFixed(1) + 'px) scale(' + z.toFixed(4) + ')';
      if (levelEl) levelEl.textContent = Math.round(z * 100) + '%';
      if (outBtn) outBtn.disabled = z <= ZOOM_MIN + 1e-6;
      if (inBtn) inBtn.disabled = z >= ZOOM_MAX - 1e-6;
    }

    // cx / cy 是相对舞台中心的像素坐标, 缩放后该点仍停在光标下
    function zoomAt(nz, cx, cy) {
      nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, nz));
      if (Math.abs(nz - z) < 1e-6) return;
      const k = nz / z;
      px = cx - (cx - px) * k;
      py = cy - (cy - py) * k;
      z = nz;
      sync();
    }

    function reset() { z = 1; px = 0; py = 0; sync(); }
    function step(dir) { zoomAt(dir > 0 ? z * ZOOM_STEP : z / ZOOM_STEP, 0, 0); }

    img.addEventListener('wheel', function (e) {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(z * Math.exp(-e.deltaY * 0.0016),
        e.clientX - r.left - r.width / 2,
        e.clientY - r.top - r.height / 2);
    }, { passive: false });

    img.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, px: px, py: py };
      img.classList.add('grabbing');
      try { img.setPointerCapture(e.pointerId); } catch (err) { }
    });
    img.addEventListener('pointermove', function (e) {
      if (!drag) return;
      px = drag.px + (e.clientX - drag.x);
      py = drag.py + (e.clientY - drag.y);
      sync();
    });
    function endDrag(e) {
      if (!drag) return;
      drag = null;
      img.classList.remove('grabbing');
      try { img.releasePointerCapture(e.pointerId); } catch (err) { }
    }
    img.addEventListener('pointerup', endDrag);
    img.addEventListener('pointercancel', endDrag);

    img.addEventListener('dblclick', function () { if (z > 1) reset(); else zoomAt(2.5, 0, 0); });

    sync();
    return { reset: reset, step: step, refresh: sync, level: function () { return z; } };
  }

  /* ---------------- 初始化 ---------------- */
  function init(options) {
    cb = options || {};
    const st = O.state;

    /* 预设按钮 */
    const pw = $('presets');
    Object.keys(O.PRESETS).forEach(function (k) {
      const b = document.createElement('button');
      b.className = 'preset' + (k === st.preset ? ' on' : '');
      b.dataset.k = k;
      b.textContent = O.PRESETS[k].name;
      b.onclick = function () {
        st.preset = k;
        window.WORLD.setPreset(k);
        Array.prototype.forEach.call(pw.children, function (c) {
          c.classList.toggle('on', c.dataset.k === k);
        });
        changedKey = 'preset';
        emit();
        toast('场景切换为 <b>' + O.PRESETS[k].name + '</b> · EV ' + O.PRESETS[k].ev.toFixed(1) + ' — ' + O.PRESETS[k].desc);
      };
      pw.appendChild(b);
    });

    /* 开关 */
    toggle('tg-handheld', 'handheld', function (v) { toast(v ? '手持模式：注意安全快门' : '已切换到<b>三脚架</b>，可以放心用慢门'); });
    toggle('tg-vr', 'vr', function (v) { toast(v ? '机身防抖已开启（约 5 档）' : '机身防抖关闭'); });
    toggle('tg-grid', 'showGrid', null);
    $('tg-film').onclick = function () {
      const on = $('app').classList.toggle('film-hidden');
      $('tg-film').classList.toggle('on', !on);
      resizeSoon();
    };

    /* 曝光标尺刻度 */
    const ticks = $('meter-ticks');
    for (let i = 0; i <= 6; i++) {
      const t = document.createElement('i');
      t.style.top = (i / 6 * 100) + '%';
      ticks.appendChild(t);
    }

    /* 滑块 */
    setupSlider('sl-iso', O.ISO_STEPS.length - 1, 1, function (v) {
      st.iso = O.ISO_STEPS[v]; changedKey = 'iso';
    });
    setupSlider('sl-ap', O.AP_STEPS.length - 1, 1, function (v) {
      st.ap = O.AP_STEPS[v]; changedKey = 'ap';
    });
    setupSlider('sl-t', O.SHUTTER_STEPS.length - 1, 1, function (v) {
      st.t = O.SHUTTER_STEPS[v]; changedKey = 't';
      if (st.t >= 0.3 && st.handheld) {
        toast('快门 ' + O.shutterLabel(st.t) + ' 手持几乎一定会糊 —— 试试<b>三脚架</b>，或开防抖后配合更大的光圈/更高的 ISO');
      }
    });
    setupSlider('sl-focal', O.FOCAL_MAX, O.FOCAL_MIN, function (v) {
      st.focal = v; changedKey = 'focal';
    });
    setupSlider('sl-focus', 1000, 0, function (v) {
      st.focus = O.normToFocus(v / 1000); changedKey = 'focus';
    });

    /* 快门按钮 */
    $('shutter-release').onclick = function () { if (cb.onShoot) cb.onShoot(); };

    /* 灯箱 */
    const closeLb = function () { $('lightbox').classList.remove('on'); };
    $('lb-close').onclick = closeLb;
    $('lightbox').onclick = function (e) { if (e.target === $('lightbox')) closeLb(); };
    $('lb-del').onclick = function () {
      const idx = +$('lb-del').dataset.idx;
      removeShot(idx);
      closeLb();
    };

    /* 缩放: 回放层与放大预览共用同一套逻辑 */
    zoomReview = makeZoom($('review'), $('review-img'), $('rv-level'), $('rv-out'), $('rv-in'));
    zoomLightbox = makeZoom($('lb-stage'), $('lb-img'), $('lb-level'), $('lb-out'), $('lb-in'));
    $('rv-out').onclick = function () { zoomReview.step(-1); };
    $('rv-in').onclick = function () { zoomReview.step(1); };
    $('rv-fit').onclick = function () { zoomReview.reset(); };
    $('lb-out').onclick = function () { zoomLightbox.step(-1); };
    $('lb-in').onclick = function () { zoomLightbox.step(1); };

    /* 只要开始摆弄回放(滚轮/拖动/双击/点工具条), 就不再自动返回取景 */
    ['wheel', 'pointerdown', 'dblclick'].forEach(function (ev) {
      $('review').addEventListener(ev, holdReview, { capture: true });
    });

    /* 即时回放的工具条: 详情 / 手动关闭 */
    $('rv-info').onclick = function () {
      const idx = reviewedIdx;
      hideReview();
      if (idx >= 0) openLightbox(idx);
    };
    $('rv-close').onclick = function () { hideReview(); };

    /* Esc 关闭; + / - / 0 缩放 */
    window.addEventListener('keydown', function (e) {
      const lbOn = $('lightbox').classList.contains('on');
      const rvOn = $('review').classList.contains('on');
      if (e.key === 'Escape') {
        if (lbOn) closeLb(); else if (rvOn) hideReview();
        return;
      }
      const z = lbOn ? zoomLightbox : (rvOn ? zoomReview : null);
      if (!z) return;
      if (e.key === '+' || e.key === '=') { z.step(1); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { z.step(-1); e.preventDefault(); }
      else if (e.key === '0') { z.reset(); e.preventDefault(); }
    });

    window.addEventListener('resize', function () {
      if (zoomReview) zoomReview.refresh();
      if (zoomLightbox) zoomLightbox.refresh();
    });

    try { doneSet = JSON.parse(localStorage.getItem('z52-challenges') || '{}'); } catch (e) { doneSet = {}; }

    sync();
  }

  function setupSlider(id, max, min, onChange) {
    const el = $(id);
    el.min = min; el.max = max;
    el.oninput = function () {
      onChange(parseFloat(el.value));
      emit();
    };
  }

  function toggle(id, key, after) {
    const el = $(id);
    el.onclick = function () {
      O.state[key] = !O.state[key];
      el.classList.toggle('on', O.state[key]);
      if (after) after(O.state[key]);
      changedKey = key;
      emit();
    };
  }

  /* ---------------- 状态同步 ---------------- */
  function emit() {
    sync();
    if (cb.onChange) cb.onChange(changedKey);
    changedKey = null;
  }

  function sync() {
    const st = O.state;
    $('sl-iso').value = O.stepIndex(O.ISO_STEPS, st.iso);
    $('sl-ap').value = O.stepIndex(O.AP_STEPS, st.ap);
    $('sl-t').value = O.stepIndex(O.SHUTTER_STEPS, st.t);
    $('sl-focal').value = st.focal;
    $('sl-focus').value = Math.round(O.focusToNorm(st.focus) * 1000);

    $('sl-iso-v').textContent = O.isoLabel(st.iso);
    $('sl-ap-v').textContent = O.apertureLabel(st.ap);
    $('sl-t-v').textContent = O.shutterLabel(st.t);
    $('sl-focal-v').textContent = O.focalLabel(st.focal);
    $('sl-focus-v').textContent = O.focusLabel(st.focus);

    // 快门滑块的档位说明
    const safe = O.safeShutter(st);
    const sh = O.shake(st, 1000);
    $('sl-t-note').textContent = st.handheld
      ? (sh.ok ? '手持安全（' + O.shutterLabel(safe) + ' 以内）' : '⚠ 手持可能糊，需 ' + O.shutterLabel(safe) + ' 更快')
      : '三脚架：无抖动';

    // 高亮变化的参数
    ['iso', 'ap', 't'].forEach(function (k) { $('sl-' + k).classList.remove('hot'); });
    if (changedKey === 'iso') $('sl-iso').classList.add('hot');
    if (changedKey === 'ap') $('sl-ap').classList.add('hot');
    if (changedKey === 't') $('sl-t').classList.add('hot');

    buildLearn();
    updateShotMeta();
  }

  /* ---------------- 每帧更新 ---------------- */
  function tick() {
    const st = O.state;
    // 底部参数条
    $('sv-iso').textContent = O.isoLabel(st.iso);
    $('sv-ap').textContent = O.apertureLabel(st.ap);
    $('sv-t').textContent = O.shutterLabel(st.t);
    $('sv-focus').textContent = O.focusLabel(st.focus);

    const d = O.dofRange(st);
    $('sv-dof').textContent = d.infinite
      ? d.near.toFixed(1) + 'm–∞'
      : (d.near < 1 ? d.near.toFixed(2) : d.near.toFixed(1)) + '–' +
      (d.far > 20 ? '∞' : (d.far < 1 ? d.far.toFixed(2) : d.far.toFixed(1))) + 'm';
    $('sv-noise').textContent = noiseWord(O.noiseLevel(st));

    // 顶栏
    $('hud-focal').textContent = st.focal;
    $('hud-scene').textContent = O.PRESETS[st.preset].name + ' · EV ' + O.evScene(st).toFixed(1);

    // 对焦框
    const fb = $('focus-box');
    fb.dataset.label = '对焦 ' + O.focusLabel(st.focus);
    fb.classList.toggle('warn', !O.shake(st, 1000).ok);

    // 曝光标尺
    const dv = O.deltaEV(st);
    const pct = 50 - Math.max(-3.4, Math.min(3.4, dv)) / 3 * 50;
    $('needle').style.top = Math.max(1, Math.min(99, pct)) + '%';
    const mn = $('meter-num');
    mn.textContent = (dv > 0 ? '+' : '') + dv.toFixed(1);
    mn.className = 'num' + (dv > 1 ? ' over' : dv < -1 ? ' under' : '');
    $('gridlines').style.display = st.showGrid ? '' : 'none';
  }

  /* ---------------- 直方图 ---------------- */
  function drawHisto() {
    const h = window.PIPE.getHisto();
    const c = $('hist');
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    if (!h) return;
    const bins = h.bins;
    let peak = 0.001;
    for (let i = 0; i < 64; i++) {
      peak = Math.max(peak, bins[i * 3], bins[i * 3 + 1], bins[i * 3 + 2]);
    }
    const cols = ['rgba(255,72,72,0.55)', 'rgba(72,255,132,0.55)', 'rgba(84,150,255,0.55)'];
    for (let ch = 0; ch < 3; ch++) {
      g.fillStyle = cols[ch];
      g.beginPath();
      g.moveTo(0, H);
      for (let i = 0; i < 64; i++) {
        const v = bins[i * 3 + ch] / (peak * 1.12);
        const x = i / 63 * W;
        g.lineTo(x, H - Math.min(1, v) * (H - 4));
      }
      g.lineTo(W, H); g.closePath();
      g.fill();
    }
    // 网格
    g.strokeStyle = 'rgba(255,255,255,0.09)'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(i / 4 * W, 0); g.lineTo(i / 4 * W, H); g.stroke();
    }
    $('hist-note').textContent = h.clipLo > 0.02 ? '直方图 · 暗部有死黑' : '直方图';
    $('hist-blink').textContent = h.clipHi > 0.012 ? '高光溢出 ' + (h.clipHi * 100).toFixed(1) + '%' : '';
  }

  /* ---------------- 诊断与学习面板 ---------------- */
  function buildLearn() {
    const st = O.state;
    const d = O.deltaEV(st);
    const dof = O.dofRange(st);
    const nz = O.noiseLevel(st);
    const sh = O.shake(st, 1000);
    const key = [st.iso, st.ap, st.t, st.focal, Math.round(st.focus * 10), st.preset,
      st.handheld, st.vr].join('|');
    if (key === lastLearnKey) return;
    lastLearnKey = key;

    // 背景虚化强度(以 35m 处的远景估算; 5.5m 处是前景标志牌)
    const bgPx = O.cocPx(st, 35, 1000);
    const fgPx = O.cocPx(st, 5.5, 1000);

    let exp = '曝光准确';
    if (d > 1) exp = '过曝 ' + d.toFixed(1) + ' EV';
    else if (d < -1) exp = '欠曝 ' + (-d).toFixed(1) + ' EV';

    const advice = [];
    if (d > 1) advice.push('画面偏亮 → 收小光圈、加快快门，或降低 ISO');
    if (d < -1) advice.push('画面偏暗 → 开大光圈、放慢快门，或提高 ISO');
    if (sh.ok === false) advice.push('快门 ' + O.shutterLabel(st.t) + ' 在 ' + st.focal + 'mm 手持太慢（安全快门 ' + O.shutterLabel(sh.safe) + '）→ 上脚架或开防抖');
    if (nz > 0.19) advice.push('ISO ' + st.iso + ' 噪点明显 → 能上脚架就用低 ISO + 慢门替代高 ISO');
    if (!advice.length) advice.push('这组参数很稳，可以按快门了');

    let html = '';
    html += '<h4>当前这一张</h4>';
    html += '<div class="kv">' +
      '<b>' + exp + '</b><span>EV ' + O.evScene(st).toFixed(1) + ' 场景 / 参数组合 ' + O.evCam(st).toFixed(1) + '</span>' +
      '<b>' + (dof.infinite ? dof.near.toFixed(1) + 'm–∞' : dof.near.toFixed(1) + '–' + dof.far.toFixed(1) + 'm') + '</b><span>景深范围（弥散圆 0.03mm）</span>' +
      '<b>' + bgPx.toFixed(1) + ' px</b><span>35m 处背景的虚化半径；5.5m 处的标志牌是 ' + fgPx.toFixed(1) + ' px</span>' +
      '<b>' + noiseWord(nz) + '</b><span>噪点（ISO ' + st.iso + '）</span>' +
      '<b>' + (sh.ok ? '稳' : '会抖') + '</b><span>' + (st.handheld ? '手持' : '脚架') + (st.vr ? ' + 防抖' : '') + '，安全快门 ' + O.shutterLabel(sh.safe) + '</span>' +
      '</div>';
    html += '<p style="color:#9aa3af">' + advice.join('；') + '。</p>';

    html += '<h4>曝光三角，一句话版</h4>';
    html += '<div class="kv">' +
      '<b>光圈 f/' + st.ap + '</b><span>越大(数字越小)越亮、越虚化、暗角越重；<br>每小一级(×1.4)少一半光</span>' +
      '<b>快门 ' + O.shutterLabel(st.t) + '</b><span>越慢越亮、越容易糊/拖影；<br>每慢一档多一倍光</span>' +
      '<b>ISO ' + st.iso + '</b><span>越高越亮、噪点越多；<br>不改变虚化和拖影</span>' +
      '</div>';
    html += '<p>三者是<b>此消彼长</b>的：想要同一个亮度，一共只有那么多"曝光量"要在三个旋钮之间分配。' +
      '当前的组合是 ' + O.apertureLabel(st.ap) + ' + ' + O.shutterLabel(st.t) + ' + ISO' + st.iso +
      '，而场景只需要 EV ' + O.evScene(st).toFixed(1) + '。</p>';

    html += '<h4>学习挑战 <button class="reset" id="chal-reset">重置进度</button></h4>';
    CHALLENGES.forEach(function (c) {
      const done = !!doneSet[c.id];
      const now = c.ok(st);
      if (now && !done) {
        doneSet[c.id] = true;
        try { localStorage.setItem('z52-challenges', JSON.stringify(doneSet)); } catch (e) { }
        toast('挑战达成 · ' + c.t.replace(/<\/?b>/g, '').split('：')[0]);
      }
      // 已达成但当前参数不满足时, 不能再把当前参数摆在 "已达成" 后面, 否则会被误读成"现在就达标"
      const tail = done
        ? (now ? '已达成 · ' + c.p(st) : '曾经达成 ✓ —— 调回条件可再拿一次')
        : c.p(st);
      html += '<div class="chal' + (done ? ' done' : '') + '">' +
        '<i class="box">✓</i><span class="t">' + c.t +
        '<span class="p">' + tail + '</span></span></div>';
    });

    $('learn-body').innerHTML = html;
    const rst = $('chal-reset');
    if (rst) rst.onclick = function () {
      doneSet = {}; lastLearnKey = '';
      try { localStorage.removeItem('z52-challenges'); } catch (e) { }
      buildLearn();
      toast('学习挑战进度已重置');
    };
    $('learn-tag').textContent = O.PRESETS[st.preset].name;
  }

  /* ---------------- 成片 ---------------- */
  // 拍完立刻在取景器里回放(纯前端预览, 不写盘); 可缩放细看, 也能手动关闭
  function review(dataUrl, idx) {
    reviewedIdx = idx;
    $('review-img').src = dataUrl;
    if (zoomReview) zoomReview.reset();
    $('review').classList.add('on');
    armReviewTimer();
  }

  function armReviewTimer() {
    clearTimeout(reviewTimer);
    reviewHeld = false;
    reviewTimer = setTimeout(hideReview, REVIEW_MS);
  }

  // 用户开始缩放/拖动 -> 取消自动返回, 由他自己关
  function holdReview() {
    if (reviewHeld) return;
    reviewHeld = true;
    clearTimeout(reviewTimer);
    reviewTimer = null;
  }

  function hideReview() {
    clearTimeout(reviewTimer);
    reviewTimer = null;
    reviewHeld = false;
    $('review').classList.remove('on');
    // 等淡出结束再清 src, 避免闪一下空白
    setTimeout(function () { if (!reviewTimer) $('review-img').removeAttribute('src'); }, 240);
  }

  function addShot(dataUrl, meta) {
    const idx = shots.length;
    shots.push({ url: dataUrl, meta: meta });
    review(dataUrl, idx);
    const strip = $('strip');
    if (strip.querySelector('.empty')) strip.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'shot';
    el.dataset.idx = idx;
    el.innerHTML = '<img src="' + dataUrl + '">' +
      '<div class="meta"><i>' + meta.t + '</i> ' + meta.ap + ' ISO' + meta.iso + '</div>' +
      '<div class="del">×</div>';
    el.querySelector('img').onclick = function () { openLightbox(idx); };
    el.querySelector('.del').onclick = function (e) {
      e.stopPropagation();
      removeShot(idx);
    };
    strip.appendChild(el);
    strip.scrollLeft = strip.scrollWidth;
  }

  function removeShot(idx) {
    const s = shots[idx];
    if (!s) return;
    shots[idx] = null;
    if (idx === reviewedIdx) hideReview();
    const strip = $('strip');
    const el = strip.querySelector('.shot[data-idx="' + idx + '"]');
    if (el) el.remove();
    if (!strip.children.length) {
      strip.innerHTML = '<span class="empty">按下快门按钮（或空格键）拍下当前画面：成片会立刻在取景器里回放，可缩放细看、也可点 × 手动关闭，并留在这条胶卷上供回看。只在本次会话里预览，不会存到本地。</span>';
    }
  }

  function openLightbox(idx) {
    const s = shots[idx];
    if (!s) return;
    hideReview();
    $('lb-img').src = s.url;
    $('lb-info').innerHTML =
      '<b>' + s.meta.ap + '</b> · <b>' + s.meta.t + '</b> · <b>ISO ' + s.meta.iso + '</b> · ' +
      s.meta.focal + ' · 对焦 ' + s.meta.focus + '<br>' +
      s.meta.preset + '（EV ' + s.meta.ev + '） · ' + s.meta.mode +
      ' · 曝光 ' + s.meta.delta + 'EV · 景深 ' + s.meta.dof;
    $('lb-del').dataset.idx = idx;
    $('lightbox').classList.add('on');
    // 必须等 .on 生效(舞台有了尺寸)之后再复位缩放
    if (zoomLightbox) zoomLightbox.reset();
  }

  function updateShotMeta() {
    // 成片元数据在拍摄时固化, 这里只用于快门按下瞬间读取
  }

  function shotMeta() {
    const st = O.state;
    const d = O.dofRange(st);
    return {
      iso: st.iso, ap: O.apertureLabel(st.ap), t: O.shutterLabel(st.t),
      focal: O.focalLabel(st.focal), focus: O.focusLabel(st.focus),
      preset: O.PRESETS[st.preset].name, ev: O.evScene(st).toFixed(1),
      mode: (st.handheld ? '手持' : '脚架') + (st.vr ? '+VR' : ''),
      delta: O.deltaEV(st).toFixed(1),
      dof: d.infinite ? d.near.toFixed(1) + 'm–∞' : d.near.toFixed(1) + '–' + d.far.toFixed(1) + 'm'
    };
  }

  /* ---------------- 提示 / 闪光 ---------------- */
  function toast(html) {
    const t = $('toast');
    t.innerHTML = html;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3800);
  }

  function flash() {
    const f = $('flash');
    f.classList.remove('fire');
    void f.offsetWidth;
    f.classList.add('fire');
  }

  function resizeSoon() {
    if (cb.onResize) setTimeout(cb.onResize, 60);
  }

  return {
    init: init, sync: sync, tick: tick, drawHisto: drawHisto,
    addShot: addShot, shotMeta: shotMeta, toast: toast, flash: flash,
    noiseWord: noiseWord
  };
})();
