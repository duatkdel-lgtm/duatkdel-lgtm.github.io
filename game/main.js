// ============================================================
//  🦎 카멜레온 숨바꼭질 3D — iPad 전용 핫시트(교대) 2팀 대전
//  B팀: 맵의 벽/바닥에 그림을 그려 카멜레온을 위장시켜 숨김
//  A팀: iPad를 넘겨받아 진짜 카멜레온을 찾아 탭
// ============================================================
import * as THREE from 'three';

// ---------------- 유틸 ----------------
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------------- 기기 게이트 (iPad 전용) ----------------
const ua = navigator.userAgent;
const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const devBypass = new URLSearchParams(location.search).has('dev');
if (!isIPad && !devBypass) {
  $('gate').classList.remove('hidden');
  $('menu').classList.add('hidden');
  throw new Error('iPad only');
}
$('rotate').classList.add('armed');
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// ---------------- 사운드 ----------------
let AC = null;
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur, type = 'sine', gain = 0.15, slide = 0) {
  try {
    const a = ac(), o = a.createOscillator(), g = a.createGain(), t = a.currentTime;
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
  } catch (e) { /* 무음 허용 */ }
}
const sfx = {
  click: () => tone(700, 0.06, 'square', 0.06),
  stamp: () => { tone(150, 0.18, 'sine', 0.25, -60); tone(300, 0.1, 'triangle', 0.1); },
  wrong: () => tone(230, 0.25, 'sawtooth', 0.12, -90),
  decoy: () => { tone(500, 0.1, 'square', 0.1, -200); setTimeout(() => tone(320, 0.18, 'square', 0.1, -120), 110); },
  found: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'triangle', 0.16), i * 110)),
  survive: () => [659, 784, 988, 1319].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'sine', 0.15), i * 110)),
  tick: () => tone(1000, 0.05, 'sine', 0.05),
};

// ---------------- 렌더러 / 씬 ----------------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ecbee);
scene.fog = new THREE.Fog(0x8ecbee, 55, 120);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);

scene.add(new THREE.HemisphereLight(0xdfeeff, 0x7fa35c, 1.15));
scene.add(new THREE.AmbientLight(0xffffff, 0.42));
const sun = new THREE.DirectionalLight(0xfff2d6, 0.95);
sun.position.set(25, 40, 12);
scene.add(sun);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------------- 페인트 표면 (캔버스 아틀라스) ----------------
const ARENA = 23;               // 맵 반경 (±23m)
let paintSurfaces = [];         // PaintSurface 목록
let paintMeshes = [];           // 레이캐스트 대상(칠할 수 있는 면)
let solidMeshes = [];           // 시야 차단 포함 전체(레이캐스트 오클루전)
let colliders = [];             // {x1,z1,x2,z2}
let decorGroup = null;          // 라운드마다 폐기할 그룹

class PaintSurface {
  constructor(wPx, hPx) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = wPx; this.canvas.height = hPx;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.base = null;           // 지우개 복원용 원본
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshLambertMaterial({ map: this.texture });
    this.meshes = [];
    this.dirty = false;
    paintSurfaces.push(this);
  }
  snapshotBase() {
    this.base = document.createElement('canvas');
    this.base.width = this.canvas.width; this.base.height = this.canvas.height;
    this.base.getContext('2d').drawImage(this.canvas, 0, 0);
  }
  // 아틀라스의 uv 영역(u0..u1, v0..v1)을 쓰는 평면 추가
  addPlane(wM, hM, u0, v0, u1, v1, pos, rotY = 0, rotX = 0) {
    const geo = new THREE.PlaneGeometry(wM, hM);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.copy(pos);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = rotY; mesh.rotation.x = rotX;
    mesh.userData = {
      surface: this, wM, hM, u0, v0, u1, v1,
      ppmX: this.canvas.width * (u1 - u0) / wM,
      ppmY: this.canvas.height * (v1 - v0) / hM,
    };
    this.meshes.push(mesh);
    decorGroup.add(mesh);
    paintMeshes.push(mesh);
    solidMeshes.push(mesh);
    return mesh;
  }
  update() { if (this.dirty) { this.texture.needsUpdate = true; this.dirty = false; } }
  dispose() { this.texture.dispose(); this.material.dispose(); }
}

// uv → 캔버스 픽셀
function uvToPx(surface, u, v) {
  return { x: u * surface.canvas.width, y: (1 - v) * surface.canvas.height };
}

// ---------------- 베이스 텍스처 페인터 ----------------
function speckle(ctx, x, y, w, h, colors, count, rMin, rMax, alpha = 1) {
  ctx.save(); ctx.globalAlpha = alpha;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = pick(colors);
    ctx.beginPath();
    ctx.arc(x + Math.random() * w, y + Math.random() * h, rand(rMin, rMax), 0, 7);
    ctx.fill();
  }
  ctx.restore();
}
function brickPattern(ctx, x, y, w, h, ppm, brick, mortar) {
  ctx.fillStyle = mortar; ctx.fillRect(x, y, w, h);
  const bw = 0.42 * ppm, bh = 0.2 * ppm, gap = 0.02 * ppm;
  let row = 0;
  for (let yy = y; yy < y + h; yy += bh + gap, row++) {
    const off = row % 2 ? -bw / 2 : 0;
    for (let xx = x + off; xx < x + w; xx += bw + gap) {
      ctx.fillStyle = brick[randi(0, brick.length - 1)];
      ctx.fillRect(Math.max(x, xx), yy, Math.min(bw, x + w - xx), Math.min(bh, y + h - yy));
    }
  }
}
function plankPattern(ctx, x, y, w, h, ppm, tones) {
  const pw = 0.28 * ppm;
  for (let xx = x; xx < x + w; xx += pw) {
    ctx.fillStyle = pick(tones);
    ctx.fillRect(xx, y, Math.min(pw - 2, x + w - xx), h);
  }
  ctx.fillStyle = 'rgba(0,0,0,.12)';
  for (let xx = x; xx < x + w; xx += pw) ctx.fillRect(xx, y, 2, h);
}
function tilePattern(ctx, x, y, w, h, ppm, a, b, grout) {
  ctx.fillStyle = grout; ctx.fillRect(x, y, w, h);
  const s = 0.5 * ppm, g = 0.03 * ppm;
  let r = 0;
  for (let yy = y; yy < y + h; yy += s + g, r++) {
    let c = 0;
    for (let xx = x; xx < x + w; xx += s + g, c++) {
      ctx.fillStyle = (r + c) % 2 ? a : b;
      ctx.fillRect(xx, yy, Math.min(s, x + w - xx), Math.min(s, y + h - yy));
    }
  }
}
function drawWindow(ctx, x, y, w, h) {
  ctx.fillStyle = '#4a5568'; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  const grad = ctx.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, '#bfe0f5'); grad.addColorStop(1, '#7fb2d9');
  ctx.fillStyle = grad; ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#4a5568'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(x + w / 2, y); ctx.lineTo(x + w / 2, y + h);
  ctx.moveTo(x, y + h / 2); ctx.lineTo(x + w, y + h / 2); ctx.stroke();
}
function drawDoor(ctx, x, y, w, h, color) {
  ctx.fillStyle = '#3f3226'; ctx.fillRect(x - 3, y - 3, w + 6, h + 3);
  ctx.fillStyle = color; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#fbd38d';
  ctx.beginPath(); ctx.arc(x + w * 0.82, y + h * 0.5, Math.max(3, w * 0.06), 0, 7); ctx.fill();
}
function drawPoster(ctx, x, y, w, h) {
  const bg = pick(['#fefcbf', '#fed7d7', '#c6f6d5', '#bee3f8', '#e9d8fd', '#fff']);
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x + 3, y + 3, w, h);
  ctx.fillStyle = bg; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = pick(['#e53e3e', '#3182ce', '#38a169', '#805ad5', '#d69e2e']);
  const kind = randi(0, 2);
  if (kind === 0) { ctx.beginPath(); ctx.arc(x + w / 2, y + h * 0.38, w * 0.24, 0, 7); ctx.fill(); }
  else if (kind === 1) ctx.fillRect(x + w * 0.2, y + h * 0.15, w * 0.6, h * 0.42);
  else {
    ctx.beginPath(); ctx.moveTo(x + w / 2, y + h * 0.12);
    ctx.lineTo(x + w * 0.85, y + h * 0.55); ctx.lineTo(x + w * 0.15, y + h * 0.55);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = 'rgba(45,55,72,.85)';
  for (let i = 0; i < 3; i++) ctx.fillRect(x + w * 0.15, y + h * (0.66 + i * 0.1), w * rand(0.4, 0.7), h * 0.045);
}

// ---------------- 맵 생성 ----------------
function clearMap() {
  if (decorGroup) {
    scene.remove(decorGroup);
    decorGroup.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !o.userData.surface) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
      }
    });
  }
  paintSurfaces.forEach((s) => s.dispose());
  paintSurfaces = []; paintMeshes = []; solidMeshes = []; colliders = [];
  decorGroup = new THREE.Group();
  scene.add(decorGroup);
}

function addTree(x, z) {
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.26, 1.6, 7),
    new THREE.MeshLambertMaterial({ color: 0x7c5a3a }));
  trunk.position.set(x, 0.8, z);
  const leaf = new THREE.Mesh(
    new THREE.IcosahedronGeometry(rand(1.1, 1.5), 0),
    new THREE.MeshLambertMaterial({ color: pick([0x3f9142, 0x53a548, 0x2f7d3b]) }));
  leaf.position.set(x, rand(2.2, 2.6), z);
  decorGroup.add(trunk, leaf);
  solidMeshes.push(trunk, leaf);
  colliders.push({ x1: x - 0.35, z1: z - 0.35, x2: x + 0.35, z2: z + 0.35 });
}

// 상자형 페인트 오브젝트(4면+윗면 아틀라스)
function makePaintBox(cx, cz, w, d, h, ppm, basePainter) {
  const perim = 2 * (w + d);
  const W = Math.min(2048, Math.ceil(perim * ppm));
  const H = Math.min(512, Math.ceil(Math.max(h, d) * ppm)) + 0;
  const wallH = Math.ceil(h * ppm), topH = Math.ceil(d * ppm);
  const surf = new PaintSurface(W, basePainter.top ? wallH + topH : wallH);
  const faces = [];
  let u = 0;
  const seg = (len) => { const u0 = u / perim; u += len; return [u0, u / perim]; };
  const vWall = wallH / surf.canvas.height;
  // 전개: 앞(w) 오른(d) 뒤(w) 왼(d)
  const [fu0, fu1] = seg(w), [ru0, ru1] = seg(d), [bu0, bu1] = seg(w), [lu0, lu1] = seg(d);
  const y = h / 2;
  faces.push(surf.addPlane(w, h, fu0, 1 - vWall, fu1, 1, new THREE.Vector3(cx, y, cz + d / 2), 0));
  faces.push(surf.addPlane(d, h, ru0, 1 - vWall, ru1, 1, new THREE.Vector3(cx + w / 2, y, cz), Math.PI / 2));
  faces.push(surf.addPlane(w, h, bu0, 1 - vWall, bu1, 1, new THREE.Vector3(cx, y, cz - d / 2), Math.PI));
  faces.push(surf.addPlane(d, h, lu0, 1 - vWall, lu1, 1, new THREE.Vector3(cx - w / 2, y, cz), -Math.PI / 2));
  if (basePainter.top) {
    const vTop0 = 0, vTop1 = topH / surf.canvas.height;
    surf.addPlane(w, d, 0, vTop0, (w / perim), vTop1, new THREE.Vector3(cx, h, cz), 0, -Math.PI / 2);
  }
  basePainter.paint(surf, { W: surf.canvas.width, wallH, topH, perim, w, d, h, ppm, faces: [[fu0, fu1, w], [ru0, ru1, d], [bu0, bu1, w], [lu0, lu1, d]] });
  surf.snapshotBase();
  surf.texture.needsUpdate = true;
  colliders.push({ x1: cx - w / 2 - 0.05, z1: cz - d / 2 - 0.05, x2: cx + w / 2 + 0.05, z2: cz + d / 2 + 0.05 });
  return surf;
}

function buildingPainter(style) {
  return {
    top: false,
    paint(surf, info) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      const ppmX = W / info.perim, ppmY = info.wallH / info.h;
      if (style === 'brick') brickPattern(ctx, 0, 0, W, H, ppmX, ['#b0533c', '#a34a35', '#bb5f45', '#994433'], '#d8c8b8');
      else if (style === 'stucco') { ctx.fillStyle = '#efe3c8'; ctx.fillRect(0, 0, W, H); speckle(ctx, 0, 0, W, H, ['#e4d5b5', '#f7eeda', '#dcccab'], 900, 1, 3, 0.6); }
      else if (style === 'tile') tilePattern(ctx, 0, 0, W, H, ppmX, '#5ba4cf', '#4d92bd', '#e8f2f8');
      else if (style === 'wood') plankPattern(ctx, 0, 0, W, H, ppmX, ['#a07648', '#8f6a40', '#ab8153', '#96703f']);
      else if (style === 'mint') { ctx.fillStyle = '#9fd8c5'; ctx.fillRect(0, 0, W, H); speckle(ctx, 0, 0, W, H, ['#8fcdb8', '#b2e3d2'], 700, 1, 3, 0.55); }
      else { ctx.fillStyle = '#f3d15e'; ctx.fillRect(0, 0, W, H); speckle(ctx, 0, 0, W, H, ['#eac54f', '#f8dc78'], 700, 1, 3, 0.5); }
      // 몰딩 띠
      ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(0, 0, W, 6);
      ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(0, H - Math.ceil(0.25 * ppmY), W, Math.ceil(0.25 * ppmY));
      // 면별 장식(문/창문/포스터)
      info.faces.forEach(([u0, u1, faceW], idx) => {
        const x0 = u0 * W, fw = (u1 - u0) * W;
        const groundY = H;             // 캔버스 아래쪽 = 벽 아래쪽
        if (idx === 0) {               // 정면: 문 + 창문
          const dw = 1.0 * ppmX, dh = 2.0 * ppmY;
          drawDoor(ctx, x0 + fw / 2 - dw / 2, groundY - dh, dw, dh, pick(['#c05621', '#2b6cb0', '#276749', '#97266d']));
          if (faceW > 4.5) {
            drawWindow(ctx, x0 + fw * 0.12, groundY - 2.3 * ppmY, 1.1 * ppmX, 1.1 * ppmY);
            drawWindow(ctx, x0 + fw * 0.88 - 1.1 * ppmX, groundY - 2.3 * ppmY, 1.1 * ppmX, 1.1 * ppmY);
          }
        } else if (Math.random() < 0.8) {
          const n = faceW > 6 ? 2 : 1;
          for (let i = 0; i < n; i++) {
            if (Math.random() < 0.45) drawPoster(ctx, x0 + fw * rand(0.1, 0.55), groundY - rand(2.0, 2.6) * ppmY, rand(0.8, 1.2) * ppmX, rand(1.1, 1.5) * ppmY);
            else drawWindow(ctx, x0 + fw * rand(0.15, 0.6), groundY - 2.3 * ppmY, 1.1 * ppmX, 1.1 * ppmY);
          }
        }
      });
    },
  };
}

function cratePainter(kind) {
  return {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      if (kind === 'wood') {
        plankPattern(ctx, 0, 0, W, H, 90, ['#c19a6b', '#b28d5e', '#caa477']);
        ctx.strokeStyle = 'rgba(80,50,20,.5)'; ctx.lineWidth = 6;
        ctx.strokeRect(4, 4, W - 8, H - 8);
      } else {
        ctx.fillStyle = kind === 'blue' ? '#4c7fae' : '#b8bcc2'; ctx.fillRect(0, 0, W, H);
        speckle(ctx, 0, 0, W, H, ['rgba(255,255,255,.25)', 'rgba(0,0,0,.15)'], 260, 1, 4, 0.7);
        ctx.fillStyle = 'rgba(0,0,0,.2)';
        for (let x = 20; x < W; x += 64) ctx.fillRect(x, 0, 6, H);
      }
    },
  };
}

function buildMap() {
  clearMap();
  // ---- 바닥 ----
  const groundSize = ARENA * 2;
  const gSurf = new PaintSurface(1024, 1024);
  {
    const ctx = gSurf.ctx, W = 1024;
    ctx.fillStyle = '#79b356'; ctx.fillRect(0, 0, W, W);
    speckle(ctx, 0, 0, W, W, ['#6da84e', '#84bd60', '#8fc46e', '#649c47'], 2600, 2, 6, 0.8);
    // 돌 광장
    ctx.fillStyle = '#cfc8ba';
    ctx.beginPath(); ctx.arc(W / 2, W / 2, W * 0.14, 0, 7); ctx.fill();
    speckle(ctx, W * 0.36, W * 0.36, W * 0.28, W * 0.28, ['#c2bbac', '#dbd4c6'], 300, 2, 6, 0.8);
    // 십자 길
    ctx.fillStyle = '#d9b98a';
    ctx.fillRect(W / 2 - 30, 0, 60, W); ctx.fillRect(0, W / 2 - 30, W, 60);
    speckle(ctx, W / 2 - 30, 0, 60, W, ['#cfae7d', '#e2c497'], 500, 1, 4, 0.8);
    speckle(ctx, 0, W / 2 - 30, W, 60, ['#cfae7d', '#e2c497'], 500, 1, 4, 0.8);
    // 꽃
    speckle(ctx, 0, 0, W, W, ['#f6e05e', '#f687b3', '#fff', '#fc8181'], 130, 2, 4, 0.9);
  }
  gSurf.addPlane(groundSize, groundSize, 0, 0, 1, 1, new THREE.Vector3(0, 0, 0), 0, -Math.PI / 2);
  gSurf.snapshotBase(); gSurf.texture.needsUpdate = true;

  // ---- 외곽 벽 4면 ----
  const wallH = 3.6;
  const mk = (len) => {
    const s = new PaintSurface(2048, Math.ceil(2048 / len * wallH));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    brickPattern(ctx, 0, 0, W, H, W / len, ['#8d99ae', '#7d8aa0', '#96a2b5'], '#adb8c9');
    ctx.fillStyle = 'rgba(255,255,255,.2)'; ctx.fillRect(0, 0, W, 8);
    for (let i = 0; i < 4; i++) drawPoster(ctx, rand(0.06, 0.85) * W, H * rand(0.18, 0.4), rand(60, 90), rand(80, 120));
    return s;
  };
  const L = groundSize;
  const wN = mk(L); wN.addPlane(L, wallH, 0, 0, 1, 1, new THREE.Vector3(0, wallH / 2, -ARENA), 0);
  const wS = mk(L); wS.addPlane(L, wallH, 0, 0, 1, 1, new THREE.Vector3(0, wallH / 2, ARENA), Math.PI);
  const wE = mk(L); wE.addPlane(L, wallH, 0, 0, 1, 1, new THREE.Vector3(ARENA, wallH / 2, 0), -Math.PI / 2);
  const wW = mk(L); wW.addPlane(L, wallH, 0, 0, 1, 1, new THREE.Vector3(-ARENA, wallH / 2, 0), Math.PI / 2);
  [wN, wS, wE, wW].forEach((s) => { s.snapshotBase(); s.texture.needsUpdate = true; });

  // ---- 건물 ----
  const defs = [
    { x: -13, z: -12, w: 8, d: 6, h: 4.0, style: 'brick', roof: 0x8b3a2f },
    { x: 12, z: -13, w: 7, d: 7, h: 3.5, style: 'stucco', roof: 0xc05621 },
    { x: -14, z: 11, w: 9, d: 5, h: 4.4, style: 'tile', roof: 0x2c5282 },
    { x: 13, z: 12, w: 6, d: 5, h: 3.0, style: 'wood', roof: 0x6b4a2b },
    { x: 0, z: -15, w: 5, d: 4, h: 3.2, style: 'yellow', roof: 0xb7791f },
    { x: 8, z: 2, w: 6, d: 4, h: 3.2, style: 'mint', roof: 0x276749 },
  ];
  defs.forEach((b) => {
    makePaintBox(b.x, b.z, b.w, b.d, b.h, 48, buildingPainter(b.style));
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(b.w + 0.5, 0.3, b.d + 0.5),
      new THREE.MeshLambertMaterial({ color: b.roof }));
    roof.position.set(b.x, b.h + 0.15, b.z);
    decorGroup.add(roof); solidMeshes.push(roof);
  });

  // ---- 그래피티 벽(양면) ----
  const gws = [
    { x: -4, z: 6, rot: 0.3, len: 6 },
    { x: 5, z: -6, rot: -0.5, len: 5 },
    { x: -9, z: -2, rot: 1.2, len: 5 },
  ];
  gws.forEach((g) => {
    const h = 2.6;
    const s = new PaintSurface(Math.ceil(g.len * 2 * 56), Math.ceil(h * 56));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    ctx.fillStyle = '#d7d2c8'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#ccc6ba', '#e2ddd3'], 700, 1, 4, 0.7);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = pick(['rgba(229,62,62,.5)', 'rgba(49,130,206,.5)', 'rgba(56,161,105,.5)', 'rgba(214,158,46,.55)', 'rgba(128,90,213,.5)']);
      ctx.beginPath(); ctx.arc(rand(0, W), rand(0, H), rand(24, 70), 0, 7); ctx.fill();
    }
    const dir = new THREE.Vector3(Math.sin(g.rot), 0, Math.cos(g.rot));
    const p1 = new THREE.Vector3(g.x, h / 2, g.z).addScaledVector(dir, 0.026);
    const p2 = new THREE.Vector3(g.x, h / 2, g.z).addScaledVector(dir, -0.026);
    s.addPlane(g.len, h, 0, 0, 0.5, 1, p1, g.rot);
    s.addPlane(g.len, h, 0.5, 0, 1, 1, p2, g.rot + Math.PI);
    s.snapshotBase(); s.texture.needsUpdate = true;
    // 대략적 충돌(회전 무시, 중심 박스)
    const ex = Math.abs(Math.cos(g.rot)) * g.len / 2 + 0.15;
    const ez = Math.abs(Math.sin(g.rot)) * g.len / 2 + 0.15;
    colliders.push({ x1: g.x - ex, z1: g.z - ez, x2: g.x + ex, z2: g.z + ez });
  });

  // ---- 상자 ----
  const crates = [
    { x: -6, z: -8, s: 1.3, kind: 'wood' }, { x: -4.6, z: -8.2, s: 1.0, kind: 'wood' },
    { x: 7, z: 8, s: 1.4, kind: 'blue' }, { x: 15, z: -4, s: 1.2, kind: 'gray' },
    { x: -16, z: 3, s: 1.1, kind: 'wood' }, { x: 2, z: 14, s: 1.3, kind: 'gray' },
  ];
  crates.forEach((c) => makePaintBox(c.x, c.z, c.s, c.s, c.s, 72, cratePainter(c.kind)));

  // ---- 나무 ----
  [[-19, -5], [19, 7], [-7, 17], [17, 17], [-19, -17], [5, -11]].forEach(([x, z]) => addTree(x, z));

  // 경기장 경계 충돌
  colliders.push(
    { x1: -ARENA - 2, z1: -ARENA - 2, x2: ARENA + 2, z2: -ARENA },
    { x1: -ARENA - 2, z1: ARENA, x2: ARENA + 2, z2: ARENA + 2 },
    { x1: -ARENA - 2, z1: -ARENA - 2, x2: -ARENA, z2: ARENA + 2 },
    { x1: ARENA, z1: -ARENA - 2, x2: ARENA + 2, z2: ARENA + 2 },
  );
}

// ---------------- 카멜레온 스탬프 ----------------
// 100x100 좌표계 실루엣 → 마스크 캔버스
function chameleonMask(sizePx, color) {
  const pad = 1.3;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(sizePx * pad);
  const ctx = cv.getContext('2d');
  ctx.translate(cv.width / 2, cv.height / 2);
  ctx.scale(sizePx / 108, sizePx / 108);
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
  ctx.lineCap = 'round';
  // 몸통+머리
  ctx.beginPath();
  ctx.moveTo(-50, 4);
  ctx.quadraticCurveTo(-49, -8, -38, -13);
  ctx.quadraticCurveTo(-33, -24, -24, -21);       // 볏(casque)
  ctx.quadraticCurveTo(-6, -30, 12, -23);         // 등
  ctx.quadraticCurveTo(27, -16, 32, -6);
  ctx.quadraticCurveTo(34, 4, 26, 9);
  ctx.quadraticCurveTo(8, 16, -14, 13);           // 배
  ctx.quadraticCurveTo(-36, 12, -44, 9);
  ctx.closePath(); ctx.fill();
  // 다리
  ctx.lineWidth = 8;
  ctx.beginPath(); ctx.moveTo(-22, 8); ctx.lineTo(-19, 26); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(12, 8); ctx.lineTo(17, 26); ctx.stroke();
  // 말린 꼬리
  ctx.lineWidth = 9;
  ctx.beginPath(); ctx.arc(38, 6, 12, Math.PI * 0.95, Math.PI * 2.25); ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(38, 6, 4.5, 0, Math.PI * 1.4); ctx.stroke();
  // 색 입히기
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color; ctx.fillRect(0, 0, cv.width, cv.height);
  return cv;
}

function sampleColorAround(surface, x, y, r) {
  try {
    const d = surface.ctx.getImageData(clamp(x - r, 0, surface.canvas.width - 1), clamp(y - r, 0, surface.canvas.height - 1), 2 * r, 2 * r).data;
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
    return `rgb(${Math.round(rr / n)},${Math.round(gg / n)},${Math.round(bb / n)})`;
  } catch (e) { return 'rgb(128,128,128)'; }
}

// 스탬프: 표면 텍스처 위에 반투명 실루엣을 눌러 찍음
function stampChameleon(surface, px, py, sizePx, opts) {
  const ctx = surface.ctx;
  const flip = Math.random() < 0.5 ? -1 : 1;
  const rot = rand(-0.35, 0.35);
  const draw = (mask, alpha, dx = 0, dy = 0) => {
    ctx.save();
    ctx.translate(px + dx, py + dy); ctx.rotate(rot); ctx.scale(flip, 1);
    ctx.globalAlpha = alpha;
    ctx.drawImage(mask, -mask.width / 2, -mask.height / 2);
    ctx.restore();
  };
  const darkMask = chameleonMask(sizePx, '#08130a');
  const liteMask = chameleonMask(sizePx, '#ffffff');
  draw(liteMask, opts.bodyAlpha * 0.55, 1.5, 1.5);   // 아래쪽 밝은 테두리 느낌
  draw(darkMask, opts.bodyAlpha);                     // 본체 어두운 톤
  // 눈 (머리 쪽): 로컬(-34,-14)
  const la = { x: -34 * flip, y: -14 };
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const ex = px + (la.x * cos - la.y * sin) * (sizePx / 108);
  const ey = py + (la.x * sin + la.y * cos) * (sizePx / 108);
  const er = Math.max(2.5, sizePx * 0.05);
  const lidColor = sampleColorAround(surface, ex, ey, Math.ceil(er * 2));
  ctx.save();
  ctx.globalAlpha = clamp(opts.bodyAlpha * 2.4, 0.25, 0.75);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(ex, ey, er, 0, 7); ctx.fill();
  ctx.globalAlpha = clamp(opts.bodyAlpha * 3.2, 0.35, 0.9);
  ctx.fillStyle = '#111';
  ctx.beginPath(); ctx.arc(ex, ey, er * 0.45, 0, 7); ctx.fill();
  ctx.restore();
  surface.dirty = true;
  // 눈 영역 저장(깜빡임용)
  const eb = Math.ceil(er * 2.6);
  let openData = null;
  try { openData = ctx.getImageData(ex - eb, ey - eb, eb * 2, eb * 2); } catch (e) {}
  return { ex, ey, er, eb, lidColor, openData };
}

// ---------------- 플레이어 ----------------
const player = {
  pos: new THREE.Vector3(0, 1.5, 18),
  yaw: Math.PI, pitch: 0,
  speed: 4.3, radius: 0.38,
  reset(x = 0, z = 18, yaw = 0) {
    this.pos.set(x, 1.5, z); this.yaw = yaw; this.pitch = -0.05;
  },
};
function collide() {
  const p = player.pos, r = player.radius;
  for (const c of colliders) {
    const nx = clamp(p.x, c.x1, c.x2), nz = clamp(p.z, c.z1, c.z2);
    const dx = p.x - nx, dz = p.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        p.x = nx + (dx / d) * r; p.z = nz + (dz / d) * r;
      } else {
        // 박스 내부: 가장 가까운 면으로 밀어냄
        const pushes = [
          { d: p.x - c.x1 + r, x: c.x1 - r, z: p.z, ax: 'x' },
          { d: c.x2 - p.x + r, x: c.x2 + r, z: p.z, ax: 'x' },
          { d: p.z - c.z1 + r, x: p.x, z: c.z1 - r, ax: 'z' },
          { d: c.z2 - p.z + r, x: p.x, z: c.z2 + r, ax: 'z' },
        ].sort((a, b) => a.d - b.d)[0];
        p.x = pushes.x; p.z = pushes.z;
      }
    }
  }
  p.x = clamp(p.x, -ARENA + r, ARENA - r);
  p.z = clamp(p.z, -ARENA + r, ARENA - r);
}

// ---------------- 게임 상태 ----------------
const DIFF = {
  easy: { bodyAlpha: 0.20, blinkMin: 3.5, blinkMax: 6, guesses: 12 },
  normal: { bodyAlpha: 0.12, blinkMin: 5, blinkMax: 8.5, guesses: 9 },
  hard: { bodyAlpha: 0.075, blinkMin: 7, blinkMax: 11, guesses: 7 },
};
const HIDE_TIME = 150, SEEK_TIME = 180;
const game = {
  state: 'menu',           // menu | handoff | hide | seek | reveal | result | gameover
  rounds: 4, round: 1, difficulty: 'normal',
  scoreA: 0, scoreB: 0,
  hiderTeam: 'B',          // 이번 라운드에 숨는 팀
  timer: 0, guesses: 0,
  hidden: null,            // {surface, mesh, px, py, worldPos, normal, snapshot, eye}
  decoys: [], decoysLeft: 3,
  placing: null,           // null | 'real' | 'decoy'
  paintMode: false,
  tool: 'brush', brushSize: 1, color: '#e53e3e',
  nextBlink: 0, blinkUntil: 0, blinking: false,
  confirmOpen: false, pending: null,
  lastTickSec: -1,
};
const BRUSH_M = [0.06, 0.16, 0.38];   // 브러시 반지름(m)
const CHAM_M = 1.05;                  // 카멜레온 몸길이(m)
const FIND_R = 1.05;                  // 지목 판정 반경(m)

// ---------------- UI 도우미 ----------------
function show(el, on = true) { $(el).classList.toggle('hidden', !on); }
let toastTimer = 0;
function toast(msg, ms = 1600) {
  const t = $('toast');
  t.textContent = msg; t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = 0; }, ms);
}
function setHint(msg) {
  const h = $('hint');
  if (!msg) { h.classList.add('hidden'); return; }
  h.textContent = msg; h.classList.remove('hidden');
}
function fmtTime(s) {
  s = Math.max(0, Math.ceil(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function teamLabel(t) { return t === 'A' ? '🔴 A팀' : '🔵 B팀'; }

// ---------------- 메뉴 설정 ----------------
function segWire(id, cb) {
  $(id).querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on'); sfx.click(); cb(b.dataset.v);
    });
  });
}
segWire('segRounds', (v) => { game.rounds = parseInt(v, 10); });
segWire('segDiff', (v) => { game.difficulty = v; });

// ---------------- 페인트 팔레트 ----------------
const PALETTE = ['#ffffff', '#1a202c', '#a0aec0', '#e53e3e', '#dd6b20', '#f6e05e',
  '#84cc16', '#38a169', '#2f855a', '#4fd1c5', '#3182ce', '#2c5282',
  '#805ad5', '#ed64a6', '#8b5e3c', '#d9b98a'];
{
  const wrap = $('swatches');
  PALETTE.forEach((c) => {
    const d = document.createElement('div');
    d.className = 'sw'; d.style.background = c;
    d.addEventListener('click', () => {
      game.color = c; game.tool = 'brush';
      updatePaintbarUI(); sfx.click();
    });
    wrap.appendChild(d);
  });
}
function updatePaintbarUI() {
  $('curColor').style.background = game.color;
  document.querySelectorAll('.sw').forEach((s) => {
    s.classList.toggle('on', s.style.background && sameColor(s.style.background, game.color));
  });
  $('brushTool').classList.toggle('on', game.tool === 'brush');
  $('dropTool').classList.toggle('on', game.tool === 'drop');
  $('eraseTool').classList.toggle('on', game.tool === 'erase');
  document.querySelectorAll('.sizeBtn').forEach((b) => b.classList.toggle('on', +b.dataset.s === game.brushSize));
}
function sameColor(a, b) {
  const cv = sameColor.cv || (sameColor.cv = document.createElement('canvas').getContext('2d'));
  cv.fillStyle = a; const s1 = cv.fillStyle;
  cv.fillStyle = b; const s2 = cv.fillStyle;
  return s1 === s2;
}
$('brushTool').addEventListener('click', () => { game.tool = 'brush'; updatePaintbarUI(); sfx.click(); });
$('dropTool').addEventListener('click', () => { game.tool = 'drop'; updatePaintbarUI(); sfx.click(); toast('💉 표면을 탭하면 색을 추출해요', 1400); });
$('eraseTool').addEventListener('click', () => { game.tool = 'erase'; updatePaintbarUI(); sfx.click(); });
document.querySelectorAll('.sizeBtn').forEach((b) => b.addEventListener('click', () => {
  game.brushSize = +b.dataset.s; updatePaintbarUI(); sfx.click();
}));

// ---------------- 레이캐스트 ----------------
const raycaster = new THREE.Raycaster();
function raycastScreen(clientX, clientY) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(solidMeshes, false);
  return hits.length ? hits[0] : null;
}
function worldNormalOf(hit) {
  const n = hit.face.normal.clone();
  n.transformDirection(hit.object.matrixWorld);
  return n;
}

// ---------------- 그리기 ----------------
function paintAt(hit, last) {
  const mesh = hit.object, ud = mesh.userData;
  if (!ud.surface) return null;
  const s = ud.surface;
  const { x, y } = uvToPx(s, hit.uv.x, hit.uv.y);
  const ppm = (ud.ppmX + ud.ppmY) / 2;
  const r = BRUSH_M[game.brushSize] * ppm;

  // 진짜 카멜레온 위에는 못 칠함
  if (game.hidden && game.hidden.surface === s) {
    const dx = x - game.hidden.px, dy = y - game.hidden.py;
    const guard = game.hidden.sizePx * 0.62 + r;
    if (dx * dx + dy * dy < guard * guard) {
      if (!paintAt.warned || performance.now() - paintAt.warned > 1500) {
        toast('🦎 카멜레온 위에는 그릴 수 없어요!', 1200);
        paintAt.warned = performance.now();
      }
      return { s, x, y };
    }
  }

  const ctx = s.ctx;
  const drawDot = (cx2, cy2) => {
    if (game.tool === 'erase') {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, 7); ctx.clip();
      ctx.drawImage(s.base, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = game.color;
      ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, 7); ctx.fill();
    }
  };
  if (last && last.s === s) {
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < Math.max(220, r * 8)) {
      const steps = Math.max(1, Math.ceil(dist / (r * 0.45)));
      for (let i = 1; i <= steps; i++) drawDot(last.x + dx * i / steps, last.y + dy * i / steps);
    } else drawDot(x, y);
  } else drawDot(x, y);
  s.dirty = true;
  return { s, x, y };
}

function eyedrop(hit) {
  const s = hit.object.userData.surface;
  if (!s) return;
  const { x, y } = uvToPx(s, hit.uv.x, hit.uv.y);
  try {
    const d = s.ctx.getImageData(clamp(Math.round(x), 0, s.canvas.width - 1), clamp(Math.round(y), 0, s.canvas.height - 1), 1, 1).data;
    game.color = `rgb(${d[0]},${d[1]},${d[2]})`;
    game.tool = 'brush';
    updatePaintbarUI();
    toast('🎨 색 추출 완료!', 900);
    sfx.click();
  } catch (e) {}
}

// ---------------- 숨기/가짜 배치 ----------------
function placeChameleonAt(hit, isReal) {
  const mesh = hit.object, ud = mesh.userData, s = ud.surface;
  const { x, y } = uvToPx(s, hit.uv.x, hit.uv.y);
  const ppm = (ud.ppmX + ud.ppmY) / 2;
  const sizePx = CHAM_M * ppm;
  const diff = DIFF[game.difficulty];

  if (isReal && game.hidden) {
    // 이전 자리 복원
    const h = game.hidden;
    if (h.snapshot) {
      h.surface.ctx.putImageData(h.snapshot.data, h.snapshot.x, h.snapshot.y);
      h.surface.dirty = true;
    }
  }
  let snapshot = null;
  if (isReal) {
    const pad2 = Math.ceil(sizePx * 0.85);
    const sx = clamp(Math.round(x - pad2), 0, s.canvas.width - 1);
    const sy = clamp(Math.round(y - pad2), 0, s.canvas.height - 1);
    const sw = Math.min(pad2 * 2, s.canvas.width - sx);
    const sh = Math.min(pad2 * 2, s.canvas.height - sy);
    try { snapshot = { x: sx, y: sy, data: s.ctx.getImageData(sx, sy, sw, sh) }; } catch (e) {}
  }
  const eye = stampChameleon(s, x, y, sizePx, { bodyAlpha: diff.bodyAlpha });
  const entry = {
    surface: s, mesh, px: x, py: y, sizePx,
    worldPos: hit.point.clone(), normal: worldNormalOf(hit),
    snapshot, eye,
  };
  if (isReal) {
    game.hidden = entry;
    $('readyBtn').disabled = false;
    toast('🦎 위장 완료! 술래를 부를 준비가 되면 ✅', 1800);
  } else {
    game.decoys.push(entry);
    game.decoysLeft--;
    $('decoyCount').textContent = game.decoysLeft;
    if (game.decoysLeft <= 0) $('decoyBtn').disabled = true;
    toast('🃏 가짜 카멜레온 배치!', 1200);
  }
  sfx.stamp();
}

// ---------------- 확인 팝업 ----------------
function openConfirm(q, screenX, screenY, onYes) {
  game.confirmOpen = true;
  $('confirmQ').textContent = q;
  const el = $('confirm');
  el.style.display = 'flex';
  el.style.left = clamp(screenX - 110, 8, window.innerWidth - 240) + 'px';
  el.style.top = clamp(screenY - 150, 8, window.innerHeight - 150) + 'px';
  confirmYesCb = onYes;
}
let confirmYesCb = null;
function closeConfirm() {
  game.confirmOpen = false;
  $('confirm').style.display = 'none';
  confirmYesCb = null;
}
$('confirmYes').addEventListener('click', () => { const cb = confirmYesCb; closeConfirm(); if (cb) cb(); });
$('confirmNo').addEventListener('click', () => { closeConfirm(); sfx.click(); });

// ---------------- 입력 ----------------
const pointers = new Map();   // id → {kind, sx, sy, lx, ly, moved, t0, last(그리기용)}
let stickPtr = null;

function stickShow(x, y) {
  const b = $('stickBase'), k = $('stickKnob');
  b.style.display = k.style.display = 'block';
  b.style.left = x - 65 + 'px'; b.style.top = y - 65 + 'px';
  k.style.left = x - 28 + 'px'; k.style.top = y - 28 + 'px';
}
function stickKnob(x, y) {
  const k = $('stickKnob');
  k.style.left = x - 28 + 'px'; k.style.top = y - 28 + 'px';
}
function stickHide() {
  $('stickBase').style.display = $('stickKnob').style.display = 'none';
}

canvas.addEventListener('pointerdown', (e) => {
  if (game.confirmOpen) return;
  const st = game.state;
  if (st !== 'hide' && st !== 'seek') return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 합성 이벤트 등 */ }
  const p = { kind: 'look', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, t0: performance.now(), last: null };

  if (game.paintMode && st === 'hide') {
    const paintPtrs = [...pointers.values()].filter((q) => q.kind === 'paint');
    if (pointers.size === 0) {
      p.kind = 'paint';
      const hit = raycastScreen(e.clientX, e.clientY);
      if (hit && hit.object.userData.surface) {
        if (game.tool === 'drop') { eyedrop(hit); p.kind = 'look'; }
        else p.last = paintAt(hit, null);
      }
    } else {
      // 두 번째 손가락 → 전부 시점 회전으로 전환
      paintPtrs.forEach((q) => { q.kind = 'look'; q.last = null; });
      p.kind = 'look';
    }
  } else {
    // 이동 모드: 왼쪽 하단 = 조이스틱
    if (e.clientX < window.innerWidth * 0.42 && e.clientY > window.innerHeight * 0.3 && stickPtr === null) {
      p.kind = 'stick';
      stickPtr = e.pointerId;
      p.ox = e.clientX; p.oy = e.clientY; p.vx = 0; p.vy = 0;
      stickShow(e.clientX, e.clientY);
    }
  }
  pointers.set(e.pointerId, p);
});

canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.lx, dy = e.clientY - p.ly;
  p.moved += Math.abs(dx) + Math.abs(dy);
  p.lx = e.clientX; p.ly = e.clientY;

  if (p.kind === 'stick') {
    let vx = e.clientX - p.ox, vy = e.clientY - p.oy;
    const len = Math.hypot(vx, vy), max = 55;
    if (len > max) { vx = vx / len * max; vy = vy / len * max; }
    p.vx = vx / max; p.vy = vy / max;
    stickKnob(p.ox + vx, p.oy + vy);
  } else if (p.kind === 'look') {
    const lookCount = [...pointers.values()].filter((q) => q.kind === 'look').length;
    const f = lookCount > 1 ? 0.5 : 1;
    player.yaw -= dx * 0.0038 * f;
    player.pitch = clamp(player.pitch - dy * 0.0032 * f, -1.15, 1.15);
  } else if (p.kind === 'paint') {
    const hit = raycastScreen(e.clientX, e.clientY);
    if (hit && hit.object.userData.surface) p.last = paintAt(hit, p.last);
    else p.last = null;
  }
});

function pointerEnd(e) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  if (p.kind === 'stick' || e.pointerId === stickPtr) { stickPtr = null; stickHide(); }

  // 탭 판정
  const isTap = p.moved < 14 && performance.now() - p.t0 < 420 && p.kind !== 'stick' && p.kind !== 'paint';
  if (!isTap || game.confirmOpen) return;

  if (game.state === 'hide' && game.placing) {
    const hit = raycastScreen(e.clientX, e.clientY);
    if (hit && hit.object.userData.surface) {
      if (hit.point.distanceTo(player.pos) > 14) { toast('너무 멀어요! 좀 더 가까이 가세요', 1300); return; }
      const isReal = game.placing === 'real';
      openConfirm(isReal ? '🦎 여기에 숨을까요?' : '🃏 가짜를 놓을까요?', e.clientX, e.clientY, () => {
        placeChameleonAt(hit, isReal);
        setPlacing(null);
      });
    } else toast('그릴 수 있는 표면을 탭하세요', 1200);
  } else if (game.state === 'seek') {
    const hit = raycastScreen(e.clientX, e.clientY);
    if (hit && hit.object.userData.surface) {
      if (hit.point.distanceTo(player.pos) > 16) { toast('너무 멀어요! 가까이 가서 지목하세요', 1300); return; }
      openConfirm('🔍 여기를 지목할까요?', e.clientX, e.clientY, () => makeGuess(hit));
    }
  }
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ---------------- 술래 지목 ----------------
function paintX(surface, x, y, ppmAvg) {
  const ctx = surface.ctx, s2 = 0.22 * ppmAvg;
  ctx.save();
  ctx.strokeStyle = 'rgba(220,38,38,.9)'; ctx.lineWidth = Math.max(3, ppmAvg * 0.05); ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - s2, y - s2); ctx.lineTo(x + s2, y + s2);
  ctx.moveTo(x + s2, y - s2); ctx.lineTo(x - s2, y + s2);
  ctx.stroke();
  ctx.restore();
  surface.dirty = true;
}
function makeGuess(hit) {
  const h = game.hidden;
  const d = hit.point.distanceTo(h.worldPos);
  if (d <= FIND_R) { endRound(true); return; }

  game.guesses--;
  $('guessPill').textContent = `🔍 ${game.guesses}`;
  const ud = hit.object.userData;
  if (ud.surface) paintX(ud.surface, ...(() => { const q = uvToPx(ud.surface, hit.uv.x, hit.uv.y); return [q.x, q.y]; })(), (ud.ppmX + ud.ppmY) / 2);

  const nearDecoy = game.decoys.find((dc) => hit.point.distanceTo(dc.worldPos) <= FIND_R);
  if (nearDecoy) { toast('🃏 가짜 카멜레온! 속았다!', 1800); sfx.decoy(); }
  else {
    sfx.wrong();
    if (d < 2.5) toast('🔥 아주 뜨거워요!', 1400);
    else if (d < 5) toast('♨️ 따뜻해요', 1400);
    else if (d < 9) toast('😐 미지근해요', 1400);
    else if (d < 15) toast('🧊 차가워요', 1400);
    else toast('❄️ 얼음이에요!', 1400);
  }
  if (game.guesses <= 0) endRound(false);
}

// ---------------- 눈 깜빡임 ----------------
function scheduleBlink() {
  const d = DIFF[game.difficulty];
  game.nextBlink = performance.now() + rand(d.blinkMin, d.blinkMax) * 1000;
}
function doBlinkStep(now) {
  const h = game.hidden;
  if (!h || !h.eye || !h.eye.openData) return;
  if (!game.blinking && now >= game.nextBlink) {
    const { ex, ey, er, lidColor } = h.eye;
    const ctx = h.surface.ctx;
    ctx.save();
    ctx.fillStyle = lidColor;
    ctx.beginPath(); ctx.arc(ex, ey, er * 1.35, 0, 7); ctx.fill();
    ctx.restore();
    h.surface.dirty = true;
    game.blinking = true;
    game.blinkUntil = now + 240;
  } else if (game.blinking && now >= game.blinkUntil) {
    const { ex, ey, eb, openData } = h.eye;
    h.surface.ctx.putImageData(openData, Math.round(ex - eb), Math.round(ey - eb));
    h.surface.dirty = true;
    game.blinking = false;
    scheduleBlink();
  }
}
function restoreEyeOpen() {
  const h = game.hidden;
  if (game.blinking && h && h.eye && h.eye.openData) {
    h.surface.ctx.putImageData(h.eye.openData, Math.round(h.eye.ex - h.eye.eb), Math.round(h.eye.ey - h.eye.eb));
    h.surface.dirty = true;
  }
  game.blinking = false;
}

// ---------------- 페이즈 전환 ----------------
function setPhaseUI() {
  const st = game.state;
  show('hud', st === 'hide' || st === 'seek');
  const hideUI = st === 'hide';
  $('hideActions').style.display = hideUI ? 'flex' : 'none';
  show('paintbar', hideUI && game.paintMode);
  show('readyBtn', hideUI && !game.paintMode);
  $('guessPill').classList.toggle('hidden', st !== 'seek');
  if (st === 'hide') {
    $('phaseLabel').textContent = `🦎 숨는 중 · ${teamLabel(game.hiderTeam)}`;
  } else if (st === 'seek') {
    $('phaseLabel').textContent = `🔍 찾는 중 · ${teamLabel(seekerTeam())}`;
  }
}
function seekerTeam() { return game.hiderTeam === 'A' ? 'B' : 'A'; }

function setPaintMode(on) {
  game.paintMode = on;
  $('paintModeBtn').classList.toggle('on', on);
  show('paintbar', on && game.state === 'hide');
  show('readyBtn', !on && game.state === 'hide');
  if (on) {
    setPlacing(null);
    stickHide(); stickPtr = null;
    setHint('한 손가락: 그리기 · 두 손가락: 시점 회전');
    updatePaintbarUI();
  } else setHint(game.placing ? '숨길 표면을 탭하세요' : '');
  if (!on) setHint('');
}
function setPlacing(mode) {
  game.placing = mode;
  $('hideBtn').classList.toggle('on', mode === 'real');
  $('decoyBtn').classList.toggle('on', mode === 'decoy');
  if (mode) {
    setPaintModeQuiet(false);
    setHint(mode === 'real' ? '🦎 숨을 곳(벽/바닥/상자)을 탭하세요' : '🃏 가짜를 놓을 곳을 탭하세요');
  } else if (!game.paintMode) setHint('');
}
function setPaintModeQuiet(on) {
  game.paintMode = on;
  $('paintModeBtn').classList.toggle('on', on);
  show('paintbar', on && game.state === 'hide');
  show('readyBtn', !on && game.state === 'hide');
}

$('paintModeBtn').addEventListener('click', () => { sfx.click(); setPaintMode(!game.paintMode); });
$('hideBtn').addEventListener('click', () => { sfx.click(); setPlacing(game.placing === 'real' ? null : 'real'); });
$('decoyBtn').addEventListener('click', () => {
  if (game.decoysLeft <= 0) return;
  sfx.click(); setPlacing(game.placing === 'decoy' ? null : 'decoy');
});
$('readyBtn').addEventListener('click', () => {
  if (!game.hidden) return;
  sfx.click();
  startHandoff('seek');
});

function startHandoff(next) {
  game.state = 'handoff';
  setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null;
  closeConfirm(); setHint('');
  const team = next === 'hide' ? game.hiderTeam : seekerTeam();
  $('hoEmoji').textContent = next === 'hide' ? '🎨' : '🔍';
  $('hoWho').textContent = `${teamLabel(team)} 차례`;
  $('hoDesc').innerHTML = next === 'hide'
    ? `iPad를 <b>${team}팀</b>에게 전달하세요.<br>맵에 그림을 그리고 카멜레온을 위장시켜 숨기세요! (제한 ${fmtTime(HIDE_TIME)})<br><b style="color:#fca5a5">${seekerTeam() === 'A' ? 'A' : 'B'}팀(술래)은 화면을 보면 안 돼요! 🙈</b>`
    : `iPad를 <b>${team}팀</b>에게 전달하세요.<br>숨어있는 진짜 카멜레온을 찾아 탭! (제한 ${fmtTime(SEEK_TIME)} · 지목 ${DIFF[game.difficulty].guesses}번)<br>💡 진짜는 아주 가끔 눈을 깜빡여요…`;
  $('hoBtn').textContent = next === 'hide' ? '🎨 숨기 시작!' : '🔍 찾기 시작!';
  $('hoBtn').onclick = () => { sfx.click(); next === 'hide' ? beginHide() : beginSeek(); };
  show('handoff', true);
}

function beginHide() {
  show('handoff', false);
  buildMap();
  game.hidden = null; game.decoys = []; game.decoysLeft = 3;
  game.placing = null; game.paintMode = false;
  game.tool = 'brush'; game.color = pick(PALETTE.slice(3));
  $('decoyCount').textContent = '3';
  $('decoyBtn').disabled = false;
  $('readyBtn').disabled = true;
  player.reset(0, 18, 0);
  game.timer = HIDE_TIME;
  game.state = 'hide';
  setPhaseUI();
  updatePaintbarUI();
  toast(`${teamLabel(game.hiderTeam)} — 그림으로 위장해 숨으세요!`, 2200);
}

function autoPlace() {
  // 시간 초과: 건물 벽 임의 지점에 자동 배치
  const walls = paintMeshes.filter((m) => m.userData.hM >= 2 && m.rotation.x === 0);
  const mesh = pick(walls.length ? walls : paintMeshes);
  const ud = mesh.userData;
  const t = rand(0.25, 0.75), sv = rand(0.3, 0.6);
  const u = ud.u0 + t * (ud.u1 - ud.u0), v = ud.v0 + sv * (ud.v1 - ud.v0);
  const local = new THREE.Vector3((t - 0.5) * ud.wM, (sv - 0.5) * ud.hM, 0);
  const point = mesh.localToWorld(local.clone());
  const fakeHit = {
    object: mesh, uv: new THREE.Vector2(u, v), point,
    face: { normal: new THREE.Vector3(0, 0, 1) },
  };
  placeChameleonAt(fakeHit, true);
}

function beginSeek() {
  show('handoff', false);
  game.guesses = DIFF[game.difficulty].guesses;
  $('guessPill').textContent = `🔍 ${game.guesses}`;
  game.paintMode = false; game.placing = null;
  player.reset(0, 18, 0);
  game.timer = SEEK_TIME;
  game.state = 'seek';
  setPhaseUI();
  scheduleBlink();
  setHint('의심스러운 곳을 탭해서 지목하세요');
  setTimeout(() => setHint(''), 4000);
}

// ---------------- 라운드 종료 ----------------
let revealUntil = 0;
function endRound(found) {
  restoreEyeOpen();
  const h = game.hidden;
  // 노란 링으로 정답 공개
  const ctx = h.surface.ctx;
  ctx.save();
  ctx.strokeStyle = '#fde047'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(h.px, h.py, h.sizePx * 0.72, 0, 7); ctx.stroke();
  ctx.strokeStyle = 'rgba(253,224,71,.5)'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.arc(h.px, h.py, h.sizePx * 0.85, 0, 7); ctx.stroke();
  ctx.restore();
  h.surface.dirty = true;
  // 정답 앞으로 카메라 이동
  const camPos = h.worldPos.clone().addScaledVector(h.normal, 3.4);
  camPos.y = clamp(camPos.y, 1.2, 4);
  camera.position.copy(camPos);
  camera.lookAt(h.worldPos);

  if (found) { game[seekerTeam() === 'A' ? 'scoreA' : 'scoreB']++; sfx.found(); toast('🎯 찾았다!', 2000); }
  else { game[game.hiderTeam === 'A' ? 'scoreA' : 'scoreB']++; sfx.survive(); toast('🦎 숨기 성공!', 2000); }

  game.state = 'reveal';
  setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null; closeConfirm();
  revealUntil = performance.now() + 2400;
  revealFound = found;
}
let revealFound = false;
function showResult() {
  game.state = 'result';
  const found = revealFound;
  $('resBig').textContent = found ? '🎯 찾았다!' : '🦎 숨기 성공!';
  const winner = found ? seekerTeam() : game.hiderTeam;
  $('resDesc').innerHTML = `라운드 ${game.round}/${game.rounds} — <b>${teamLabel(winner)}</b> 득점!<br>` +
    (found ? '술래가 카멜레온을 찾아냈어요.' : '카멜레온이 끝까지 들키지 않았어요.');
  $('resScoreA').textContent = game.scoreA;
  $('resScoreB').textContent = game.scoreB;
  $('resBtn').textContent = game.round >= game.rounds ? '최종 결과 보기 🏁' : '다음 라운드 ▶';
  show('result', true);
}
$('resBtn').addEventListener('click', () => {
  sfx.click();
  show('result', false);
  if (game.round >= game.rounds) { showGameover(); return; }
  game.round++;
  game.hiderTeam = game.hiderTeam === 'A' ? 'B' : 'A';
  startHandoff('hide');
});
function showGameover() {
  game.state = 'gameover';
  const a = game.scoreA, b = game.scoreB;
  $('goBig').textContent = a === b ? '🤝 무승부!' : (a > b ? '🏆 🔴 A팀 승리!' : '🏆 🔵 B팀 승리!');
  $('goDesc').textContent = a === b ? '숨바꼭질 실력이 막상막하!' : '축하합니다! 한 판 더 어때요?';
  $('goScoreA').textContent = a;
  $('goScoreB').textContent = b;
  show('gameover', true);
}
$('goBtn').addEventListener('click', () => {
  sfx.click();
  show('gameover', false);
  show('menu', true);
  game.state = 'menu';
});

// ---------------- 시작 ----------------
$('startBtn').addEventListener('click', () => {
  ac(); sfx.click();
  game.scoreA = 0; game.scoreB = 0; game.round = 1; game.hiderTeam = 'B';
  show('menu', false);
  startHandoff('hide');
});

// ---------------- 메인 루프 ----------------
buildMap();   // 메뉴 배경용
camera.position.set(0, 10, 26);
camera.lookAt(0, 1, 0);
let menuAngle = 0;

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();
  const st = game.state;

  if (st === 'menu' || st === 'handoff' || st === 'result' || st === 'gameover') {
    // 회전 데모 카메라
    menuAngle += dt * 0.1;
    camera.position.set(Math.sin(menuAngle) * 22, 12, Math.cos(menuAngle) * 22);
    camera.lookAt(0, 1, 0);
  } else if (st === 'hide' || st === 'seek') {
    // 이동
    if (stickPtr !== null) {
      const p = pointers.get(stickPtr);
      if (p) {
        const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
        const r = new THREE.Vector3(-f.z, 0, f.x);
        player.pos.addScaledVector(f, -p.vy * player.speed * dt);
        player.pos.addScaledVector(r, p.vx * player.speed * dt);
        collide();
      }
    }
    camera.position.copy(player.pos);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(player.pitch, player.yaw, 0);

    // 타이머
    game.timer -= dt;
    $('timer').textContent = fmtTime(game.timer);
    const sec = Math.ceil(game.timer);
    if (sec <= 10 && sec !== game.lastTickSec && sec > 0) { game.lastTickSec = sec; sfx.tick(); }
    if (game.timer <= 0) {
      if (st === 'hide') {
        if (!game.hidden) autoPlace();
        toast('⏰ 시간 종료!', 1500);
        startHandoff('seek');
      } else endRound(false);
    }
    // 깜빡임 (찾기 페이즈)
    if (st === 'seek') doBlinkStep(now);
  } else if (st === 'reveal') {
    if (now >= revealUntil) showResult();
  }

  paintSurfaces.forEach((s) => s.update());
  renderer.render(scene, camera);
}
animate();
