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

// ---------------- 기기 감지 (iPad + PC 모두 지원) ----------------
const isTouchDevice = navigator.maxTouchPoints > 0;
if (isTouchDevice) $('rotate').classList.add('armed');   // 세로 경고는 터치 기기에서만
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

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
  shot: () => {
    try {
      const a = ac(), len = 0.25;
      const buf = a.createBuffer(1, Math.floor(a.sampleRate * len), a.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.2);
      const src = a.createBufferSource(); src.buffer = buf;
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1100;
      const g = a.createGain(); g.gain.value = 0.55;
      src.connect(f); f.connect(g); g.connect(a.destination); src.start();
      tone(85, 0.22, 'sine', 0.35, -40);
    } catch (e) {}
  },
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
  // 아틀라스의 uv 영역을 쓰는 임의 지오메트리 파트(카멜레온 몸 등)
  addPart(geo, u0, v0, u1, v1, sizeM, group) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.userData = {
      surface: this,
      ppmX: this.canvas.width * (u1 - u0) / sizeM,
      ppmY: this.canvas.height * (v1 - v0) / sizeM,
    };
    group.add(mesh);
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

// ---------------- 3D 카멜레온 캐릭터 ----------------
// 새하얀 몸의 카멜레온 모델 — 몸 전체가 페인트 가능한 캔버스(메차카멜레온 방식)
// cloneFrom을 주면 그 시점의 페인트 상태를 복사(가짜 카멜레온용)
function buildChameleon(sizeScale = 1, cloneFrom = null) {
  const surf = new PaintSurface(512, 512);
  {
    const ctx = surf.ctx;
    ctx.fillStyle = '#f4f4ee'; ctx.fillRect(0, 0, 512, 512);
    speckle(ctx, 0, 0, 512, 512, ['#e9eae2', '#fbfbf7'], 500, 2, 5, 0.5);
    if (cloneFrom) ctx.drawImage(cloneFrom.canvas, 0, 0);
  }
  surf.snapshotBase();
  surf.texture.needsUpdate = true;

  const g = new THREE.Group();
  const part = (geo, r, sizeM) => surf.addPart(geo, r[0], r[1], r[2], r[3], sizeM, g);

  // 몸통(타원체) — 앞쪽 = +Z
  const bodyGeo = new THREE.SphereGeometry(1, 24, 16);
  bodyGeo.scale(0.20, 0.16, 0.34);
  part(bodyGeo, [0, 0, 0.5, 0.5], 0.7).position.set(0, 0.02, 0);
  // 머리
  part(new THREE.SphereGeometry(0.115, 16, 12), [0.5, 0, 0.78, 0.28], 0.24)
    .position.set(0, 0.075, 0.32);
  // 볏(casque)
  const casque = part(new THREE.ConeGeometry(0.075, 0.15, 10), [0.78, 0, 1, 0.22], 0.15);
  casque.position.set(0, 0.185, 0.26); casque.rotation.x = -0.5;
  // 주둥이
  const snout = part(new THREE.ConeGeometry(0.055, 0.11, 10), [0.5, 0.3, 0.64, 0.44], 0.11);
  snout.position.set(0, 0.05, 0.43); snout.rotation.x = Math.PI / 2;
  // 말린 꼬리(토러스 호)
  const tail = part(new THREE.TorusGeometry(0.10, 0.032, 8, 22, Math.PI * 1.75), [0, 0.52, 0.46, 0.96], 0.45);
  tail.position.set(0, 0.06, -0.38); tail.rotation.y = Math.PI / 2; tail.rotation.z = 0.5;
  // 다리 4개
  [[-0.13, 0.16], [0.13, 0.16], [-0.13, -0.14], [0.13, -0.14]].forEach(([lx, lz], i) => {
    const leg = part(new THREE.CylinderGeometry(0.026, 0.034, 0.17, 8),
      [0.5 + (i % 2) * 0.13, 0.5 + Math.floor(i / 2) * 0.15, 0.61 + (i % 2) * 0.13, 0.63 + Math.floor(i / 2) * 0.15], 0.17);
    leg.position.set(lx, -0.10, lz);
  });
  // 돌출형 눈(포탑 눈) — 페인트 불가, 진짜만 깜빡임
  const eyes = [];
  [-1, 1].forEach((s) => {
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 12, 10),
      new THREE.MeshLambertMaterial({ color: 0xfffbe8 }));
    eye.position.set(s * 0.095, 0.105, 0.345);
    eye.userData.isEye = true;
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.018, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0x1c1c1c }));
    pupil.position.set(s * 0.032, 0.01, 0.028);
    eye.add(pupil);
    g.add(eye);
    solidMeshes.push(eye);
    eyes.push(eye);
  });

  g.scale.setScalar(sizeScale);
  decorGroup.add(g);
  return { group: g, surface: surf, eyes, worldPos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
}

// 표면에 카멜레온을 붙임(배가 표면을 향하도록 정렬 + 무작위 회전)
function attachChameleon(cham, hit) {
  const n = worldNormalOf(hit);
  const align = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  const twist = new THREE.Quaternion().setFromAxisAngle(n, rand(0, Math.PI * 2));
  cham.group.quaternion.copy(twist.multiply(align));
  cham.group.position.copy(hit.point).addScaledVector(n, 0.155 * cham.group.scale.x);
  cham.worldPos.copy(hit.point);
  cham.normal.copy(n);
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
  easy: { sizeScale: 1.25, blinkMin: 3.5, blinkMax: 6, guesses: 12 },
  normal: { sizeScale: 1.0, blinkMin: 5, blinkMax: 8.5, guesses: 9 },
  hard: { sizeScale: 0.8, blinkMin: 7, blinkMax: 11, guesses: 7 },
};
const HIDE_TIME = 150, SEEK_TIME = 180;
const game = {
  state: 'menu',           // menu | handoff | hide | seek | reveal | result | gameover
  rounds: 4, round: 1, difficulty: 'normal',
  scoreA: 0, scoreB: 0,
  hiderTeam: 'B',          // 이번 라운드에 숨는 팀
  timer: 0, guesses: 0,
  hidden: null,            // 배치 완료된 진짜 카멜레온 {group, surface, eyes, worldPos, normal}
  cham: null,              // 이번 라운드의 내 카멜레온(3D 모델)
  chamPlaced: false,
  decoys: [], decoysLeft: 3,
  placing: null,           // null | 'real' | 'decoy'
  paintMode: false,
  tool: 'brush', brushM: 0.14, color: '#e53e3e',
  recoil: 0,
  nextBlink: 0, blinkUntil: 0, blinking: false,
  confirmOpen: false, pending: null,
  lastTickSec: -1,
};
const SHOT_RANGE = 14;                // 샷건 사거리(m)
const SHOT_PELLETS = 8;               // 펠릿 수
const SHOT_SPREAD = 0.045;            // 퍼짐(rad) — 멀수록 잘 안 맞음

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
// 브러시 크기 슬라이더 (2px~60px 표시 = 0.02m~0.60m)
$('brushRange').addEventListener('input', (e) => {
  const v = +e.target.value;
  game.brushM = v / 100;
  const d = $('brushPreview');
  const px = clamp(v * 0.7, 5, 42);
  d.style.width = px + 'px'; d.style.height = px + 'px';
});

// ---------------- 실행취소 (스트로크 단위) ----------------
const undoStack = [];
function pushUndo(surface) {
  const cv = document.createElement('canvas');
  cv.width = surface.canvas.width; cv.height = surface.canvas.height;
  cv.getContext('2d').drawImage(surface.canvas, 0, 0);
  undoStack.push({ surface, cv });
  if (undoStack.length > 8) undoStack.shift();
}
$('undoTool').addEventListener('click', () => {
  const u = undoStack.pop();
  if (!u) { toast('되돌릴 그림이 없어요', 900); return; }
  u.surface.ctx.drawImage(u.cv, 0, 0);
  u.surface.dirty = true;
  sfx.click();
});

// ---------------- 레이캐스트 ----------------
const raycaster = new THREE.Raycaster();
function raycastScreen(clientX, clientY, skipEyes = false) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(solidMeshes, false);
  for (const h of hits) {
    if (skipEyes && h.object.userData.isEye) continue;   // 눈 뒤의 몸에 칠해짐
    return h;
  }
  return null;
}
// 줌 (핀치/휠) — FOV 조절
function setZoom(fov) {
  camera.fov = clamp(fov, 20, 80);
  camera.updateProjectionMatrix();
}
window.addEventListener('wheel', (e) => {
  if ((game.state === 'hide' && game.paintMode) || game.state === 'seek') {
    setZoom(camera.fov + e.deltaY * 0.02);
  }
}, { passive: true });
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
  const r = Math.max(1.5, game.brushM * ppm);

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
  if (isReal) {
    attachChameleon(game.cham, hit);
    game.chamPlaced = true;
    game.hidden = game.cham;
    $('readyBtn').disabled = false;
    toast('🦎 붙었다! 이제 몸을 색칠해서 위장하세요 🎨', 2000);
  } else {
    // 가짜: 지금까지 칠한 내 모습을 그대로 복제
    const decoy = buildChameleon(DIFF[game.difficulty].sizeScale, game.cham.surface);
    decoy.group.traverse((o) => { o.userData.chamRole = 'decoy'; });
    attachChameleon(decoy, hit);
    game.decoys.push(decoy);
    game.decoysLeft--;
    $('decoyCount').textContent = game.decoysLeft;
    if (game.decoysLeft <= 0) $('decoyBtn').disabled = true;
    toast('🃏 가짜 카멜레온 배치! (내 모습 복사)', 1400);
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

let penActive = 0;   // Apple Pencil 팜 리젝션용
canvas.addEventListener('pointerdown', (e) => {
  if (game.confirmOpen) return;
  const st = game.state;
  if (st !== 'hide' && st !== 'seek') return;
  // 펜 사용 중 손바닥(터치) 무시
  if (e.pointerType === 'touch' && penActive > 0) return;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 합성 이벤트 등 */ }
  if (e.pointerType === 'pen') penActive++;
  const p = { kind: 'look', type: e.pointerType, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, t0: performance.now(), last: null };

  if (game.paintMode && st === 'hide') {
    if (e.pointerType === 'mouse' && e.button === 2) {
      p.kind = 'look';               // PC: 우클릭 드래그 = 시점 회전
    } else if (e.pointerType === 'pen' || pointers.size === 0) {
      // Apple Pencil은 언제나 그리기 (터치가 남아 있어도)
      if (e.pointerType === 'pen') {
        [...pointers.values()].forEach((q) => {
          if (q.kind === 'paint' && q.type === 'touch') { q.kind = 'look'; q.last = null; }
        });
      }
      p.kind = 'paint';
      const hit = raycastScreen(e.clientX, e.clientY, true);
      if (hit && hit.object.userData.surface) {
        if (game.tool === 'drop') { eyedrop(hit); p.kind = 'look'; }
        else { pushUndo(hit.object.userData.surface); p.last = paintAt(hit, null); }
      }
    } else {
      // 두 번째 손가락 → 시점 회전/핀치 줌으로 전환
      [...pointers.values()].forEach((q) => { if (q.kind === 'paint') { q.kind = 'look'; q.last = null; } });
      p.kind = 'look';
    }
  } else {
    // 이동 모드: 왼쪽 하단 = 조이스틱 (손가락 전용, 마우스는 WASD·펜은 시점)
    if (e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.42 && e.clientY > window.innerHeight * 0.3 && stickPtr === null) {
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
  const prevX = p.lx, prevY = p.ly;
  const dx = e.clientX - prevX, dy = e.clientY - prevY;
  p.moved += Math.abs(dx) + Math.abs(dy);
  p.lx = e.clientX; p.ly = e.clientY;

  if (p.kind === 'stick') {
    let vx = e.clientX - p.ox, vy = e.clientY - p.oy;
    const len = Math.hypot(vx, vy), max = 55;
    if (len > max) { vx = vx / len * max; vy = vy / len * max; }
    p.vx = vx / max; p.vy = vy / max;
    stickKnob(p.ox + vx, p.oy + vy);
  } else if (p.kind === 'look') {
    const looks = [...pointers.values()].filter((q) => q.kind === 'look');
    const f = looks.length > 1 ? 0.5 : 1;
    player.yaw -= dx * 0.0038 * f;
    player.pitch = clamp(player.pitch - dy * 0.0032 * f, -1.15, 1.15);
    // 두 손가락 핀치 = 확대/축소 (그리기 모드·찾기 페이즈)
    if (looks.length === 2 && (game.paintMode || game.state === 'seek')) {
      const o = looks.find((q) => q !== p);
      if (o) {
        const prevDist = Math.hypot(prevX - o.lx, prevY - o.ly);
        const newDist = Math.hypot(e.clientX - o.lx, e.clientY - o.ly);
        setZoom(camera.fov + (prevDist - newDist) * 0.12);
      }
    }
  } else if (p.kind === 'paint') {
    const hit = raycastScreen(e.clientX, e.clientY, true);
    if (hit && hit.object.userData.surface) p.last = paintAt(hit, p.last);
    else p.last = null;
  }
});

function pointerEnd(e) {
  const p = pointers.get(e.pointerId);
  if (p && p.type === 'pen') penActive = Math.max(0, penActive - 1);
  if (!p) return;
  pointers.delete(e.pointerId);
  if (p.kind === 'stick' || e.pointerId === stickPtr) { stickPtr = null; stickHide(); }

  // 탭 판정
  const isTap = p.moved < 14 && performance.now() - p.t0 < 420 && p.kind !== 'stick' && p.kind !== 'paint';
  if (!isTap || game.confirmOpen) return;

  if (game.state === 'hide' && game.placing) {
    const hit = raycastScreen(e.clientX, e.clientY, true);
    if (hit && hit.object.userData.surface && !hit.object.userData.chamRole) {
      if (hit.point.distanceTo(player.pos) > 14) { toast('너무 멀어요! 좀 더 가까이 가세요', 1300); return; }
      const isReal = game.placing === 'real';
      openConfirm(isReal ? '🦎 여기에 숨을까요?' : '🃏 가짜를 놓을까요?', e.clientX, e.clientY, () => {
        placeChameleonAt(hit, isReal);
        setPlacing(null);
      });
    } else toast('그릴 수 있는 표면을 탭하세요', 1200);
  } else if (game.state === 'seek' && p.type === 'mouse') {
    shoot();   // PC: 클릭 = 조준점으로 발사
  }
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);

// ---------------- 키보드 (PC) ----------------
const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.code === 'Space' && game.state === 'seek') shoot();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
function keyMoveVec() {
  let x = 0, y = 0;
  if (keys.KeyW || keys.ArrowUp) y -= 1;
  if (keys.KeyS || keys.ArrowDown) y += 1;
  if (keys.KeyA || keys.ArrowLeft) x -= 1;
  if (keys.KeyD || keys.ArrowRight) x += 1;
  const len = Math.hypot(x, y);
  return len > 0 ? { x: x / len, y: y / len } : null;
}

// ---------------- 술래 샷건 ----------------
// 원작 규칙: 빗나간 탄약은 영영 소모, 카멜레온 명중 시 탄약 회복, 탄약 0 = 숨는 팀 승리
function drawHole(surface, x, y, ppmAvg) {
  const ctx = surface.ctx, r = Math.max(2, 0.035 * ppmAvg);
  ctx.save();
  ctx.fillStyle = 'rgba(30,25,20,.85)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.9)';
  ctx.beginPath(); ctx.arc(x, y, r * 0.5, 0, 7); ctx.fill();
  ctx.restore();
  surface.dirty = true;
}
let lastShotAt = 0;
function shoot() {
  if (game.state !== 'seek' || game.confirmOpen) return;
  const now = performance.now();
  if (now - lastShotAt < 650 || game.guesses <= 0) return;
  lastShotAt = now;
  sfx.shot();
  game.recoil = 0.09;
  const fl = $('flash');
  fl.style.opacity = 0.3;
  setTimeout(() => { fl.style.opacity = 0; }, 70);

  const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  let hitReal = false, hitDecoy = false, bestDist = Infinity, impacts = 0;
  for (let i = 0; i < SHOT_PELLETS; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * SHOT_SPREAD;
    const dir = fwd.clone()
      .addScaledVector(right, Math.cos(a) * rr)
      .addScaledVector(up, Math.sin(a) * rr).normalize();
    raycaster.set(camera.position, dir);
    raycaster.far = SHOT_RANGE;
    const hits = raycaster.intersectObjects(solidMeshes, false);
    raycaster.far = Infinity;
    if (!hits.length) continue;
    const h = hits[0];
    impacts++;
    const role = h.object.userData.chamRole;
    if (role === 'real') hitReal = true;
    else if (role === 'decoy') hitDecoy = true;
    const ud = h.object.userData;
    if (ud.surface && h.uv) {
      const q = uvToPx(ud.surface, h.uv.x, h.uv.y);
      drawHole(ud.surface, q.x, q.y, (ud.ppmX + ud.ppmY) / 2);
    }
    bestDist = Math.min(bestDist, h.point.distanceTo(game.hidden.group.position));
  }

  if (hitReal) { endRound(true); return; }   // 명중! (탄약 소모 없음 — 원작 규칙)
  game.guesses--;
  $('guessPill').textContent = `🔫 ${game.guesses}`;
  if (hitDecoy) { toast('🃏 가짜였다! 총알만 날렸다!', 1800); sfx.decoy(); }
  else if (impacts === 0) { toast(`💨 허공에 발사! (사거리 ${SHOT_RANGE}m)`, 1400); sfx.wrong(); }
  else {
    sfx.wrong();
    if (bestDist < 2.5) toast('🔥 아주 뜨거워요!', 1400);
    else if (bestDist < 5) toast('♨️ 따뜻해요', 1400);
    else if (bestDist < 9) toast('😐 미지근해요', 1400);
    else if (bestDist < 15) toast('🧊 차가워요', 1400);
    else toast('❄️ 얼음이에요!', 1400);
  }
  if (game.guesses <= 0) {
    toast('💥 탄약이 다 떨어졌다!', 1800);
    setTimeout(() => { if (game.state === 'seek') endRound(false); }, 1100);
  }
}
$('fireBtn').addEventListener('pointerdown', (e) => { e.preventDefault(); shoot(); });

// ---------------- 눈 깜빡임 ----------------
function scheduleBlink() {
  const d = DIFF[game.difficulty];
  game.nextBlink = performance.now() + rand(d.blinkMin, d.blinkMax) * 1000;
}
function doBlinkStep(now) {
  const h = game.hidden;
  if (!h || !h.eyes) return;
  if (!game.blinking && now >= game.nextBlink) {
    h.eyes.forEach((e) => e.scale.set(1, 0.12, 1));   // 눈 감기
    game.blinking = true;
    game.blinkUntil = now + 240;
  } else if (game.blinking && now >= game.blinkUntil) {
    h.eyes.forEach((e) => e.scale.set(1, 1, 1));       // 눈 뜨기
    game.blinking = false;
    scheduleBlink();
  }
}
function restoreEyeOpen() {
  const h = game.hidden;
  if (h && h.eyes) h.eyes.forEach((e) => e.scale.set(1, 1, 1));
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
  $('crosshair').style.display = st === 'seek' ? 'block' : 'none';
  show('fireBtn', st === 'seek');
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
    setHint(isTouchDevice ? '✏️펜슬/손가락: 그리기 · 두 손가락: 시점 회전+핀치 확대' : '드래그: 그리기 · 우클릭 드래그: 시점 · 휠: 확대 · WASD: 이동');
    updatePaintbarUI();
  } else { setHint(''); setZoom(70); }
}
function setPlacing(mode) {
  game.placing = mode;
  $('hideBtn').classList.toggle('on', mode === 'real');
  $('decoyBtn').classList.toggle('on', mode === 'decoy');
  if (mode) {
    setPaintModeQuiet(false);
    setHint(mode === 'real' ? '🦎 카멜레온이 붙을 곳(벽/바닥/상자)을 탭하세요' : '🃏 가짜를 붙일 곳을 탭하세요');
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
$('exitBtn').addEventListener('click', () => {
  sfx.click();
  openConfirm('🏠 게임을 끝내고 메뉴로 나갈까요?', window.innerWidth / 2, window.innerHeight / 2, () => {
    game.state = 'menu';
    setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null;
    setHint(''); setZoom(70);
    show('menu', true);
  });
});

function startHandoff(next) {
  game.state = 'handoff';
  setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null;
  closeConfirm(); setHint('');
  const team = next === 'hide' ? game.hiderTeam : seekerTeam();
  $('hoEmoji').textContent = next === 'hide' ? '🎨' : '🔍';
  $('hoWho').textContent = `${teamLabel(team)} 차례`;
  $('hoDesc').innerHTML = next === 'hide'
    ? `기기를 <b>${team}팀</b>에게 전달하세요.<br>새하얀 카멜레온 몸을 색칠하고 벽에 붙어 위장하세요! (제한 ${fmtTime(HIDE_TIME)})<br><b style="color:#fca5a5">${seekerTeam() === 'A' ? 'A' : 'B'}팀(술래)은 화면을 보면 안 돼요! 🙈</b>`
    : `기기를 <b>${team}팀</b>에게 전달하세요.<br>🔫 샷건으로 진짜 카멜레온을 쏘세요! (제한 ${fmtTime(SEEK_TIME)} · 탄약 ${DIFF[game.difficulty].guesses}발)<br><b style="color:#fca5a5">빗나간 총알은 영영 소모!</b> 탄약이 다 떨어지면 숨는 팀 승리<br>💡 진짜는 아주 가끔 눈을 깜빡여요…`;
  $('hoBtn').textContent = next === 'hide' ? '🎨 숨기 시작!' : '🔍 찾기 시작!';
  $('hoBtn').onclick = () => { sfx.click(); next === 'hide' ? beginHide() : beginSeek(); };
  show('handoff', true);
}

function beginHide() {
  show('handoff', false);
  buildMap();
  // 내 카멜레온(새하얀 몸) 생성 — 배치 전까지 플레이어를 따라다님(3인칭)
  game.cham = buildChameleon(DIFF[game.difficulty].sizeScale);
  game.cham.group.traverse((o) => { o.userData.chamRole = 'real'; });
  game.chamPlaced = false;
  game.hidden = null; game.decoys = []; game.decoysLeft = 3;
  game.placing = null; game.paintMode = false;
  game.tool = 'brush'; game.color = pick(PALETTE.slice(3));
  undoStack.length = 0;
  setZoom(70);
  $('decoyCount').textContent = '3';
  $('decoyBtn').disabled = false;
  $('readyBtn').disabled = true;
  player.reset(0, 18, 0);
  game.timer = HIDE_TIME;
  game.state = 'hide';
  setPhaseUI();
  updatePaintbarUI();
  toast(`${teamLabel(game.hiderTeam)} — 하얀 카멜레온을 색칠해서 위장하세요!`, 2600);
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
  $('guessPill').textContent = `🔫 ${game.guesses}`;
  game.paintMode = false; game.placing = null;
  game.recoil = 0;
  setZoom(70);
  player.reset(0, 18, 0);
  game.timer = SEEK_TIME;
  game.state = 'seek';
  setPhaseUI();
  scheduleBlink();
  setHint('🔫 조준점을 맞추고 발사! 가까울수록 잘 맞아요');
  setTimeout(() => setHint(''), 4500);
}

// ---------------- 라운드 종료 ----------------
let revealUntil = 0;
function endRound(found) {
  restoreEyeOpen();
  const h = game.hidden;
  // 노란 링으로 정답 공개 (3D 링)
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.56, 40),
    new THREE.MeshBasicMaterial({ color: 0xfde047, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
  ring.position.copy(h.group.position).addScaledVector(h.normal, 0.12);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.normal);
  ring.scale.setScalar(h.group.scale.x);
  decorGroup.add(ring);
  // 정답 앞으로 카메라 이동
  const camPos = h.group.position.clone().addScaledVector(h.normal, 3.2);
  camPos.y = clamp(camPos.y, 1.2, 4);
  camera.position.copy(camPos);
  camera.lookAt(h.group.position);

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

window.__dbg = { game, player };   // 디버그/테스트용
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
    // 이동 (터치 조이스틱 + 키보드)
    let mvx = 0, mvy = 0;
    if (stickPtr !== null) {
      const p = pointers.get(stickPtr);
      if (p) { mvx = p.vx; mvy = p.vy; }
    }
    const kv = keyMoveVec();
    if (kv) { mvx += kv.x; mvy += kv.y; }
    const moving = !!(mvx || mvy);
    if (moving) {
      const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      player.pos.addScaledVector(f, -mvy * player.speed * dt);
      player.pos.addScaledVector(r, mvx * player.speed * dt);
      collide();
    }
    if (st === 'hide' && game.cham && !game.chamPlaced) {
      // 3인칭: 내 카멜레온이 앞에서 걸어다님
      const m = game.cham.group;
      m.position.set(player.pos.x, moving ? 0.02 + Math.abs(Math.sin(now * 0.012)) * 0.05 : 0.02, player.pos.z);
      m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw + Math.PI);
      const back = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
      camera.position.set(
        player.pos.x + back.x * 2.7,
        clamp(1.7 - player.pitch * 1.6, 0.5, 4.2),
        player.pos.z + back.z * 2.7);
      camera.lookAt(m.position.x, 0.45, m.position.z);
    } else {
      camera.position.copy(player.pos);
      camera.rotation.order = 'YXZ';
      camera.rotation.set(player.pitch + game.recoil, player.yaw, 0);
      game.recoil *= Math.exp(-dt * 9);   // 반동 회복
    }

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
