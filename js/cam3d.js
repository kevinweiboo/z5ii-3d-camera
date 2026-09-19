/* =============================================================
 * cam3d.js — 可拖拽的 Nikon Z5II + Z 24-120mm f/4 S 三维模型
 * 顶盖 ISO 拨盘 / 快门拨盘 / 前指令拨盘 / 变焦环 / 对焦环
 * 光圈叶片随 f 值真实收放(9 片)
 * ============================================================= */
window.CAM3D = (function () {
  'use strict';
  const T = window.THREE;

  let renderer, scene, camera, canvas, tagsEl;
  let root, lensGroup, lensBarrel, blades = [], bladePivot = [];
  let ctrl = {};              // 可拖拽部件
  let labels = {};
  let onChange = null;
  let orbit = { az: 0.62, el: 0.30, dist: 46, tAz: 0.62, tEl: 0.30, tDist: 46 };
  let dragging = null, hovered = null, lastPt = { x: 0, y: 0 };
  let lcdTex, lcdCtx, lcdDirty = true;
  let phong = {};
  let t0 = 0;

  /* ---------------- 材质 ---------------- */
  function bodyMat(color, shin) {
    return new T.MeshPhongMaterial({
      color: color, shininess: shin === undefined ? 24 : shin,
      specular: 0x3a4048, flatShading: false
    });
  }

  function box(w, h, d, mat) {
    const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat);
    return m;
  }

  /* ---------------- 旋钮/环 ---------------- */
  function knurl(radius, height, seg, mat) {
    const g = new T.CylinderGeometry(radius, radius, height, seg, 1);
    return new T.Mesh(g, mat);
  }

  function makeDial(radius, height, mat, markerColor) {
    const g = new T.Group();
    const d = knurl(radius, height, 30, mat);
    g.add(d);
    const top = new T.Mesh(new T.CircleGeometry(radius * 0.99, 30),
      new T.MeshPhongMaterial({ color: 0x1d2025, shininess: 60, specular: 0x2a2f36 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = height / 2 + 0.001;
    g.add(top);
    const mk = new T.Mesh(new T.BoxGeometry(0.13, 0.05, radius * 0.8),
      new T.MeshBasicMaterial({ color: markerColor || 0xf5c518 }));
    mk.position.set(0, height / 2 + 0.03, -radius * 0.45);
    g.add(mk);
    g.userData.marker = mk;
    return g;
  }

  function makeRing(radius, height, mat, ribs) {
    const g = new T.Group();
    const seg = ribs || 48;
    const r = knurl(radius, height, seg, mat);
    r.rotation.x = Math.PI / 2;
    g.add(r);
    return g;
  }

  /* ---------------- 液晶屏 ---------------- */
  function lcdTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 320;
    lcdTex = new T.CanvasTexture(c);
    lcdCtx = c.getContext('2d');
    return lcdTex;
  }

  function drawLCD(st) {
    if (!lcdCtx) return;
    const O = window.OPT;
    const g = lcdCtx, W = 512, H = 320;
    g.fillStyle = '#0b0d0f'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#14171a'; g.fillRect(6, 6, W - 12, H - 12);
    // 顶行
    g.font = '600 30px ui-monospace, Menlo, monospace';
    g.fillStyle = '#eef2f6';
    g.fillText('M', 22, 52);
    g.fillStyle = '#f5c518';
    g.fillText(O.shutterLabel(st.t), 66, 52);
    g.fillStyle = '#eef2f6';
    g.fillText(O.apertureLabel(st.ap), 220, 52);
    g.fillText('ISO', 350, 52);
    g.fillStyle = '#f5c518';
    g.fillText(O.isoLabel(st.iso), 410, 52);
    // 曝光标尺
    const cx = W / 2, y = 128, half = 196;
    g.strokeStyle = '#4c545e'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx - half, y); g.lineTo(cx + half, y); g.stroke();
    for (let i = -3; i <= 3; i++) {
      const x = cx + (i / 3) * half;
      g.beginPath(); g.moveTo(x, y - 11); g.lineTo(x, y + 11); g.stroke();
    }
    const d = O.deltaEV(st);
    const nx = cx + Math.max(-1, Math.min(1, d / 3)) * half;
    g.fillStyle = Math.abs(d) < 0.5 ? '#3ddc84' : (Math.abs(d) < 1.5 ? '#f5c518' : '#ff5f56');
    g.fillRect(nx - 6, y - 18, 12, 36);
    // 下排
    g.font = '500 24px ui-monospace, Menlo, monospace';
    g.fillStyle = '#9aa3af';
    g.fillText(O.focalLabel(st.focal), 22, 200);
    g.fillText(O.focusLabel(st.focus), 190, 200);
    g.fillText(O.PRESETS[st.preset].name, 320, 200);
    g.font = '500 22px ui-monospace, Menlo, monospace';
    g.fillStyle = '#6b7480';
    g.fillText('EV' + O.evScene(st).toFixed(1), 22, 246);
    g.fillStyle = st.handheld ? '#f5c518' : '#3ddc84';
    g.fillText(st.handheld ? 'HANDHELD' : 'TRIPOD', 150, 246);
    g.fillStyle = st.vr ? '#3ddc84' : '#6b7480';
    g.fillText(st.vr ? 'VR ON' : 'VR OFF', 340, 246);
    // 胶片装饰
    g.strokeStyle = '#20242a'; g.lineWidth = 2;
    g.strokeRect(14, 276, W - 28, 30);
    g.fillStyle = '#20242a';
    for (let i = 0; i < 26; i++) g.fillRect(22 + i * 18, 280, 10, 4);
    lcdTex.needsUpdate = true;
  }

  /* ---------------- 构build ---------------- */
  function build() {
    scene = new T.Scene();
    scene.background = null;

    root = new T.Group();
    scene.add(root);

    const cBody = 0x292d33, cTop = 0x3b4149, cGrip = 0x1e2126;
    const mBody = bodyMat(cBody, 26);
    const mTop = bodyMat(cTop, 40);
    const mGrip = new T.MeshPhongMaterial({ color: cGrip, shininess: 8, specular: 0x1a1d21 });
    const mKnurl = bodyMat(0x33383f, 60);
    const mSilver = new T.MeshPhongMaterial({ color: 0x8d949c, shininess: 90, specular: 0xcfd6dd });
    const mGlass = new T.MeshPhongMaterial({
      color: 0x0a0f16, shininess: 160, specular: 0x9fc4e8, transparent: true, opacity: 0.34
    });
    phong = { mBody: mBody, mTop: mTop, mKnurl: mKnurl, mSilver: mSilver };

    /* --- 机身主体 --- */
    const body = box(13.4, 9.0, 6.1, mBody);
    body.position.y = 0;
    root.add(body);
    root.userData.body = body;

    // 顶盖
    const topPlate = box(13.9, 1.5, 6.4, mTop);
    topPlate.position.y = 5.2;
    root.add(topPlate);
    // 底板
    const basePlate = box(13.4, 0.8, 6.0, bodyMat(0x232629, 16));
    basePlate.position.y = -4.85;
    root.add(basePlate);

    // 握柄
    const grip = box(4.5, 9.0, 6.5, mGrip);
    grip.position.set(5.35, 0, 0.55);
    root.add(grip);
    const gripFront = box(1.0, 8.2, 5.6, mGrip);
    gripFront.position.set(7.1, -0.2, 0.35);
    root.add(gripFront);
    // 红色饰条
    const red = box(0.14, 1.5, 0.5, new T.MeshPhongMaterial({ color: 0xb0182a, shininess: 70 }));
    red.position.set(7.62, 2.6, 1.3);
    root.add(red);

    // 取景器
    const hump = box(4.4, 2.3, 3.2, mTop);
    hump.position.set(-1.2, 6.6, -1.9);
    root.add(hump);
    const shoe = box(3.0, 0.32, 2.2, bodyMat(0x16181b, 50));
    shoe.position.set(-1.2, 7.9, -1.9);
    root.add(shoe);
    const cup = new T.Mesh(new T.CylinderGeometry(1.25, 1.45, 0.9, 24), mGrip);
    cup.rotation.x = Math.PI / 2;
    cup.position.set(-1.2, 6.5, -3.6);
    root.add(cup);
    const eye = new T.Mesh(new T.CircleGeometry(1.05, 24),
      new T.MeshPhongMaterial({ color: 0x05070a, shininess: 140, specular: 0x6f8fb5 }));
    eye.position.set(-1.2, 6.5, -4.06);
    root.add(eye);

    // 背屏
    lcdTexture();
    const scr = new T.Mesh(new T.PlaneGeometry(9.4, 5.9),
      new T.MeshBasicMaterial({ map: lcdTex, toneMapped: false }));
    scr.position.set(-0.4, -0.35, -3.07);
    scr.rotation.y = Math.PI;
    root.add(scr);
    const scrFrame = box(10.0, 6.5, 0.3, bodyMat(0x15171a, 10));
    scrFrame.position.set(-0.4, -0.35, -2.95);
    root.add(scrFrame);

    /* --- 顶盖拨盘 --- */
    const iso = makeDial(1.72, 0.62, mKnurl, 0xf5c518);
    iso.position.set(-4.9, 6.24, -0.7);
    iso.userData.ctrl = 'iso';
    root.add(iso);
    ctrl.iso = iso;

    const shd = makeDial(1.5, 0.58, mKnurl, 0xf5c518);
    shd.position.set(2.1, 6.22, 1.35);
    shd.userData.ctrl = 't';
    root.add(shd);
    ctrl.t = shd;

    // 快门按钮
    const btn = new T.Group();
    const btnBase = new T.Mesh(new T.CylinderGeometry(0.9, 0.95, 0.35, 26), mSilver);
    btn.add(btnBase);
    const btnCap = new T.Mesh(new T.CylinderGeometry(0.72, 0.78, 0.42, 26),
      new T.MeshPhongMaterial({ color: 0xd8c9a0, shininess: 120, specular: 0xfff3d0 }));
    btnCap.position.y = 0.28;
    btn.add(btnCap);
    btn.position.set(5.9, 6.28, 1.65);
    btn.userData.ctrl = 'shoot';
    root.add(btn);
    ctrl.shoot = btn;

    // 前指令拨盘 (光圈)
    const fdial = knurl(1.02, 0.55, 26, mKnurl);
    fdial.rotation.z = Math.PI / 2;
    fdial.position.set(5.15, 4.2, 3.35);
    fdial.userData.ctrl = 'ap';
    root.add(fdial);
    ctrl.ap = fdial;

    // 后指令拨盘 (小, 纯装饰对照)
    const rdial = knurl(0.95, 0.5, 26, mKnurl);
    rdial.rotation.z = Math.PI / 2;
    rdial.position.set(4.6, 5.0, -3.0);
    root.add(rdial);

    // 机顶小饰件
    const btnA = new T.Mesh(new T.CylinderGeometry(0.3, 0.3, 0.26, 16), mKnurl);
    btnA.position.set(0.6, 6.15, 1.6);
    root.add(btnA);

    /* --- 镜头 --- */
    lensGroup = new T.Group();
    lensGroup.position.set(0, -0.4, 3.05);
    root.add(lensGroup);
    ctrl.lens = lensGroup;

    const mMount = mSilver;
    const mountRing = new T.Mesh(new T.CylinderGeometry(3.05, 3.05, 0.6, 40), mMount);
    mountRing.rotation.x = Math.PI / 2;
    mountRing.position.z = 0.3;
    lensGroup.add(mountRing);

    const mBarrel = bodyMat(0x24282d, 34);
    // 后段桶身(变焦时伸缩)
    lensBarrel = new T.Group();
    lensBarrel.position.z = 0.55;
    lensGroup.add(lensBarrel);

    const rear1 = new T.Mesh(new T.CylinderGeometry(3.15, 3.2, 1.8, 40), mBarrel);
    rear1.rotation.x = Math.PI / 2;
    rear1.position.z = 0.9;
    lensBarrel.add(rear1);

    // 光圈叶片 (9 片, 位于镜筒内部)
    const bladeMat = new T.MeshPhongMaterial({
      color: 0x14171b, shininess: 70, specular: 0x555c66, side: T.DoubleSide
    });
    const iris = new T.Group();
    iris.position.z = 8.6;
    lensBarrel.add(iris);
    for (let i = 0; i < 9; i++) {
      const pv = new T.Group();
      pv.rotation.z = (i / 9) * Math.PI * 2;
      const bl = new T.Mesh(new T.BoxGeometry(2.0, 2.6, 0.05), bladeMat);
      bl.position.set(1.55, 0, i * 0.014);
      bl.rotation.z = 0.55;
      pv.add(bl);
      iris.add(pv);
      bladePivot.push(pv);
      blades.push(bl);
    }
    // 光圈后面的遮光筒(防止看穿镜筒)
    const stop = new T.Mesh(new T.CylinderGeometry(2.95, 2.95, 6.6, 32, 1, true),
      new T.MeshPhongMaterial({ color: 0x0d0f12, shininess: 4, side: T.BackSide }));
    stop.rotation.x = Math.PI / 2;
    stop.position.z = 5.1;
    lensBarrel.add(stop);

    // 中段变焦环
    const zoomRing = makeRing(3.72, 2.9, new T.MeshPhongMaterial({
      color: 0x2b3036, shininess: 12, specular: 0x23262a
    }), 44);
    zoomRing.position.z = 4.6;
    zoomRing.userData.ctrl = 'focal';
    lensBarrel.add(zoomRing);
    ctrl.focal = zoomRing;

    // 控制环
    const cRing = makeRing(3.62, 1.1, mKnurl, 40);
    cRing.position.z = 6.5;
    lensBarrel.add(cRing);

    // 对焦环
    const focusRing = makeRing(3.78, 2.4, new T.MeshPhongMaterial({
      color: 0x22262b, shininess: 10, specular: 0x1e2125
    }), 52);
    focusRing.position.z = 8.4;
    focusRing.userData.ctrl = 'focus';
    lensBarrel.add(focusRing);
    ctrl.focus = focusRing;

    // 前段 + 前镜组
    const front = new T.Mesh(new T.CylinderGeometry(3.85, 3.72, 1.5, 44), mBarrel);
    front.rotation.x = Math.PI / 2;
    front.position.z = 10.3;
    lensBarrel.add(front);
    const frontLip = new T.Mesh(new T.CylinderGeometry(3.9, 3.9, 0.42, 44), mSilver);
    frontLip.rotation.x = Math.PI / 2;
    frontLip.position.z = 11.0;
    lensBarrel.add(frontLip);
    const frontGlass = new T.Mesh(new T.SphereGeometry(3.35, 40, 22, 0, Math.PI * 2, 0, Math.PI * 0.36), mGlass);
    frontGlass.rotation.x = Math.PI / 2;
    frontGlass.position.z = 10.35;
    lensBarrel.add(frontGlass);
    const irisRing = null; // 前组不加遮挡, 让光圈叶片能从前方看见

    // S 标与文字饰条
    const badge = box(1.5, 0.9, 0.08, mSilver);
    badge.position.set(2.9, 2.2, 4.62);
    badge.rotation.y = Math.PI / 2;
    lensBarrel.add(badge);
    const ring2 = new T.Mesh(new T.CylinderGeometry(3.55, 3.55, 0.16, 40),
      new T.MeshPhongMaterial({ color: 0xc8b273, shininess: 110, specular: 0xffffff }));
    ring2.rotation.x = Math.PI / 2;
    ring2.position.z = 3.1;
    lensBarrel.add(ring2);

    /* --- 灯光 --- */
    scene.add(new T.HemisphereLight(0xa8c2e0, 0x14161a, 0.85));
    const key = new T.DirectionalLight(0xffffff, 1.35);
    key.position.set(-14, 18, 16);
    scene.add(key);
    const fill = new T.DirectionalLight(0x8fb4e0, 0.55);
    fill.position.set(18, 6, 10);
    scene.add(fill);
    const rim = new T.DirectionalLight(0xffd9a0, 0.85);
    rim.position.set(6, 10, -20);
    scene.add(rim);
    const p1 = new T.PointLight(0xfff0d8, 26, 40, 2);
    p1.position.set(-6, 8, 12);
    scene.add(p1);

    camera = new T.PerspectiveCamera(30, 1, 0.5, 500);
    scene.fog = new T.Fog(0x0a0b0d, 60, 130);

    return scene;
  }

  /* ---------------- 状态应用到模型 ---------------- */
  function applyState(st) {
    const O = window.OPT;
    // ISO 拨盘角度
    const ii = O.stepIndex(O.ISO_STEPS, st.iso) / (O.ISO_STEPS.length - 1);
    ctrl.iso.rotation.y = -0.6 + ii * 2.6;
    // 快门拨盘
    const si = O.stepIndex(O.SHUTTER_STEPS, st.t) / (O.SHUTTER_STEPS.length - 1);
    ctrl.t.rotation.y = -0.5 + si * 2.3;
    // 光圈拨盘 (前指令拨盘绕 x 轴转)
    const ai = O.stepIndex(O.AP_STEPS, st.ap) / (O.AP_STEPS.length - 1);
    ctrl.ap.rotation.x = ai * 2.6;
    // 变焦环 / 对焦环
    const zi = (st.focal - O.FOCAL_MIN) / (O.FOCAL_MAX - O.FOCAL_MIN);
    ctrl.focal.rotation.z = -zi * 3.1;
    const fi = O.focusToNorm(st.focus);
    ctrl.focus.rotation.z = -fi * 4.6;
    // 镜筒伸缩 (Z 24-120 f/4 S 变焦时前组伸出)
    lensBarrel.position.z = 0.55 + zi * 2.4;
    // 光圈叶片收放
    const k = Math.min(1, Math.max(0, (Math.log2(st.ap) - Math.log2(4)) / (Math.log2(22) - Math.log2(4))));
    const bladeR = 1.55 - k * 0.78;
    for (let i = 0; i < blades.length; i++) {
      blades[i].position.x = bladeR;
      blades[i].rotation.z = 0.55 + k * 0.42;
    }
    // 液晶屏
    lcdDirty = true;
    if (lcdDirty) drawLCD(st);
  }

  /* ---------------- 交互 ---------------- */
  function setPointerHandlers() {
    const ray = new T.Raycaster();
    const ndc = new T.Vector2();
    let orbitStart = null;

    function pick(ev) {
      const r = canvas.getBoundingClientRect();
      ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
      ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
      ray.setFromCamera(ndc, camera);
      const hits = ray.intersectObjects(root.children, true);
      for (let i = 0; i < hits.length; i++) {
        let o = hits[i].object;
        while (o && o !== root) {
          if (o.userData && o.userData.ctrl && o.userData.ctrl !== 'lens') {
            return { ctrl: o.userData.ctrl, obj: o };
          }
          o = o.parent;
        }
      }
      return null;
    }

    canvas.addEventListener('pointermove', function (ev) {
      if (dragging) {
        const dx = ev.clientX - lastPt.x, dy = ev.clientY - lastPt.y;
        lastPt = { x: ev.clientX, y: ev.clientY };
        handleDrag(dragging, dx, dy, ev);
        return;
      }
      const h = pick(ev);
      const key = h ? h.ctrl : null;
      if (hovered !== key) {
        hovered = key;
        canvas.style.cursor = key === 'focal' || key === 'focus' ? 'ew-resize'
          : key ? 'ns-resize' : 'grab';
        updateHoverTag();
      }
      if (orbitStart) {
        orbit.tAz = orbitStart.az + (ev.clientX - orbitStart.x) * 0.008;
        orbit.tEl = Math.max(-0.25, Math.min(1.35, orbitStart.el + (ev.clientY - orbitStart.y) * 0.006));
      }
    });

    canvas.addEventListener('pointerdown', function (ev) {
      const h = pick(ev);
      lastPt = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
      if (h) {
        dragging = h.ctrl;
        if (h.ctrl === 'shoot' && onChange) onChange('shoot');
      } else {
        orbitStart = { x: ev.clientX, y: ev.clientY, az: orbit.tAz, el: orbit.tEl };
      }
    });

    canvas.addEventListener('pointerup', function (ev) {
      dragging = null; orbitStart = null;
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) { }
    });
    canvas.addEventListener('pointercancel', function () { dragging = null; orbitStart = null; });

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      orbit.tDist = Math.max(22, Math.min(88, orbit.tDist + ev.deltaY * 0.03));
    }, { passive: false });

    canvas.addEventListener('dblclick', function () {
      orbit.tAz = 0.62; orbit.tEl = 0.30; orbit.tDist = 46;
    });
  }

  function handleDrag(key, dx, dy, ev) {
    const O = window.OPT, st = O.state;
    const vstep = Math.round(-dy / 14), hstep = Math.round(dx / 16);
    if (!vstep && !hstep) return;
    if (key === 'iso') {
      st.iso = O.step(O.ISO_STEPS, st.iso, vstep);
    } else if (key === 't') {
      st.t = O.step(O.SHUTTER_STEPS, st.t, vstep);
    } else if (key === 'ap') {
      st.ap = O.step(O.AP_STEPS, st.ap, vstep);
    } else if (key === 'focal') {
      st.focal = Math.max(O.FOCAL_MIN, Math.min(O.FOCAL_MAX, st.focal + hstep));
    } else if (key === 'focus') {
      st.focus = O.focusDrag(st.focus, hstep);
    }
    if (onChange) onChange(key);
  }

  /* ---------------- 跟随标签 ---------------- */
  function makeTag(key, html) {
    const d = document.createElement('div');
    d.className = 'tag3d';
    d.innerHTML = html;
    d.dataset.k = key;
    tagsEl.appendChild(d);
    return d;
  }

  function initTags() {
    labels.iso = makeTag('iso', '<span class="lk">ISO 拨盘</span> <em>—</em>');
    labels.t = makeTag('t', '<span class="lk">快门拨盘</span> <em>—</em>');
    labels.ap = makeTag('ap', '<span class="lk">光圈(前拨盘)</span> <em>—</em>');
    labels.focal = makeTag('focal', '<span class="lk">变焦环</span> <em>—</em>');
    labels.focus = makeTag('focus', '<span class="lk">对焦环</span> <em>—</em>');
    labels.shoot = makeTag('shoot', '<span class="lk">按我拍照</span>');
  }

  function updateTags(st) {
    const O = window.OPT;
    if (!labels.iso) return;
    labels.iso.querySelector('em').textContent = O.isoLabel(st.iso);
    labels.t.querySelector('em').textContent = O.shutterLabel(st.t);
    labels.ap.querySelector('em').textContent = O.apertureLabel(st.ap);
    labels.focal.querySelector('em').textContent = O.focalLabel(st.focal);
    labels.focus.querySelector('em').textContent = O.focusLabel(st.focus);
    ['iso', 't', 'ap', 'focal', 'focus', 'shoot'].forEach(function (k) {
      labels[k].classList.toggle('hot', hovered === k || dragging === k);
    });
  }

  function updateHoverTag() {
    if (!labels.iso) return;
    ['iso', 't', 'ap', 'focal', 'focus', 'shoot'].forEach(function (k) {
      labels[k].classList.toggle('hot', hovered === k || dragging === k);
    });
  }

  function projectTags() {
    if (!labels.iso) return;
    const v = new T.Vector3();
    const r = canvas.getBoundingClientRect();
    for (const k in labels) {
      const obj = ctrl[k];
      if (!obj) { labels[k].style.display = 'none'; continue; }
      obj.getWorldPosition(v);
      v.project(camera);
      if (v.z > 1) { labels[k].style.display = 'none'; continue; }
      labels[k].style.display = '';
      const x = (v.x * 0.5 + 0.5) * r.width;
      const y = (-v.y * 0.5 + 0.5) * r.height - 20;
      labels[k].style.transform = 'translate(-50%, -50%) translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
    }
  }

  /* ---------------- 运行 ---------------- */
  function init(cv, tags, changeCb) {
    canvas = cv;
    tagsEl = tags;
    onChange = changeCb;
    renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0d0f12, 1);
    build();
    initTags();
    setPointerHandlers();
    resize();
    return renderer;
  }

  function resize() {
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const w = Math.max(2, r.width), h = Math.max(2, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render(st, dt) {
    if (!renderer) return;
    // 平滑环绕
    orbit.az += (orbit.tAz - orbit.az) * 0.12;
    orbit.el += (orbit.tEl - orbit.el) * 0.12;
    orbit.dist += (orbit.tDist - orbit.dist) * 0.12;
    const cy = 0.6;
    camera.position.set(
      Math.sin(orbit.az) * Math.cos(orbit.el) * orbit.dist,
      cy + Math.sin(orbit.el) * orbit.dist * 0.85,
      Math.cos(orbit.az) * Math.cos(orbit.el) * orbit.dist + 6
    );
    camera.lookAt(0, cy, 4.2);
    // 快门按钮轻微浮动, 增加"可点"的感觉
    if (ctrl.shoot) {
      const hov = (hovered === 'shoot' || dragging === 'shoot') ? 0.16 : 0;
      ctrl.shoot.position.y += (6.28 - hov - ctrl.shoot.position.y) * 0.25;
    }
    if (st) updateTags(st);
    projectTags();
    renderer.render(scene, camera);
  }

  return { init: init, render: render, resize: resize, applyState: applyState, drawLCD: drawLCD };
})();
