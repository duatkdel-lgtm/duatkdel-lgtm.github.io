// ============================================================
//  🕴️ 젤리맨 숨바꼭질 3D — iPad/PC 핫시트(교대) 2팀 대전
//  B팀: 새하얀 젤리맨 몸에 그림을 그리고 자세를 잡아 배경에 위장
//  A팀: 기기를 넘겨받아 샷건으로 진짜 젤리맨을 사냥
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
document.addEventListener('touchmove', (e) => {
  // 굵기 슬라이더 등 UI 조작은 막지 않음 (화면 스크롤만 방지)
  if (e.target && e.target.closest && e.target.closest('#paintbar, #posePanel, .settings')) return;
  e.preventDefault();
}, { passive: false });
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

const hemiLight = new THREE.HemisphereLight(0xdfeeff, 0x7fa35c, 1.15);
scene.add(hemiLight);
const ambLight = new THREE.AmbientLight(0xffffff, 0.42);
scene.add(ambLight);
const sun = new THREE.DirectionalLight(0xfff2d6, 0.95);
sun.position.set(25, 40, 12);
scene.add(sun);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------------- 페인트 표면 (캔버스 아틀라스) ----------------
const ARENA = 23;               // 마을 맵 반경 (±23m)
let ARENA_X = 23, ARENA_Z = 23; // 현재 맵의 이동 가능 절반 크기
let SPAWN = { x: 0, z: 18, yaw: 0 };   // 맵별 시작 위치
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
  // 아틀라스의 uv 영역을 쓰는 임의 지오메트리 파트(젤리맨 몸 등)
  // sizeX/sizeY: 이 파트가 uv 가로/세로로 덮는 실제 월드 길이(m) — 붓 왜곡 보정용
  addPart(geo, u0, v0, u1, v1, sizeX, sizeY, group) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
    }
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.userData = {
      surface: this, spherical: true,
      u0, v0, u1, v1,
      ppmX: this.canvas.width * (u1 - u0) / sizeX,
      ppmY: this.canvas.height * (v1 - v0) / sizeY,
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
  if (game.map === 'gym') buildGymMap();
  else buildTownMap();
}

function buildTownMap() {
  ARENA_X = ARENA; ARENA_Z = ARENA;
  SPAWN = { x: 0, z: 18, yaw: 0 };
  scene.background.set(0x8ecbee);
  scene.fog.color.set(0x8ecbee); scene.fog.near = 55; scene.fog.far = 120;
  hemiLight.intensity = 1.15; ambLight.intensity = 0.42; sun.intensity = 0.95;
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

// ============================================================
//  💪 노네임피트니스 맵 — 실제 매장 도면/사진 기반
//  블랙 노출천장 + 라인조명 + 네온스트립, 아치거울 단상,
//  골드 포스터월, 빨간 랙, 연두 러닝머신, 브릭 기둥
// ============================================================
const GYM_X = 22, GYM_Z = 10, GYM_H = 4.2;   // 실내 44 x 20m, 층고 4.2m

// 노네임 공식 로고: 블랙 필 + 골드 테두리 + 실버 메탈릭 이탤릭 NONAME
function drawNonameLogo(ctx, cx, cy, w) {
  const h = w * 0.42, r = h / 2, lw = Math.max(2, w * 0.022);
  const x0 = cx - w / 2, y0 = cy - h / 2;
  const pill = () => {
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0);
    ctx.lineTo(x0 + w - r, y0);
    ctx.arc(x0 + w - r, cy, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(x0 + r, y0 + h);
    ctx.arc(x0 + r, cy, r, Math.PI / 2, Math.PI * 1.5);
    ctx.closePath();
  };
  ctx.save();
  ctx.fillStyle = '#0a0a0a'; pill(); ctx.fill();
  const gold = ctx.createLinearGradient(x0, y0, x0 + w, y0 + h);
  gold.addColorStop(0, '#8a6a1a'); gold.addColorStop(0.3, '#f3d565');
  gold.addColorStop(0.55, '#c9a227'); gold.addColorStop(0.8, '#f3d565'); gold.addColorStop(1, '#8a6a1a');
  ctx.strokeStyle = gold; ctx.lineWidth = lw; pill(); ctx.stroke();
  const silver = ctx.createLinearGradient(x0, y0, x0 + w, y0);
  silver.addColorStop(0, '#b9b9b9'); silver.addColorStop(0.3, '#ffffff');
  silver.addColorStop(0.5, '#9c9c9c'); silver.addColorStop(0.7, '#f4f4f4'); silver.addColorStop(1, '#c2c2c2');
  ctx.fillStyle = silver;
  ctx.font = `italic 900 ${Math.floor(h * 0.52)}px sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.transform(1, 0, -0.12, 1, 0, 0);   // 살짝 더 기울인 스피드체 느낌
  ctx.fillText('NONAME', cx + cy * 0.12, cy + h * 0.03);
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function neonStrip(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, '#ff2fb3'); g.addColorStop(0.35, '#a855f7');
  g.addColorStop(0.7, '#6366f1'); g.addColorStop(1, '#38bdf8');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(x, y + h * 0.3, w, h * 0.25);
}
function drawGymPoster(ctx, x, y, w, h) {
  ctx.fillStyle = '#c9a227'; ctx.fillRect(x - 4, y - 4, w + 8, h + 8);   // 골드 프레임
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#4a4d52'); g.addColorStop(1, '#24262a');
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  // 흑백 피트니스 모델 실루엣
  ctx.fillStyle = 'rgba(15,16,18,.85)';
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h * 0.32, w * 0.16, h * 0.13, 0, 0, 7); ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h * 0.62, w * 0.26, h * 0.26, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#c9a227';
  ctx.font = `bold ${Math.max(8, w * 0.13)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('NONAME FITNESS', x + w / 2, y + h * 0.95);
  ctx.textAlign = 'left';
}
// 양면 파티션 벽 (축 정렬: rot 0 = X방향, PI/2 = Z방향)
function makeDoubleWall(cx, cz, alongZ, len, h, paintFn) {
  const ppm = 52;
  const s = new PaintSurface(Math.min(2048, Math.ceil(len * 2 * ppm)), Math.ceil(h * ppm));
  paintFn(s.ctx, s.canvas.width, s.canvas.height);
  const rot = alongZ ? Math.PI / 2 : 0;
  const dir = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
  const p1 = new THREE.Vector3(cx, h / 2, cz).addScaledVector(dir, 0.03);
  const p2 = new THREE.Vector3(cx, h / 2, cz).addScaledVector(dir, -0.03);
  s.addPlane(len, h, 0, 0, 0.5, 1, p1, rot);
  s.addPlane(len, h, 0.5, 0, 1, 1, p2, rot + Math.PI);
  s.snapshotBase(); s.texture.needsUpdate = true;
  const ex = alongZ ? 0.15 : len / 2 + 0.1;
  const ez = alongZ ? len / 2 + 0.1 : 0.15;
  colliders.push({ x1: cx - ex, z1: cz - ez, x2: cx + ex, z2: cz + ez });
  return s;
}
function plantPot(x, z) {
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.45, 8),
    new THREE.MeshLambertMaterial({ color: 0xe8e6e0 }));
  pot.position.set(x, 0.23, z);
  const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshLambertMaterial({ color: 0x3f7d44 }));
  leaf.position.set(x, 0.85, z);
  decorGroup.add(pot, leaf);
  solidMeshes.push(pot, leaf);
  colliders.push({ x1: x - 0.25, z1: z - 0.25, x2: x + 0.25, z2: z + 0.25 });
}

// 러닝머신: 칠할 수 있는 데크 + 연두 레일 + 콘솔(파란 화면). 앞쪽(-Z)이 창가 방향
function makeTreadmill(cx, cz) {
  makePaintBox(cx, cz, 0.85, 1.9, 0.26, 70, {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#141518'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#b5e341';
      ctx.fillRect(0, H * 0.42, W, 5); ctx.fillRect(0, H - 5, W, 5);
      ctx.fillStyle = '#0a0b0d'; ctx.fillRect(W * 0.06, H * 0.48, W * 0.88, H * 0.48);
      ctx.fillStyle = 'rgba(255,255,255,.07)';
      for (let y = H * 0.52; y < H - 4; y += 9) ctx.fillRect(W * 0.06, y, W * 0.88, 2);
    },
  });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1c1e23 });
  const lime = new THREE.MeshLambertMaterial({ color: 0x9fc93c });
  const zF = cz - 0.78;
  [-0.36, 0.36].forEach((ox) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.05, 0.07), dark);
    post.position.set(cx + ox, 0.78, zF);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.055, 1.0), lime);
    rail.position.set(cx + ox, 1.0, zF + 0.55);
    decorGroup.add(post, rail);
    solidMeshes.push(post, rail);
  });
  const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.09), dark);
  consoleBox.position.set(cx, 1.42, zF); consoleBox.rotation.x = -0.25;
  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 0.02),
    new THREE.MeshBasicMaterial({ color: 0x2f9edb }));
  screen.position.set(cx, 1.44, zF + 0.06); screen.rotation.x = -0.25;
  decorGroup.add(consoleBox, screen);
  solidMeshes.push(consoleBox);
}
// 스핀바이크: 플라이휠(보라) + 안장 + 핸들바
function makeSpinBike(cx, cz) {
  const dark = new THREE.MeshLambertMaterial({ color: 0x1a1b20 });
  const purple = new THREE.MeshLambertMaterial({ color: 0x7c3aed });
  const parts = [];
  const add = (geo, x, y, z, rx = 0, rz = 0, mat = dark) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.x = rx; m.rotation.z = rz;
    parts.push(m);
    return m;
  };
  add(new THREE.BoxGeometry(0.48, 0.07, 0.12), cx, 0.05, cz - 0.4);
  add(new THREE.BoxGeometry(0.48, 0.07, 0.12), cx, 0.05, cz + 0.4);
  add(new THREE.BoxGeometry(0.09, 0.09, 0.95), cx, 0.5, cz, 0.45);
  const wheel = add(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 14), cx, 0.42, cz - 0.3, 0, Math.PI / 2, purple);
  add(new THREE.BoxGeometry(0.06, 0.42, 0.06), cx, 0.85, cz + 0.32);
  add(new THREE.BoxGeometry(0.24, 0.07, 0.3), cx, 1.08, cz + 0.32);            // 안장
  add(new THREE.BoxGeometry(0.06, 0.5, 0.06), cx, 0.92, cz - 0.3);
  add(new THREE.BoxGeometry(0.44, 0.07, 0.14), cx, 1.2, cz - 0.3);             // 핸들바
  parts.forEach((m) => { decorGroup.add(m); solidMeshes.push(m); });
  colliders.push({ x1: cx - 0.26, z1: cz - 0.52, x2: cx + 0.26, z2: cz + 0.52 });
}

function buildGymMap() {
  ARENA_X = GYM_X; ARENA_Z = GYM_Z;
  SPAWN = { x: 19.5, z: 6.5, yaw: Math.PI / 2 };   // 정문에서 홀 안쪽을 바라봄
  scene.background.set(0x0d0e12);
  scene.fog.color.set(0x0d0e12); scene.fog.near = 30; scene.fog.far = 85;
  hemiLight.intensity = 0.55; ambLight.intensity = 0.8; sun.intensity = 0.6;

  const W2 = GYM_X * 2, D2 = GYM_Z * 2;

  // ---- 바닥: 검은 고무매트 타일 + 존별 색 ----
  const gSurf = new PaintSurface(1408, 640);
  {
    const ctx = gSurf.ctx, W = 1408, H = 640;
    const zx = (wx) => (wx + GYM_X) / W2 * W, zy = (wz) => (wz + GYM_Z) / D2 * H;
    ctx.fillStyle = '#1b1c20'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#17181c', '#212228', '#25262c'], 2200, 1, 4, 0.7);
    // 고무매트 타일 줄눈
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 2;
    for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = 0; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // 스트레칭 단상 (베이지 타일)
    ctx.fillStyle = '#cfc9bd';
    ctx.fillRect(zx(-21.5), zy(-9.5), zx(-13.5) - zx(-21.5), zy(-3) - zy(-9.5));
    speckle(ctx, zx(-21.5), zy(-9.5), zx(-13.5) - zx(-21.5), zy(-3) - zy(-9.5), ['#c5bfb2', '#d8d2c6'], 160, 1, 3, 0.7);
    // 요가매트 3장
    ctx.fillStyle = '#3f4449';
    [[-20.3, -8.6], [-18.2, -8.6], [-16.1, -8.6]].forEach(([mx, mz]) => {
      ctx.fillRect(zx(mx), zy(mz), zx(mx + 0.9) - zx(mx), zy(mz + 2.2) - zy(mz));
    });
    // 스피닝룸 다크 존
    ctx.fillStyle = '#121317';
    ctx.fillRect(zx(15), zy(-10), zx(22) - zx(15), zy(-3) - zy(-10));
    // 입구 로비 (밝은 타일 존) — 문 열면 여기부터 시작
    ctx.fillStyle = '#a8a49b';
    ctx.fillRect(zx(17), zy(2), zx(22) - zx(17), zy(10) - zy(2));
    speckle(ctx, zx(17), zy(2), zx(22) - zx(17), zy(10) - zy(2), ['#9d998f', '#b3afa5'], 140, 1, 3, 0.6);
    // 게이트 통로 그린 매트 + 오렌지 라인
    ctx.fillStyle = '#2f7d3b';
    ctx.fillRect(zx(17), zy(5.2), zx(22) - zx(17), zy(7.8) - zy(5.2));
    ctx.strokeStyle = '#f97316'; ctx.lineWidth = 5;
    ctx.strokeRect(zx(17), zy(5.2), zx(22) - zx(17), zy(7.8) - zy(5.2));
    // 중앙 통로 라임 라인
    ctx.fillStyle = 'rgba(181,227,65,.5)';
    ctx.fillRect(zx(-13), zy(1.7), zx(14) - zx(-13), 4);
    ctx.fillRect(zx(-13), zy(-1.7), zx(14) - zx(-13), 4);
  }
  gSurf.addPlane(W2, D2, 0, 0, 1, 1, new THREE.Vector3(0, 0, 0), 0, -Math.PI / 2);
  gSurf.snapshotBase(); gSurf.texture.needsUpdate = true;

  // ---- 북쪽 벽: 창문 + 화이트 브릭 기둥 + 형광 사인 ----
  {
    const s = new PaintSurface(2048, Math.ceil(2048 / W2 * GYM_H));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    const ppmX = W / W2, ppmY = H / GYM_H;
    ctx.fillStyle = '#101319'; ctx.fillRect(0, 0, W, H);
    // 유리 패널 + 검은 프레임
    for (let x = 0; x < W; x += 1.6 * ppmX) {
      const g = ctx.createLinearGradient(x, 0, x + 1.6 * ppmX, H);
      g.addColorStop(0, '#1a2430'); g.addColorStop(1, '#0e141c');
      ctx.fillStyle = g;
      ctx.fillRect(x + 3, H * 0.12, 1.6 * ppmX - 6, H * 0.78);
    }
    // 화이트 브릭 기둥 (5개 간격)
    for (let i = 0; i < 5; i++) {
      const px = (i * 9 + 4) * ppmX;
      brickPattern(ctx, px, 0, 1.1 * ppmX, H, ppmX * 2.2, ['#d8d5cf', '#c9c6c0', '#e2dfd9'], '#b3b0aa');
    }
    // 유리 위 형광 연두 사인 (밖을 향한 간판의 뒷면 느낌)
    ctx.fillStyle = '#9ae62e';
    ctx.font = `bold ${Math.floor(H * 0.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.85;
    ctx.fillText('노 네 임 피 트 니 스', W / 2, H * 0.5);
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
    // 그린 LED 시계 + NONAME MAGAZINE 포스터 (기둥 위)
    const cx2 = (2 * 9 + 4.55) * ppmX;
    ctx.fillStyle = '#05070a'; ctx.fillRect(cx2 - 60, H * 0.2, 120, 26);
    ctx.fillStyle = '#31f56b'; ctx.font = `bold 20px monospace`; ctx.textAlign = 'center';
    ctx.fillText('00:59:50', cx2, H * 0.2 + 20); ctx.textAlign = 'left';
    ctx.fillStyle = '#f2efe9'; ctx.fillRect(cx2 - 35, H * 0.34, 70, 90);
    ctx.fillStyle = '#26282e'; ctx.font = 'bold 11px sans-serif';
    ctx.fillText('NONAME', cx2 - 28, H * 0.34 + 16);
    ctx.fillText('MAGAZINE', cx2 - 28, H * 0.34 + 30);
    neonStrip(ctx, 0, 0, W, H * 0.055);
    s.addPlane(W2, GYM_H, 0, 0, 1, 1, new THREE.Vector3(0, GYM_H / 2, -GYM_Z), 0);
    s.snapshotBase(); s.texture.needsUpdate = true;
  }

  // ---- 남쪽 벽: 화이트 그리드 대형 거울벽 ----
  {
    const s = new PaintSurface(2048, Math.ceil(2048 / W2 * GYM_H));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    ctx.fillStyle = '#2a2d33'; ctx.fillRect(0, 0, W, H);
    // 거울 패널들
    for (let x = 8; x < W - 8; x += W / 10) {
      const g = ctx.createLinearGradient(x, 0, x + W / 10, H);
      g.addColorStop(0, '#454c56'); g.addColorStop(0.5, '#2e333b'); g.addColorStop(1, '#3a414b');
      ctx.fillStyle = g;
      ctx.fillRect(x, H * 0.12, W / 10 - 10, H * 0.82);
      // 흰 프레임
      ctx.strokeStyle = '#e8e8e6'; ctx.lineWidth = 5;
      ctx.strokeRect(x, H * 0.12, W / 10 - 10, H * 0.82);
      // 반사 하이라이트 사선
      ctx.strokeStyle = 'rgba(255,255,255,.14)'; ctx.lineWidth = 12;
      ctx.beginPath(); ctx.moveTo(x + 14, H * 0.85); ctx.lineTo(x + W / 22, H * 0.2); ctx.stroke();
      // 네온 반사
      ctx.fillStyle = 'rgba(236,72,153,.2)';
      ctx.fillRect(x, H * 0.12, W / 10 - 10, H * 0.07);
    }
    neonStrip(ctx, 0, 0, W, H * 0.055);
    s.addPlane(W2, GYM_H, 0, 0, 1, 1, new THREE.Vector3(0, GYM_H / 2, GYM_Z), Math.PI);
    s.snapshotBase(); s.texture.needsUpdate = true;
  }

  // ---- 서쪽 벽: 골드 프레임 포스터 갤러리 (프리웨이트룸 무드) ----
  {
    const s = new PaintSurface(1024, Math.ceil(1024 / D2 * GYM_H));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    ctx.fillStyle = '#efece6'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#e6e2da', '#f5f2ec'], 400, 1, 3, 0.5);
    // 하단 웨인스코팅
    ctx.fillStyle = '#dcd7cd'; ctx.fillRect(0, H * 0.72, W, H * 0.28);
    ctx.strokeStyle = '#c9a227'; ctx.lineWidth = 3; ctx.strokeRect(10, H * 0.75, W - 20, H * 0.2);
    // 골드 포스터 6장 + 상단 중앙 공식 로고
    for (let i = 0; i < 6; i++) drawGymPoster(ctx, 30 + i * (W - 60) / 6, H * 0.16, (W - 60) / 6 - 24, H * 0.46);
    drawNonameLogo(ctx, W / 2, H * 0.09, W * 0.2);
    neonStrip(ctx, 0, 0, W, H * 0.05);
    s.addPlane(D2, GYM_H, 0, 0, 1, 1, new THREE.Vector3(-GYM_X, GYM_H / 2, 0), Math.PI / 2);
    s.snapshotBase(); s.texture.needsUpdate = true;
  }

  // ---- 동쪽 벽: 정문 + 대형 로고 ----
  {
    const s = new PaintSurface(1024, Math.ceil(1024 / D2 * GYM_H));
    const ctx = s.ctx, W = s.canvas.width, H = s.canvas.height;
    ctx.fillStyle = '#26282e'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#212329', '#2b2d34'], 600, 1, 3, 0.6);
    // 공식 로고 (골드 필)
    drawNonameLogo(ctx, W / 2, H * 0.36, W * 0.42);
    ctx.font = `bold ${Math.floor(H * 0.09)}px sans-serif`;
    ctx.fillStyle = '#9ae62e'; ctx.textAlign = 'center';
    ctx.fillText('노네임피트니스', W / 2, H * 0.62);
    ctx.textAlign = 'left';
    // 정문 (유리문 2짝, 남쪽 = 캔버스에서 z+6.5 위치)
    const doorX = (6.5 + GYM_Z) / D2;   // 동쪽 벽은 -Z→+Z가 캔버스 x- → x+ 반전 고려 없이 근사
    const dx = W * (1 - doorX) - 60;
    ctx.fillStyle = '#0f1318'; ctx.fillRect(dx, H * 0.35, 120, H * 0.65);
    ctx.strokeStyle = '#b8bcc2'; ctx.lineWidth = 5; ctx.strokeRect(dx, H * 0.35, 120, H * 0.65);
    ctx.beginPath(); ctx.moveTo(dx + 60, H * 0.35); ctx.lineTo(dx + 60, H); ctx.stroke();
    neonStrip(ctx, 0, 0, W, H * 0.05);
    s.addPlane(D2, GYM_H, 0, 0, 1, 1, new THREE.Vector3(GYM_X, GYM_H / 2, 0), -Math.PI / 2);
    s.snapshotBase(); s.texture.needsUpdate = true;
  }

  // ---- 천장 (블랙 노출 + 라인조명 + 네온 테두리) ----
  {
    const ceil = new THREE.Mesh(new THREE.BoxGeometry(W2, 0.2, D2),
      new THREE.MeshLambertMaterial({ color: 0x0c0d10 }));
    ceil.position.set(0, GYM_H + 0.1, 0);
    decorGroup.add(ceil); solidMeshes.push(ceil);
    for (let i = -1; i <= 1; i++) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(36, 0.06, 0.22),
        new THREE.MeshBasicMaterial({ color: 0xffffff }));
      strip.position.set(0, GYM_H - 0.04, i * 5.4);
      decorGroup.add(strip);
    }
    const neonColors = [0xff2fb3, 0x8b5cf6, 0x38bdf8, 0xec4899];
    [[0, -GYM_Z + 0.15, W2 - 0.6, 0.14], [0, GYM_Z - 0.15, W2 - 0.6, 0.14]].forEach(([x, z, len], i) => {
      const n = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.14),
        new THREE.MeshBasicMaterial({ color: neonColors[i] }));
      n.position.set(x, GYM_H - 0.1, z);
      decorGroup.add(n);
    });
    [[-GYM_X + 0.15, 0], [GYM_X - 0.15, 0]].forEach(([x, z], i) => {
      const n = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, D2 - 0.6),
        new THREE.MeshBasicMaterial({ color: neonColors[i + 2] }));
      n.position.set(x, GYM_H - 0.1, z);
      decorGroup.add(n);
    });
  }

  // ---- 스트레칭 단상 + 아치 거울 파티션 ----
  makePaintBox(-17.5, -6.2, 8, 6.6, 0.18, 64, {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#cfc9bd'; ctx.fillRect(0, 0, W, H);
      speckle(ctx, 0, 0, W, H, ['#c5bfb2', '#dad4c8'], 300, 1, 3, 0.6);
    },
  });
  makeDoubleWall(-17.5, -2.8, false, 8, 2.6, (ctx, W, H) => {
    ctx.fillStyle = '#5b5e63'; ctx.fillRect(0, 0, W, H);   // 다크그레이 벽
    // 아치 거울 3개 (양면 각각)
    for (let side = 0; side < 2; side++) {
      const x0 = side * W / 2;
      for (let i = 0; i < 3; i++) {
        const mx = x0 + W / 2 * (0.14 + i * 0.3), mw = W / 2 * 0.18, mh = H * 0.62, my = H * 0.18;
        const g = ctx.createLinearGradient(mx, my, mx + mw, my + mh);
        g.addColorStop(0, '#3b444f'); g.addColorStop(1, '#232a33');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(mx, my + mh);
        ctx.lineTo(mx, my + mw / 2);
        ctx.arc(mx + mw / 2, my + mw / 2, mw / 2, Math.PI, 0);
        ctx.lineTo(mx + mw, my + mh);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#f0efec'; ctx.lineWidth = 4; ctx.stroke();
      }
    }
  });

  // ---- 탈의실 2개 (남쪽 벽 앞) ----
  [['남자', -4.5, 0x60a5fa], ['여자', 1, 0xf472b6]].forEach(([label, bx, tint]) => {
    makePaintBox(bx, 8.2, 4.4, 3.2, 3, 50, {
      top: false,
      paint(surf, info) {
        const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
        ctx.fillStyle = '#e9e4da'; ctx.fillRect(0, 0, W, H);
        speckle(ctx, 0, 0, W, H, ['#e0dbd0', '#f1ece2'], 500, 1, 3, 0.5);
        // 정면(첫 면)에 문 + 픽토그램 + 사인
        const fw = info.faces[0][1] * W - info.faces[0][0] * W;
        const ppmX = W / info.perim, ppmY = info.wallH / info.h;
        drawDoor(ctx, fw / 2 - 0.55 * ppmX, H - 2.1 * ppmY, 1.1 * ppmX, 2.1 * ppmY, '#3f434a');
        ctx.fillStyle = '#' + tint.toString(16).padStart(6, '0');
        ctx.beginPath(); ctx.arc(fw / 2, H - 2.5 * ppmY, 0.25 * ppmX, 0, 7); ctx.fill();
        ctx.fillStyle = '#3a3d42'; ctx.font = `bold ${Math.floor(0.32 * ppmY)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`${label} 탈의실`, fw / 2, H - 2.95 * ppmY);
        ctx.textAlign = 'left';
      },
    });
  });

  // ---- 스피닝룸 파티션 (다크) ----
  const spinWallPaint = (ctx, W, H) => {
    ctx.fillStyle = '#17181d'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#131418', '#1c1d23'], 400, 1, 3, 0.6);
    neonStrip(ctx, 0, 0, W, H * 0.06);
    ctx.fillStyle = '#a855f7'; ctx.font = `bold ${Math.floor(H * 0.16)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.fillText('SPINNING', W / 4, H * 0.4);
    ctx.fillText('SPINNING', W * 3 / 4, H * 0.4); ctx.textAlign = 'left';
  };
  makeDoubleWall(15, -6.8, true, 6.4, 3, spinWallPaint);
  makeDoubleWall(19.8, -3.5, false, 4.4, 3, spinWallPaint);   // 입구 틈 x 15..17.6
  // 스피닝실 입구 보라 네온 프레임 (로비에서 들어오면 우측에 바로 보임)
  {
    const neon = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.12, 0.14),
      new THREE.MeshBasicMaterial({ color: 0xa855f7 }));
    neon.position.set(16.3, 3.05, -3.5);
    decorGroup.add(neon);
  }

  // ---- 입구 로비 파티션 (정문 → 로비 → 게이트 → 홀) ----
  const lobbyWallPaint = (ctx, W, H) => {
    ctx.fillStyle = '#f0ede7'; ctx.fillRect(0, 0, W, H);
    speckle(ctx, 0, 0, W, H, ['#e7e3db', '#f7f4ee'], 300, 1, 3, 0.5);
    ctx.fillStyle = '#f97316'; ctx.fillRect(0, H * 0.62, W, H * 0.09);
    drawNonameLogo(ctx, W / 4, H * 0.36, W * 0.32);
    drawNonameLogo(ctx, W * 3 / 4, H * 0.36, W * 0.32);
    ctx.font = `bold ${Math.floor(H * 0.09)}px sans-serif`;
    ctx.fillStyle = '#f97316'; ctx.textAlign = 'center';
    ctx.fillText('WELCOME 💪', W / 4, H * 0.58);
    ctx.fillText('WELCOME 💪', W * 3 / 4, H * 0.58);
    ctx.textAlign = 'left';
    neonStrip(ctx, 0, 0, W, H * 0.06);
  };
  makeDoubleWall(17, 3.5, true, 3, 3, lobbyWallPaint);      // 로비 남쪽 벽 (z 2..5)
  makeDoubleWall(17, 9, true, 2, 3, lobbyWallPaint);        // 로비 북쪽 벽 (z 8..10)
  // 스피드게이트 2개 (통로 z 5..8 사이)
  const gatePaint = {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#eceae5'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f97316'; ctx.fillRect(0, 0, W, Math.max(6, H * 0.12));
      ctx.fillStyle = '#26282e'; ctx.fillRect(W * 0.42, H * 0.3, W * 0.16, H * 0.2);
      ctx.fillStyle = '#31f56b'; ctx.fillRect(W * 0.46, H * 0.34, W * 0.08, H * 0.1);
    },
  };
  makePaintBox(17, 5.55, 0.55, 0.9, 1.05, 70, gatePaint);
  makePaintBox(17, 7.45, 0.55, 0.9, 1.05, 70, gatePaint);

  // ---- 기구들 ----
  // 빨간 파워랙 2 (프리웨이트존)
  const rackPaint = {
    top: false,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#141518'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#c22a2a';
      for (let x = 6; x < W; x += W / 8) ctx.fillRect(x, 0, 10, H);
      ctx.fillStyle = 'rgba(255,255,255,.15)';
      for (let y = 10; y < H; y += 26) ctx.fillRect(0, y, W, 3);
    },
  };
  makePaintBox(-19, 4.5, 1.5, 1.5, 2.4, 60, rackPaint);
  makePaintBox(-15.5, 4.5, 1.5, 1.5, 2.4, 60, rackPaint);
  // 화이트 케이블 머신 2
  const cablePaint = {
    top: false,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#e8e8e6'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#2b2d33';
      ctx.fillRect(W * 0.1, H * 0.15, W * 0.12, H * 0.8);
      ctx.fillRect(W * 0.55, H * 0.15, W * 0.12, H * 0.8);
      ctx.fillStyle = '#9aa0a8';
      for (let y = H * 0.2; y < H; y += 14) { ctx.fillRect(W * 0.12, y, W * 0.08, 5); ctx.fillRect(W * 0.57, y, W * 0.08, 5); }
    },
  };
  makePaintBox(-10, -7.5, 1.3, 0.8, 2.3, 60, cablePaint);
  makePaintBox(-6.5, -7.5, 1.3, 0.8, 2.3, 60, cablePaint);
  // 덤벨랙 2 (옐로 라벨)
  const dbPaint = {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#1a1b1f'; ctx.fillRect(0, 0, W, H);
      for (let y = H * 0.2; y < H * 0.95; y += H * 0.3) {
        for (let x = 12; x < W - 12; x += 34) {
          ctx.fillStyle = '#2c2e34'; ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.fill();
          ctx.fillStyle = '#f2c320'; ctx.beginPath(); ctx.moveTo(x - 6, y + 5); ctx.lineTo(x + 6, y + 5); ctx.lineTo(x, y - 5); ctx.closePath(); ctx.fill();
        }
      }
    },
  };
  makePaintBox(-11.5, 7.8, 3, 0.8, 1, 64, dbPaint);
  makePaintBox(-7.5, 7.8, 3, 0.8, 1, 64, dbPaint);
  // 블랙 머신 6 (중앙 2열)
  const machinePaint = {
    top: false,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#1d1f24'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#0f1013';
      ctx.fillRect(W * 0.08, H * 0.1, W * 0.1, H * 0.85);
      ctx.fillRect(W * 0.5, H * 0.3, W * 0.35, H * 0.2);
      ctx.fillStyle = '#e8e8e6'; ctx.fillRect(W * 0.3, H * 0.15, W * 0.06, H * 0.7);
      ctx.fillStyle = '#c22a2a'; ctx.fillRect(W * 0.52, H * 0.55, W * 0.2, H * 0.12);
    },
  };
  [[-3, -5], [0.5, -5], [4, -5], [-3, 5], [0.5, 5], [4, 5]].forEach(([mx, mz]) =>
    makePaintBox(mx, mz, 1.1, 1.5, 1.6, 60, machinePaint));
  // 러닝머신 8 (2열, 창가를 바라봄) — 데크+레일+콘솔이 있는 진짜 형태
  [[7.5, -6.8], [9.3, -6.8], [11.1, -6.8], [12.9, -6.8],
   [7.5, -3.6], [9.3, -3.6], [11.1, -3.6], [12.9, -3.6]].forEach(([mx, mz]) => makeTreadmill(mx, mz));
  // 스핀바이크 6 (스피닝룸 안) — 플라이휠+안장+핸들바
  [[16.8, -8.4], [18.6, -8.4], [20.4, -8.4], [16.8, -5.6], [18.6, -5.6], [20.4, -5.6]].forEach(([mx, mz]) =>
    makeSpinBike(mx, mz));
  // 인포메이션 카운터 (우드)
  makePaintBox(16.5, 1.5, 2.6, 1, 1.1, 60, {
    top: true,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      plankPattern(ctx, 0, 0, W, H, 110, ['#b08a5c', '#a37e51', '#bc9668']);
      ctx.fillStyle = '#f5f3ee'; ctx.font = `bold ${Math.floor(H * 0.2)}px sans-serif`;
      ctx.fillText('INFORMATION', W * 0.05, H * 0.55);
    },
  });
  // 우드 큐비 선반 (요가용품)
  makePaintBox(-13, -0.5, 2, 0.5, 1.8, 60, {
    top: false,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#c9a877'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#2f2a24';
      for (let gx = 0; gx < 4; gx++) for (let gy = 0; gy < 3; gy++) {
        ctx.fillRect(W * (0.06 + gx * 0.24), H * (0.08 + gy * 0.32), W * 0.18, H * 0.24);
      }
      // 핑크 짐볼 하나
      ctx.fillStyle = '#f472b6';
      ctx.beginPath(); ctx.arc(W * 0.39, H * 0.52, H * 0.11, 0, 7); ctx.fill();
    },
  });
  // 키오스크
  makePaintBox(20.8, 3.4, 0.6, 0.5, 1.6, 70, {
    top: false,
    paint(surf) {
      const ctx = surf.ctx, W = surf.canvas.width, H = surf.canvas.height;
      ctx.fillStyle = '#26282e'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f97316'; ctx.fillRect(W * 0.1, H * 0.1, W * 0.3, H * 0.35);
    },
  });
  // 화분들
  plantPot(-13.5, -8.8); plantPot(14, 8.5); plantPot(21, -1.5);

  // 경기장 경계 충돌
  colliders.push(
    { x1: -GYM_X - 2, z1: -GYM_Z - 2, x2: GYM_X + 2, z2: -GYM_Z },
    { x1: -GYM_X - 2, z1: GYM_Z, x2: GYM_X + 2, z2: GYM_Z + 2 },
    { x1: -GYM_X - 2, z1: -GYM_Z - 2, x2: -GYM_X, z2: GYM_Z + 2 },
    { x1: GYM_X, z1: -GYM_Z - 2, x2: GYM_X + 2, z2: GYM_Z + 2 },
  );
}

// ---------------- 3D 젤리맨 캐릭터 (원작 스타일) ----------------
// 새하얀 인간형 젤리 몸 — 눈 없음, 몸 전체가 페인트 캔버스, 자세 변형 가능
// cloneFrom을 주면 그 시점의 페인트 상태를 복사(가짜용)

// 자세 프리셋: 팔/다리 rotZ(몸 평면 안 회전) + roll(전체 회전) + squash(젤리 찌부)
const POSES = [
  { name: '🙆 大자 뻗기', armL: 2.35, armR: -2.35, legL: 0.45, legR: -0.45, roll: 0 },
  { name: '🧍 차렷', armL: 0.12, armR: -0.12, legL: 0.07, legR: -0.07, roll: 0 },
  { name: '🙌 만세!', armL: 2.95, armR: -2.95, legL: 0.12, legR: -0.12, roll: 0 },
  { name: '🏃 달리기', armL: 2.1, armR: -0.5, legL: 0.85, legR: -0.1, roll: 0.3 },
  { name: '🤸 점핑잭', armL: 1.25, armR: -1.25, legL: 1.5, legR: -1.5, roll: 0 },
  { name: '🐸 쪼그려앉기', armL: 0.75, armR: -0.75, legL: 1.75, legR: -1.75, roll: 0, squash: 0.6 },
  { name: '💃 발레', armL: 2.5, armR: -1.9, legL: 0.06, legR: -1.6, roll: 0 },
  { name: '🦸 슈퍼맨', armL: 2.95, armR: -0.25, legL: 0.15, legR: -0.35, roll: -Math.PI / 2 },
  { name: '🛌 옆으로 눕기', armL: 0.55, armR: -0.55, legL: 0.15, legR: -0.15, roll: Math.PI / 2 },
  { name: '🙃 물구나무', armL: 2.5, armR: -2.5, legL: 0.4, legR: -0.4, roll: Math.PI },
];

function buildJelly(sizeScale = 1, cloneFrom = null) {
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
  const part = (geo, r, sx, sy) => surf.addPart(geo, r[0], r[1], r[2], r[3], sx, sy, g);

  // 몸 전체를 '늘린 구체'로 구성 — 구체 UV는 세로 밀도가 균일해서 붓이 안 늘어남
  // 몸통 (앞뒤로 납작한 젤리 타원체) — 정면 = +Z
  const torsoGeo = new THREE.SphereGeometry(1, 20, 16);
  torsoGeo.scale(0.155, 0.305, 0.102);
  part(torsoGeo, [0, 0, 0.5, 0.55], 0.82, 0.74).position.set(0, 0.62, 0);   // 둘레, 세로 호길이
  // 머리 (눈 없음!)
  const headGeo = new THREE.SphereGeometry(0.115, 16, 12);
  headGeo.scale(1, 1.08, 0.8);
  part(headGeo, [0.5, 0, 0.8, 0.3], 0.65, 0.36).position.set(0, 0.98, 0);
  // 팔다리 — 긴 타원체, 위쪽 관절 볼 중심이 회전축
  const limb = (rM, halfLen, rect, sx, sy, px2, py2) => {
    const geo = new THREE.SphereGeometry(1, 14, 12);
    geo.scale(rM, halfLen, rM * 0.75);
    geo.translate(0, -(halfLen - rM), 0);   // 관절 볼 중심 = 원점(회전축)
    const m = part(geo, rect, sx, sy);
    m.position.set(px2, py2, 0);
    return m;
  };
  // 어깨/골반을 몸통 표면 안쪽에 심어서 관절 볼이 항상 몸에 파묻힘
  const armL = limb(0.055, 0.19, [0.8, 0, 0.9, 0.42], 0.31, 0.44, 0.15, 0.77);
  const armR = limb(0.055, 0.19, [0.9, 0, 1, 0.42], 0.31, 0.44, -0.15, 0.77);
  const legL = limb(0.066, 0.235, [0.5, 0.32, 0.64, 0.8], 0.37, 0.54, 0.075, 0.42);
  const legR = limb(0.066, 0.235, [0.64, 0.32, 0.78, 0.8], 0.37, 0.54, -0.075, 0.42);
  armL.userData.limb = 'armL'; armR.userData.limb = 'armR';
  legL.userData.limb = 'legL'; legR.userData.limb = 'legR';

  g.scale.setScalar(sizeScale);
  decorGroup.add(g);
  const j = {
    group: g, surface: surf, armL, armR, legL, legR,
    baseScale: sizeScale, pose: 0, qBasis: null, customRoll: 0, squash: 1,
    worldPos: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
  };
  applyPose(j, 0);
  return j;
}

function applyPose(j, idx) {
  const p = POSES[idx];
  j.pose = idx;
  j.customRoll = p.roll;
  j.squash = p.squash || 1;
  j.group.scale.set(j.baseScale, j.baseScale * j.squash, j.baseScale);   // 젤리 찌부
  j.armL.rotation.z = p.armL; j.armR.rotation.z = p.armR;
  j.legL.rotation.z = p.legL; j.legR.rotation.z = p.legR;
  if (j.qBasis) applyAttachOrientation(j);   // 이미 붙어있으면 roll 즉시 반영
}

function applyAttachOrientation(j) {
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), j.customRoll);
  j.group.quaternion.copy(j.qBasis.clone().multiply(roll));
  // 몸 중심(로컬 y≈0.55)이 탭한 지점에 오도록 배치
  const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(j.group.quaternion);
  j.group.position.copy(j.worldPos)
    .addScaledVector(j.normal, 0.115 * j.baseScale)
    .addScaledVector(yAxis, -0.55 * j.baseScale * j.squash);
}

// 걷기 중 자세(눕기/물구나무 등)로 몸이 땅에 파묻히지 않게 들어올릴 높이
function jellyLift(j) {
  const th = j.customRoll || 0, s = j.baseScale;
  return Math.max(0, -Math.cos(th)) * 1.08 * s * j.squash + Math.abs(Math.sin(th)) * 0.18 * s;
}

// 표면에 젤리맨을 붙임: 등(-Z)을 벽에 대고, 머리는 위쪽으로
function attachJelly(j, hit) {
  const n = worldNormalOf(hit);
  const z = n.clone();
  // 바닥/천장이면 플레이어가 보던 방향을 머리 방향으로
  let up = Math.abs(n.y) > 0.9
    ? new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw))
    : new THREE.Vector3(0, 1, 0);
  up = up.clone().addScaledVector(z, -up.dot(z));
  if (up.lengthSq() < 1e-4) up.set(1, 0, 0);
  up.normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  j.qBasis = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  j.worldPos.copy(hit.point);
  j.normal.copy(n);
  applyAttachOrientation(j);
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
  p.x = clamp(p.x, -ARENA_X + r, ARENA_X - r);
  p.z = clamp(p.z, -ARENA_Z + r, ARENA_Z - r);
}

// ---------------- 게임 상태 ----------------
const DIFF = {
  easy: { sizeScale: 1.2, breath: 0.05, blinkMin: 3.5, blinkMax: 6, guesses: 12 },
  normal: { sizeScale: 1.0, breath: 0.032, blinkMin: 5, blinkMax: 8.5, guesses: 9 },
  hard: { sizeScale: 0.82, breath: 0.02, blinkMin: 7, blinkMax: 11, guesses: 7 },
};
const SEEK_TIME = 180;
const game = {
  state: 'menu',           // menu | handoff | hide | seek | reveal | result | gameover
  rounds: 4, round: 1, difficulty: 'normal',
  map: 'town',             // 'town' | 'gym'(노네임피트니스)
  hideTime: 60,            // 숨는 시간(초) — 메뉴에서 30/60/90초 방 선택
  scoreA: 0, scoreB: 0,
  hiderTeam: 'B',          // 이번 라운드에 숨는 팀
  timer: 0, guesses: 0,
  hidden: null,            // 배치 완료된 진짜 카멜레온 {group, surface, eyes, worldPos, normal}
  cham: null,              // 이번 라운드의 내 카멜레온(3D 모델)
  chamPlaced: false,
  decoys: [], decoysLeft: 3,
  placing: null,           // null | 'decoy'
  paintMode: false,
  editCam: false,          // 붙은 뒤 몸 중심 편집 카메라 (궤도 회전 가능)
  editDist: 2.2, editPanX: 0, editPanY: 0,
  editYaw: 0, editPitch: 0,   // 몸 둘레로 카메라 돌리기 (옆면/아랫면 칠하기)
  tool: 'brush', brushM: 0.05, color: '#e53e3e',
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
segWire('segTime', (v) => { game.hideTime = parseInt(v, 10); });
segWire('segMap', (v) => {
  game.map = v;
  if (game.state === 'menu') buildMap();   // 메뉴 배경 미리보기 교체
});

// ---------------- 페인트 팔레트 ----------------
// 어차피 스포이드로 찍는 게 핵심이라 프리셋은 최소한만 + 전체 색상 피커
// + 붙는 순간 주변 벽 색을 자동 추출해서 점선 스와치로 추가
const PALETTE = ['#ffffff', '#1a202c', '#8a939e', '#e53e3e', '#f6e05e', '#3182ce'];
game.nearbyColors = [];
function renderSwatches() {
  const wrap = $('swatches');
  wrap.innerHTML = '';
  const add = (c, near) => {
    const d = document.createElement('div');
    d.className = near ? 'sw near' : 'sw';
    d.style.background = c;
    d.addEventListener('click', () => {
      game.color = c; game.tool = 'brush';
      updatePaintbarUI(); sfx.click();
    });
    wrap.appendChild(d);
  };
  PALETTE.forEach((c) => add(c, false));
  game.nearbyColors.forEach((c) => add(c, true));
}
renderSwatches();
// 붙은 지점 주변에서 대표 색 추출
function buildNearbyPalette(hit) {
  const ud = hit.object.userData, s = ud.surface;
  game.nearbyColors = [];
  if (s) {
    const { x, y } = uvToPx(s, hit.uv.x, hit.uv.y);
    const cols = [];
    [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.8, 0.3], [-0.8, -0.3], [0.5, -0.5]].forEach(([ox, oy]) => {
      const px2 = clamp(Math.round(x + ox * ud.ppmX), 0, s.canvas.width - 1);
      const py2 = clamp(Math.round(y + oy * ud.ppmY), 0, s.canvas.height - 1);
      try {
        const d = s.ctx.getImageData(px2, py2, 1, 1).data;
        if (!cols.some((q) => Math.abs(q[0] - d[0]) + Math.abs(q[1] - d[1]) + Math.abs(q[2] - d[2]) < 60)) {
          cols.push([d[0], d[1], d[2]]);
        }
      } catch (e) {}
    });
    game.nearbyColors = cols.slice(0, 5).map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
    if (game.nearbyColors[0]) game.color = game.nearbyColors[0];   // 밑색 자동 세팅
  }
  renderSwatches();
}
function toHex(color) {
  const cv = toHex.cv || (toHex.cv = document.createElement('canvas').getContext('2d'));
  cv.fillStyle = color;
  return cv.fillStyle;
}
function sameColor(a, b) { return toHex(a) === toHex(b); }
function updatePaintbarUI() {
  $('colorPicker').value = toHex(game.color);
  document.querySelectorAll('.sw').forEach((s) => {
    s.classList.toggle('on', s.style.background && sameColor(s.style.background, game.color));
  });
  $('brushTool').classList.toggle('on', game.tool === 'brush');
  $('dropTool').classList.toggle('on', game.tool === 'drop');
  $('eraseTool').classList.toggle('on', game.tool === 'erase');
}
$('colorPicker').addEventListener('input', (e) => {
  game.color = e.target.value;
  game.tool = 'brush';
  updatePaintbarUI();
});
$('brushTool').addEventListener('click', () => { game.tool = 'brush'; updatePaintbarUI(); sfx.click(); });
$('dropTool').addEventListener('click', () => { game.tool = 'drop'; updatePaintbarUI(); sfx.click(); toast('💉 표면을 탭하면 색을 추출해요', 1400); });
$('eraseTool').addEventListener('click', () => { game.tool = 'erase'; updatePaintbarUI(); sfx.click(); });
$('fillTool').addEventListener('click', () => {
  if (!game.cham) return;
  sfx.click();
  pushUndo(game.cham.surface);
  const s = game.cham.surface;
  s.ctx.fillStyle = game.color;
  s.ctx.fillRect(0, 0, s.canvas.width, s.canvas.height);
  s.dirty = true;
  toast('🪣 몸 전체를 채웠어요! 이제 무늬를 그리세요', 1300);
});
$('previewTool').addEventListener('click', () => {
  if (!game.editCam) return;
  sfx.click();
  const on = game.editDist < 4;
  game.editDist = on ? 6 : 1.4;
  game.editPanX = 0; game.editPanY = 0;
  game.editYaw = 0; game.editPitch = 0;
  $('previewTool').classList.toggle('on', on);
  toast(on ? '👁️ 술래 눈에는 이렇게 보여요!' : '🎨 편집 거리로 복귀', 1200);
});
// 브러시 크기 슬라이더 (0.01m ~ 0.25m — 몸에 세밀하게 그리는 용도)
$('brushRange').addEventListener('input', (e) => {
  const v = +e.target.value;
  game.brushM = v / 100;
  const d = $('brushPreview');
  const px = clamp(v * 1.6, 5, 40);
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
function toScreen(v3) {
  const p = v3.clone().project(camera);
  return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
}
// 손가락 위치 → 팔다리 회전각(몸 평면 기준). 몸이 어떤 방향으로 붙어있든 정확함
function limbAngleFromScreen(j, limbKey, fx, fy) {
  const limb = j[limbKey];
  const joint = limb.getWorldPosition(new THREE.Vector3());
  const q = j.group.quaternion;
  const js = toScreen(joint);
  const px = toScreen(joint.clone().addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(q), 0.3));
  const py = toScreen(joint.clone().addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), 0.3));
  const A = px.x - js.x, C = px.y - js.y;   // 화면에 투영된 몸 X축
  const B = py.x - js.x, D = py.y - js.y;   // 화면에 투영된 몸 Y축
  const det = A * D - B * C;
  if (Math.abs(det) < 1e-3) return null;
  const dx = fx - js.x, dy = fy - js.y;
  const u = (D * dx - B * dy) / det;
  const v = (-C * dx + A * dy) / det;
  return Math.atan2(u, -v);
}

// 줌 (핀치/휠) — FOV 조절
function setZoom(fov) {
  camera.fov = clamp(fov, 20, 80);
  camera.updateProjectionMatrix();
}
window.addEventListener('wheel', (e) => {
  if (game.editCam && game.state === 'hide') {
    game.editDist = clamp(game.editDist + e.deltaY * 0.003, 0.55, 7);
  } else if ((game.state === 'hide' && game.paintMode) || game.state === 'seek') {
    setZoom(camera.fov + e.deltaY * 0.02);
  }
}, { passive: true });
function worldNormalOf(hit) {
  const n = hit.face.normal.clone();
  n.transformDirection(hit.object.matrixWorld);
  return n;
}

// ---------------- 그리기 ----------------
// 원작 방식: 칠은 오직 '내 카멜레온 몸'에만! 벽 색은 스포이드로 추출해서 몸에 입힘
function paintAt(hit, last, pressure = 0.5, isPen = false) {
  const mesh = hit.object, ud = mesh.userData;
  if (!ud.surface) return null;
  const s = ud.surface;
  if (!game.cham || s !== game.cham.surface) return null;   // 몸 밖은 조용히 무시
  const { x, y } = uvToPx(s, hit.uv.x, hit.uv.y);
  // 애플펜슬 필압으로 굵기 조절 (살살 = 가늘게, 꾹 = 굵게)
  const pressF = isPen ? (0.25 + clamp(pressure, 0.05, 1) * 1.5) : 1;
  // 부위별 가로/세로 픽셀 밀도가 달라서 타원으로 찍어야 표면에선 정원이 됨
  // 구체 파트는 위도에 따라 가로 둘레가 줄어들어 추가 보정 (극지방 왜곡 방지)
  let latF = 1;
  if (ud.spherical) {
    const t = (hit.uv.y - ud.v0) / (ud.v1 - ud.v0);
    latF = 1 / Math.max(0.35, Math.sin(Math.PI * clamp(t, 0, 1)));
  }
  const rX = Math.max(1.2, game.brushM * ud.ppmX * pressF * latF);
  const rY = Math.max(1.2, game.brushM * ud.ppmY * pressF);
  const r = (rX + rY) / 2;

  const ctx = s.ctx;
  const drawDot = (cx2, cy2) => {
    if (game.tool === 'erase') {
      ctx.save();
      ctx.beginPath(); ctx.ellipse(cx2, cy2, rX, rY, 0, 0, 7); ctx.clip();
      ctx.drawImage(s.base, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = game.color;
      ctx.beginPath(); ctx.ellipse(cx2, cy2, rX, rY, 0, 0, 7); ctx.fill();
    }
  };
  if (last && last.s === s) {
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    if (dist < Math.max(220, r * 8)) {
      const steps = Math.max(1, Math.ceil(dist / (Math.min(rX, rY) * 0.45)));
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
    attachJelly(game.cham, hit);
    game.chamPlaced = true;
    game.hidden = game.cham;
    $('readyBtn').disabled = false;
    $('paintModeBtn').style.opacity = 1;
    buildNearbyPalette(hit);   // 주변 벽 색 자동 추출 + 밑색 세팅
    toast('🕴️ 붙었다! 🪣로 밑색 → 무늬 그리기 (🚶 걷기로 나가기)', 2400);
    if (game.state === 'hide') enterEditCam(true);   // 벽 정면 편집 뷰 + 그리기 ON
  } else {
    // 가짜: 지금까지 칠한 내 모습 + 현재 자세(커스텀 포함)를 그대로 복제
    const decoy = buildJelly(DIFF[game.difficulty].sizeScale, game.cham.surface);
    decoy.group.traverse((o) => { o.userData.chamRole = 'decoy'; });
    applyPose(decoy, game.cham.pose);
    ['armL', 'armR', 'legL', 'legR'].forEach((k) => { decoy[k].rotation.z = game.cham[k].rotation.z; });
    decoy.customRoll = game.cham.customRoll;
    attachJelly(decoy, hit);
    game.decoys.push(decoy);
    game.decoysLeft--;
    $('decoyCount').textContent = game.decoysLeft;
    if (game.decoysLeft <= 0) $('decoyBtn').disabled = true;
    toast('🃏 가짜 젤리맨 배치! (내 모습·자세 복사)', 1400);
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
        if (game.tool === 'drop') { eyedrop(hit); p.kind = 'drop'; }   // 색만 추출, 탭으로 처리 안 함
        else {
          if (game.cham && hit.object.userData.surface === game.cham.surface) pushUndo(game.cham.surface);
          p.last = paintAt(hit, null, e.pressure, e.pointerType === 'pen');
        }
      }
    } else {
      // 두 번째 손가락 → 시점 회전/핀치 줌으로 전환
      [...pointers.values()].forEach((q) => { if (q.kind === 'paint') { q.kind = 'look'; q.last = null; } });
      p.kind = 'look';
    }
  } else {
    // 이동 모드: 왼쪽 하단 = 조이스틱 (손가락 전용, 마우스는 WASD·펜은 시점)
    if (e.pointerType === 'touch' && !game.editCam && e.clientX < window.innerWidth * 0.42 && e.clientY > window.innerHeight * 0.3 && stickPtr === null) {
      p.kind = 'stick';
      stickPtr = e.pointerId;
      p.ox = e.clientX; p.oy = e.clientY; p.vx = 0; p.vy = 0;
      stickShow(e.clientX, e.clientY);
    } else if (st === 'hide' && game.cham && !game.placing) {
      // 내 젤리맨을 직접 잡으면: 팔다리 = 관절 드래그, 몸통 = 벽 위 회전
      const hit = raycastScreen(e.clientX, e.clientY);
      if (hit && hit.object.userData.chamRole === 'real') {
        const lk = hit.object.userData.limb;
        if (lk) {
          p.kind = 'poseLimb'; p.limb = lk;
        } else if (game.cham.qBasis) {
          p.kind = 'poseRoll';
          const c = toScreen(game.cham.group.getWorldPosition(new THREE.Vector3()));
          p.cx = c.x; p.cy = c.y;
          p.a0 = Math.atan2(e.clientY - c.y, e.clientX - c.x);
          p.roll0 = game.cham.customRoll;
        }
      }
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
    if (game.editCam && game.state === 'hide') {
      if (looks.length === 1 || game.paintMode) {
        // 드래그(그리기 모드에선 두 손가락) = 몸 둘레로 돌려보기 → 옆면·아랫면 칠하기
        game.editYaw = clamp(game.editYaw + dx * 0.006 * f, -1.35, 1.35);
        game.editPitch = clamp(game.editPitch + dy * 0.005 * f, -1.1, 1.1);
      } else {
        // (이동 모드) 두 손가락 드래그 = 화면 평행이동
        const k = game.editDist * 0.0016 * f;
        game.editPanX = clamp(game.editPanX - dx * k, -1.3, 1.3);
        game.editPanY = clamp(game.editPanY + dy * k, -1.0, 1.0);
      }
    } else {
      player.yaw -= dx * 0.0038 * f;
      player.pitch = clamp(player.pitch - dy * 0.0032 * f, -1.15, 1.15);
    }
    // 두 손가락 핀치 = 확대/축소
    if (looks.length === 2 && (game.paintMode || game.editCam || game.state === 'seek')) {
      const o = looks.find((q) => q !== p);
      if (o) {
        const prevDist = Math.hypot(prevX - o.lx, prevY - o.ly);
        const newDist = Math.hypot(e.clientX - o.lx, e.clientY - o.ly);
        if (game.editCam) game.editDist = clamp(game.editDist + (newDist - prevDist) * -0.01, 0.55, 7);
        else setZoom(camera.fov + (prevDist - newDist) * 0.12);
      }
    }
  } else if (p.kind === 'paint') {
    const hit = raycastScreen(e.clientX, e.clientY, true);
    if (hit && hit.object.userData.surface) p.last = paintAt(hit, p.last, e.pressure, p.type === 'pen');
    else p.last = null;
  } else if (p.kind === 'poseLimb' && game.cham) {
    const th = limbAngleFromScreen(game.cham, p.limb, e.clientX, e.clientY);
    if (th !== null) game.cham[p.limb].rotation.z = th;
  } else if (p.kind === 'poseRoll' && game.cham) {
    const a = Math.atan2(e.clientY - p.cy, e.clientX - p.cx);
    game.cham.customRoll = p.roll0 - (a - p.a0);
    applyAttachOrientation(game.cham);
  }
});

function pointerEnd(e) {
  const p = pointers.get(e.pointerId);
  if (p && p.type === 'pen') penActive = Math.max(0, penActive - 1);
  if (!p) return;
  pointers.delete(e.pointerId);
  if (p.kind === 'stick' || e.pointerId === stickPtr) { stickPtr = null; stickHide(); }

  // 붙어있는 내 몸을 탭 → 편집 뷰로 재진입
  if (game.state === 'hide' && game.chamPlaced && !game.editCam &&
      (p.kind === 'poseLimb' || p.kind === 'poseRoll') &&
      p.moved < 12 && performance.now() - p.t0 < 420) {
    enterEditCam(false);
    return;
  }

  // 탭 판정
  const isTap = p.moved < 14 && performance.now() - p.t0 < 420 && p.kind === 'look';
  if (!isTap || game.confirmOpen) return;

  if (game.state === 'hide' && !game.paintMode) {
    // 벽/바닥/상자를 그냥 탭하면 그 자리에 붙음 (🃏 모드면 가짜 배치)
    // 그리기 모드에서는 시점 이동과 그리기만 — 탭해도 아무 반응 없음
    const hit = raycastScreen(e.clientX, e.clientY, true);
    const isDecoy = game.placing === 'decoy';
    if (hit && hit.object.userData.surface && !hit.object.userData.chamRole) {
      if (hit.point.distanceTo(player.pos) > 14) {
        if (isDecoy) toast('너무 멀어요! 좀 더 가까이 가세요', 1300);
        return;
      }
      openConfirm(isDecoy ? '🃏 가짜를 놓을까요?' : '🕴️ 여기에 붙을까요?', e.clientX, e.clientY, () => {
        placeChameleonAt(hit, !isDecoy);
        setPlacing(null);
      });
    } else if (isDecoy) toast('그릴 수 있는 표면을 탭하세요', 1200);
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
    bestDist = Math.min(bestDist, h.point.distanceTo(game.hidden.worldPos));
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

// ---------------- 숨쉬기 (눈이 없는 젤리맨의 유일한 단서) ----------------
// 진짜만 아주 가끔 '후우' 하고 몸이 미세하게 부풀었다 꺼짐
const BREATH_DUR = 1000;
function scheduleBlink() {
  const d = DIFF[game.difficulty];
  game.nextBlink = performance.now() + rand(d.blinkMin, d.blinkMax) * 1000;
}
function doBlinkStep(now) {
  const h = game.hidden;
  if (!h) return;
  if (!game.blinking && now >= game.nextBlink) {
    game.blinking = true;
    game.blinkUntil = now + BREATH_DUR;
  } else if (game.blinking) {
    const t = 1 - (game.blinkUntil - now) / BREATH_DUR;
    if (t >= 1) {
      h.group.scale.set(h.baseScale, h.baseScale * h.squash, h.baseScale);
      game.blinking = false;
      scheduleBlink();
    } else {
      const amp = DIFF[game.difficulty].breath;
      const s = 1 + Math.sin(t * Math.PI) * amp;
      h.group.scale.set(h.baseScale * s, h.baseScale * h.squash, h.baseScale * s);  // 옆으로 볼록
    }
  }
}
function restoreEyeOpen() {
  const h = game.hidden;
  if (h) h.group.scale.set(h.baseScale, h.baseScale * h.squash, h.baseScale);
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
    $('phaseLabel').textContent = `🕴️ 숨는 중 · ${teamLabel(game.hiderTeam)}`;
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
    setHint(isTouchDevice ? '🕴️ 손가락=그리기 · 옆면은 두 손가락 드래그로 돌려서! · 💉벽 색 추출' : '🕴️ 드래그=그리기 · 우클릭 드래그=돌려보기 · 💉벽 색 추출');
    updatePaintbarUI();
  } else { setHint(''); setZoom(70); }
}
function setPlacing(mode) {
  game.placing = mode;
  $('decoyBtn').classList.toggle('on', mode === 'decoy');
  if (mode) {
    setPaintModeQuiet(false);
    setHint('🃏 가짜를 붙일 곳을 탭하세요');
  } else if (!game.paintMode) setHint('');
}
function setPaintModeQuiet(on) {
  game.paintMode = on;
  $('paintModeBtn').classList.toggle('on', on);
  show('paintbar', on && game.state === 'hide');
  show('readyBtn', !on && game.state === 'hide');
}

$('paintModeBtn').addEventListener('click', () => {
  sfx.click();
  // 그리기는 붙은 뒤 편집 뷰에서만 — 어정쩡한 3인칭 그리기 방지
  if (!game.chamPlaced) { toast('👆 먼저 벽/바닥/상자를 탭해서 붙으세요!', 1600); return; }
  if (!game.editCam) { enterEditCam(true); return; }
  setPaintMode(!game.paintMode);
});

// ---------------- 자세 팔레트 (탭하면 그 자세로) ----------------
{
  const panel = $('posePanel');
  POSES.forEach((ps, i) => {
    const b = document.createElement('button');
    b.textContent = ps.name;
    b.addEventListener('click', () => {
      if (!game.cham || game.state !== 'hide') return;
      sfx.click();
      applyPose(game.cham, i);
      updatePosePanelUI();
    });
    panel.appendChild(b);
  });
}
function updatePosePanelUI() {
  [...$('posePanel').children].forEach((b, i) => b.classList.toggle('on', !!game.cham && game.cham.pose === i));
}
$('poseBtn').addEventListener('click', () => {
  if (!game.cham || game.state !== 'hide') return;
  sfx.click();
  const open = $('posePanel').classList.contains('hidden');
  show('posePanel', open);
  $('poseBtn').classList.toggle('on', open);
  if (open) updatePosePanelUI();
});

// ---------------- 편집 카메라 (붙은 뒤 벽 정면 고정 뷰) ----------------
function enterEditCam(withPaint) {
  game.editCam = true;
  game.editDist = 1.4; game.editPanX = 0; game.editPanY = 0;   // 몸이 화면에 꽉 차게
  game.editYaw = 0; game.editPitch = 0;
  $('previewTool').classList.remove('on');
  stickHide(); stickPtr = null;
  show('walkBtn', true);
  if (withPaint) setPaintMode(true);
  else setHint('드래그: 돌려보기 · 두 손가락: 이동/확대 · 팔다리 드래그: 자세 · 벽 탭: 이사');
}
function exitEditCam() {
  game.editCam = false;
  show('walkBtn', false);
  show('posePanel', false);
  $('poseBtn').classList.remove('on');
  setPaintMode(false);
  setZoom(70);
  setHint('');
}
$('walkBtn').addEventListener('click', () => { sfx.click(); exitEditCam(); });
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
    game.editCam = false;
    show('walkBtn', false); show('posePanel', false);
    $('poseBtn').classList.remove('on');
    setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null;
    setHint(''); setZoom(70);
    show('menu', true);
  });
});

function startHandoff(next) {
  game.state = 'handoff';
  game.editCam = false;
  show('walkBtn', false); show('posePanel', false);
  $('poseBtn').classList.remove('on');
  setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null;
  closeConfirm(); setHint('');
  const team = next === 'hide' ? game.hiderTeam : seekerTeam();
  $('hoEmoji').textContent = next === 'hide' ? '🎨' : '🔍';
  $('hoWho').textContent = `${teamLabel(team)} 차례`;
  const scoreLine = `<span style="color:#94a3b8">라운드 ${game.round}/${game.rounds} · 🔴 A ${game.scoreA} : ${game.scoreB} B 🔵</span><br>`;
  $('hoDesc').innerHTML = scoreLine + (next === 'hide'
    ? `기기를 <b>${team}팀</b>에게 전달하세요.<br>새하얀 젤리맨 몸을 색칠하고 자세를 잡아 벽에 붙으세요! (제한 ${fmtTime(game.hideTime)})<br><b style="color:#fca5a5">${seekerTeam() === 'A' ? 'A' : 'B'}팀(술래)은 화면을 보면 안 돼요! 🙈</b>`
    : `기기를 <b>${team}팀</b>에게 전달하세요.<br>🔫 샷건으로 진짜 젤리맨을 쏘세요! (제한 ${fmtTime(SEEK_TIME)} · 탄약 ${DIFF[game.difficulty].guesses}발)<br><b style="color:#fca5a5">빗나간 총알은 영영 소모!</b> 탄약이 다 떨어지면 숨는 팀 승리<br>💡 진짜는 아주 가끔 <b>후우~ 하고 숨을 쉬어요</b> (몸이 살짝 부풀었다 꺼짐)`);
  $('hoBtn').textContent = next === 'hide' ? '🎨 숨기 시작!' : '🔍 찾기 시작!';
  $('hoBtn').onclick = () => { sfx.click(); next === 'hide' ? beginHide() : beginSeek(); };
  show('handoff', true);
}

function beginHide() {
  show('handoff', false);
  buildMap();
  // 내 젤리맨(새하얀 몸) 생성 — 배치 전까지 플레이어를 따라다님(3인칭)
  game.cham = buildJelly(DIFF[game.difficulty].sizeScale);
  game.cham.group.traverse((o) => { o.userData.chamRole = 'real'; });
  game.chamPlaced = false;
  game.hidden = null; game.decoys = []; game.decoysLeft = 3;
  game.placing = null; game.paintMode = false;
  game.editCam = false;
  show('walkBtn', false); show('posePanel', false);
  $('poseBtn').classList.remove('on');
  game.tool = 'brush'; game.color = pick(PALETTE.slice(3));
  undoStack.length = 0;
  setZoom(70);
  $('decoyCount').textContent = '3';
  $('decoyBtn').disabled = false;
  $('readyBtn').disabled = true;
  $('paintModeBtn').style.opacity = 0.4;   // 붙기 전엔 그리기 불가 표시
  player.reset(SPAWN.x, SPAWN.z, SPAWN.yaw);
  game.timer = game.hideTime;
  game.state = 'hide';
  setPhaseUI();
  updatePaintbarUI();
  game.nearbyColors = [];
  renderSwatches();
  toast(`${teamLabel(game.hiderTeam)} — 하얀 젤리맨을 색칠해서 위장하세요!`, 2600);
  setHint('👆 벽/바닥/상자를 탭하면 그 자리에 붙어요');
  setTimeout(() => { if (game.state === 'hide' && !game.paintMode && !game.placing) setHint(''); }, 5000);
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
  player.reset(SPAWN.x, SPAWN.z, SPAWN.yaw);
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
    new THREE.RingGeometry(0.62, 0.78, 40),
    new THREE.MeshBasicMaterial({ color: 0xfde047, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
  ring.position.copy(h.worldPos).addScaledVector(h.normal, 0.14);
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.normal);
  ring.scale.setScalar(h.baseScale);
  decorGroup.add(ring);
  // 정답 앞으로 카메라 이동
  const camPos = h.worldPos.clone().addScaledVector(h.normal, 3.4);
  camPos.y = clamp(camPos.y, 1.2, 4);
  camera.position.copy(camPos);
  camera.lookAt(h.worldPos);

  if (found) { game[seekerTeam() === 'A' ? 'scoreA' : 'scoreB']++; sfx.found(); toast('🎯 찾았다!', 2000); }
  else { game[game.hiderTeam === 'A' ? 'scoreA' : 'scoreB']++; sfx.survive(); toast('🕴️ 숨기 성공!', 2000); }

  game.state = 'reveal';
  setPhaseUI(); stickHide(); pointers.clear(); stickPtr = null; closeConfirm();
  revealUntil = performance.now() + 2400;
  revealFound = found;
}
let revealFound = false;
function showResult() {
  game.state = 'result';
  const found = revealFound;
  $('resBig').textContent = found ? '🎯 찾았다!' : '🕴️ 숨기 성공!';
  const winner = found ? seekerTeam() : game.hiderTeam;
  $('resDesc').innerHTML = `라운드 ${game.round}/${game.rounds} — <b>${teamLabel(winner)}</b> 득점!<br>` +
    (found ? '술래가 젤리맨을 찾아냈어요.' : '젤리맨이 끝까지 들키지 않았어요.');
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

  if (!(st === 'hide' && game.editCam)) camera.up.set(0, 1, 0);   // 편집 뷰 외에는 기본 업벡터

  if (st === 'menu' || st === 'handoff' || st === 'result' || st === 'gameover') {
    // 회전 데모 카메라
    menuAngle += dt * 0.1;
    if (game.map === 'gym') {
      camera.position.set(Math.sin(menuAngle) * 15, 2.4, Math.cos(menuAngle) * 5.5);
      camera.lookAt(0, 1.4, 0);
    } else {
      camera.position.set(Math.sin(menuAngle) * 22, 12, Math.cos(menuAngle) * 22);
      camera.lookAt(0, 1, 0);
    }
  } else if (st === 'hide' || st === 'seek') {
    // 이동 (터치 조이스틱 + 키보드)
    let mvx = 0, mvy = 0;
    if (stickPtr !== null) {
      const p = pointers.get(stickPtr);
      if (p) { mvx = p.vx; mvy = p.vy; }
    }
    const kv = keyMoveVec();
    if (kv) { mvx += kv.x; mvy += kv.y; }
    const inEdit = st === 'hide' && game.editCam && game.chamPlaced && game.cham;
    const moving = !inEdit && !!(mvx || mvy);
    if (moving) {
      const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
      const r = new THREE.Vector3(-f.z, 0, f.x);
      player.pos.addScaledVector(f, -mvy * player.speed * dt);
      player.pos.addScaledVector(r, mvx * player.speed * dt);
      collide();
    }
    if (inEdit) {
      // 편집 뷰: 몸 중심 궤도 카메라 (드래그로 옆면·아랫면까지 돌려보며 칠하기)
      const qb = game.cham.qBasis;
      const qCam = qb.clone()
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), game.editYaw))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), game.editPitch));
      const xA = new THREE.Vector3(1, 0, 0).applyQuaternion(qb);
      const yA = new THREE.Vector3(0, 1, 0).applyQuaternion(qb);
      const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(qCam);
      const look = game.cham.worldPos.clone()
        .addScaledVector(xA, game.editPanX)
        .addScaledVector(yA, game.editPanY);
      camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(qCam));
      camera.position.copy(look).addScaledVector(dir, game.editDist);
      camera.lookAt(look);
    } else if (st === 'hide' && game.cham && !game.chamPlaced) {
      // 3인칭: 내 젤리맨이 앞에서 걸어다님
      const m = game.cham.group;
      m.position.set(
        player.pos.x,
        (moving ? Math.abs(Math.sin(now * 0.012)) * 0.07 : 0) + jellyLift(game.cham),
        player.pos.z);
      m.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), player.yaw + Math.PI);
      if (game.cham.customRoll) {
        m.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), game.cham.customRoll));
      }
      const back = new THREE.Vector3(Math.sin(player.yaw), 0, Math.cos(player.yaw));
      camera.position.set(
        player.pos.x + back.x * 2.2,
        clamp(1.55 - player.pitch * 1.5, 0.6, 3.6),
        player.pos.z + back.z * 2.2);
      camera.lookAt(m.position.x, 0.62, m.position.z);
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
    $('timer').style.color = sec <= 10 ? '#f87171' : '#fde047';
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
