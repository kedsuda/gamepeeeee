import * as THREE from 'three';
import { OBJLoader } from './vendor/OBJLoader.js';
import { MTLLoader } from './vendor/MTLLoader.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

// ===================== CONFIG =====================
const GRID = 0.5;        // collision / pathfinding cell size (world units)
const WALL_H = 3.2;
const PLAYER_H = 1.9;    // model height after normalising
const PLAYER_R = 0.55;
const GHOST_R = 0.6;
const CHASE_CELLS = 60;  // ghosts hunt you when within this path distance (cells)

const CHARACTERS = [
  {
    id: 'allmight', name: 'All Might', icon: '💪', dir: 'assets/allmight/',
    desc: 'ฮีโร่อันดับ 1 หมัดหนักที่สุด ระยะใกล้',
    hp: 160, speed: 6.2, dmg: 45, range: 2.8, arc: 1.1, atkCd: 0.5, ranged: false,
    special: 'smash', specialName: 'DETROIT SMASH!', specialCd: 6,
    stats: { hp: 0.95, atk: 1, spd: 0.6 }, color: 0xffd23f, rot: 0,
  },
  {
    id: 'commando', name: 'Super Commando', icon: '🔫', dir: 'assets/commando/',
    desc: 'ยิงระยะไกล + ระเบิดมือ',
    hp: 120, speed: 6.6, dmg: 20, atkCd: 0.2, ranged: true,
    special: 'grenade', specialName: 'GRENADE!', specialCd: 4.5,
    stats: { hp: 0.7, atk: 0.7, spd: 0.7 }, color: 0x7dff6b, rot: 0,
    // the exported weapon lies on the ground beside the feet — move it into the hands
    fix: (obj) => { const w = obj.getObjectByName('Weapon_Commando_M'); if (w) w.position.set(-1.17, 0.8, 0.3); },
  },
  {
    id: 'tuxedo', name: 'Tuxedo Sam', icon: '🐧', dir: 'assets/tuxedo/',
    desc: 'เร็วที่สุด ท่าพิเศษ ฟองสบู่ ทำให้ผีมึน + ฟื้นเลือด',
    hp: 110, speed: 8.2, dmg: 26, range: 2.4, arc: 1.3, atkCd: 0.32, ranged: false,
    special: 'bubble', specialName: 'BUBBLE BURST!', specialCd: 7,
    stats: { hp: 0.6, atk: 0.55, spd: 1 }, color: 0x5bc8ff, rot: 0,
  },
];

// what a player becomes when their multiplayer role is "ghost"
const GHOST_CH = {
  id: 'ghost', name: 'ผี', icon: '👻', hp: 150, speed: 7.4, atkCd: 1.1,
  special: 'phase', specialName: 'ทะลุกำแพง!', specialCd: 12, color: 0xc58bff, rot: 0,
};
const PVP_DMG = 0.6;      // runner damage multiplier against ghost players
const CATCH_DMG = 40;     // damage a ghost player deals when touching a runner

const GHOST_TYPES = {
  normal: { color: 0x9fd8ff, hp: 60, speed: 3.3, dmg: 12, scale: 1, score: 1 },
  fast:   { color: 0xff5d7a, hp: 40, speed: 5.0, dmg: 8, scale: 0.85, score: 2 },
  big:    { color: 0xb36bff, hp: 180, speed: 2.4, dmg: 24, scale: 1.5, score: 4 },
};

// ===================== DOM =====================
const $ = (id) => document.getElementById(id);
const canvas = $('game');

// ===================== AUDIO =====================
let actx = null;
function tone(freq, dur = 0.12, type = 'square', vol = 0.08, slide = 0) {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), actx.currentTime + dur);
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + dur);
    o.connect(g).connect(actx.destination);
    o.start(); o.stop(actx.currentTime + dur);
  } catch { /* audio not available */ }
}
const sfx = {
  punch: () => tone(160, 0.1, 'square', 0.08, -80),
  shoot: () => tone(900, 0.06, 'sawtooth', 0.04, -600),
  hit: () => tone(300, 0.08, 'triangle', 0.1, -150),
  ghostDie: () => { tone(700, 0.35, 'sine', 0.08, -600); tone(500, 0.4, 'triangle', 0.05, -400); },
  hurt: () => tone(120, 0.25, 'sawtooth', 0.12, -60),
  special: () => { tone(90, 0.5, 'sawtooth', 0.15, -60); tone(220, 0.4, 'square', 0.08, 400); },
  pickup: () => { tone(660, 0.1, 'sine', 0.1); setTimeout(() => tone(990, 0.15, 'sine', 0.1), 90); },
  key: () => { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.15, 'triangle', 0.1), i * 80)); },
  dash: () => tone(400, 0.15, 'sine', 0.06, 500),
  boom: () => { tone(60, 0.6, 'sawtooth', 0.2, -30); tone(110, 0.4, 'square', 0.1, -80); },
};

// ===================== MODEL LOADING =====================
const prototypes = {};

function fixMaterials(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (m.map) { m.map.colorSpace = THREE.SRGBColorSpace; m.alphaTest = 0.3; }
      if (m.specular) m.specular.setScalar(0.12);
      if ('shininess' in m) m.shininess = 20;
      m.side = THREE.DoubleSide;
      m.transparent = false;
    }
  });
}

function normalize(obj, height) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  obj.scale.multiplyScalar(height / size.y);
  box.setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= box.min.y;
  const wrap = new THREE.Group();
  wrap.add(obj);
  return wrap;
}

function loadCharacter(ch, onProgress) {
  return new Promise((resolve, reject) => {
    const mtl = new MTLLoader().setPath(ch.dir);
    mtl.load('model.mtl', (materials) => {
      materials.preload();
      new OBJLoader().setMaterials(materials).setPath(ch.dir).load('model.obj', (obj) => {
        fixMaterials(obj);
        ch.fix?.(obj);
        resolve(normalize(obj, PLAYER_H));
      }, (e) => e.total && onProgress(e.loaded / e.total), reject);
    }, undefined, reject);
  });
}

// ===================== RENDERER / SCENE =====================
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060c);
scene.fog = new THREE.FogExp2(0x05060c, 0.04);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight(0x7080c0, 0x151020, 0.9));
const moon = new THREE.DirectionalLight(0x8090ff, 0.5);
moon.position.set(10, 30, 5);
scene.add(moon);
const playerLight = new THREE.PointLight(0xffd9a0, 4, 24, 1);
scene.add(playerLight);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- procedural textures ----------
function canvasTex(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
const brickTex = canvasTex((g, s) => {
  g.fillStyle = '#2b2838'; g.fillRect(0, 0, s, s);
  const rows = 8, h = s / rows;
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * (s / 8);
    for (let x = -s / 4; x < s; x += s / 4) {
      const l = 30 + Math.random() * 18;
      g.fillStyle = `hsl(${250 + Math.random() * 20},14%,${l}%)`;
      g.fillRect(x + off + 2, r * h + 2, s / 4 - 4, h - 4);
    }
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(80,255,170,${Math.random() * 0.12})`;
    g.fillRect(Math.random() * s, Math.random() * s, 6 + Math.random() * 16, 3 + Math.random() * 8);
  }
});
const floorTex = canvasTex((g, s) => {
  g.fillStyle = '#18161f'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    g.fillStyle = `hsl(240,10%,${12 + Math.random() * 6}%)`;
    g.fillRect(x * s / 2 + 3, y * s / 2 + 3, s / 2 - 6, s / 2 - 6);
  }
  for (let i = 0; i < 300; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
  }
});

// ---------- shared geometries ----------
const ghostHeadGeo = new THREE.SphereGeometry(0.6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
const ghostBodyGeo = (() => {
  const g = new THREE.CylinderGeometry(0.6, 0.72, 0.95, 24, 4, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y < -0.4) p.setY(i, y + Math.sin(Math.atan2(p.getZ(i), p.getX(i)) * 7) * 0.13);
  }
  g.computeVertexNormals();
  return g;
})();
const eyeGeo = new THREE.SphereGeometry(0.14, 12, 8);
const pupilGeo = new THREE.SphereGeometry(0.07, 8, 6);
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x110011 });
const particleGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
const bulletGeo = new THREE.SphereGeometry(0.14, 8, 6);
const grenadeGeo = new THREE.SphereGeometry(0.22, 10, 8);
const heartGeo = (() => {
  const s = new THREE.Shape();
  s.moveTo(0, -0.35);
  s.bezierCurveTo(-0.1, -0.2, -0.45, -0.05, -0.45, 0.15);
  s.bezierCurveTo(-0.45, 0.4, -0.1, 0.45, 0, 0.22);
  s.bezierCurveTo(0.1, 0.45, 0.45, 0.4, 0.45, 0.15);
  s.bezierCurveTo(0.45, -0.05, 0.1, -0.2, 0, -0.35);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.15, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.05, bevelSegments: 2 });
  g.center();
  return g;
})();

// ===================== MAZE (from assets/maze/maze.glb) =====================
const MAZE_XZ = 4;              // horizontal scale applied to the maze model
const MAZE_Y = WALL_H / 2.4;    // model walls are 2.4 high
const MARGIN = 2;               // solid grid cells around the maze
let mazeSrc = null;

function loadMaze() {
  return new Promise((res, rej) => new GLTFLoader().load('assets/maze/maze.glb', (g) => res(g.scene), undefined, rej));
}

// planar UVs from world position so the brick texture isn't stretched by the non-uniform scale
function worldUV(g) {
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const nx = Math.abs(n.getX(i)), ny = Math.abs(n.getY(i)), nz = Math.abs(n.getZ(i));
    const [u, v] = ny > 0.6 ? [x, z] : nx > nz ? [z, y] : [x, y];
    uv[i * 2] = u / 3; uv[i * 2 + 1] = v / 3;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function prepGeo(o) {
  let g = o.geometry.clone();
  g.applyMatrix4(o.matrixWorld);
  if (g.index) g = g.toNonIndexed();
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// Builds the maze geometry for one level and rasterises its walls into a collision/nav grid.
// variant 0..7 rotates / mirrors the maze so each level feels different.
function buildMaze(variant) {
  const root = new THREE.Group();
  root.add(mazeSrc.clone(true));
  root.rotation.y = (variant % 4) * Math.PI / 2;
  root.scale.set(MAZE_XZ * (variant >= 4 ? -1 : 1), MAZE_Y, MAZE_XZ);
  root.updateMatrixWorld(true);

  const wallGeos = [], baseGeos = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = o.material.name;
    if (name === 'Wall_material') wallGeos.push(prepGeo(o));
    else if (name === 'Baseboard_material') baseGeos.push(prepGeo(o));
    // 'Materiale' is the model's floor plane — we draw our own floor
  });
  const box = new THREE.Box3();
  for (const g of wallGeos) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const ox = MARGIN * GRID - box.min.x, oz = MARGIN * GRID - box.min.z;
  for (const g of [...wallGeos, ...baseGeos]) { g.translate(ox, 0, oz); worldUV(g); }
  const W = box.max.x - box.min.x, D = box.max.z - box.min.z;
  const x0 = MARGIN * GRID, z0 = MARGIN * GRID, x1 = x0 + W, z1 = z0 + D;
  const cols = Math.ceil(W / GRID) + 2 * MARGIN, rows = Math.ceil(D / GRID) + 2 * MARGIN;
  const grid = new Uint8Array(rows * cols);
  const wallMark = new Uint8Array(rows * cols); // cells touched by wall geometry only
  // rasterise every wall triangle (projected onto XZ) by dense barycentric sampling
  let minR = rows, maxR = 0, minC = cols, maxC = 0; // extent of the outer wall in cells
  const mark = (x, z) => {
    // clamp so faces lying exactly on the outer boundary don't spill into the next cell
    x = Math.min(x1 - 1e-3, Math.max(x0 + 1e-3, x)); z = Math.min(z1 - 1e-3, Math.max(z0 + 1e-3, z));
    const c = Math.floor(x / GRID), r = Math.floor(z / GRID);
    if (r < 0 || c < 0 || r >= rows || c >= cols) return;
    wallMark[r * cols + c] = 1;
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minC = Math.min(minC, c); maxC = Math.max(maxC, c);
  };
  for (const g of wallGeos) {
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      const ax = p.getX(i), az = p.getZ(i), bx = p.getX(i + 1), bz = p.getZ(i + 1), cx = p.getX(i + 2), cz = p.getZ(i + 2);
      const len = Math.max(Math.hypot(bx - ax, bz - az), Math.hypot(cx - ax, cz - az), Math.hypot(cx - bx, cz - bz));
      const n = Math.max(1, Math.ceil(len / (GRID * 0.4)));
      for (let a = 0; a <= n; a++) for (let b = 0; b <= n - a; b++) {
        mark(ax + (bx - ax) * a / n + (cx - ax) * b / n, az + (bz - az) * a / n + (cz - az) * b / n);
      }
    }
  }

  // solid = wall geometry + everything outside the maze footprint
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cx = c * GRID + GRID / 2, cz = r * GRID + GRID / 2;
    grid[r * cols + c] = wallMark[r * cols + c] || cx < x0 || cx > x1 || cz < z0 || cz > z1 ? 1 : 0;
  }

  // openings in the outer wall become the entrance and the exit
  const gaps = [];
  // a real opening is open through the whole outer-wall thickness (checked two cells deep, since the
  // far walls don't line up with the grid and can be only partly marked in the outermost row)
  const scan = (fixed, isRow, inward) => {
    const fixed2 = fixed + (isRow ? inward[0] : inward[1]);
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const mid = run[(run.length / 2) | 0];
        gaps.push(isRow ? { r: fixed, c: mid, inward } : { r: mid, c: fixed, inward });
      }
      run = [];
    };
    const [k0, k1] = isRow ? [minC, maxC] : [minR, maxR];
    for (let k = k0; k <= k1; k++) {
      const open = isRow ? !wallMark[fixed * cols + k] && !wallMark[fixed2 * cols + k]
        : !wallMark[k * cols + fixed] && !wallMark[k * cols + fixed2];
      if (open) run.push(k); else flush();
    }
    flush();
  };
  scan(minR, true, [1, 0]);
  scan(maxR, true, [-1, 0]);
  scan(minC, false, [0, 1]);
  scan(maxC, false, [0, -1]);

  // walkable cells with one cell of clearance — ghosts path on these so they don't scrape walls
  const nav = new Uint8Array(rows * cols);
  for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
    let ok = 1;
    for (let dr = -1; dr <= 1 && ok; dr++) for (let dc = -1; dc <= 1; dc++) if (grid[(r + dr) * cols + c + dc]) { ok = 0; break; }
    nav[r * cols + c] = ok;
  }

  const wallGeo = mergeGeometries(wallGeos);
  const baseGeo = baseGeos.length ? mergeGeometries(baseGeos) : null;
  for (const g of [...wallGeos, ...baseGeos]) g.dispose();
  return { grid, wallMark, nav, rows, cols, gaps, wallGeo, baseGeo };
}

// ===================== GAME STATE =====================
const S = {
  state: 'menu', // menu | play | pause | over | clear
  charIdx: 0,
  level: 1, kills: 0, score: 0,
  grid: null, nav: null, rows: 0, cols: 0, dist: null, distTimer: 0, visited: null,
  levelGroup: null,
  player: null,
  ghosts: [], bullets: [], grenades: [], particles: [], effects: [], pickups: [], keys: [],
  keysGot: 0, keysNeed: 3, exit: null,
  spawnTimer: 0, ghostMax: 4,
  camYaw: 0, camPitch: 0.5, camDist: 6, shake: 0,
  msgTimer: 0,
  // multiplayer
  mode: 'solo',          // solo | mp
  role: 'runner',        // runner | ghost (mp only)
  remotes: new Map(),    // id -> other players
  mpPaused: false,
};
const keys = {};
const mouse = { left: false, right: false };

const cellCenter = (r, c) => new THREE.Vector3(c * GRID + GRID / 2, 0, r * GRID + GRID / 2);
const toCell = (x, z) => [Math.floor(z / GRID), Math.floor(x / GRID)];
function isWall(x, z) {
  const [r, c] = toCell(x, z);
  if (r < 0 || c < 0 || r >= S.rows || c >= S.cols) return true;
  return S.grid[r * S.cols + c] === 1;
}
// true if any grid cell overlapping the circle's bounding square is solid
function collides(x, z, rad) {
  const c0 = Math.floor((x - rad) / GRID), c1 = Math.floor((x + rad) / GRID);
  const r0 = Math.floor((z - rad) / GRID), r1 = Math.floor((z + rad) / GRID);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (r < 0 || c < 0 || r >= S.rows || c >= S.cols || S.grid[r * S.cols + c]) return true;
  }
  return false;
}
function moveCircle(obj, dx, dz, rad) {
  if (!collides(obj.x + dx, obj.z, rad)) obj.x += dx;
  if (!collides(obj.x, obj.z + dz, rad)) obj.z += dz;
}
function navCells() {
  const out = [];
  for (let i = 0; i < S.rows * S.cols; i++) if (S.nav[i]) out.push(i);
  return out;
}

// BFS distance (in cells) from (x,z) over the nav grid. Cells next to the start may be
// non-nav (the player can hug walls) so open cells within 3 steps are allowed too.
function bfsFrom(x, z, out) {
  const { rows, cols, grid, nav } = S;
  out.fill(-1);
  const [sr, sc] = toCell(x, z);
  if (sr < 0 || sc < 0 || sr >= rows || sc >= cols) return out;
  const q = new Int32Array(rows * cols);
  let h = 0, t = 0;
  out[sr * cols + sc] = 0; q[t++] = sr * cols + sc;
  while (h < t) {
    const i = q[h++], r = (i / cols) | 0, c = i % cols, d = out[i];
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc, j = nr * cols + nc;
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols || out[j] !== -1) continue;
      if (!(nav[j] || (d < 3 && !grid[j]))) continue;
      out[j] = d + 1; q[t++] = j;
    }
  }
  return out;
}
const computeDist = () => bfsFrom(S.player.x, S.player.z, S.dist);

// ===================== LEVEL BUILD =====================
const wallMat = new THREE.MeshStandardMaterial({ map: brickTex, roughness: 0.85, color: 0xc8b8f0, side: THREE.DoubleSide });
const baseMat = new THREE.MeshStandardMaterial({ color: 0x2a2440, roughness: 0.6, side: THREE.DoubleSide });

function clearLevel() {
  if (S.levelGroup) {
    scene.remove(S.levelGroup);
    S.levelGroup.traverse((o) => {
      if (o.userData.disposable) { o.geometry.dispose(); }
    });
  }
  S.ghosts = []; S.bullets = []; S.grenades = []; S.particles = []; S.effects = []; S.pickups = []; S.keys = [];
  for (const r of S.remotes.values()) r.label.material.map.dispose();
  S.remotes.clear();
  document.querySelectorAll('.floater').forEach((f) => f.remove());
  floaters.length = 0;
}

// deterministic PRNG so every multiplayer client places keys/hearts identically
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildLevel() {
  clearLevel();
  const mp = S.mode === 'mp';
  // own PRNG (three.js also draws from Math.random for object UUIDs, which would desync clients)
  const rnd = mp ? mulberry32(NET.seed) : Math.random;
  const M = buildMaze(mp ? NET.variant : (S.level - 1) % 8);
  Object.assign(S, { grid: M.grid, wallMark: M.wallMark, nav: M.nav, rows: M.rows, cols: M.cols, gaps: M.gaps });
  const NC = M.rows * M.cols;
  S.dist = new Int16Array(NC);
  S.visited = new Uint8Array(NC);
  S.keysGot = 0; S.keysNeed = 3;
  S.ghostMax = Math.min(3 + S.level * 2, 12);
  S.spawnTimer = 4;
  const lg = new THREE.Group();
  S.levelGroup = lg;
  scene.add(lg);

  // floor (extends past the maze so the outside doesn't look like a void)
  const fw = M.cols * GRID + 30, fd = M.rows * GRID + 30;
  const fGeo = new THREE.PlaneGeometry(fw, fd);
  const ft = floorTex.clone(); ft.needsUpdate = true; ft.repeat.set(fw / 2, fd / 2);
  const floor = new THREE.Mesh(fGeo, new THREE.MeshStandardMaterial({ map: ft, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(M.cols * GRID / 2, 0, M.rows * GRID / 2);
  floor.userData.disposable = true;
  lg.add(floor);

  const walls = new THREE.Mesh(M.wallGeo, wallMat);
  walls.userData.disposable = true;
  lg.add(walls);
  if (M.baseGeo) {
    const base = new THREE.Mesh(M.baseGeo, baseMat);
    base.userData.disposable = true;
    lg.add(base);
  }

  // entrance / exit: the pair of outer-wall gaps that are furthest apart by path
  const probe = new Int16Array(NC);
  const stepIn = (gp, n) => cellCenter(gp.r + gp.inward[0] * n, gp.c + gp.inward[1] * n);
  let start, exitPos, startGap = null;
  if (M.gaps.length >= 2) {
    let best = -1;
    for (const a of M.gaps) {
      const pa = stepIn(a, 3);
      bfsFrom(pa.x, pa.z, probe);
      for (const b of M.gaps) {
        if (a === b) continue;
        const pb = stepIn(b, 3);
        const [br, bc] = toCell(pb.x, pb.z);
        const d = probe[br * M.cols + bc];
        if (d > best) { best = d; start = pa; exitPos = stepIn(b, 1); startGap = a; }
      }
    }
  }
  if (!start) {
    // no usable openings: start in the first nav cell, exit at the furthest reachable one
    const cells = navCells();
    start = cellCenter((cells[0] / M.cols) | 0, cells[0] % M.cols);
    bfsFrom(start.x, start.z, probe);
    let far = cells[0];
    for (const i of cells) if (probe[i] > probe[far]) far = i;
    exitPos = cellCenter((far / M.cols) | 0, far % M.cols);
  }

  // ghost players start deep inside: the nav cell furthest from both the start and the exit
  bfsFrom(start.x, start.z, probe);
  const fromExit = bfsFrom(exitPos.x, exitPos.z, new Int16Array(NC));
  let gs = -1, gsBest = -1;
  for (const i of navCells()) {
    const v = Math.min(probe[i], fromExit[i]);
    if (v > gsBest) { gsBest = v; gs = i; }
  }
  S.ghostSpawn = gs >= 0 ? cellCenter((gs / M.cols) | 0, gs % M.cols) : exitPos.clone();
  S.startPos = start;

  // player
  const ghostRole = mp && S.role === 'ghost';
  const ch = ghostRole ? GHOST_CH : CHARACTERS[S.charIdx];
  const { pivot, anim, mat: avatarMat } = makeAvatar(ghostRole ? 'ghost' : 'runner', ch.id);
  lg.add(pivot);
  const prevHp = S.player && S.level > 1 ? S.player.hp : ch.hp;
  const spawn = ghostRole ? S.ghostSpawn : start;
  S.player = {
    ch, x: spawn.x, z: spawn.z, pivot, anim, avatarMat,
    hp: mp ? NET.me.hp : Math.min(ch.hp, S.level > 1 ? prevHp + 40 : ch.hp), maxHp: mp ? NET.me.maxHp : ch.hp,
    atkCd: 0, spCd: 0, dashCd: 0, dashT: 0, invuln: 0, kx: 0, kz: 0,
    atkAnim: 0, walk: 0, moving: false,
    stun: 0, phaseT: 0, lungeT: 0, catchCd: 0, banished: 0,
  };
  // face into the maze (forward = (sin yaw, cos yaw) in x/z; inward = [dRow, dCol])
  S.camYaw = startGap && !ghostRole ? Math.atan2(startGap.inward[1], startGap.inward[0]) : 0;
  S.camPitch = 0.5;
  S.snapCam = true;
  playerLight.color.setHex(ghostRole ? GHOST_CH.color : 0xffd9a0);

  // exit portal
  const portal = new THREE.Group();
  const ringMat = new THREE.MeshStandardMaterial({ color: 0xff3355, emissive: 0xff2244, emissiveIntensity: 1.5 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.13, 12, 40), ringMat);
  ring.userData.disposable = true;
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xff2244, transparent: true, opacity: 0.35, side: THREE.DoubleSide });
  const core = new THREE.Mesh(new THREE.CircleGeometry(1.0, 32), coreMat);
  core.userData.disposable = true;
  portal.add(ring, core);
  portal.position.set(exitPos.x, 1.4, exitPos.z);
  const plight = new THREE.PointLight(0xff2244, 3, 12, 1);
  plight.position.y = 0.5;
  portal.add(plight);
  lg.add(portal);
  S.exit = { x: exitPos.x, z: exitPos.z, portal, ring, ringMat, coreMat, plight, open: false };

  // keys: spread out (farthest-point sampling) and away from the start and the exit
  bfsFrom(start.x, start.z, S.dist);
  const [er, ec] = toCell(exitPos.x, exitPos.z);
  const cand = navCells().filter((i) => S.dist[i] > 16 && Math.hypot(((i / M.cols) | 0) - er, (i % M.cols) - ec) > 8);
  const pos = (i) => cellCenter((i / M.cols) | 0, i % M.cols);
  const picks = [];
  const anchors = [start, exitPos];
  for (let k = 0; k < S.keysNeed && cand.length; k++) {
    let best = null, bd = -1;
    for (let j = 0; j < cand.length; j += 3) {
      const p = pos(cand[j]);
      const d = Math.min(...[...anchors, ...picks].map((a) => Math.hypot(a.x - p.x, a.z - p.z))) + rnd() * 2;
      if (d > bd) { bd = d; best = p; }
    }
    picks.push(best);
  }
  for (const p of picks) S.keys.push(makeKey(p.x, p.z));
  // hearts at random spots
  for (let k = 0; k < (mp ? 5 : Math.min(2 + S.level, 6)) && cand.length; k++) {
    const p = pos(cand[(rnd() * cand.length) | 0]);
    S.pickups.push(makeHeart(p.x, p.z));
  }

  if (mp) {
    for (const p of NET.gamePlayers) if (p.id !== NET.id) addRemote(p);
    if (ghostRole) S.visited.fill(1); // ghosts know the whole maze
    updateHud();
    return;
  }

  // initial ghosts
  for (let i = 0; i < Math.ceil(S.ghostMax * 0.6); i++) spawnGhost(24);

  updateHud();
  showMsg(`ด่าน ${S.level} — เก็บกุญแจ 🗝️ ${S.keysNeed} ดอก แล้วไปที่ประตูมิติ!`, 3.5);
}

// player model: the chosen character for runners, a ghost for ghost players
function makeAvatar(role, charId) {
  const pivot = new THREE.Group();
  const anim = new THREE.Group();
  pivot.add(anim);
  if (role === 'ghost') {
    const { group, mat } = makeGhostMesh(GHOST_CH.color);
    group.scale.setScalar(1.25);
    group.position.y = 0.3;
    anim.add(group);
    return { pivot, anim, mat };
  }
  anim.add(prototypes[charId].clone());
  return { pivot, anim, mat: null };
}

function makeKey(x, z) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffaa00, emissiveIntensity: 0.9, metalness: 0.6, roughness: 0.3 });
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.07, 8, 20), mat);
  bow.position.y = 0.3;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.6, 0.09), mat);
  shaft.position.y = -0.15;
  const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.09), mat);
  tooth.position.set(0.1, -0.35, 0);
  for (const o of [bow, shaft, tooth]) { o.userData.disposable = true; g.add(o); }
  const light = new THREE.PointLight(0xffc040, 1.5, 6, 1);
  g.add(light);
  g.position.set(x, 1.2, z);
  S.levelGroup.add(g);
  return { x, z, mesh: g };
}

function makeHeart(x, z) {
  const mesh = new THREE.Mesh(heartGeo, new THREE.MeshStandardMaterial({ color: 0xff3355, emissive: 0xff1133, emissiveIntensity: 0.7 }));
  mesh.position.set(x, 1, z);
  S.levelGroup.add(mesh);
  return { x, z, mesh };
}

// ===================== GHOSTS =====================
function pickGhostType() {
  const r = Math.random();
  if (S.level >= 2 && r < 0.12 + S.level * 0.03) return 'big';
  if (r < 0.4) return 'fast';
  return 'normal';
}

function makeGhostMesh(color) {
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.55, transparent: true, opacity: 0.82,
    roughness: 0.4, side: THREE.DoubleSide,
  });
  const g = new THREE.Group();
  const head = new THREE.Mesh(ghostHeadGeo, mat); head.position.y = 0.95;
  const body = new THREE.Mesh(ghostBodyGeo, mat); body.position.y = 0.48;
  g.add(head, body);
  for (const sx of [-0.22, 0.22]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat); e.position.set(sx, 1.1, 0.48);
    const pu = new THREE.Mesh(pupilGeo, pupilMat); pu.position.set(sx, 1.1, 0.6);
    g.add(e, pu);
  }
  return { group: g, mat };
}

function spawnGhost(minDist = 6) {
  computeDist();
  let cand = navCells().filter((i) => S.dist[i] >= minDist);
  if (!cand.length) cand = navCells().filter((i) => S.dist[i] >= 8);
  if (!cand.length) return;
  const i = cand[(Math.random() * cand.length) | 0];
  const r = (i / S.cols) | 0, c = i % S.cols;
  const typeKey = pickGhostType();
  const t = GHOST_TYPES[typeKey];
  const p = cellCenter(r, c);
  const { group: g, mat } = makeGhostMesh(t.color);
  const inner = new THREE.Group(); inner.add(g);
  inner.scale.setScalar(t.scale * 0.01);
  inner.position.set(p.x, 0, p.z);
  S.levelGroup.add(inner);
  S.ghosts.push({
    type: typeKey, t, mesh: inner, mat, x: p.x, z: p.z, hp: t.hp * (1 + (S.level - 1) * 0.15), maxHp: t.hp,
    kx: 0, kz: 0, stun: 0, flash: 0, atkCd: 0, phase: Math.random() * 10, yaw: 0,
    wanderDir: Math.random() * Math.PI * 2, wanderT: 0, spawnT: 0, dying: 0, rad: GHOST_R * t.scale,
  });
}

function damageGhost(g, dmg, kx = 0, kz = 0, stun = 0.15) {
  if (g.remote) return hitRemote(g, dmg, kx, kz, stun);
  if (g.dying) return;
  g.hp -= dmg;
  g.kx += kx; g.kz += kz;
  g.stun = Math.max(g.stun, stun);
  g.flash = 0.15;
  addFloater(g.x, 1.8 * g.t.scale, g.z, `-${Math.round(dmg)}`, '#ffe066');
  burst(g.x, 1, g.z, g.t.color, 6);
  sfx.hit();
  if (g.hp <= 0) {
    g.dying = 0.5;
    S.kills++; S.score += g.t.score * 10;
    sfx.ghostDie();
    burst(g.x, 1, g.z, g.t.color, 22, 6);
    burst(g.x, 1, g.z, 0xffffff, 10, 4);
    updateHud();
  }
}

function updateGhosts(dt) {
  const P = S.player;
  for (const g of S.ghosts) {
    g.phase += dt;
    if (g.spawnT < 1) { g.spawnT = Math.min(1, g.spawnT + dt * 1.5); }
    const sc = g.t.scale * (g.dying ? Math.max(0.01, g.dying * 2) : Math.max(0.01, g.spawnT));
    g.mesh.scale.setScalar(sc);
    if (g.dying) {
      g.dying -= dt;
      g.mesh.position.y += dt * 3;
      g.mat.opacity = Math.max(0, g.dying * 1.6);
      continue;
    }
    // flash
    g.flash -= dt;
    g.mat.emissive.setHex(g.flash > 0 ? 0xffffff : g.t.color);
    g.mat.emissiveIntensity = g.flash > 0 ? 1.5 : (g.stun > 0.3 ? 0.2 : 0.55);

    // knockback
    if (Math.abs(g.kx) + Math.abs(g.kz) > 0.01) {
      moveCircle(g, g.kx * dt, g.kz * dt, g.rad * 0.8);
      g.kx *= Math.pow(0.02, dt); g.kz *= Math.pow(0.02, dt);
    }
    g.atkCd -= dt;
    if (g.stun > 0) { g.stun -= dt; g.mesh.rotation.z = Math.sin(g.phase * 20) * 0.2; }
    else if (g.spawnT >= 1) {
      g.mesh.rotation.z = 0;
      const dx = P.x - g.x, dz = P.z - g.z;
      const d = Math.hypot(dx, dz);
      const [gr, gc] = toCell(g.x, g.z);
      const gd = S.dist[gr * S.cols + gc];
      let tx, tz, chasing = true;
      const speed = g.t.speed * (1 + (S.level - 1) * 0.06);
      if (d < 2.5 || (gd >= 0 && gd <= 4)) { tx = P.x; tz = P.z; }
      else {
        // follow the BFS gradient (8 neighbours); also recovers ghosts pushed off the nav grid
        let best = null;
        let bd = gd >= 0 && gd <= CHASE_CELLS ? gd : (gd < 0 ? Infinity : -1);
        if (bd !== -1) {
          for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const nr = gr + dr, nc = gc + dc;
            if (nr < 0 || nc < 0 || nr >= S.rows || nc >= S.cols) continue;
            // no corner cutting
            if (dr && dc && (S.grid[(gr + dr) * S.cols + gc] || S.grid[gr * S.cols + gc + dc])) continue;
            const v = S.dist[nr * S.cols + nc];
            if (v >= 0 && v < bd) { bd = v; best = [nr, nc]; }
          }
        }
        if (best) { const p = cellCenter(best[0], best[1]); tx = p.x; tz = p.z; }
        else {
          // out of range: drift around, turning when blocked or bored
          chasing = false;
          g.wanderT -= dt;
          if (g.wanderT <= 0) { g.wanderDir = Math.random() * Math.PI * 2; g.wanderT = 1.5 + Math.random() * 2; }
          tx = g.x + Math.sin(g.wanderDir); tz = g.z + Math.cos(g.wanderDir);
          if (collides(tx, tz, g.rad)) g.wanderT = 0;
        }
      }
      if (tx !== undefined) {
        const mx = tx - g.x, mz = tz - g.z, ml = Math.hypot(mx, mz);
        if (ml > 0.05) {
          const sp = Math.min(ml, speed * dt * (chasing ? 1 : 0.5));
          moveCircle(g, (mx / ml) * sp, (mz / ml) * sp, g.rad * 0.8);
          g.yaw = lerpAngle(g.yaw, Math.atan2(mx, mz), 1 - Math.pow(0.001, dt));
        }
      }
      // attack player
      const reach = PLAYER_R + g.rad + 0.15;
      if (d < reach && g.atkCd <= 0) {
        g.atkCd = 1.0;
        hurtPlayer(g.t.dmg * (1 + (S.level - 1) * 0.1), dx / (d || 1), dz / (d || 1));
      }
    }
    // separation from other ghosts
    for (const o of S.ghosts) {
      if (o === g || o.dying) continue;
      const sx = g.x - o.x, sz = g.z - o.z, sd = Math.hypot(sx, sz), min = g.rad + o.rad;
      if (sd > 0.001 && sd < min) moveCircle(g, (sx / sd) * (min - sd) * 0.5, (sz / sd) * (min - sd) * 0.5, g.rad * 0.8);
    }
    g.mesh.position.set(g.x, 0.25 + Math.sin(g.phase * 3) * 0.15, g.z);
    g.mesh.rotation.y = g.yaw;
  }
  S.ghosts = S.ghosts.filter((g) => {
    if (g.dying !== 0 && g.dying <= 0) { S.levelGroup.remove(g.mesh); g.mat.dispose(); return false; }
    return true;
  });

  // respawn
  S.spawnTimer -= dt;
  const alive = S.ghosts.filter((g) => !g.dying).length;
  if (S.spawnTimer <= 0 && alive < S.ghostMax) {
    spawnGhost(7);
    S.spawnTimer = Math.max(2.5, 7 - S.level * 0.6);
  }
}

function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ===================== PLAYER =====================
function hurtPlayer(dmg, nx, nz) {
  const P = S.player;
  if (P.invuln > 0 || P.dashT > 0 || S.state !== 'play') return;
  P.hp -= dmg;
  P.invuln = 0.8;
  P.kx += nx * 9; P.kz += nz * 9;
  S.shake = 0.35;
  sfx.hurt();
  addFloater(P.x, 2.2, P.z, `-${Math.round(dmg)}`, '#ff4d6d');
  $('hurt').style.opacity = 1;
  setTimeout(() => ($('hurt').style.opacity = 0), 180);
  updateHud();
  if (P.hp <= 0) {
    P.hp = 0;
    gameOver();
  }
}

function forward() { return new THREE.Vector3(Math.sin(S.camYaw), 0, Math.cos(S.camYaw)); }

// things the local player's attacks can hit: AI ghosts in solo, the opposing team in multiplayer
function enemies() {
  if (S.mode !== 'mp') return S.ghosts;
  const out = [];
  for (const r of S.remotes.values()) if (r.role !== S.role && !r.banished) out.push(r);
  return out;
}
const dmgMul = () => (S.mode === 'mp' ? PVP_DMG : 1);

function spawnBullet(x, z, yaw, dmg, live) {
  const mesh = new THREE.Mesh(bulletGeo, new THREE.MeshBasicMaterial({ color: 0xbaff6b }));
  const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  mesh.position.set(x + dir.x * 0.9, 0.85, z + dir.z * 0.9);
  S.levelGroup.add(mesh);
  S.bullets.push({ mesh, dir, life: 1.2, dmg, live });
}

function attack() {
  const P = S.player, ch = P.ch;
  if (P.atkCd > 0) return;
  P.atkCd = ch.atkCd;
  P.atkAnim = 1;
  if (ch.id === 'ghost') { // lunge forward to grab
    P.lungeT = 0.3;
    sfx.dash();
    sendFx({ k: 'lunge' });
    return;
  }
  const f = forward();
  if (ch.ranged) {
    sfx.shoot();
    const yaw = S.camYaw + (Math.random() - 0.5) * 0.05;
    spawnBullet(P.x, P.z, yaw, ch.dmg * dmgMul(), true);
    sendFx({ k: 'shoot', x: P.x, z: P.z, yaw });
    return;
  }
  sfx.punch();
  swingEffect(P.x, P.z, S.camYaw, ch.range, ch.color);
  sendFx({ k: 'swing', x: P.x, z: P.z, yaw: S.camYaw, range: ch.range, color: ch.color });
  for (const g of enemies()) {
    if (g.dying || g.spawnT < 1) continue;
    const dx = g.x - P.x, dz = g.z - P.z, d = Math.hypot(dx, dz);
    if (d > ch.range + g.rad) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / (d || 1))));
    if (ang < ch.arc || d < 0.9) damageGhost(g, ch.dmg * dmgMul(), (dx / (d || 1)) * 10, (dz / (d || 1)) * 10, 0.25);
  }
}

function special() {
  const P = S.player, ch = P.ch;
  if (P.spCd > 0) return;
  P.spCd = ch.specialCd;
  P.atkAnim = 1.4;
  showMsg(ch.specialName, 1.2);
  if (ch.special === 'phase') {
    P.phaseT = 3;
    tone(200, 0.6, 'sine', 0.1, 500);
    sendFx({ k: 'phase' });
    return;
  }
  sfx.special();
  specialFx(ch.special, P.x, P.z, S.camYaw, true);
  sendFx({ k: 'special', s: ch.special, x: P.x, z: P.z, yaw: S.camYaw });
}

// visuals for a character special; `live` = cast by the local player, so it also deals damage
function specialFx(kind, x, z, yaw, live) {
  const P = S.player;
  const f = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  const targets = live ? enemies() : [];
  if (kind === 'smash') {
    if (live) S.shake = 0.6;
    ringEffect(x + f.x * 2, z + f.z * 2, 0xffd23f, 7, 0.5);
    for (let i = 1; i <= 4; i++) burst(x + f.x * i * 1.6, 1, z + f.z * i * 1.6, 0xffe066, 10, 7);
    for (const g of targets) {
      if (g.dying) continue;
      const dx = g.x - x, dz = g.z - z, d = Math.hypot(dx, dz);
      const ang = Math.acos(Math.max(-1, Math.min(1, (dx * f.x + dz * f.z) / (d || 1))));
      if (d < 8.5 && (ang < 0.75 || d < 2.2)) damageGhost(g, 110 * dmgMul(), (dx / d) * 28, (dz / d) * 28, 1);
    }
  } else if (kind === 'grenade') {
    const mesh = new THREE.Mesh(grenadeGeo, new THREE.MeshStandardMaterial({ color: 0x335522, emissive: 0x88ff44, emissiveIntensity: 0.5 }));
    mesh.position.set(x + f.x * 0.6, 1.4, z + f.z * 0.6);
    S.levelGroup.add(mesh);
    S.grenades.push({ mesh, vx: f.x * 11, vy: 5.5, vz: f.z * 11, life: 1.3, live });
  } else if (kind === 'bubble') {
    ringEffect(x, z, 0x9fe6ff, 7, 0.6);
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 5;
      burst(x + Math.cos(a) * r, 0.5 + Math.random() * 2, z + Math.sin(a) * r, 0xbff3ff, 1, 1.5);
    }
    if (!live) return;
    if (S.mode === 'mp') netSend({ t: 'heal', amt: 25 }); // floater shows when the server confirms
    else { P.hp = Math.min(P.maxHp, P.hp + 25); addFloater(P.x, 2.4, P.z, '+25', '#6bff9a'); }
    for (const g of targets) {
      if (g.dying) continue;
      const dx = g.x - x, dz = g.z - z, d = Math.hypot(dx, dz);
      if (d < 7) damageGhost(g, 35 * dmgMul(), (dx / (d || 1)) * 12, (dz / (d || 1)) * 12, 3.5);
    }
    updateHud();
  }
}

function explode(x, y, z, live = true) {
  sfx.boom();
  if (live) S.shake = 0.5;
  ringEffect(x, z, 0xffa040, 5, 0.5);
  burst(x, y + 0.5, z, 0xffa040, 30, 9);
  burst(x, y + 0.5, z, 0x555555, 15, 5);
  if (!live) return;
  for (const g of enemies()) {
    if (g.dying) continue;
    const dx = g.x - x, dz = g.z - z, d = Math.hypot(dx, dz);
    if (d < 4.8) damageGhost(g, 90 * (1 - d / 8) * dmgMul(), (dx / (d || 1)) * 18, (dz / (d || 1)) * 18, 0.8);
  }
}

function updatePlayer(dt) {
  const P = S.player, ch = P.ch;
  const mp = S.mode === 'mp', isGhost = ch.id === 'ghost';
  P.atkCd -= dt; P.spCd -= dt; P.dashCd -= dt; P.invuln -= dt; P.dashT -= dt;
  P.stun -= dt; P.lungeT -= dt; P.catchCd -= dt; P.banished -= dt;
  if (P.phaseT > 0) {
    P.phaseT -= dt;
    // never end a phase inside a wall
    if (P.phaseT <= 0 && collides(P.x, P.z, PLAYER_R)) P.phaseT = 0.05;
  }
  const held = mp && isGhost && performance.now() < S.releaseAt; // runners' head start
  const canAct = !S.mpPaused && P.banished <= 0 && P.stun <= 0 && !held;
  const mover = P.phaseT > 0 ? freeMove : moveCircle;

  // camera rotation via keys
  if (keys['ArrowLeft']) S.camYaw += dt * 2.5;
  if (keys['ArrowRight']) S.camYaw -= dt * 2.5;

  let fx = 0, fz = 0;
  const f = forward();
  const right = new THREE.Vector3(-f.z, 0, f.x); // screen right
  if (canAct) {
    if (keys['KeyW'] || keys['ArrowUp']) { fx += f.x; fz += f.z; }
    if (keys['KeyS'] || keys['ArrowDown']) { fx -= f.x; fz -= f.z; }
    if (keys['KeyD']) { fx += right.x; fz += right.z; }
    if (keys['KeyA']) { fx -= right.x; fz -= right.z; }
  }
  if (P.lungeT > 0 && canAct) { fx = f.x; fz = f.z; }
  const len = Math.hypot(fx, fz);
  P.moving = len > 0;
  let speed = ch.speed;
  if (P.dashT > 0) speed *= 3;
  if (P.lungeT > 0) speed *= 2.6;
  if (len > 0) { fx /= len; fz /= len; mover(P, fx * speed * dt, fz * speed * dt, PLAYER_R); }
  if (canAct && (keys['ShiftLeft'] || keys['ShiftRight']) && P.dashCd <= 0) {
    P.dashCd = 1.2; P.dashT = 0.22; sfx.dash();
    burst(P.x, 0.5, P.z, 0xffffff, 8, 2);
  }
  // knockback
  if (Math.abs(P.kx) + Math.abs(P.kz) > 0.01) {
    mover(P, P.kx * dt, P.kz * dt, PLAYER_R);
    P.kx *= Math.pow(0.01, dt); P.kz *= Math.pow(0.01, dt);
  }

  if (canAct && (mouse.left || keys['KeyJ'] || keys['Space'])) attack();
  if (canAct && (mouse.right || keys['KeyK'])) special();

  // ghost players catch runners by touching them
  if (mp && isGhost && canAct && P.catchCd <= 0) {
    for (const r of enemies()) {
      const dx = r.x - P.x, dz = r.z - P.z, d = Math.hypot(dx, dz);
      if (d < PLAYER_R + 0.8 + (P.lungeT > 0 ? 0.5 : 0)) {
        P.catchCd = 0.8;
        hitRemote(r, CATCH_DMG, (dx / (d || 1)) * 10, (dz / (d || 1)) * 10, 0);
        break;
      }
    }
  }

  // visual
  P.walk += dt * (P.moving ? speed * 1.6 : 0);
  P.atkAnim = Math.max(0, P.atkAnim - dt * 5);
  P.pivot.position.set(P.x, 0, P.z);
  P.pivot.rotation.y = S.camYaw + ch.rot;
  const bob = isGhost ? Math.sin(performance.now() / 300) * 0.15
    : P.moving ? Math.abs(Math.sin(P.walk)) * 0.12 : Math.sin(performance.now() / 500) * 0.02;
  P.anim.position.set(0, bob, Math.sin(Math.min(1, P.atkAnim) * Math.PI) * 0.5);
  P.anim.rotation.z = P.stun > 0 ? Math.sin(performance.now() / 40) * 0.2 : P.moving ? Math.sin(P.walk) * 0.06 : 0;
  P.anim.rotation.x = P.dashT > 0 || P.lungeT > 0 ? 0.35 : Math.sin(Math.min(1, P.atkAnim) * Math.PI) * 0.18;
  P.pivot.visible = P.banished > 0 ? false : P.invuln > 0 ? Math.floor(P.invuln * 20) % 2 === 0 : true;
  if (P.avatarMat) P.avatarMat.opacity = P.phaseT > 0 ? 0.3 : 0.82;
  playerLight.position.set(P.x, 2.8, P.z);
  if (mp) sendState(dt);

  // visited cells for minimap
  const [pr, pc] = toCell(P.x, P.z);
  for (let r = pr - 7; r <= pr + 7; r++) for (let c = pc - 7; c <= pc + 7; c++) {
    if (r >= 0 && c >= 0 && r < S.rows && c < S.cols) S.visited[r * S.cols + c] = 1;
  }

  // pickups
  for (const k of S.keys) {
    if (k.got) continue;
    k.mesh.rotation.y += dt * 2;
    k.mesh.position.y = 1.2 + Math.sin(performance.now() / 300 + k.x) * 0.15;
    if (mp) {
      // the server decides who got it; retry if no answer within a second
      if (!isGhost && Math.hypot(k.x - P.x, k.z - P.z) < 1.2 && !(performance.now() - (k.asked || -1e9) < 1000)) {
        k.asked = performance.now();
        netSend({ t: 'pick', kind: 'key', idx: S.keys.indexOf(k) });
      }
      continue;
    }
    if (Math.hypot(k.x - P.x, k.z - P.z) < 1.2) {
      k.got = true; S.keysGot++;
      S.levelGroup.remove(k.mesh);
      sfx.key();
      burst(k.x, 1.2, k.z, 0xffd23f, 20, 4);
      if (S.keysGot >= S.keysNeed) {
        openExit();
        showMsg('ประตูมิติเปิดแล้ว! ไปที่จุดสีเขียวบนแผนที่!', 3);
      } else showMsg(`ได้กุญแจ ${S.keysGot}/${S.keysNeed}`, 1.5);
      updateHud();
    }
  }
  for (const h of S.pickups) {
    if (h.got) continue;
    h.mesh.rotation.y += dt * 2;
    if (mp) {
      if (!isGhost && Math.hypot(h.x - P.x, h.z - P.z) < 1.1 && P.hp < P.maxHp && !(performance.now() - (h.asked || -1e9) < 1000)) {
        h.asked = performance.now();
        netSend({ t: 'pick', kind: 'heart', idx: S.pickups.indexOf(h) });
      }
      continue;
    }
    if (Math.hypot(h.x - P.x, h.z - P.z) < 1.1 && P.hp < P.maxHp) {
      h.got = true; S.levelGroup.remove(h.mesh);
      P.hp = Math.min(P.maxHp, P.hp + 35);
      sfx.pickup(); addFloater(P.x, 2.2, P.z, '+35', '#6bff9a');
      updateHud();
    }
  }
  // exit
  const E = S.exit;
  E.ring.rotation.z += dt * (E.open ? 3 : 0.6);
  E.portal.rotation.y = Math.atan2(P.x - E.x, P.z - E.z);
  if (E.open && Math.hypot(E.x - P.x, E.z - P.z) < 1.5) {
    if (!mp) levelClear();
    else if (!isGhost && !(performance.now() - (S.exitAsked || -1e9) < 1000)) {
      S.exitAsked = performance.now();
      netSend({ t: 'exit' });
    }
  }
}

// movement that ignores walls (ghost phase), kept inside the maze bounds
function freeMove(obj, dx, dz) {
  obj.x = Math.max(1, Math.min(S.cols * GRID - 1, obj.x + dx));
  obj.z = Math.max(1, Math.min(S.rows * GRID - 1, obj.z + dz));
}

// ===================== PROJECTILES & FX =====================
function updateProjectiles(dt) {
  for (const b of S.bullets) {
    b.life -= dt;
    const step = 24 * dt;
    b.mesh.position.addScaledVector(b.dir, step);
    const p = b.mesh.position;
    if (isWall(p.x, p.z)) { b.life = 0; burst(p.x, p.y, p.z, 0xbaff6b, 4, 2); continue; }
    if (!b.live) continue;
    for (const g of enemies()) {
      if (g.dying || g.spawnT < 1) continue;
      if (Math.hypot(g.x - p.x, g.z - p.z) < g.rad + 0.2) {
        damageGhost(g, b.dmg, b.dir.x * 4, b.dir.z * 4, 0.08);
        b.life = 0; break;
      }
    }
  }
  S.bullets = S.bullets.filter((b) => {
    if (b.life <= 0) { S.levelGroup.remove(b.mesh); b.mesh.material.dispose(); return false; }
    return true;
  });

  for (const g of S.grenades) {
    g.life -= dt;
    g.vy -= 16 * dt;
    const p = g.mesh.position;
    const nx = p.x + g.vx * dt, nz = p.z + g.vz * dt;
    if (isWall(nx, p.z)) g.vx *= -0.5; else p.x = nx;
    if (isWall(p.x, nz)) g.vz *= -0.5; else p.z = nz;
    p.y += g.vy * dt;
    if (p.y < 0.22) { p.y = 0.22; g.vy *= -0.4; g.vx *= 0.7; g.vz *= 0.7; }
    g.mesh.rotation.x += dt * 10;
    if (g.life <= 0) explode(p.x, p.y, p.z, g.live);
  }
  S.grenades = S.grenades.filter((g) => {
    if (g.life <= 0) { S.levelGroup.remove(g.mesh); g.mesh.material.dispose(); return false; }
    return true;
  });
}

function burst(x, y, z, color, n = 8, power = 3) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(particleGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
    m.position.set(x, y, z);
    S.levelGroup.add(m);
    S.particles.push({
      m, life: 0.5 + Math.random() * 0.4,
      v: new THREE.Vector3((Math.random() - 0.5) * power * 2, Math.random() * power * 1.2, (Math.random() - 0.5) * power * 2),
    });
  }
}
function swingEffect(x, z, yaw, range, color) {
  const geo = new THREE.RingGeometry(range * 0.5, range, 24, 1, -0.9, 1.8);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2; // lay flat; ring segment is centred on +X
  const holder = new THREE.Group();
  holder.add(m);
  holder.position.set(x, 1.0, z);
  holder.rotation.y = yaw - Math.PI / 2; // turn +X to the facing direction
  S.levelGroup.add(holder);
  S.effects.push({ obj: holder, mat: m.material, geo, life: 0.18, max: 0.18, grow: 0.3 });
}
function ringEffect(x, z, color, radius, life) {
  const geo = new THREE.RingGeometry(0.8, 1, 48);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.15, z);
  S.levelGroup.add(m);
  S.effects.push({ obj: m, mat: m.material, geo, life, max: life, ring: radius });
}
function updateFx(dt) {
  for (const p of S.particles) {
    p.life -= dt;
    p.v.y -= 9 * dt;
    p.m.position.addScaledVector(p.v, dt);
    if (p.m.position.y < 0.05) { p.m.position.y = 0.05; p.v.multiplyScalar(0.5); }
    p.m.material.opacity = Math.min(1, p.life * 2);
    p.m.rotation.x += dt * 8;
  }
  S.particles = S.particles.filter((p) => {
    if (p.life <= 0) { S.levelGroup.remove(p.m); p.m.material.dispose(); return false; }
    return true;
  });
  for (const e of S.effects) {
    e.life -= dt;
    const t = 1 - e.life / e.max;
    if (e.ring) e.obj.scale.setScalar(1 + t * e.ring);
    else e.obj.scale.setScalar(1 + t * e.grow);
    e.mat.opacity = Math.max(0, 1 - t) * 0.8;
  }
  S.effects = S.effects.filter((e) => {
    if (e.life <= 0) { S.levelGroup.remove(e.obj); e.geo.dispose(); e.mat.dispose(); return false; }
    return true;
  });
}

// floating damage numbers
const floaters = [];
function addFloater(x, y, z, text, color) {
  const el = document.createElement('div');
  el.className = 'floater'; el.textContent = text; el.style.color = color;
  $('floaters').appendChild(el);
  floaters.push({ el, pos: new THREE.Vector3(x, y, z), life: 0.9 });
}
function updateFloaters(dt) {
  const v = new THREE.Vector3();
  for (const f of floaters) {
    f.life -= dt;
    f.pos.y += dt * 1.5;
    v.copy(f.pos).project(camera);
    const vis = v.z < 1;
    f.el.style.display = vis ? 'block' : 'none';
    f.el.style.left = ((v.x + 1) / 2) * innerWidth + 'px';
    f.el.style.top = ((1 - v.y) / 2) * innerHeight + 'px';
    f.el.style.opacity = Math.min(1, f.life * 2);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    if (floaters[i].life <= 0) { floaters[i].el.remove(); floaters.splice(i, 1); }
  }
}

// ===================== CAMERA =====================
// only real wall geometry blocks the camera (the open floor outside the maze is solid for walking only)
function camBlocked(x, z) {
  const c0 = Math.floor((x - 0.2) / GRID), c1 = Math.floor((x + 0.2) / GRID);
  const r0 = Math.floor((z - 0.2) / GRID), r1 = Math.floor((z + 0.2) / GRID);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    if (r >= 0 && c >= 0 && r < S.rows && c < S.cols && S.wallMark[r * S.cols + c]) return true;
  }
  return false;
}
function updateCamera(dt) {
  const P = S.player;
  const target = new THREE.Vector3(P.x, 1.6, P.z);
  // shorten distance if a wall is between camera and player; when that leaves too little
  // room, tilt the camera upward so it can look over the walls instead
  const dir = new THREE.Vector3();
  let dist = S.camDist, pitch = S.camPitch;
  for (; ; pitch += 0.15) {
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    dir.set(-Math.sin(S.camYaw) * cp, sp, -Math.cos(S.camYaw) * cp);
    dist = S.camDist;
    for (let d = 0.3; d <= S.camDist; d += 0.15) {
      const px = target.x + dir.x * d, py = target.y + dir.y * d, pz = target.z + dir.z * d;
      if (py < WALL_H + 0.2 && camBlocked(px, pz)) { dist = Math.max(0.8, d - 0.3); break; }
    }
    if (dist >= 3.5 || pitch >= 1.35) break;
  }
  // backed against a wall: hover high above the player instead of clipping into their head
  const want = dist < 2.5
    ? new THREE.Vector3(P.x - Math.sin(S.camYaw) * 0.6, WALL_H + 3, P.z - Math.cos(S.camYaw) * 0.6)
    : target.clone().addScaledVector(dir, dist);
  if (S.snapCam) { camera.position.copy(want); S.snapCam = false; }
  else camera.position.lerp(want, 1 - Math.pow(0.0001, dt));
  if (S.shake > 0) {
    S.shake -= dt;
    camera.position.x += (Math.random() - 0.5) * S.shake * 0.8;
    camera.position.y += (Math.random() - 0.5) * S.shake * 0.8;
  }
  // look ahead of the player normally, but straight at them when the camera is steep
  const ahead = 2 * Math.max(0, 1 - (pitch - S.camPitch) * 1.4);
  S.camLook = (S.camLook ?? ahead) + (ahead - (S.camLook ?? ahead)) * (1 - Math.pow(0.001, dt));
  const look = target.clone().addScaledVector(forward(), S.camLook);
  camera.lookAt(look);
}

// ===================== HUD / MINIMAP =====================
function updateHud() {
  const P = S.player;
  if (!P) return;
  const mp = S.mode === 'mp';
  $('hudName').textContent = mp
    ? `${S.role === 'ghost' ? '👻 ผี' : `🏃 ผู้หนี · ${P.ch.icon} ${P.ch.name}`} — ${NET.name}`
    : `${P.ch.icon} ${P.ch.name}`;
  $('mpStats').classList.toggle('hidden', !mp);
  $('soloStats').classList.toggle('hidden', mp);
  $('hpBar').style.width = (P.hp / P.maxHp) * 100 + '%';
  $('hpText').textContent = `${Math.ceil(P.hp)} / ${P.maxHp}`;
  $('hudLevel').textContent = S.level;
  $('hudKeys').textContent = `${S.keysGot}/${S.keysNeed}`;
  $('hudKills').textContent = S.kills;
}
function updateSpecialBar() {
  const P = S.player;
  const frac = 1 - Math.max(0, P.spCd) / P.ch.specialCd;
  $('spBar').style.width = frac * 100 + '%';
  $('spText').textContent = frac >= 1 ? `${P.ch.specialName} พร้อม! (คลิกขวา/K)` : 'ท่าพิเศษกำลังชาร์จ...';
}

const mm = $('minimap').getContext('2d');
function drawMinimap() {
  const W = 190, P = S.player, { rows, cols } = S;
  const s = (W - 10) / Math.max(rows, cols);
  const ox = (W - cols * s) / 2, oy = (W - rows * s) / 2;
  mm.clearRect(0, 0, W, W);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c;
    if (!S.visited[i]) continue;
    mm.fillStyle = S.grid[i] ? '#6a5fa8' : '#1c1828';
    mm.fillRect(ox + c * s, oy + r * s, s + 0.5, s + 0.5);
  }
  const dot = (x, z, color, rad) => {
    mm.fillStyle = color; mm.beginPath();
    mm.arc(ox + (x / GRID) * s, oy + (z / GRID) * s, rad, 0, Math.PI * 2); mm.fill();
  };
  // exit is always shown so players know where to go
  dot(S.exit.x, S.exit.z, S.exit.open ? '#33ff99' : '#ff3355', 4);
  for (const k of S.keys) {
    if (k.got) continue;
    const [r, c] = toCell(k.x, k.z);
    if (S.visited[r * cols + c]) dot(k.x, k.z, '#ffd23f', 3.5);
  }
  for (const g of S.ghosts) {
    if (g.dying) continue;
    if (Math.hypot(g.x - P.x, g.z - P.z) < 14) dot(g.x, g.z, '#ff4d6d', 2.8);
  }
  // other players: teammates always; ghosts sense every runner, runners only see nearby ghosts
  for (const r of S.remotes.values()) {
    if (r.banished) continue;
    if (r.role === S.role) dot(r.x, r.z, r.role === 'ghost' ? '#c58bff' : '#7ef0ff', 3);
    else if (S.role === 'ghost') dot(r.x, r.z, '#ffa040', 3.2);
    else if (Math.hypot(r.x - P.x, r.z - P.z) < 14) dot(r.x, r.z, '#ff4d6d', 3.2);
  }
  // player arrow
  mm.save(); mm.translate(ox + (P.x / GRID) * s, oy + (P.z / GRID) * s); mm.rotate(-S.camYaw);
  mm.fillStyle = '#5bc8ff'; mm.beginPath();
  mm.moveTo(0, 6); mm.lineTo(4, -4); mm.lineTo(-4, -4); mm.closePath(); mm.fill();
  mm.restore();
}

function showMsg(text, time = 2) {
  $('msg').textContent = text;
  $('msg').style.opacity = 1;
  S.msgTimer = time;
}

// ===================== STATE TRANSITIONS =====================
function startGame() {
  S.level = 1; S.kills = 0; S.score = 0; S.player = null;
  $('menu').classList.add('hidden');
  $('overlay').classList.add('hidden');
  $('hud').classList.remove('hidden');
  buildLevel();
  S.state = 'play';
  lockPointer();
}
function nextLevel() {
  S.level++;
  $('overlay').classList.add('hidden');
  buildLevel();
  S.state = 'play';
  lockPointer();
}
function levelClear() {
  S.state = 'clear';
  sfx.key();
  unlockPointer();
  overlay('🎉 ผ่านด่าน!', `ด่าน ${S.level} สำเร็จ · ปราบผีไปแล้ว ${S.kills} ตัว<br>ด่านต่อไปเขาวงกตจะใหญ่ขึ้น และผีจะเยอะขึ้น!`, [
    ['ด่านต่อไป ▶', nextLevel],
    ['เปลี่ยนตัวละคร', toMenu, true],
  ]);
}
function gameOver() {
  S.state = 'over';
  unlockPointer();
  overlay('💀 ผีจับได้แล้ว!', `ไปได้ถึงด่าน ${S.level} · ปราบผี ${S.kills} ตัว · คะแนน ${S.score}`, [
    ['เล่นอีกครั้ง', startGame],
    ['เปลี่ยนตัวละคร', toMenu, true],
  ]);
}
function pauseGame() {
  if (S.state !== 'play') return;
  if (S.mode === 'mp') {
    // an online round can't be paused — just release the controls
    S.mpPaused = true;
    for (const k in keys) keys[k] = false;
    mouse.left = mouse.right = false;
    unlockPointer();
    overlay('⏸ พักมือ', 'เกมออนไลน์ยังเดินต่ออยู่นะ! ตัวละครคุณยืนนิ่งอยู่ในเขาวงกต', [
      ['เล่นต่อ', () => { S.mpPaused = false; $('overlay').classList.add('hidden'); lockPointer(); }],
      ['ออกจากห้อง', toMenu, true],
    ]);
    return;
  }
  S.state = 'pause';
  unlockPointer();
  overlay('⏸ หยุดเกม', 'พักก่อนนะ ผีรออยู่...', [
    ['เล่นต่อ', resumeGame],
    ['กลับเมนู', toMenu, true],
  ]);
}
function resumeGame() {
  $('overlay').classList.add('hidden');
  S.state = 'play';
  lockPointer();
}
function toMenu() {
  S.state = 'menu';
  if (S.mode === 'mp') netDisconnect();
  S.mode = 'solo';
  clearLevel();
  $('overlay').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('lobby').classList.add('hidden');
  $('roulette').classList.add('hidden');
  $('menu').classList.remove('hidden');
  unlockPointer();
}
function overlay(title, text, buttons) {
  $('ovTitle').textContent = title;
  $('ovText').innerHTML = text;
  const box = $('ovBtns');
  box.innerHTML = '';
  for (const [label, fn, alt] of buttons) {
    const b = document.createElement('button');
    b.className = 'btn' + (alt ? ' alt' : '');
    b.textContent = label;
    b.onclick = fn;
    box.appendChild(b);
  }
  $('overlay').classList.remove('hidden');
}

// ===================== INPUT =====================
function lockPointer() { canvas.requestPointerLock?.()?.catch?.(() => {}); }
function unlockPointer() { if (document.pointerLockElement) document.exitPointerLock(); }
let wasLocked = false;
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (wasLocked && !locked && S.state === 'play') pauseGame();
  wasLocked = locked;
});
canvas.addEventListener('mousedown', (e) => {
  if (S.state !== 'play') return;
  if (document.pointerLockElement !== canvas) lockPointer();
  if (e.button === 0) mouse.left = true;
  if (e.button === 2) mouse.right = true;
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) mouse.left = false;
  if (e.button === 2) mouse.right = false;
});
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => {
  if (S.state !== 'play' || document.pointerLockElement !== canvas) return;
  S.camYaw -= e.movementX * 0.0028;
  S.camPitch = Math.max(0.15, Math.min(1.25, S.camPitch + e.movementY * 0.002));
});
addEventListener('wheel', (e) => {
  if (S.state === 'play') S.camDist = Math.max(3, Math.min(10, S.camDist + Math.sign(e.deltaY) * 0.6));
});
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (S.mpPaused) return;
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (S.state === 'play') pauseGame();
    else if (S.state === 'pause' && e.code === 'KeyP') resumeGame();
  }
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouse.left = mouse.right = false; });

// ===================== CHARACTER SELECT PREVIEW =====================
const pvCanvas = $('preview');
const pvRenderer = new THREE.WebGLRenderer({ canvas: pvCanvas, antialias: true, alpha: true });
pvRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
pvRenderer.setSize(420, 420, false);
pvRenderer.outputColorSpace = THREE.SRGBColorSpace;
const pvScene = new THREE.Scene();
const pvCam = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
pvCam.position.set(0, 1.5, 5.6);
pvCam.lookAt(0, 0.95, 0);
pvScene.add(new THREE.HemisphereLight(0xffffff, 0x302040, 1.6));
const pvKey = new THREE.DirectionalLight(0xffffff, 1.8);
pvKey.position.set(2, 4, 3);
pvScene.add(pvKey);
const pvRim = new THREE.DirectionalLight(0x8a5cff, 2);
pvRim.position.set(-3, 2, -3);
pvScene.add(pvRim);
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.35, 0.2, 40),
  new THREE.MeshStandardMaterial({ color: 0x2a2350, emissive: 0x3b2a8a, emissiveIntensity: 0.4 }));
pedestal.position.y = -0.1;
pvScene.add(pedestal);
const pvHolder = new THREE.Group();
pvScene.add(pvHolder);

function selectChar(i) {
  S.charIdx = i;
  document.querySelectorAll('.card').forEach((c, j) => c.classList.toggle('sel', j === i));
  const ch = CHARACTERS[i];
  pvHolder.clear();
  pvHolder.add(prototypes[ch.id].clone());
  const bar = (label, v) => `<div class="statrow"><span>${label}</span><div class="sb"><i style="width:${v * 100}%"></i></div></div>`;
  $('charInfo').innerHTML = `<h3>${ch.icon} ${ch.name}</h3><div>${ch.desc}</div>
    <div style="margin:6px 0">ท่าพิเศษ: <b>${ch.specialName}</b></div>
    ${bar('พลังชีวิต', ch.stats.hp)}${bar('พลังโจมตี', ch.stats.atk)}${bar('ความเร็ว', ch.stats.spd)}`;
}

function buildMenu() {
  const box = $('cards');
  CHARACTERS.forEach((ch, i) => {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = `<div class="ico">${ch.icon}</div><div class="nm">${ch.name}</div>`;
    d.onclick = () => { selectChar(i); tone(500 + i * 120, 0.08, 'triangle', 0.06); };
    box.appendChild(d);
  });
  $('startBtn').onclick = () => { S.mode = 'solo'; startGame(); };
  $('mpBtn').onclick = openLobby;
  bindLobby();
  selectChar(0);
}

// ===================== MULTIPLAYER (LAN) =====================
const NET = {
  ws: null, id: null, name: '', hostId: null, players: [], settings: { ghosts: 1 }, ips: [], port: 8080, inGame: false,
  seed: 0, variant: 0, gamePlayers: [], me: null, sendT: 0, lastHud: '', lastCount: 0,
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const charOf = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];
const nameOf = (id) => (id === NET.id ? 'คุณ' : NET.gamePlayers.find((p) => p.id === id)?.name ?? '???');
const inRound = () => S.mode === 'mp' && S.player && (S.state === 'play' || S.state === 'roulette');

function netSend(m) { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); }
function sendFx(m) { if (S.mode === 'mp') netSend({ t: 'fx', ...m }); }
function sendState(dt) {
  NET.sendT -= dt;
  if (NET.sendT > 0) return;
  NET.sendT = 1 / 15;
  const P = S.player, r2 = (v) => Math.round(v * 100) / 100;
  netSend({ t: 'st', x: r2(P.x), z: r2(P.z), y: r2(S.camYaw), m: P.moving ? 1 : 0, d: P.dashT > 0 || P.lungeT > 0 ? 1 : 0, ph: P.phaseT > 0 ? 1 : 0 });
}
function netDisconnect() {
  if (NET.ws) { NET.ws.onclose = null; NET.ws.close(); }
  NET.ws = null; NET.id = null;
}

// ---------- lobby ----------
function openLobby() {
  S.state = 'lobby'; S.mode = 'mp';
  $('menu').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  $('lobbyErr').textContent = '';
  if (!$('nameInput').value) { try { $('nameInput').value = localStorage.getItem('gm_name') || ''; } catch { /* storage blocked */ } }
  renderLobby();
  if (NET.id == null) $('nameInput').focus();
}

function joinLobby() {
  const name = $('nameInput').value.trim();
  if (!name) { $('lobbyErr').textContent = 'ใส่ชื่อก่อนนะ'; return; }
  try { localStorage.setItem('gm_name', name); } catch { /* storage blocked */ }
  NET.name = name;
  $('lobbyErr').textContent = '';
  $('joinBtn').disabled = true;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  NET.ws = ws;
  ws.onopen = () => netSend({ t: 'hello', name, char: CHARACTERS[S.charIdx].id });
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onNet(m);
  };
  ws.onclose = () => {
    NET.ws = null; NET.id = null;
    $('joinBtn').disabled = false;
    if (S.mode !== 'mp') return;
    if (S.state === 'lobby') {
      $('lobbyErr').textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ — ต้องเปิดเกมผ่าน start.bat (node server.js)';
      renderLobby();
    } else {
      S.state = 'over';
      unlockPointer();
      $('roulette').classList.add('hidden');
      overlay('📡 หลุดการเชื่อมต่อ', 'ติดต่อเครื่องที่เปิดเซิร์ฟเวอร์ไม่ได้แล้ว', [['กลับเมนู', toMenu]]);
    }
  };
}

function renderLobby() {
  const joined = NET.id != null;
  $('joinForm').classList.toggle('hidden', joined);
  $('lobbyMain').classList.toggle('hidden', !joined);
  if (!joined) return;
  const box = $('lobbyChars');
  box.innerHTML = '';
  CHARACTERS.forEach((ch, i) => {
    const b = document.createElement('div');
    b.className = 'chip' + (i === S.charIdx ? ' sel' : '');
    b.textContent = `${ch.icon} ${ch.name}`;
    b.onclick = () => { selectChar(i); netSend({ t: 'char', char: ch.id }); renderLobby(); };
    box.appendChild(b);
  });
  $('playerList').innerHTML = NET.players.map((p) => `<div class="prow">
      <span class="${p.id === NET.id ? 'me' : ''}">${p.id === NET.hostId ? '👑 ' : ''}${esc(p.name)}${p.id === NET.id ? ' (คุณ)' : ''}</span>
      <span>${charOf(p.char).icon}${p.playing ? ' · กำลังเล่น' : ''}</span></div>`).join('');
  const urls = NET.ips.map((ip) => `<code>http://${ip}:${NET.port}</code>`).join(' หรือ ');
  $('shareBox').innerHTML = urls
    ? `📱 ให้เพื่อนที่ต่อ Wi-Fi เดียวกันเปิด ${urls} ในเบราว์เซอร์`
    : 'ไม่พบ IP วง LAN ของเครื่องนี้ — ต่อ Wi-Fi ก่อนนะ';
  const isHost = NET.id === NET.hostId, n = NET.players.length;
  $('hostBox').classList.toggle('hidden', !isHost);
  const maxG = Math.max(1, n - 1);
  $('ghostCount').innerHTML = Array.from({ length: maxG }, (_, i) => `<option value="${i + 1}">ผี ${i + 1} ตัว</option>`).join('');
  $('ghostCount').value = String(Math.min(NET.settings.ghosts, maxG));
  $('mpStartBtn').disabled = n < 2 || NET.inGame;
  $('mpStartBtn').textContent = n < 2 ? 'รอเพื่อนเข้าห้องอย่างน้อย 1 คน...'
    : NET.inGame ? 'รอรอบที่เล่นอยู่จบก่อน...' : '🎲 สุ่มบทบาท แล้วเริ่มเกม!';
  const host = NET.players.find((p) => p.id === NET.hostId);
  $('waitBox').classList.toggle('hidden', isHost && !NET.inGame);
  $('waitBox').textContent = NET.inGame ? 'มีรอบที่กำลังเล่นอยู่ — รอรอบหน้านะ'
    : `รอ ${host ? host.name : 'หัวห้อง'} 👑 กดสุ่มบทบาทและเริ่มเกม...`;
}

function backToLobby() {
  clearLevel();
  S.player = null;
  S.state = 'lobby';
  $('overlay').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('roulette').classList.add('hidden');
  $('lobby').classList.remove('hidden');
  renderLobby();
}

// ---------- role roulette ----------
function playRoulette(players, done) {
  const box = $('rouCards');
  box.innerHTML = '';
  const cards = players.map((p) => {
    const d = document.createElement('div');
    d.className = 'rcard';
    d.innerHTML = `<div class="ri">❔</div><div>${esc(p.name)}</div>`;
    box.appendChild(d);
    return d;
  });
  $('rouTitle').textContent = '🎲 กำลังสุ่มว่าใครเป็นผี...';
  $('rouYou').innerHTML = '';
  $('roulette').classList.remove('hidden');
  const nG = players.filter((p) => p.role === 'ghost').length;
  const spinEnd = S.startAt - 2600;
  let delay = 70;
  const tick = () => {
    if (S.state !== 'roulette') return;
    if (performance.now() < spinEnd) {
      const order = cards.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, nG);
      cards.forEach((c, i) => c.classList.toggle('hot', order.includes(i)));
      tone(650 + Math.random() * 350, 0.04, 'square', 0.04);
      delay *= 1.1;
      setTimeout(tick, delay);
      return;
    }
    cards.forEach((c, i) => {
      const g = players[i].role === 'ghost';
      c.classList.remove('hot');
      c.classList.add(g ? 'ghost' : 'runner');
      c.querySelector('.ri').textContent = g ? '👻' : '🏃';
    });
    sfx.special();
    $('rouTitle').textContent = '🎲 ผลการสุ่ม!';
    $('rouYou').innerHTML = S.role === 'ghost'
      ? 'คุณคือ 👻 ผี!<small>ไล่จับผู้หนี (ชนตัว = จับ) · คลิกซ้าย พุ่งจับ · คลิกขวา ทะลุกำแพง</small>'
      : `คุณคือ 🏃 ผู้หนี (${CHARACTERS[S.charIdx].name})!<small>ช่วยกันเก็บกุญแจ 3 ดอก แล้วหนีออกประตูมิติ · ตีผีสู้ได้นะ!</small>`;
    setTimeout(done, Math.max(800, S.startAt - performance.now()));
  };
  tick();
}

// ---------- other players ----------
function makeLabel(name, role) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 32px "Segoe UI", Tahoma, "Leelawadee UI", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const text = `${role === 'ghost' ? '👻' : '🏃'} ${name}`;
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(text, 160, 32);
  g.fillStyle = role === 'ghost' ? '#e2c4ff' : '#9ff3ff'; g.fillText(text, 160, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, fog: false }));
  s.scale.set(2.5, 0.5, 1);
  return s;
}

function addRemote(p) {
  const ghost = p.role === 'ghost';
  const { pivot, anim, mat } = makeAvatar(p.role, p.char);
  const label = makeLabel(p.name, p.role);
  label.position.y = ghost ? 2.6 : 2.3;
  pivot.add(label);
  const at = ghost ? S.ghostSpawn : S.startPos;
  const r = {
    id: p.id, name: p.name, char: p.char, role: p.role, remote: true, pivot, anim, mat, label,
    x: at.x, z: at.z, tx: at.x, tz: at.z, yaw: 0, tyaw: 0, moving: false, dash: false, phase: false,
    rad: ghost ? GHOST_R * 1.25 : PLAYER_R, t: { color: ghost ? GHOST_CH.color : 0xff6b6b, scale: 1 },
    spawnT: 1, dying: 0, banished: false, flash: 0, walk: 0, atkAnim: 0, stun: 0, hp: p.hp,
  };
  S.levelGroup.add(pivot);
  S.remotes.set(p.id, r);
  return r;
}

function removeRemote(id) {
  const r = S.remotes.get(id);
  if (!r) return null;
  S.levelGroup.remove(r.pivot);
  r.label.material.map.dispose();
  r.mat?.dispose();
  S.remotes.delete(id);
  return r;
}

function updateRemotes(dt) {
  const k = 1 - Math.pow(0.0005, dt);
  const now = performance.now();
  for (const r of S.remotes.values()) {
    if (Math.hypot(r.tx - r.x, r.tz - r.z) > 6) { r.x = r.tx; r.z = r.tz; }
    else { r.x += (r.tx - r.x) * k; r.z += (r.tz - r.z) * k; }
    r.yaw = lerpAngle(r.yaw, r.tyaw, k);
    r.walk += dt * (r.moving ? 10 : 0);
    r.atkAnim = Math.max(0, r.atkAnim - dt * 5);
    r.flash -= dt; r.stun -= dt;
    const ghost = r.role === 'ghost';
    r.pivot.visible = !r.banished;
    r.pivot.position.set(r.x, 0, r.z);
    r.pivot.rotation.y = r.yaw;
    const bob = ghost ? Math.sin(now / 300 + r.id) * 0.15 : r.moving ? Math.abs(Math.sin(r.walk)) * 0.12 : 0;
    r.anim.position.set(0, bob, Math.sin(Math.min(1, r.atkAnim) * Math.PI) * 0.5);
    r.anim.rotation.z = r.stun > 0 ? Math.sin(now / 40) * 0.2 : r.moving ? Math.sin(r.walk) * 0.06 : 0;
    r.anim.rotation.x = r.dash ? 0.35 : Math.sin(Math.min(1, r.atkAnim) * Math.PI) * 0.18;
    if (r.mat) {
      r.mat.opacity = r.phase ? 0.3 : 0.82;
      r.mat.emissive.setHex(r.flash > 0 ? 0xffffff : GHOST_CH.color);
    }
  }
}

function hitRemote(r, dmg, kx, kz, stun) {
  netSend({ t: 'hit', target: r.id, dmg: Math.round(dmg), kx, kz, stun });
  r.flash = 0.15;
  addFloater(r.x, 2, r.z, `-${Math.round(dmg)}`, S.role === 'ghost' ? '#ff4d6d' : '#ffe066');
  burst(r.x, 1, r.z, r.t.color, 6);
  sfx.hit();
}

function openExit() {
  S.exit.open = true;
  S.exit.ringMat.color.setHex(0x33ff99); S.exit.ringMat.emissive.setHex(0x22ff88);
  S.exit.coreMat.color.setHex(0x22ff88); S.exit.plight.color.setHex(0x22ff88);
}

function updateMpHud() {
  const now = performance.now();
  const left = Math.max(0, S.mpEndAt - now);
  let runners = S.role === 'runner' ? 1 : 0, ghosts = S.role === 'ghost' ? 1 : 0;
  for (const r of S.remotes.values()) r.role === 'ghost' ? ghosts++ : runners++;
  const txt = `⏱ ${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`
    + ` · 🗝️ ${S.keysGot}/${S.keysNeed} · 🏃 ${runners} · 👻 ${ghosts}`;
  if (txt !== NET.lastHud) { $('mpStats').textContent = txt; NET.lastHud = txt; }
  // head-start countdown
  const rel = S.releaseAt - now;
  if (rel > 0) {
    const s = Math.ceil(rel / 1000);
    if (s !== NET.lastCount) {
      NET.lastCount = s;
      showMsg(S.role === 'ghost' ? `👻 ผู้หนีกำลังวิ่ง... ออกล่าได้ใน ${s}` : `🏃 วิ่งเลย! ผีจะออกล่าใน ${s} วินาที`, 1.2);
    }
  } else if (NET.lastCount) {
    NET.lastCount = 0;
    showMsg(S.role === 'ghost' ? '👻 ออกล่าได้! ไปจับพวกมัน!' : '👻 ผีออกล่าแล้ว! ระวังตัว!', 2);
  }
}

// ---------- server messages ----------
function onNet(m) {
  switch (m.t) {
    case 'welcome':
      NET.id = m.id;
      renderLobby();
      break;
    case 'lobby':
      Object.assign(NET, { players: m.players, hostId: m.hostId, settings: m.settings, ips: m.ips, port: m.port, inGame: m.inGame });
      if (S.state === 'lobby') renderLobby();
      break;
    case 'start': onStart(m); break;
    case 'end': onEnd(m); break;
    case 'leave':
      NET.gamePlayers = NET.gamePlayers.filter((p) => p.id !== m.id);
      if (S.levelGroup) removeRemote(m.id);
      break;
    default:
      if (inRound()) onRoundMsg(m);
  }
}

function onStart(m) {
  const me = m.players.find((p) => p.id === NET.id);
  if (!me || S.state !== 'lobby') return;
  Object.assign(NET, { seed: m.seed, variant: m.variant, gamePlayers: m.players, me, startRole: me.role, lastCount: -1, lastHud: '' });
  S.role = me.role;
  S.charIdx = Math.max(0, CHARACTERS.findIndex((c) => c.id === me.char));
  const now = performance.now();
  S.startAt = now + m.startIn; S.releaseAt = now + m.releaseIn; S.mpEndAt = now + m.endIn;
  S.level = 1; S.kills = 0; S.player = null; S.exitAsked = 0; S.mpPaused = false;
  $('lobby').classList.add('hidden');
  $('overlay').classList.add('hidden');
  buildLevel();
  S.state = 'roulette';
  $('hud').classList.remove('hidden');
  playRoulette(m.players, () => {
    if (S.state !== 'roulette') return;
    $('roulette').classList.add('hidden');
    S.state = 'play';
    S.snapCam = true;
    showMsg('คลิกที่จอเพื่อควบคุมกล้องด้วยเมาส์', 2);
  });
}

function onRoundMsg(m) {
  const P = S.player;
  switch (m.t) {
    case 'st': {
      const r = S.remotes.get(m.id);
      if (!r) return;
      r.tx = +m.x || 0; r.tz = +m.z || 0; r.tyaw = +m.y || 0;
      r.moving = !!m.m; r.dash = !!m.d; r.phase = !!m.ph;
      break;
    }
    case 'fx': {
      const r = S.remotes.get(m.id);
      if (!r) return;
      r.atkAnim = 1;
      const near = Math.hypot(r.x - P.x, r.z - P.z) < 25;
      const x = +m.x || r.x, z = +m.z || r.z, yaw = +m.yaw || 0;
      if (m.k === 'swing') { swingEffect(x, z, yaw, Math.min(4, +m.range || 2), +m.color || 0xffffff); if (near) sfx.punch(); }
      else if (m.k === 'shoot') { spawnBullet(x, z, yaw, 0, false); if (near) sfx.shoot(); }
      else if (m.k === 'special' && ['smash', 'grenade', 'bubble'].includes(m.s)) { specialFx(m.s, x, z, yaw, false); if (near) sfx.special(); }
      else if (m.k === 'lunge') { if (near) sfx.dash(); }
      else if (m.k === 'phase') burst(r.x, 1, r.z, GHOST_CH.color, 12, 3);
      break;
    }
    case 'hp': {
      if (m.id !== NET.id) {
        const r = S.remotes.get(m.id);
        if (r) { r.hp = m.hp; if (m.dmg > 0) { r.flash = 0.15; r.stun = m.stun || 0; } }
        return;
      }
      const before = P.hp;
      P.hp = m.hp;
      if (m.dmg > 0) {
        P.kx += m.kx || 0; P.kz += m.kz || 0;
        addFloater(P.x, 2.2, P.z, `-${Math.round(m.dmg)}`, '#ff4d6d');
        S.shake = 0.35;
        sfx.hurt();
        $('hurt').style.opacity = 1;
        setTimeout(() => ($('hurt').style.opacity = 0), 180);
        if (S.role === 'ghost') P.stun = Math.max(P.stun, m.stun || 0);
        else P.invuln = 0.7;
      } else if (m.hp > before) {
        addFloater(P.x, 2.2, P.z, `+${Math.round(m.hp - before)}`, '#6bff9a');
        sfx.pickup();
      }
      updateHud();
      break;
    }
    case 'role': {
      const gp = NET.gamePlayers.find((p) => p.id === m.id);
      if (gp) gp.role = 'ghost';
      if (m.id === NET.id) {
        S.role = 'ghost';
        S.levelGroup.remove(P.pivot);
        const av = makeAvatar('ghost');
        S.levelGroup.add(av.pivot);
        Object.assign(P, {
          ch: GHOST_CH, pivot: av.pivot, anim: av.anim, avatarMat: av.mat, hp: m.hp, maxHp: m.maxHp,
          x: S.ghostSpawn.x, z: S.ghostSpawn.z, kx: 0, kz: 0, invuln: 0, atkCd: 0, spCd: 0, stun: 1.5,
        });
        S.visited.fill(1);
        playerLight.color.setHex(GHOST_CH.color);
        sfx.ghostDie();
        showMsg(`😱 ${nameOf(m.by)} จับคุณได้! ตอนนี้คุณกลายเป็นผีแล้ว — ไปจับคนที่เหลือ!`, 4);
      } else {
        const old = removeRemote(m.id);
        if (old) {
          burst(old.x, 1, old.z, GHOST_CH.color, 20, 5);
          addRemote({ id: old.id, name: old.name, char: old.char, role: 'ghost', hp: m.hp });
        }
        if (m.by === NET.id) { S.kills++; sfx.ghostDie(); }
        showMsg(`👻 ${old ? old.name : 'ผู้หนี'} โดนจับ กลายเป็นผีแล้ว!`, 2.5);
      }
      updateHud();
      break;
    }
    case 'banish': {
      if (m.id === NET.id) {
        P.banished = 99; // until the server says we're back
        burst(P.x, 1, P.z, GHOST_CH.color, 26, 6);
        sfx.ghostDie();
        showMsg(`💥 ${nameOf(m.by)} ขับไล่คุณ! กลับมาใน ${Math.round((m.ms || 4000) / 1000)} วินาที`, 3);
      } else {
        const r = S.remotes.get(m.id);
        if (!r) return;
        r.banished = true;
        burst(r.x, 1, r.z, GHOST_CH.color, 26, 6);
        burst(r.x, 1, r.z, 0xffffff, 10, 4);
        sfx.ghostDie();
        showMsg(m.by === NET.id ? `👊 ขับไล่ ${r.name} สำเร็จ!` : `👊 ${nameOf(m.by)} ขับไล่ ${r.name}!`, 2);
      }
      break;
    }
    case 'unbanish': {
      if (m.id === NET.id) {
        Object.assign(P, { banished: 0, hp: m.hp, x: S.ghostSpawn.x, z: S.ghostSpawn.z, kx: 0, kz: 0, stun: 0, phaseT: 0 });
        showMsg('👻 กลับมาแล้ว! ออกล่าต่อ!', 2);
        updateHud();
      } else {
        const r = S.remotes.get(m.id);
        if (r) { r.banished = false; r.hp = m.hp; }
      }
      break;
    }
    case 'pick': {
      if (m.kind === 'key') {
        const k = S.keys[m.idx];
        if (!k || k.got) return;
        k.got = true;
        S.levelGroup.remove(k.mesh);
        burst(k.x, 1.2, k.z, 0xffd23f, 20, 4);
        sfx.key();
        S.keysGot = m.keysGot;
        if (S.keysGot >= S.keysNeed) {
          openExit();
          showMsg(S.role === 'ghost' ? '⚠️ ผู้หนีได้กุญแจครบ! ประตูมิติเปิดแล้ว ไปเฝ้าทางออก!' : '🚪 ประตูมิติเปิดแล้ว! รีบไปจุดสีเขียวบนแผนที่!', 3.5);
        } else showMsg(`🗝️ ${nameOf(m.by)} ได้กุญแจ (${S.keysGot}/${S.keysNeed})`, 2);
        updateHud();
      } else {
        const h = S.pickups[m.idx];
        if (!h || h.got) return;
        h.got = true;
        S.levelGroup.remove(h.mesh);
      }
      break;
    }
  }
}

function onEnd(m) {
  if (S.mode !== 'mp' || !S.player || S.state === 'lobby') return;
  S.state = 'over';
  S.mpPaused = false;
  unlockPointer();
  $('roulette').classList.add('hidden');
  const won = (m.winner === 'ghosts') === (S.role === 'ghost');
  if (won) sfx.key(); else sfx.hurt();
  overlay(m.winner === 'ghosts' ? '👻 ฝ่ายผีชนะ!' : '🏃 ฝ่ายผู้หนีชนะ!',
    `${esc(m.reason)}<br>${NET.startRole === 'runner' && S.role === 'ghost'
      ? (won ? '😈 คุณโดนจับกลายเป็นผี แล้วช่วยฝ่ายผีชนะ!' : '😵 คุณโดนจับกลายเป็นผี... แต่ผู้หนีที่เหลือรอดไปได้')
      : won ? '🎉 ทีมของคุณชนะ!' : '💀 ทีมของคุณแพ้...'}`, [
      ['กลับห้องรอ (เล่นอีกรอบ)', backToLobby],
      ['ออกจากห้อง', toMenu, true],
    ]);
}

function bindLobby() {
  $('joinBtn').onclick = joinLobby;
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinLobby(); });
  $('lobbyBack').onclick = toMenu;
  $('ghostCount').onchange = () => netSend({ t: 'settings', ghosts: +$('ghostCount').value });
  $('mpStartBtn').onclick = () => netSend({ t: 'start' });
}

// ===================== MAIN LOOP =====================
const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (S.state === 'menu') {
    pvHolder.rotation.y += dt * 0.8;
    pvRenderer.render(pvScene, pvCam);
    return;
  }
  if (S.state === 'lobby') return;
  if (S.state === 'play') {
    if (S.mode === 'mp') {
      updatePlayer(dt);
      updateRemotes(dt);
      updateMpHud();
    } else {
      S.distTimer -= dt;
      if (S.distTimer <= 0) { computeDist(); S.distTimer = 0.25; }
      updatePlayer(dt);
      if (S.state === 'play') updateGhosts(dt);
    }
    updateProjectiles(dt);
    updateFx(dt);
    updateSpecialBar();
    S.msgTimer -= dt;
    if (S.msgTimer <= 0) $('msg').style.opacity = 0;
  }
  if (!S.player || !S.levelGroup) return;
  updateCamera(dt);
  updateFloaters(dt);
  if (S.state === 'play') drawMinimap();
  renderer.render(scene, camera);
}

window.__ghostMaze = S; // handy for debugging in the console
window.__net = NET;

// ===================== BOOT =====================
(async () => {
  const progress = new Array(CHARACTERS.length).fill(0);
  const setBar = () => {
    const p = progress.reduce((a, b) => a + b, 0) / CHARACTERS.length;
    $('loadBar').style.width = p * 100 + '%';
  };
  try {
    const mazeP = loadMaze().then((m) => { mazeSrc = m; });
    await Promise.all(CHARACTERS.map(async (ch, i) => {
      prototypes[ch.id] = await loadCharacter(ch, (p) => { progress[i] = p; setBar(); });
      progress[i] = 1; setBar();
    }));
    await mazeP;
  } catch (err) {
    console.error(err);
    $('loadText').textContent = 'โหลดโมเดล/เขาวงกตไม่สำเร็จ — ต้องเปิดผ่าน start.bat (node server.js) ไม่ใช่ดับเบิลคลิกไฟล์ html';
    return;
  }
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');
  buildMenu();
  loop();
})();
