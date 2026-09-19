/* =============================================================
 * optics.js — 曝光三角 / 景深 / 防抖 的物理模型
 * 机身与镜头参数对齐: Nikon Z5II + NIKKOR Z 24-120mm f/4 S
 * ============================================================= */
window.OPT = (function () {
  'use strict';

  /* ---------- 档位表 (1/3 EV 步进, 与尼康机身一致) ---------- */
  const ISO_STEPS = [
    100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600,
    2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800, 16000,
    20000, 25600, 32000, 40000, 51200, 64000
  ];

  const AP_STEPS = [4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22];

  const SHUTTER_STEPS = [
    1 / 8000, 1 / 6400, 1 / 5000, 1 / 4000, 1 / 3200, 1 / 2500, 1 / 2000,
    1 / 1600, 1 / 1250, 1 / 1000, 1 / 800, 1 / 640, 1 / 500, 1 / 400,
    1 / 320, 1 / 250, 1 / 200, 1 / 160, 1 / 125, 1 / 100, 1 / 80, 1 / 60,
    1 / 50, 1 / 40, 1 / 30, 1 / 25, 1 / 20, 1 / 15, 1 / 13, 1 / 10, 1 / 8,
    1 / 6, 1 / 5, 1 / 4, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.3, 1.6, 2, 2.5,
    3.2, 4, 5, 6, 8, 10, 13, 15, 20, 25, 30
  ];

  const FOCAL_MIN = 24;
  const FOCAL_MAX = 120;
  const SENSOR_H = 24;      // 全画幅传感器高 36x24mm
  const SENSOR_W = 36;
  const COC_STD = 0.03;     // 全画幅标准容许弥散圆 mm
  const VR_STOPS = 5;       // 保守估计: Z5II 机身防抖约 5 档(官方标称 7.5 档)

  /* ---------- 光照场景 (EV100 由场景亮度决定, 与参数无关) ---------- */
  const PRESETS = {
    night: {
      key: 'night', name: '夜晚霓虹', ev: 5.5,
      sky: ['#0a0f1e', '#1b2338'], sun: '#cfe0ff', sunPos: [16, 30, 30],
      lampOn: true, desc: '路灯和霓虹亮起。f/4 手持大约要 ISO 1600~6400, 或者上脚架长曝光。'
    },
    indoor: {
      key: 'indoor', name: '阴天弱光', ev: 7.5,
      sky: ['#1a1c24', '#2b2e3a'], sun: '#ffd9a8', sunPos: [-16, 22, 24],
      lampOn: true, desc: '阴天傍晚或宽敞室内的亮度。f/4 手持大约要 ISO 400~1600。'
    },
    dusk: {
      key: 'dusk', name: '黄昏街道', ev: 9.5,
      sky: ['#2a2540', '#c07a52'], sun: '#ff9d5c', sunPos: [-24, 14, 22],
      lampOn: true, desc: '蓝调时刻。天空和灯光亮度接近, 是最好拍的时段。'
    },
    day: {
      key: 'day', name: '晴天户外', ev: 13.0,
      sky: ['#2a6fc4', '#9ec6ea'], sun: '#fff6df', sunPos: [22, 38, 26],
      lampOn: false, desc: '阳光明媚。ISO 100 + f/8 + 1/125 就是标准正确曝光。'
    }
  };

  /* ---------- 状态 ---------- */
  const state = {
    iso: 100,
    ap: 8,
    t: 1 / 125,
    focal: 50,
    focus: 6.0,
    preset: 'day',
    handheld: true,
    vr: true,
    showGrid: true,
    showFocusBox: true,
    freeze: false
  };

  /* ---------- EV 计算 ---------- */
  // 相机设置对应的曝光值: EV = log2(N^2/t) - log2(ISO/100)
  function evCam(st) {
    st = st || state;
    return Math.log2((st.ap * st.ap) / st.t) - Math.log2(st.iso / 100);
  }

  function evScene(st) {
    st = st || state;
    return PRESETS[st.preset].ev;
  }

  // >0 过曝, <0 欠曝
  function deltaEV(st) {
    st = st || state;
    return evScene(st) - evCam(st);
  }

  // 渲染亮度倍率
  function exposureScale(st) {
    return Math.pow(2, Math.max(-14, Math.min(8, deltaEV(st))));
  }

  /* ---------- 景深: 精确弥散圆 (CoC) ---------- */
  // f: 焦距 mm, N: 光圈值, S2: 对焦距离 mm, S1: 物距 mm -> 返回传感器上弥散圆直径 mm
  function cocMM(focalMM, N, s2mm, s1mm) {
    const f = focalMM;
    const v = f * s2mm / (s2mm - f);
    const v1 = f * s1mm / (s1mm - f);
    if (!isFinite(v) || !isFinite(v1) || v <= 0) return 0;
    const A = f / N;
    return Math.abs(A * (v - v1) / v);
  }

  // 把传感器上的弥散圆换算成渲染分辨率下的模糊半径(像素)
  function cocPx(st, distM, renderH) {
    st = st || state;
    const c = cocMM(st.focal, st.ap, st.focus * 1000, Math.max(distM, st.focal / 1000 + 0.002) * 1000);
    return c / SENSOR_H * renderH;
  }

  // 景深范围 (米), 基于标准容许弥散圆 0.03mm
  function dofRange(st) {
    st = st || state;
    const f = st.focal, N = st.ap, S = st.focus * 1000;
    if (S <= f) return { near: st.focus, far: st.focus, hyper: Infinity, infinite: false };
    const H = (f * f) / (N * COC_STD) + f;
    const near = (S * (H - f)) / (H + S - 2 * f) / 1000;
    const infinite = H <= S;
    const far = infinite ? Infinity : (S * (H - f)) / (H - S) / 1000;
    return { near: near, far: far, hyper: H / 1000, infinite: infinite };
  }

  /* ---------- 噪点 ---------- */
  // 返回 0~1 的相对噪点强度
  // 与 grainAmt 同源归一化(0~1): 保证诊断文字与画面里真实的颗粒感一致
  function noiseLevel(st) {
    return Math.min(1, grainAmt(st) / 0.05);
  }

  function grainAmt(st) {
    st = st || state;
    // 线性域噪点幅度: 与 ISO 的 ~0.45 次方成正比(读噪声+散粒噪声的粗略合成)
    // ISO100 近乎干净, ISO6400 明显颗粒, ISO64000 严重
    const g = Math.pow(Math.max(st.iso, 100) / 100, 0.45);
    const under = Math.max(0, -deltaEV(st));
    const boost = 1 + Math.min(under, 4) * 0.22;
    return Math.min(0.05, 0.0022 * g * boost);
  }

  /* ---------- 手抖 ---------- */
  function safeShutter(st) {
    st = st || state;
    const vr = st.vr ? VR_STOPS : 0;
    return (1 / st.focal) * Math.pow(2, vr);
  }

  // 手抖造成的画面偏移(像素, 峰值) + 是否处于安全快门内
  function shake(st, renderH) {
    st = st || state;
    const safe = safeShutter(st);
    if (!st.handheld) return { amp: 0, ok: true, safe: safe, stops: 0 };
    const over = Math.max(0, Math.log2(st.t / safe));
    // 每超 1 档, 约 0.22 度的抖动
    const deg = Math.min(over, 4) * 0.22;
    const vfovDeg = 2 * Math.atan(SENSOR_H / (2 * st.focal)) * 180 / Math.PI;
    const amp = (deg / vfovDeg) * renderH * 1.6;
    return { amp: amp, ok: over <= 0.05, safe: safe, stops: over };
  }

  /* ---------- 动态模糊 ---------- */
  // 快门期间等效的动画时间跨度(秒). 过长时用光轨等附加效果补足
  function blurSpan(st) {
    st = st || state;
    return Math.min(st.t, 0.55);
  }

  // 需要的子帧数量
  function blurSamples(st) {
    const span = blurSpan(st);
    const s = Math.round(span * 60);
    return Math.max(1, Math.min(26, s));
  }

  // 光轨强度 0~1 (长曝光时几何光轨淡入)
  function trailAmount(st) {
    st = st || state;
    const x = Math.log2(st.t / (1 / 8));
    return Math.max(0, Math.min(1, x / 3.2));
  }

  /* ---------- 档位操作 ---------- */
  function stepIndex(arr, v) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const d = Math.abs(arr[i] - v);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }

  function step(list, cur, dir) {
    const i = stepIndex(list, cur);
    return list[Math.max(0, Math.min(list.length - 1, i + dir))];
  }

  /* ---------- 格式化 ---------- */
  function shutterLabel(t) {
    if (t >= 0.3) {
      const s = t >= 1 ? String(Math.round(t * 10) / 10) : t.toFixed(1);
      return s.replace(/\.0$/, '') + '"';
    }
    const d = 1 / t;
    return '1/' + (d >= 100 ? Math.round(d) : (Math.round(d * 10) / 10));
  }

  function apertureLabel(n) {
    return 'f/' + (Number.isInteger(n) ? n : n.toFixed(1).replace(/\.0$/, ''));
  }

  function isoLabel(i) { return String(i); }

  function focalLabel(f) { return f + 'mm'; }

  function focusLabel(d) {
    if (d >= 25) return '∞';
    if (d < 1) return d.toFixed(2) + 'm';
    return d.toFixed(1) + 'm';
  }

  /* ---------- 对焦距离映射 (对数刻度: 0.35m ~ 60m, 末端为无穷远) ---------- */
  const FOCUS_MIN = 0.35;
  const FOCUS_MAX = 60;

  function focusToNorm(d) {
    if (d >= FOCUS_MAX) return 1;
    const t = (Math.log(Math.max(d, FOCUS_MIN)) - Math.log(FOCUS_MIN)) /
      (Math.log(FOCUS_MAX) - Math.log(FOCUS_MIN));
    return Math.max(0, Math.min(1, t));
  }

  function normToFocus(t) {
    t = Math.max(0, Math.min(1, t));
    if (t >= 0.996) return 400;
    return Math.exp(Math.log(FOCUS_MIN) + t * (Math.log(FOCUS_MAX) - Math.log(FOCUS_MIN)));
  }

  function focusDrag(d, delta) {
    return normToFocus(focusToNorm(d) + delta * 0.013);
  }

  /* ---------- 导出 ---------- */
  return {
    state: state,
    ISO_STEPS: ISO_STEPS, AP_STEPS: AP_STEPS, SHUTTER_STEPS: SHUTTER_STEPS,
    PRESETS: PRESETS,
    FOCAL_MIN: FOCAL_MIN, FOCAL_MAX: FOCAL_MAX,
    FOCUS_MIN: FOCUS_MIN, FOCUS_MAX: FOCUS_MAX,
    SENSOR_H: SENSOR_H, SENSOR_W: SENSOR_W, COC_STD: COC_STD, VR_STOPS: VR_STOPS,
    evCam: evCam, evScene: evScene, deltaEV: deltaEV, exposureScale: exposureScale,
    cocMM: cocMM, cocPx: cocPx, dofRange: dofRange,
    noiseLevel: noiseLevel, grainAmt: grainAmt,
    safeShutter: safeShutter, shake: shake,
    blurSpan: blurSpan, blurSamples: blurSamples, trailAmount: trailAmount,
    step: step, stepIndex: stepIndex,
    shutterLabel: shutterLabel, apertureLabel: apertureLabel, isoLabel: isoLabel,
    focalLabel: focalLabel, focusLabel: focusLabel,
    focusToNorm: focusToNorm, normToFocus: normToFocus, focusDrag: focusDrag
  };
})();
