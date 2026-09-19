/* =============================================================
 * main.js — 主循环与装配
 * ============================================================= */
(function () {
  'use strict';

  const O = window.OPT;
  const T = window.THREE;

  let renderer, camera, world, canvas, vf;
  let timeAcc = 0, lastMs = 0, seed = Math.random() * 100;
  let histoTick = 0, ready = false;

  const MAXW = 1440, MAXH = 900;

  function boot() {
    T.ColorManagement.enabled = true;

    canvas = document.getElementById('view');
    vf = document.querySelector('.viewfinder');

    try {
      renderer = new T.WebGLRenderer({
        canvas: canvas, antialias: false, alpha: false,
        preserveDrawingBuffer: true, powerPreference: 'high-performance'
      });
    } catch (e) {
      document.body.innerHTML = '<div style="padding:40px;color:#fff;font:14px/1.7 sans-serif">' +
        '当前浏览器无法创建 WebGL 上下文，请换用 Chrome / Edge / Safari 最新版打开。</div>';
      return;
    }
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;

    // 场景
    world = window.WORLD.build();
    camera = new T.PerspectiveCamera(50, 1.6, 0.1, 420);
    camera.position.copy(window.WORLD.CAM_POS);
    camera.lookAt(window.WORLD.CAM_LOOK);

    // 管线
    window.PIPE.init(renderer);

    // 三维相机
    window.CAM3D.init(
      document.getElementById('cam3d'),
      document.getElementById('tags3d'),
      onCam3dChange
    );

    // 界面
    window.UI.init({
      onShoot: shoot,
      onChange: onStateChange,
      onResize: resize
    });

    bindKeys();
    resize();
    window.addEventListener('resize', resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(vf);

    ready = true;
    window.CAM3D.applyState(O.state);
    camera.fov = fovOf(O.state.focal);
    camera.updateProjectionMatrix();

    window.UI.toast('欢迎 · 拖动右侧相机上的<b>拨盘和镜头环</b>，或直接拉动滑杆。' +
      '先试试把光圈开到 f/4 并把焦距拉到 120mm，看串灯怎么变成光斑。');

    lastMs = performance.now();
    requestAnimationFrame(loop);
  }

  function fovOf(focal) {
    return 2 * Math.atan(O.SENSOR_H / (2 * focal)) * 180 / Math.PI;
  }

  function onStateChange(key) {
    if (key === 'shoot') { shoot(); return; }
    window.CAM3D.applyState(O.state);
  }

  function onCam3dChange(key) {
    window.UI.sync();
    window.CAM3D.applyState(O.state);
  }

  /* ---------------- 尺寸 ---------------- */
  function resize() {
    if (!vf) return;
    const r = vf.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    const k = Math.min(1, MAXW / w, MAXH / h);
    w = Math.max(320, Math.round(w * k));
    h = Math.max(200, Math.round(h * k));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    window.PIPE.setSize(w, h);
    window.CAM3D.resize();
  }

  /* ---------------- 曝光参数装配 ---------------- */
  function opticsParams(st) {
    const nz = O.noiseLevel(st);
    const dry = 4 / st.ap;                 // 相对 f/4 的开口比例
    return {
      fov: fovOf(st.focal),
      focal: st.focal,
      fNum: st.ap,
      focus: Math.min(st.focus, 400),
      exposure: O.exposureScale(st),
      grain: O.grainAmt(st),
      chroma: 0.22 + 0.55 * nz,
      ca: 0.18 + 1.05 * Math.pow(dry, 1.35),
      vig: 0.06 + 0.15 * dry
    };
  }

  /* ---------------- 主循环 ---------------- */
  let accFrames = 0, accTime = 0, fps = 60;

  function loop(ms) {
    if (!ready) return;
    requestAnimationFrame(loop);

    const dt = Math.min(0.1, (ms - lastMs) / 1000) || 0.016;
    lastMs = ms;
    accFrames++; accTime += dt;
    if (accTime > 0.5) { fps = accFrames / accTime; accFrames = 0; accTime = 0; }

    const st = O.state;
    if (!st.freeze) timeAcc += dt;

    camera.fov = fovOf(st.focal);
    camera.updateProjectionMatrix();

    const samples = O.blurSamples(st);
    const span = O.blurSpan(st);
    const trail = O.trailAmount(st);
    const shakeAmp = O.shake(st, window.PIPE.size.h).amp;

    // 每帧只重算一次阴影贴图(而不是每个子帧)
    renderer.shadowMap.needsUpdate = true;

    const basePos = camera.position.clone();
    const baseQuat = camera.quaternion.clone();

    window.PIPE.render({
      scene: world.scene,
      camera: camera,
      basePos: basePos,
      baseQuat: baseQuat,
      worldTime: timeAcc,
      samples: samples,
      span: span,
      trail: trail,
      shakeAmp: shakeAmp,
      seed: seed,
      histogram: true,
      optics: opticsParams(st),
      updateScene: function (t, o) { window.WORLD.update(t, o); }
    });

    // 界面
    window.UI.tick();
    histoTick++;
    if (histoTick % 6 === 0) window.UI.drawHisto();
    window.CAM3D.render(st, dt);
  }

  /* ---------------- 拍照 ---------------- */
  function shoot() {
    if (!ready) return;
    try {
      const url = canvas.toDataURL('image/png');
      window.UI.addShot(url, window.UI.shotMeta());
      window.UI.flash();
      const st = O.state;
      const d = O.deltaEV(st);
      if (Math.abs(d) > 1.5) {
        window.UI.toast('拍下了 · 不过曝光偏差 ' + d.toFixed(1) + ' EV —— ' +
          (d > 0 ? '试试收小光圈或加快快门' : '试试开大光圈、放慢快门或提高 ISO'));
      }
    } catch (e) {
      window.UI.toast('没能抓下这一帧：' + e.message);
    }
  }

  /* ---------------- 快捷键 ---------------- */
  function bindKeys() {
    window.addEventListener('keydown', function (e) {
      const st = O.state;
      let k = null;
      switch (e.key) {
        case ' ': shoot(); e.preventDefault(); return;
        case 'ArrowUp': st.iso = O.step(O.ISO_STEPS, st.iso, 1); k = 'iso'; break;
        case 'ArrowDown': st.iso = O.step(O.ISO_STEPS, st.iso, -1); k = 'iso'; break;
        case 'ArrowRight': st.t = O.step(O.SHUTTER_STEPS, st.t, 1); k = 't'; break;
        case 'ArrowLeft': st.t = O.step(O.SHUTTER_STEPS, st.t, -1); k = 't'; break;
        case 'q': case 'Q': st.ap = O.step(O.AP_STEPS, st.ap, 1); k = 'ap'; break;
        case 'a': case 'A': st.ap = O.step(O.AP_STEPS, st.ap, -1); k = 'ap'; break;
        case 'w': case 'W': st.focal = Math.min(O.FOCAL_MAX, st.focal + 2); k = 'focal'; break;
        case 's': case 'S': st.focal = Math.max(O.FOCAL_MIN, st.focal - 2); k = 'focal'; break;
        case 'f': case 'F':
          st.freeze = !st.freeze;
          window.UI.toast(st.freeze ? '已冻结主体运动，方便单独观察其他变量' : '恢复运动');
          return;
        case 'g': case 'G':
          st.handheld = !st.handheld;
          document.getElementById('tg-handheld').classList.toggle('on', st.handheld);
          document.getElementById('tg-handheld').innerHTML = '<i class="dot"></i>' + (st.handheld ? '手持' : '脚架');
          k = 'handheld';
          break;
        case '1': case '2': case '3': case '4':
          var keys = Object.keys(O.PRESETS);
          var pk = keys[+e.key - 1];
          if (pk) {
            st.preset = pk;
            window.WORLD.setPreset(pk);
            Array.prototype.forEach.call(document.getElementById('presets').children, function (c) {
              c.classList.toggle('on', c.dataset.k === pk);
            });
            k = 'preset';
          }
          break;
        default: return;
      }
      e.preventDefault();
      window.UI.sync();
      window.CAM3D.applyState(st);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
