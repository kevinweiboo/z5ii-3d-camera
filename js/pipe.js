/* =============================================================
 * pipe.js — 自定义渲染管线
 *  ① 快门: 在曝光时间内采多个子帧并累加 -> 真实动态模糊
 *  ② 光圈/焦距/对焦: 由精确弥散圆公式驱动的多级景深 + 九边形焦外光斑
 *  ③ ISO: 线性域噪点(含色噪) + 暗部加权
 *  ④ 光圈还带来暗角与色散变化
 * ============================================================= */
window.PIPE = (function () {
  'use strict';

  const T = window.THREE;

  const TAPS_FULL = 20, TAPS_HALF = 24, TAPS_QUARTER = 20;
  const MAXCOC_FULL = 34, MAXCOC_HALF = 12, MAXCOC_QUARTER = 14;
  const BLADES = 9;               // NIKKOR Z 24-120mm f/4 S 的光圈叶片数

  let renderer, W = 1280, H = 720;
  const QUAD_SCALE = 0.25;
  let rtScene, rtAccum, rtFullB, rtHalf, rtHalfB, rtQuarter, rtQuarterB, rtHisto;
  let quadScene, quadCam, quadMesh;
  let mAccum, mDown, mBlurFull, mBlurHalf, mBlurQuarter, mComp, mCopy;
  let tapsFull, tapsHalf, tapsQuarter;
  let histoBuf, histoData = null, histoFrame = 0;
  let quality = 1.0;
  // 分级调试开关(常驻便于排查): index.html?stage=scene|acc|full|quarter
  // 分别直接显示 原始场景 / 累加缓冲 / 全分辨率景深 / 四分之一分辨率景深
  const DBG = (function () {
    try { return new URLSearchParams(location.search).get('stage'); } catch (e) { return null; }
  })();

  /* ---------- 顶点着色器 ---------- */
  const VS = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');

  /* ---------- 焦外光斑采样点: 黄金角螺旋 + 九边形边界 ---------- */
  function makeTaps(n, polygon) {
    const out = [];
    const PHI = 2.39996323;
    const seg = Math.PI * 2 / BLADES;
    for (let i = 0; i < n; i++) {
      const a = i * PHI;
      const r = Math.sqrt((i + 0.55) / n);
      let poly = 1;
      if (polygon) {
        let th = a % seg; if (th < 0) th += seg;
        th -= seg / 2;
        poly = Math.cos(seg / 2) / Math.cos(th);
      }
      out.push(new T.Vector3(Math.cos(a) * r, Math.sin(a) * r, poly));
    }
    return out;
  }

  /* ---------- 共用 GLSL 片段 ---------- */
  const GLSL_DEPTH = [
    'uniform sampler2D tDepth; uniform float uNear; uniform float uFar;',
    'uniform vec2 uRes; uniform float uFocal; uniform float uFNum;',
    'uniform float uFocus; uniform float uSensorH; uniform float uMaxR;',
    'float linDepth(vec2 uv){',
    '  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;',
    '  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));',
    '}',
    'float cocOfDepth(float s1m){',
    '  float f = uFocal;',
    // 统一到毫米: 焦距 mm 必须与物距同单位, 否则弥散圆完全失真
    '  float s2 = uFocus * 1000.0;',
    '  float s1 = s1m * 1000.0;',
    '  float v  = f * s2 / max(s2 - f, 0.0001);',
    '  float v1 = f * s1 / max(s1 - f, 0.0001);',
    '  float A = f / uFNum;',
    '  float c = abs(A * (v - v1) / v);',
    '  return clamp(c / uSensorH * uRes.y, 0.0, uMaxR);',
    '}',
    'float cocAt(vec2 uv){',
    '  return cocOfDepth(max(linDepth(uv), 0.02));',
    '}'
  ].join('\n');

  /* ---------- 初始化 ---------- */
  function init(r) {
    renderer = r;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;

    quadScene = new T.Scene();
    quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadMesh = new T.Mesh(new T.PlaneGeometry(2, 2));
    quadMesh.frustumCulled = false;
    quadScene.add(quadMesh);

    tapsFull = makeTaps(TAPS_FULL, false);
    tapsHalf = makeTaps(TAPS_HALF, true);
    tapsQuarter = makeTaps(TAPS_QUARTER, true);

    mAccum = new T.ShaderMaterial({
      vertexShader: VS,
      // 注意: 叠加混合使用 SrcAlpha/One, 因此 alpha 必须固定为 1,
      // 权重只由 uW 承担, 否则会被 alpha 二次衰减
      fragmentShader: 'uniform sampler2D tSrc; uniform float uW; varying vec2 vUv;\n' +
        'void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb * uW, 1.0); }',
      uniforms: { tSrc: { value: null }, uW: { value: 1 } },
      blending: T.AdditiveBlending, transparent: true,
      depthTest: false, depthWrite: false
    });

    mDown = new T.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: [
        'uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;',
        'void main(){',
        '  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0,-1.0)).rgb;',
        '  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0,-1.0)).rgb;',
        '  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;',
        '  c += texture2D(tSrc, vUv + uTexel * vec2( 1.0, 1.0)).rgb;',
        '  gl_FragColor = vec4(c * 0.25, 1.0);',
        '}'
      ].join('\n'),
      uniforms: { tSrc: { value: null }, uTexel: { value: new T.Vector2() } },
      depthTest: false, depthWrite: false
    });

    mBlurFull = makeBlur(tapsFull, MAXCOC_FULL, 0.0);
    mBlurHalf = makeBlur(tapsHalf, MAXCOC_HALF, 0.55);
    mBlurQuarter = makeBlur(tapsQuarter, MAXCOC_QUARTER, 0.85);

    mComp = new T.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: [
        'varying vec2 vUv;',
        'uniform sampler2D tFull; uniform sampler2D tHalf; uniform sampler2D tQuarter;',
        'uniform float uExposure; uniform float uGrain; uniform float uChroma;',
        'uniform float uCA; uniform float uVig; uniform float uSeed; uniform float uTime;',
        'uniform vec2 uResPx;',
        GLSL_DEPTH,
        'vec3 aces(vec3 x){',
        '  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);',
        '}',
        'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
        'vec3 hash3(vec2 p){',
        '  return vec3(hash(p), hash(p + 19.19), hash(p + 47.31));',
        '}',
        'vec3 toSRGB(vec3 c){',
        '  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055,',
        '             step(vec3(0.0031308), c));',
        '}',
        'void main(){',
        '  float coc = cocAt(vUv);',
        '  vec2 cen = vUv - 0.5;',
        '  vec2 dir = length(cen) > 1e-4 ? normalize(cen) : vec2(1.0, 0.0);',
        '  vec2 o = dir * uCA * (0.30 + 1.55 * length(cen)) / uResPx;',
        '  float sha = 1.0 - smoothstep(0.6, 3.0, coc);',
        '  vec3 sharp = vec3(texture2D(tFull, vUv + o * sha).r,',
        '                    texture2D(tFull, vUv).g,',
        '                    texture2D(tFull, vUv - o * sha).b);',
        '  vec3 col = sharp;',
        '  float w1 = smoothstep(1.2, 4.5, coc);',
        '  col = mix(col, texture2D(tHalf, vUv).rgb, w1);',
        '  float w2 = smoothstep(5.0, 13.0, coc);',
        '  col = mix(col, texture2D(tQuarter, vUv).rgb, w2);',
        // 暗角 (光圈越大越明显)
        '  float rr = dot(cen, cen);',
        '  col *= 1.0 - uVig * rr * 1.6;',
        // 曝光
        '  col *= uExposure;',
        // 噪点 (线性域, 暗部加权)
        '  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));',
        '  vec2 gp = vUv * uResPx;',
        '  vec3 n1 = hash3(gp + fract(uSeed) * 91.7);',
        '  vec3 n2 = hash3(gp * 1.71 + fract(uSeed * 1.37) * 53.3);',
        '  vec3 nz = (n1 - 0.5) * 0.6 + (n2 - 0.5) * 0.4;',
        '  vec3 nchroma = vec3(nz.r, dot(n1 - 0.5, vec3(0.5)) + 0.5 * (n2.g - 0.5), nz.b);',
        '  vec3 gn = mix(nz, nchroma, uChroma);',
        // 散粒噪声: 幅度随 sqrt(信号) 增长, 暗部只保留少量读噪声
        '  float amp = uGrain * (0.25 + sqrt(max(lum, 0.0))) * 2.0;',
        '  col += gn * amp;',
        '  col = max(col, vec3(0.0));',
        // 色调映射 + 输出编码
        '  col = aces(col * 1.06);',
        '  gl_FragColor = vec4(toSRGB(col), 1.0);',
        '}'
      ].join('\n'),
      uniforms: {
        tFull: { value: null }, tHalf: { value: null }, tQuarter: { value: null },
        tDepth: { value: null },
        uNear: { value: 0.05 }, uFar: { value: 400 },
        uRes: { value: new T.Vector2(1, 1) },
        uResPx: { value: new T.Vector2(1, 1) },
        uFocal: { value: 50 }, uFNum: { value: 8 }, uFocus: { value: 3 },
        uSensorH: { value: 24 }, uMaxR: { value: MAXCOC_FULL },
        uExposure: { value: 1 }, uGrain: { value: 0.01 }, uChroma: { value: 0.5 },
        uCA: { value: 0.4 }, uVig: { value: 0.2 },
        uSeed: { value: 0 }, uTime: { value: 0 }
      },
      depthTest: false, depthWrite: false
    });

    mCopy = new T.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: 'uniform sampler2D tSrc; varying vec2 vUv;\n' +
        'void main(){ gl_FragColor = texture2D(tSrc, vUv); }',
      uniforms: { tSrc: { value: null } },
      depthTest: false, depthWrite: false
    });

    histoBuf = new Uint8Array(128 * 72 * 4);
    rtHisto = new T.WebGLRenderTarget(128, 72, { type: T.UnsignedByteType });
  }

  function makeBlur(taps, maxR, highlight) {
    return new T.ShaderMaterial({
      vertexShader: VS,
      fragmentShader: [
        'varying vec2 vUv;',
        'uniform sampler2D tSrc; uniform vec3 uTaps[' + taps.length + '];',
        'uniform float uBlade; uniform float uHighlight;',
        GLSL_DEPTH,
        'void main(){',
        '  vec3 base = texture2D(tSrc, vUv).rgb;',
        '  float coc = cocAt(vUv);',
        '  if (coc < 0.55) { gl_FragColor = vec4(base, 1.0); return; }',
        '  vec3 sum = base * 0.45; float wsum = 0.45;',
        '  for (int i = 0; i < ' + taps.length + '; i++){',
        '    vec3 tp = uTaps[i];',
        '    float poly = mix(1.0, tp.z, uBlade);',
        '    vec2 u2 = vUv + tp.xy * poly * coc / uRes;',
        '    float ct = cocAt(u2);',
        '    vec3 cs = texture2D(tSrc, u2).rgb;',
        '    float lum = dot(cs, vec3(0.2126, 0.7152, 0.0722));',
        '    float w = smoothstep(0.0, 1.0, min(ct, coc * 1.5) / max(coc, 0.001));',
        '    w *= 1.0 + uHighlight * smoothstep(0.45, 1.0, lum);',
        '    sum += cs * w; wsum += w;',
        '  }',
        '  gl_FragColor = vec4(sum / wsum, 1.0);',
        '}'
      ].join('\n'),
      uniforms: {
        tSrc: { value: null }, tDepth: { value: null },
        uTaps: { value: taps },
        uBlade: { value: 0.35 }, uHighlight: { value: 1.6 },
        uNear: { value: 0.05 }, uFar: { value: 400 },
        uRes: { value: new T.Vector2(1, 1) },
        uFocal: { value: 50 }, uFNum: { value: 8 }, uFocus: { value: 3 },
        uSensorH: { value: 24 }, uMaxR: { value: maxR }
      },
      depthTest: false, depthWrite: false
    });
  }

  /* ---------- 尺寸 ---------- */
  function setSize(w, h) {
    w = Math.max(2, Math.floor(w));
    h = Math.max(2, Math.floor(h));
    if (w === W && h === H) return;
    W = w; H = h;
    const hw = Math.max(2, Math.floor(W * 0.5)), hh = Math.max(2, Math.floor(H * 0.5));
    const qw = Math.max(2, Math.floor(W * QUAD_SCALE)), qh = Math.max(2, Math.floor(H * QUAD_SCALE));

    function dispose(rt) { if (rt) rt.dispose(); }
    dispose(rtScene); dispose(rtAccum); dispose(rtFullB); dispose(rtHalf);
    dispose(rtHalfB); dispose(rtQuarter); dispose(rtQuarterB);

    const depthTex = new T.DepthTexture(W, H);
    depthTex.type = T.UnsignedIntType;
    rtScene = new T.WebGLRenderTarget(W, H, {
      type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
      depthTexture: depthTex, stencilBuffer: false
    });
    const opts = { type: T.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    rtAccum = new T.WebGLRenderTarget(W, H, opts);
    rtFullB = new T.WebGLRenderTarget(W, H, opts);
    rtHalf = new T.WebGLRenderTarget(hw, hh, opts);
    rtHalfB = new T.WebGLRenderTarget(hw, hh, opts);
    rtQuarter = new T.WebGLRenderTarget(qw, qh, opts);
    rtQuarterB = new T.WebGLRenderTarget(qw, qh, opts);
  }

  function setQuality(q) { quality = q; }

  function blit(mat, target, uniforms) {
    if (uniforms) {
      for (const k in uniforms) if (mat.uniforms[k]) mat.uniforms[k].value = uniforms[k];
    }
    quadMesh.material = mat;
    renderer.setRenderTarget(target || null);
    renderer.render(quadScene, quadCam);
  }

  /* ---------- 主渲染 ---------- */
  // p: { scene, camera, basePos, baseQuat, worldTime, samples, span, updateScene,
  //      optics:{ fov, focal, fNum, focus, exposure, grain, chroma, ca, vig, blade },
  //      shakeAmp, seed, trail }
  function render(p) {
    const cam = p.camera;
    const n = Math.max(1, p.samples | 0);
    const inv = 1 / n;

    for (let i = 0; i < n; i++) {
      const k = n === 1 ? 0 : (i / (n - 1) - 0.5);
      const t = p.worldTime + p.span * k;

      cam.position.copy(p.basePos);
      cam.quaternion.copy(p.baseQuat);
      if (p.shakeAmp > 0.01) {
        const vb = 2 * Math.atan(window.OPT.SENSOR_H / (2 * p.optics.focal));
        const ang = p.shakeAmp / H * vb;
        const sx = 0.6 * Math.sin(t * 7.3 + p.seed) + 0.4 * Math.sin(t * 17.1 + p.seed * 2.3);
        const sy = 0.6 * Math.sin(t * 5.7 + p.seed * 3.1) + 0.4 * Math.sin(t * 13.7 + p.seed * 0.7);
        cam.rotateX(sy * ang);
        cam.rotateY(sx * ang);
      }
      cam.updateMatrixWorld();

      p.updateScene(t, { trail: p.trail, cheap: i > 0 });

      renderer.setRenderTarget(rtScene);
      renderer.clear(true, true, false);
      renderer.render(p.scene, cam);

      if (i === 0) {
        renderer.setRenderTarget(rtAccum);
        renderer.clear(true, false, false);
      }
      blit(mAccum, rtAccum, { tSrc: rtScene.texture, uW: inv });
    }

    cam.position.copy(p.basePos);
    cam.quaternion.copy(p.baseQuat);
    cam.updateMatrixWorld();

    const o = p.optics;
    const dw = { tDepth: rtScene.depthTexture, uNear: cam.near, uFar: cam.far,
      uFocal: o.focal, uFNum: o.fNum, uFocus: o.focus, uSensorH: window.OPT.SENSOR_H };

    if (DBG === 'scene') { blit(mCopy, null, { tSrc: rtScene.texture }); return; }
    if (DBG === 'acc') { blit(mCopy, null, { tSrc: rtAccum.texture }); return; }

    // 降采样: 全 -> 半 -> 四分之一
    blit(mDown, rtHalf, { tSrc: rtAccum.texture, uTexel: new T.Vector2(1 / W, 1 / H) });
    blit(mDown, rtQuarter, { tSrc: rtHalf.texture, uTexel: new T.Vector2(2 / W, 2 / H) });

    // 三级景深: 半径随分辨率等比缩放, 大半径用低分辨率换取足够的采样密度
    blurPass(mBlurFull, rtAccum.texture, rtFullB, W, H, dw, o);
    blurPass(mBlurHalf, rtHalf.texture, rtHalfB, Math.floor(W * 0.5), Math.floor(H * 0.5), dw, o);
    blurPass(mBlurQuarter, rtQuarter.texture, rtQuarterB,
      Math.floor(W * QUAD_SCALE), Math.floor(H * QUAD_SCALE), dw, o);

    if (DBG === 'full') { blit(mCopy, null, { tSrc: rtFullB.texture }); return; }
    if (DBG === 'quarter') { blit(mCopy, null, { tSrc: rtQuarterB.texture }); return; }

    // 合成
    const cu = mComp.uniforms;
    cu.tFull.value = rtFullB.texture;
    cu.tHalf.value = rtHalfB.texture;
    cu.tQuarter.value = rtQuarterB.texture;
    cu.tDepth.value = rtScene.depthTexture;
    cu.uNear.value = cam.near; cu.uFar.value = cam.far;
    cu.uRes.value.set(W, H); cu.uResPx.value.set(W, H);
    cu.uFocal.value = o.focal; cu.uFNum.value = o.fNum; cu.uFocus.value = o.focus;
    cu.uSensorH.value = window.OPT.SENSOR_H; cu.uMaxR.value = MAXCOC_FULL;
    cu.uExposure.value = o.exposure;
    cu.uGrain.value = o.grain;
    cu.uChroma.value = o.chroma;
    cu.uCA.value = o.ca;
    cu.uVig.value = o.vig;
    cu.uSeed.value = p.seed;
    cu.uTime.value = p.worldTime;

    quadMesh.material = mComp;
    renderer.setRenderTarget(null);
    renderer.render(quadScene, quadCam);

    // 直方图 (低频, 只读 128x72 缩略)
    histoFrame++;
    if (p.histogram && histoFrame % 4 === 0) {
      renderer.setRenderTarget(rtHisto);
      renderer.render(quadScene, quadCam);
      renderer.readRenderTargetPixels(rtHisto, 0, 0, 128, 72, histoBuf);
      computeHisto();
      renderer.setRenderTarget(null);
    }
  }

  function blurPass(mat, srcTex, target, w, h, dw, o) {
    mat.uniforms.tSrc.value = srcTex;
    mat.uniforms.uRes.value.set(w, h);
    applyCommon(mat, dw);
    applyBlade(mat, o);
    quadMesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  function applyCommon(m, dw) {
    const u = m.uniforms;
    u.tDepth.value = dw.tDepth;
    u.uNear.value = dw.uNear; u.uFar.value = dw.uFar;
    u.uFocal.value = dw.uFocal; u.uFNum.value = dw.uFNum;
    u.uFocus.value = dw.uFocus; u.uSensorH.value = dw.uSensorH;
  }

  function applyBlade(m, o) {
    // 光圈叶片: 收缩时光斑从圆形变为九边形
    m.uniforms.uBlade.value = Math.min(1, Math.max(0, (o.fNum - 4) / 13)) * 0.9;
  }

  /* ---------- 直方图 ---------- */
  function computeHisto() {
    const bins = new Float32Array(64 * 3);
    let clipHi = 0, clipLo = 0;
    const n = 128 * 72;
    for (let i = 0; i < n; i++) {
      const r = histoBuf[i * 4], g = histoBuf[i * 4 + 1], b = histoBuf[i * 4 + 2];
      bins[(r >> 2) * 3] += 1;
      bins[(g >> 2) * 3 + 1] += 1;
      bins[(b >> 2) * 3 + 2] += 1;
      if (r > 250 && g > 250 && b > 250) clipHi++;
      if (r < 3 && g < 3 && b < 3) clipLo++;
    }
    for (let i = 0; i < 64; i++) {
      bins[i * 3] /= n; bins[i * 3 + 1] /= n; bins[i * 3 + 2] /= n;
    }
    histoData = { bins: bins, clipHi: clipHi / n, clipLo: clipLo / n };
  }

  function getHisto() { return histoData; }

  return {
    init: init, setSize: setSize, render: render,
    setQuality: setQuality, getHisto: getHisto,
    get size() { return { w: W, h: H }; },
    MAXCOC_FULL: MAXCOC_FULL
  };
})();
