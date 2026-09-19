/* =============================================================
 * scene.js — 三维街景 diorama
 * 所有动画都是 t 的纯函数, 以便快门多子帧采样
 * ============================================================= */
window.WORLD = (function () {
  'use strict';

  const T = window.THREE;

  // 机位与街道尺度 (单位: 米)
  const CAM_POS = new T.Vector3(0.35, 1.55, 3.20);
  const CAM_LOOK = new T.Vector3(-0.05, 1.12, -40);
  const ROAD_W = 11;
  const ROAD_Z0 = 16, ROAD_Z1 = -120;
  const BUILD_X = 10.6;        // 建筑近侧立面到中轴的距离

  let scene, skyMat, sunMesh, root;
  let cars = [], lamps = [], bulbs = [], dust, dustGeo;
  let lampLights = [];
  let facadeMats = [], winMats = [];
  let presetKey = 'day';
  let trailMeshes = [];

  // 复用颜色对象, 避免每帧分配 (会被快门子帧放大数十倍)
  const C_LAMP = new T.Color('#ffe6b8');
  const C_STRING = new T.Color('#fff0cf');
  const _tmpC = new T.Color();

  /* ---------------- 工具 ---------------- */
  function rng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function cv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function tex(canvas, rx, ry, srgb) {
    const t = new T.CanvasTexture(canvas);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.repeat.set(rx || 1, ry || 1);
    t.anisotropy = 4;
    if (srgb !== false) t.encoding = T.sRGBEncoding;
    return t;
  }

  /* ---------------- 程序化贴图 ---------------- */
  function skyTexture() {
    const c = cv(8, 128), g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0, '#000000');
    grd.addColorStop(1, '#ffffff');
    g.fillStyle = grd; g.fillRect(0, 0, 8, 128);
    // 这里只作为渐变查找, 真正的颜色在着色器里插值
    return tex(c, 1, 1, false);
  }

  function asphaltTexture(seed, base, marks) {
    const c = cv(256, 256), g = c.getContext('2d');
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const v = (r() * 46 - 23) | 0;
      g.fillStyle = 'rgba(' + (128 + v) + ',' + (128 + v) + ',' + (132 + v) + ',0.12)';
      g.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
    }
    if (marks) {
      g.strokeStyle = 'rgba(226,222,196,0.62)';
      g.lineWidth = 3;
      g.setLineDash([26, 34]);
      g.beginPath(); g.moveTo(128, 0); g.lineTo(128, 256); g.stroke();
    }
    return tex(c, 1, 1);
  }

  function windowTexture(seed, lit) {
    const W = 128, H = 256, c = cv(W, H), g = c.getContext('2d');
    const r = rng(seed);
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, H);
    const cols = 4, rows = 10;
    const cw = W / cols, ch = H / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const on = r() < lit;
        const px = x * cw + cw * 0.22, py = y * ch + ch * 0.2;
        const pw = cw * 0.56, ph = ch * 0.54;
        if (on) {
          const warm = r();
          g.fillStyle = warm > 0.72
            ? 'rgb(190,215,255)' : warm > 0.32
              ? 'rgb(255,206,138)' : 'rgb(255,176,104)';
        } else {
          g.fillStyle = 'rgb(20,23,28)';
        }
        g.fillRect(px, py, pw, ph);
      }
    }
    return tex(c, 1, 1);
  }

  function concreteTexture(seed, base) {
    const c = cv(128, 128), g = c.getContext('2d');
    const r = rng(seed);
    g.fillStyle = base; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1400; i++) {
      const v = (r() * 40 - 20) | 0;
      g.fillStyle = 'rgba(' + (140 + v) + ',' + (140 + v) + ',' + (146 + v) + ',0.14)';
      g.fillRect(r() * 128, r() * 128, 1 + r() * 2, 1 + r() * 2);
    }
    return tex(c, 1, 1);
  }

  function glowTexture() {
    const c = cv(128, 128), g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.18, 'rgba(255,255,255,0.62)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.16)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return tex(c, 1, 1, false);
  }

  function streakTexture() {
    const c = cv(256, 16), g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 256, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.30)');
    grd.addColorStop(0.87, 'rgba(255,255,255,0.92)');
    grd.addColorStop(1, 'rgba(255,255,255,1)');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 16);
    const grd2 = g.createLinearGradient(0, 0, 0, 16);
    grd2.addColorStop(0, 'rgba(0,0,0,1)');
    grd2.addColorStop(0.5, 'rgba(0,0,0,0)');
    grd2.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = grd2; g.fillRect(0, 0, 256, 16);
    return tex(c, 1, 1, false);
  }

  /* ---------------- 构建 ---------------- */
  function build() {
    scene = new T.Scene();
    scene.fog = new T.FogExp2(0x0b0e14, 0.0125);
    root = new T.Group();
    scene.add(root);

    const glowTex = glowTexture();
    const streakTex = streakTexture();

    /* --- 天空穹顶 --- */
    const skyGeo = new T.SphereGeometry(320, 32, 20);
    skyMat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: {
        cTop: { value: new T.Color('#3b7ec9') },
        cBot: { value: new T.Color('#bcd8f0') },
        uHaze: { value: 0.55 }
      },
      vertexShader: [
        'varying vec3 vP;',
        'void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 cTop; uniform vec3 cBot; uniform float uHaze;',
        'varying vec3 vP;',
        'void main(){',
        '  float h = normalize(vP).y;',
        '  float t = smoothstep(-0.08, 0.62, h);',
        '  vec3 col = mix(cBot, cTop, t);',
        '  col += vec3(0.06,0.05,0.04) * pow(max(0.0, 1.0 - abs(h)), 6.0) * uHaze;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    scene.add(new T.Mesh(skyGeo, skyMat));

    /* --- 天体 (太阳/月亮) --- */
    sunMesh = new T.Mesh(
      new T.SphereGeometry(6, 20, 14),
      new T.MeshBasicMaterial({ color: 0xfff6df, fog: false })
    );
    scene.add(sunMesh);

    /* --- 地面 --- */
    const groundTex = asphaltTexture(11, '#4b5057', false);
    groundTex.repeat.set(34, 34);
    const ground = new T.Mesh(
      new T.PlaneGeometry(220, 260),
      new T.MeshPhongMaterial({ map: groundTex, shininess: 8, specular: 0x1a1d22 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    root.add(ground);

    /* --- 马路 --- */
    const roadLen = ROAD_Z0 - ROAD_Z1;
    const roadTex = asphaltTexture(23, '#3f444a', true);
    roadTex.repeat.set(1, roadLen / 12);
    const road = new T.Mesh(
      new T.PlaneGeometry(ROAD_W, roadLen),
      new T.MeshPhongMaterial({ map: roadTex, shininess: 26, specular: 0x2a2f36 })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.012, (ROAD_Z0 + ROAD_Z1) / 2);
    road.receiveShadow = true;
    root.add(road);

    /* --- 人行道 --- */
    const walkTex = concreteTexture(31, '#8d9298');
    walkTex.repeat.set(2, 40);
    const walkMat = new T.MeshPhongMaterial({ map: walkTex, shininess: 14, specular: 0x22262b });
    [-1, 1].forEach(function (s) {
      const w = new T.Mesh(new T.BoxGeometry(5.2, 0.22, roadLen - 6), walkMat);
      w.position.set(s * (ROAD_W / 2 + 2.6), 0.11, (ROAD_Z0 + ROAD_Z1) / 2);
      w.castShadow = true; w.receiveShadow = true;
      root.add(w);
    });

    /* --- 建筑 --- */
    const r = rng(7);
    const winTex = [windowTexture(101, 0.42), windowTexture(102, 0.3), windowTexture(103, 0.55)];
    const facTex = [concreteTexture(201, '#9aa0a8'), concreteTexture(202, '#b3b8be'), concreteTexture(203, '#7f858d')];
    for (let i = 0; i < 16; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = -22 - Math.floor(i / 2) * 11.5 - r() * 3;
      const h = 8 + r() * 15;
      const wd = 8 + r() * 6;
      const dp = 9 + r() * 7;
      const x = side * (BUILD_X + dp / 2 + r() * 4);
      const ti = i % 3;
      const wi = (i + 1) % 3;
      const mat = new T.MeshPhongMaterial({
        map: facTex[ti], shininess: 10, specular: 0x1c2026,
        emissive: new T.Color('#ffffff'),
        emissiveMap: winTex[wi],
        emissiveIntensity: 0.0
      });
      mat.map.repeat.set(Math.max(1, wd / 6), Math.max(1, h / 6));
      mat.emissiveMap.repeat.set(Math.max(1, wd / 8), Math.max(1, h / 14));
      winMats.push(mat);
      const b = new T.Mesh(new T.BoxGeometry(wd, h, dp), mat);
      b.position.set(x, h / 2, z);
      b.castShadow = true; b.receiveShadow = true;
      root.add(b);
      if (r() > 0.45) {
        const t2 = new T.Mesh(new T.BoxGeometry(wd * 0.3, 1.6 + r() * 2.6, dp * 0.3),
          new T.MeshPhongMaterial({ color: 0x848a92, shininess: 12 }));
        t2.position.set(x + (r() - 0.5) * wd * 0.35, h + 1.2 + r() * 1.4, z);
        root.add(t2);
      }
    }

    /* --- 路灯 --- */
    const poleMat = new T.MeshPhongMaterial({ color: 0x8f959c, shininess: 48, specular: 0xb8bec4 });
    const bulbMat = new T.MeshBasicMaterial({ color: 0xffe6b8, fog: false });
    const glowMat = new T.SpriteMaterial({
      map: glowTex, color: 0xffd9a0, transparent: true,
      blending: T.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.55
    });
    const lampZs = [-6, -19, -32, -45, -58, -72];
    for (let i = 0; i < lampZs.length; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const g = new T.Group();
      const x = side * (ROAD_W / 2 + 1.1);
      const pole = new T.Mesh(new T.CylinderGeometry(0.09, 0.13, 5.2, 10), poleMat);
      pole.position.y = 2.6; pole.castShadow = true;
      g.add(pole);
      const arm = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 1.9, 8), poleMat);
      arm.rotation.z = Math.PI / 2 * (side > 0 ? 1 : -1);
      arm.position.set(-side * 0.95, 5.15, 0);
      g.add(arm);
      const head = new T.Mesh(new T.SphereGeometry(0.17, 14, 10), bulbMat.clone());
      head.position.set(-side * 1.85, 5.05, 0);
      head.userData.lamp = true;
      g.add(head);
      bulbs.push(head);
      const sp = new T.Sprite(glowMat.clone());
      sp.scale.set(3.4, 3.4, 1);
      sp.position.copy(head.position);
      g.add(sp);
      head.userData.glow = sp;
      g.position.set(x, 0, lampZs[i]);
      root.add(g);
      lamps.push(g);
    }
    // 少量真实点光源, 控制开销
    [0, 2, 4].forEach(function (idx) {
      const g = lamps[idx];
      const pl = new T.PointLight(0xffcf8a, 5, 30, 2);
      const head = g.children[2];
      pl.position.set(g.position.x + head.position.x, 5.0, g.position.z + head.position.z);
      pl.userData.lampIdx = idx;
      root.add(pl);
      lampLights.push(pl);
    });

    /* --- 串灯 (焦外光斑主角: 小、亮、成串) --- */
    const stringMat = new T.MeshBasicMaterial({ color: 0xfff0cf, fog: false });
    const stringMatB = new T.MeshBasicMaterial({ color: 0xffd7f2, fog: false });
    const N = 34;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const x = -8.2 + u * 16.4;
      const sag = Math.sin(Math.PI * u) * 0.9;
      const b = new T.Mesh(new T.SphereGeometry(0.058, 10, 8), i % 3 === 0 ? stringMatB : stringMat);
      b.position.set(x, 4.25 - sag, -14);
      b.userData.ph = i * 1.7;
      b.userData.base = i % 3 === 0 ? 0.95 : 1.0;
      root.add(b);
      bulbs.push(b);
    }
    for (let i = 0; i < 22; i++) {
      const u = i / 21;
      const x = -7.4 + u * 14.8;
      const b = new T.Mesh(new T.SphereGeometry(0.05, 8, 6), stringMat);
      b.position.set(x, 4.0 - Math.sin(Math.PI * u) * 0.8, -30);
      b.userData.ph = i * 2.3; b.userData.base = 1.0;
      root.add(b);
      bulbs.push(b);
    }

    /* --- 旋转风车 (快门凝固 / 拖影) --- */
    const wind = new T.Group();
    wind.position.set(-4.2, 2.5, -16);
    const mast = new T.Mesh(new T.CylinderGeometry(0.05, 0.06, 2.4, 8), poleMat);
    mast.position.y = -1.2;
    wind.add(mast);
    const rotor = new T.Group();
    rotor.name = 'rotor';
    const bladeMat = new T.MeshPhongMaterial({ color: 0xd9dee5, shininess: 30, side: T.DoubleSide });
    const tipMat = new T.MeshBasicMaterial({ color: 0x7fe6ff, fog: false });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const bl = new T.Mesh(new T.BoxGeometry(1.02, 0.1, 0.02), bladeMat);
      bl.position.set(Math.cos(a) * 0.55, Math.sin(a) * 0.55, 0);
      bl.rotation.z = a;
      rotor.add(bl);
      const tip = new T.Mesh(new T.SphereGeometry(0.055, 8, 6), tipMat);
      tip.position.set(Math.cos(a) * 1.06, Math.sin(a) * 1.06, 0.01);
      rotor.add(tip);
    }
    wind.add(rotor);
    root.add(wind);
    cars.rotor = rotor;

    /* --- 汽车 --- */
    function makeCar(color, dir) {
      const g = new T.Group();
      const bodyMat = new T.MeshPhongMaterial({ color: color, shininess: 90, specular: 0x9aa3ad });
      const body = new T.Mesh(new T.BoxGeometry(1.86, 0.62, 4.4), bodyMat);
      body.position.y = 0.62; body.castShadow = true;
      g.add(body);
      const cab = new T.Mesh(new T.BoxGeometry(1.66, 0.56, 2.3), bodyMat);
      cab.position.set(0, 1.16, -0.18);
      cab.castShadow = true;
      g.add(cab);
      const glass = new T.Mesh(new T.BoxGeometry(1.68, 0.42, 2.28),
        new T.MeshPhongMaterial({ color: 0x0d1117, shininess: 120, specular: 0x8fb6d8 }));
      glass.position.set(0, 1.2, -0.18);
      g.add(glass);
      const wheelGeo = new T.CylinderGeometry(0.33, 0.33, 0.22, 14);
      const wheelMat = new T.MeshPhongMaterial({ color: 0x14161a, shininess: 20 });
      [[-0.92, 1.45], [0.92, 1.45], [-0.92, -1.45], [0.92, -1.45]].forEach(function (p) {
        const w = new T.Mesh(wheelGeo, wheelMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(p[0], 0.33, p[1]);
        g.add(w);
      });
      const zf = dir > 0 ? 2.2 : -2.2;
      const headMat = new T.MeshBasicMaterial({ color: 0xfff4d8, fog: false });
      const tailMat = new T.MeshBasicMaterial({ color: 0xff2a1a, fog: false });
      const heads = [], tails = [];
      [-0.62, 0.62].forEach(function (x) {
        const h = new T.Mesh(new T.SphereGeometry(0.11, 10, 8), headMat);
        h.position.set(x, 0.72, zf);
        g.add(h); heads.push(h);
        const tg = new T.Mesh(new T.SphereGeometry(0.075, 8, 6), tailMat);
        tg.position.set(x, 0.72, -zf);
        g.add(tg); tails.push(tg);
      });
      g.userData.heads = heads;
      g.userData.tails = tails;
      return g;
    }

    function makeTrail(color, width, len) {
      const geo = new T.PlaneGeometry(width, len);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, len / 2);
      const mat = new T.MeshBasicMaterial({
        map: streakTex, color: color, transparent: true, opacity: 0,
        blending: T.AdditiveBlending, depthWrite: false, fog: false
      });
      const m = new T.Mesh(geo, mat);
      m.visible = false;
      return m;
    }

    const carDefs = [
      { z0: 8, z1: -100, speed: 8.5, lane: 2.2, color: 0x30507a, trail: 0xfff0c8 },
      { z0: -100, z1: 8, speed: 10.5, lane: -2.2, color: 0x7a2f34, trail: 0xff3a2a },
      { z0: 6, z1: -100, speed: 6.2, lane: 2.2, color: 0x2a2f36, trail: 0xfff6da }
    ];
    carDefs.forEach(function (d, i) {
      const car = makeCar(d.color, d.z1 > d.z0 ? 1 : -1);
      car.userData.def = d;
      root.add(car);
      const tr = makeTrail(d.trail, 1.5, 12);
      root.add(tr);
      cars.push({ obj: car, def: d, trail: tr });
      trailMeshes.push(tr);
    });

    /* --- 前景标志牌 (近处对焦目标, 约 5.5m) --- */
    const postMat2 = new T.MeshPhongMaterial({ color: 0x39414a, shininess: 42, specular: 0x5b636c });
    const post = new T.Mesh(new T.CylinderGeometry(0.045, 0.055, 2.4, 12), postMat2);
    post.position.set(1.25, 1.2, -2.2);
    post.castShadow = true;
    root.add(post);
    const plate = new T.Mesh(new T.BoxGeometry(0.56, 0.5, 0.035),
      new T.MeshPhongMaterial({ color: 0xd8dde3, shininess: 60, specular: 0x8f979f }));
    plate.position.set(1.25, 1.78, -2.2);
    plate.rotation.y = -0.30;
    plate.castShadow = true;
    root.add(plate);
    const plateIn = new T.Mesh(new T.BoxGeometry(0.42, 0.36, 0.02),
      new T.MeshPhongMaterial({ color: 0x2a4f8a, shininess: 40 }));
    plateIn.position.set(1.25, 1.78, -2.175);
    plateIn.rotation.y = -0.30;
    root.add(plateIn);

    /* --- 花盆小景 (7.7m) --- */
    const potMat = new T.MeshPhongMaterial({ color: 0x8a4b3a, shininess: 12 });
    const pot = new T.Mesh(new T.CylinderGeometry(0.32, 0.24, 0.5, 16), potMat);
    pot.position.set(-1.9, 0.25, -4.2); pot.castShadow = true;
    root.add(pot);
    const leafMat = new T.MeshPhongMaterial({ color: 0x336e3f, shininess: 24, flatShading: true });
    const lr = rng(55);
    for (let i = 0; i < 9; i++) {
      const s = new T.Mesh(new T.SphereGeometry(0.18 + lr() * 0.1, 8, 6), leafMat);
      s.position.set(-1.9 + (lr() - 0.5) * 0.42, 0.72 + lr() * 0.4, -4.2 + (lr() - 0.5) * 0.42);
      s.castShadow = true;
      root.add(s);
    }

    const woodMat = new T.MeshPhongMaterial({ color: 0x6b4a32, shininess: 10 });
    const bench = new T.Group();
    const seat = new T.Mesh(new T.BoxGeometry(2.0, 0.09, 0.5), woodMat);
    seat.position.y = 0.45; seat.castShadow = true;
    bench.add(seat);
    const back = new T.Mesh(new T.BoxGeometry(2.0, 0.42, 0.07), woodMat);
    back.position.set(0, 0.68, -0.22);
    bench.add(back);
    [-0.85, 0.85].forEach(function (x) {
      const leg = new T.Mesh(new T.BoxGeometry(0.08, 0.45, 0.44), new T.MeshPhongMaterial({ color: 0x2b2f35 }));
      leg.position.set(x, 0.22, 0);
      bench.add(leg);
    });
    bench.position.set(2.35, 0.22, -8.6);
    bench.rotation.y = -0.42;
    root.add(bench);

    const binMat = new T.MeshPhongMaterial({ color: 0x2f4a3a, shininess: 34 });
    [-1, 1].forEach(function (s) {
      const bin = new T.Mesh(new T.CylinderGeometry(0.3, 0.27, 0.9, 14), binMat);
      bin.position.set(s * 5.9, 0.67, -12); bin.castShadow = true;
      root.add(bin);
    });

    // 远处立面霓虹招牌 (焦外光斑来源, 贴在建筑立面上)
    const neonCols = [0x5fd8ff, 0xff6ec7, 0xffd35f, 0x8affa0];
    for (let i = 0; i < 9; i++) {
      const c = neonCols[i % neonCols.length];
      const s = new T.Mesh(new T.BoxGeometry(0.18, 1.4 + (i % 3) * 0.9, 0.26),
        new T.MeshBasicMaterial({ color: c, fog: false }));
      s.position.set((i % 2 === 0 ? -1 : 1) * (BUILD_X - 0.25), 4.2 + (i % 4) * 1.6, -26 - i * 6.2);
      root.add(s);
      bulbs.push(s);
    }

    /* --- 尘埃微粒 --- */
    const DN = 520;
    const pos = new Float32Array(DN * 3);
    const rr = rng(88);
    for (let i = 0; i < DN; i++) {
      pos[i * 3] = (rr() - 0.5) * 40;
      pos[i * 3 + 1] = rr() * 7 + 0.2;
      pos[i * 3 + 2] = -rr() * 70;
    }
    dustGeo = new T.BufferGeometry();
    dustGeo.setAttribute('position', new T.BufferAttribute(pos, 3));
    dustGeo.userData.base = pos.slice(0);
    dust = new T.Points(dustGeo, new T.PointsMaterial({
      color: 0xffe9c4, size: 0.035, sizeAttenuation: true,
      transparent: true, opacity: 0.85, blending: T.AdditiveBlending,
      depthWrite: false, map: glowTex, fog: false
    }));
    root.add(dust);

    /* --- 灯 --- */
    const hemi = new T.HemisphereLight(0x9fb6d8, 0x2a2c31, 0.52);
    scene.add(hemi);
    const sun = new T.DirectionalLight(0xfff6df, 1.35);
    sun.position.set(22, 38, 26);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 140;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.03;
    scene.add(sun);
    scene.userData.sun = sun;
    scene.userData.hemi = hemi;

    // 启动时按 state 中的预设初始化光照, 避免出现"参数是夜景、光影是白天"的错配
    presetKey = (window.OPT.state && window.OPT.state.preset) || presetKey;
    setPreset(presetKey);
    return { scene: scene, sun: sun, hemi: hemi };
  }

  /* ---------------- 预设 ---------------- */
  function setPreset(key) {
    const P = window.OPT.PRESETS[key] || window.OPT.PRESETS.day;
    presetKey = key;
    if (!scene) return;

    skyMat.uniforms.cTop.value.set(P.sky[0]);
    skyMat.uniforms.cBot.value.set(P.sky[1]);
    skyMat.uniforms.uHaze.value = key === 'night' ? 0.85 : key === 'dusk' ? 0.7 : 0.45;

    const sun = scene.userData.sun, hemi = scene.userData.hemi;
    sun.color.set(P.sun);
    // 保持环境光+直射光总量恒定, 让"场景亮度 EV"的物理含义不受预设污染
    const mix = { day: [1.12, 0.48], dusk: [0.85, 0.46], indoor: [0.95, 0.56], night: [0.36, 0.40] }[key];
    sun.intensity = mix[0];
    hemi.intensity = mix[1];
    sun.position.set(P.sunPos[0], P.sunPos[1], P.sunPos[2]);

    sunMesh.position.set(P.sunPos[0] * 6, P.sunPos[1] * 6, P.sunPos[2] * 6);
    sunMesh.material.color.set(P.sun);
    sunMesh.visible = key !== 'indoor';
    sunMesh.scale.setScalar(key === 'night' ? 0.6 : 1);

    fogDensity(key);

    const lampK = P.lampOn ? 1 : 0;
    bulbs.forEach(function (b) {
      if (!b.material) return;
      if (b.userData.lamp || b.userData.base !== undefined) {
        if (!b.userData.baseColor) {
          b.userData.baseColor = (b.userData.lamp ? C_LAMP : C_STRING).clone();
        }
        b.material.color.copy(b.userData.baseColor).multiplyScalar(0.18 + 0.82 * lampK);
      }
    });
    bulbs.forEach(function (b) {
      if (b.userData.glow) b.userData.glow.material.opacity = 0.55 * lampK;
    });
    lampLights.forEach(function (l) { l.intensity = 5 * lampK; });

    winMats.forEach(function (m) { m.emissiveIntensity = key === 'day' ? 0.06 : key === 'dusk' ? 0.8 : 1.05; });
    cars.forEach(function (c) {
      if (!c.obj.userData.heads) return;
      c.trail.userData.k = key === 'day' ? 0.45 : 1;
    });
    scene.fog.color.set(key === 'day' ? 0x9fb8d4 : key === 'dusk' ? 0x3a3350 : 0x0b0e14);
  }

  function fogDensity(key) {
    const d = { day: 0.0042, dusk: 0.0065, indoor: 0.0055, night: 0.0105 }[key] || 0.0105;
    if (scene && scene.fog) scene.fog.density = d;
  }

  /* ---------------- 动画 (t 的纯函数) ---------------- */
  function update(t, opts) {
    opts = opts || {};
    const P = window.OPT.PRESETS[presetKey];
    const lampK = P.lampOn ? 1 : 0;

    // 汽车
    cars.forEach(function (c, idx) {
      if (!c.obj.userData.def) return;
      const d = c.def;
      const span = Math.abs(d.z1 - d.z0);
      const dir = d.z1 > d.z0 ? 1 : -1;
      let prog = ((t * d.speed + idx * 33) % span) / span;
      const z = d.z0 + (d.z1 - d.z0) * prog;
      c.obj.position.set(d.lane, 0, z);
      c.obj.rotation.y = dir > 0 ? 0 : Math.PI;
      const trailOn = opts.trail || 0;
      const len = 4 + trailOn * (d.speed * 1.5);
      const mtl = c.trail.material;
      if (trailOn > 0.02) {
        c.trail.visible = true;
        const back = dir > 0 ? -1 : 1;
        c.trail.position.set(d.lane, 0.028, z);
        c.trail.rotation.y = back > 0 ? 0 : Math.PI;
        c.trail.scale.set(1, 1, len / 12);
        mtl.opacity = trailOn * 0.55 * (c.trail.userData.k || 1);
      } else {
        c.trail.visible = false;
      }
    });

    // 风车
    if (cars.rotor) cars.rotor.rotation.z = -t * Math.PI * 2 * 1.35;

    // 灯闪烁 (使用预缓存颜色, 每帧零分配)
    bulbs.forEach(function (b) {
      if (b.userData.ph === undefined || !b.userData.baseColor) return;
      const tw = 0.88 + 0.12 * Math.sin(t * 2.6 + b.userData.ph) * Math.sin(t * 1.1 + b.userData.ph * 2.3);
      const k = (b.userData.lamp ? 1 : 0.98) * tw;
      b.material.color.copy(b.userData.baseColor).multiplyScalar(0.18 + 0.82 * lampK * k);
      if (b.userData.glow) b.userData.glow.material.opacity = 0.55 * lampK * tw;
    });

    // 尘埃 (仅在主帧更新, 子帧复用, 省去 26 倍重复计算)
    if (dust && !opts.cheap) {
      const arr = dustGeo.attributes.position.array;
      const base = dustGeo.userData.base;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = base[i] + Math.sin(t * 0.32 + base[i + 1] * 2.1) * 0.35;
        arr[i + 1] = base[i + 1] + ((t * 0.16 + base[i] * 0.1) % 1.0) * 0.5;
        arr[i + 2] = base[i + 2];
      }
      dustGeo.attributes.position.needsUpdate = true;
    }
  }

  return {
    build: build,
    update: update,
    setPreset: setPreset,
    CAM_POS: CAM_POS,
    CAM_LOOK: CAM_LOOK,
    ROAD_W: ROAD_W
  };
})();
