/**
 * 5. Wavefront Energy — top-down sandcastle vs waves prototype
 *
 * Architecture:
 *  - Terrain grid: each cell has height (0=deep water, 1=sand, 2=wall),
 *    wetness, and erosion resistance.
 *  - Wave system: explicit wavefront segments carrying position, direction,
 *    energy.  Each step advances them by Huygens propagation — the front
 *    bends/reflects at obstacles and splits around gaps.
 *  - Energy is deposited as "impact flash" and erosion when hitting sand/wall.
 *  - Wet wash persists and decays, showing recent wave reach.
 *  - Sand slumps if height gradient is too steep.
 */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const CELL = 6;               // px per grid cell
const WAVE_INTERVAL = 12000;  // ms between auto waves
const WAVE_SPEED = 1.2;       // cells per tick (in deep water)
const MAX_SEGS = 6000;        // hard cap on active segments
const WET_DECAY = 0.0018;     // wetness decay per tick
const EROSION_THRESHOLD = 18; // cumulative energy to erode one sand cell
const WALL_THRESHOLD = 60;    // cumulative energy to erode one wall cell
const SLUMP_RATIO = 0.45;     // height diff that causes slumping
const TRANSPORT_DIST = 2;     // cells sand moves when eroded
const FLASH_DECAY = 0.07;
const SEG_SPLIT_ANGLE = 0.22; // rad — Huygens secondary wavelet half-angle
const ENERGY_DISSIPATE = 0.012; // per cell traversed in open water
const SAND_SLOW = 0.55;       // energy multiplier when crossing shallow/beach
const REFLECT_LOSS = 0.38;    // energy lost on wall reflection
const MIN_ENERGY = 0.04;
const NUM_RAYS = 96;          // rays per wavefront line

// ── Grid cell types ───────────────────────────────────────────────────────────
const T_WATER = 0;
const T_SAND  = 1;
const T_WALL  = 2;

// ── State ─────────────────────────────────────────────────────────────────────
let canvas, ctx;
let GW, GH;           // grid width / height in cells
let grid;             // Uint8Array — cell type
let erosionAcc;       // Float32Array — accumulated energy for erosion
let wetness;          // Float32Array — 0‥1 wash indicator
let flashEnergy;      // Float32Array — impact flash brightness
let wavefronts = [];  // active WaveFront objects
let paused = false;
let brushMode = 'sand'; // 'sand' | 'wall'
let brushSize = 3;
let eraseMode = false;
let mouseDown = false;
let lastMouse = null;
let wavesSent = 0;
let totalErosion = 0;
let lastWaveTime = 0;
let lastFrame = 0;
let fps = 0;
let fpsAccum = 0;
let fpsFrames = 0;

// Castle health tracking
let initialWallCount = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function idx(x, y) { return y * GW + x; }

function inBounds(x, y) { return x >= 0 && x < GW && y >= 0 && y < GH; }

function cellType(x, y) {
  if (!inBounds(x, y)) return T_WATER;
  return grid[idx(x, y)];
}

// Bilinear speed factor at a grid position
function speedAt(x, y) {
  const cx = Math.floor(x), cy = Math.floor(y);
  const t = cellType(cx, cy);
  if (t === T_WATER) return WAVE_SPEED;
  if (t === T_SAND)  return WAVE_SPEED * SAND_SLOW;
  return 0; // wall blocks
}

function isSolid(cx, cy) {
  return cellType(cx, cy) === T_WALL;
}

function isLand(cx, cy) {
  const t = cellType(cx, cy);
  return t === T_SAND || t === T_WALL;
}

// ── WaveFront ─────────────────────────────────────────────────────────────────
/**
 * A WaveFront is a collection of Segments.  Each segment carries:
 *   px, py   — current position (float grid coords)
 *   dx, dy   — normalised direction
 *   energy   — 0‥1
 *   age      — ticks alive
 *   dead     — flag
 */

class Segment {
  constructor(px, py, dx, dy, energy) {
    this.px = px; this.py = py;
    this.dx = dx; this.dy = dy;
    this.energy = energy;
    this.age = 0;
    this.dead = false;
    // For rendering the front line we keep previous position
    this.ppx = px; this.ppy = py;
  }
}

class WaveFront {
  constructor(segments) {
    this.segments = segments;
    this.id = Math.random();
    this.age = 0;
    // hue offset for colour variety
    this.hue = 180 + Math.random() * 60;
  }

  get alive() {
    return this.segments.some(s => !s.dead);
  }
}

// ── Castle seeding ────────────────────────────────────────────────────────────

function seedCastle() {
  // Place castle in right-centre third of grid, clear of shore
  const cx = Math.floor(GW * 0.68);
  const cy = Math.floor(GH * 0.50);
  const R_OUTER = Math.floor(Math.min(GW, GH) * 0.085);
  const R_INNER = Math.floor(R_OUTER * 0.62);
  const WALL_W  = 2;

  // Fill area with sand first
  for (let dy = -R_OUTER - 4; dy <= R_OUTER + 4; dy++) {
    for (let dx = -R_OUTER - 4; dx <= R_OUTER + 4; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (!inBounds(gx, gy)) continue;
      const r = Math.sqrt(dx*dx + dy*dy);
      if (r <= R_OUTER + 3) {
        grid[idx(gx, gy)] = T_SAND;
      }
    }
  }

  // Outer ring wall
  for (let dy = -R_OUTER - 1; dy <= R_OUTER + 1; dy++) {
    for (let dx = -R_OUTER - 1; dx <= R_OUTER + 1; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (!inBounds(gx, gy)) continue;
      const r = Math.sqrt(dx*dx + dy*dy);
      if (r >= R_OUTER - WALL_W && r <= R_OUTER) {
        grid[idx(gx, gy)] = T_WALL;
      }
    }
  }

  // Gate gap — west side (sea-facing), 4 cells wide
  for (let g = -2; g <= 2; g++) {
    const gx = cx - R_OUTER, gy = cy + g;
    if (inBounds(gx, gy)) grid[idx(gx, gy)] = T_SAND;
    if (inBounds(gx+1, gy)) grid[idx(gx+1, gy)] = T_SAND;
  }

  // Four corner turrets
  const turretPositions = [
    [-R_OUTER + 1, -R_OUTER + 1],
    [ R_OUTER - 1, -R_OUTER + 1],
    [-R_OUTER + 1,  R_OUTER - 1],
    [ R_OUTER - 1,  R_OUTER - 1],
  ];
  const TR = Math.floor(R_OUTER * 0.3);
  for (const [tx, ty] of turretPositions) {
    for (let dy2 = -TR; dy2 <= TR; dy2++) {
      for (let dx2 = -TR; dx2 <= TR; dx2++) {
        const gx = cx + tx + dx2, gy = cy + ty + dy2;
        if (!inBounds(gx, gy)) continue;
        const r2 = Math.sqrt(dx2*dx2 + dy2*dy2);
        if (r2 <= TR) grid[idx(gx, gy)] = T_WALL;
      }
    }
  }

  // Inner keep (small central wall square)
  const KR = Math.floor(R_INNER * 0.55);
  for (let dy2 = -KR; dy2 <= KR; dy2++) {
    for (let dx2 = -KR; dx2 <= KR; dx2++) {
      const gx = cx + dx2, gy = cy + dy2;
      if (!inBounds(gx, gy)) continue;
      const edge = Math.abs(dx2) >= KR - 1 || Math.abs(dy2) >= KR - 1;
      if (edge) grid[idx(gx, gy)] = T_WALL;
    }
  }

  // Short sea-facing walls — angled like a chevron to deflect waves
  const chevronLen = Math.floor(R_OUTER * 0.55);
  for (let i = 0; i < chevronLen; i++) {
    // upper arm
    const ux = cx - R_OUTER - i - 2;
    const uy = cy - Math.floor(i * 0.7) - 3;
    if (inBounds(ux, uy)) grid[idx(ux, uy)] = T_WALL;
    if (inBounds(ux, uy+1)) grid[idx(ux, uy+1)] = T_WALL;
    // lower arm
    const lx = cx - R_OUTER - i - 2;
    const ly = cy + Math.floor(i * 0.7) + 3;
    if (inBounds(lx, ly)) grid[idx(lx, ly)] = T_WALL;
    if (inBounds(lx, ly-1)) grid[idx(lx, ly-1)] = T_WALL;
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  canvas = document.getElementById('canvas');
  ctx = canvas.getContext('2d');

  resize();
  window.addEventListener('resize', resize);

  setupInput();
  setupButtons();

  reset();
  requestAnimationFrame(loop);
}

function resize() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  // Keep same logical grid if already initialised
  const newGW = Math.floor(canvas.width  / CELL);
  const newGH = Math.floor(canvas.height / CELL);
  if (newGW !== GW || newGH !== GH) {
    GW = newGW; GH = newGH;
    if (grid) reset();
  }
}

function reset() {
  const size = GW * GH;
  grid        = new Uint8Array(size);
  erosionAcc  = new Float32Array(size);
  wetness     = new Float32Array(size);
  flashEnergy = new Float32Array(size);
  wavefronts  = [];
  wavesSent   = 0;
  totalErosion = 0;
  lastWaveTime = performance.now();

  // Shore: left 18% is open water, then beach gradient
  const shoreStart = Math.floor(GW * 0.18);
  const shoreEnd   = Math.floor(GW * 0.32);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      if (x >= shoreEnd) {
        grid[idx(x, y)] = T_SAND;
      } else if (x >= shoreStart) {
        // Irregular shoreline
        const noise = Math.sin(y * 0.18) * 3 + Math.sin(y * 0.07 + x * 0.11) * 2;
        const shore = shoreStart + (shoreEnd - shoreStart) * ((x - shoreStart) / (shoreEnd - shoreStart));
        grid[idx(x, y)] = (x >= shore + noise) ? T_SAND : T_WATER;
      }
      // else water
    }
  }

  seedCastle();

  initialWallCount = 0;
  for (let i = 0; i < size; i++) {
    if (grid[i] === T_WALL) initialWallCount++;
  }

  updateModeButton();
}

// ── Wave generation ────────────────────────────────────────────────────────────

function spawnWave() {
  // Spawn a wavefront along the left edge, slightly inside water
  const spawnX = 3;
  const segs = [];
  // Rays equally spaced vertically covering full height
  for (let i = 0; i < NUM_RAYS; i++) {
    const py = (i + 0.5) * (GH / NUM_RAYS);
    // Slight angle variation to simulate ocean variability
    const angleOff = (Math.random() - 0.5) * 0.08;
    const dx = Math.cos(angleOff);
    const dy = Math.sin(angleOff);
    segs.push(new Segment(spawnX, py, dx, dy, 0.9 + Math.random() * 0.1));
  }
  wavefronts.push(new WaveFront(segs));
  wavesSent++;
  lastWaveTime = performance.now();
}

// ── Simulation step ────────────────────────────────────────────────────────────

function step(dt) {
  const dtFactor = dt / 16.67; // normalise to 60fps

  // Decay wetness and flash
  for (let i = 0; i < GW * GH; i++) {
    if (wetness[i] > 0)     wetness[i]     = Math.max(0, wetness[i] - WET_DECAY * dtFactor);
    if (flashEnergy[i] > 0) flashEnergy[i] = Math.max(0, flashEnergy[i] - FLASH_DECAY * dtFactor);
  }

  // Advance wavefronts
  const newFronts = [];
  let totalSegs = 0;

  for (const wf of wavefronts) {
    if (!wf.alive) continue;
    wf.age++;
    const newSegs = [];

    for (const seg of wf.segments) {
      if (seg.dead) continue;
      if (totalSegs >= MAX_SEGS) { seg.dead = true; continue; }

      seg.ppx = seg.px; seg.ppy = seg.py;

      const speed = speedAt(seg.px, seg.py) * dtFactor;
      const nx = seg.px + seg.dx * speed;
      const ny = seg.py + seg.dy * speed;

      const cx = Math.floor(nx), cy = Math.floor(ny);

      if (!inBounds(cx, cy)) { seg.dead = true; continue; }

      const t = cellType(cx, cy);

      if (t === T_WALL) {
        // Reflect off wall
        const wallNormal = computeWallNormal(cx, cy, seg.dx, seg.dy);
        if (wallNormal) {
          const dot = seg.dx * wallNormal.nx + seg.dy * wallNormal.ny;
          seg.dx = seg.dx - 2 * dot * wallNormal.nx;
          seg.dy = seg.dy - 2 * dot * wallNormal.ny;
          // Stay in place this tick, lose energy
          seg.energy *= (1 - REFLECT_LOSS);
          // Impact flash
          applyImpact(cx, cy, seg.energy * 1.5);
        } else {
          seg.dead = true;
        }
        seg.energy *= (1 - REFLECT_LOSS * 0.5);

      } else {
        // Move forward
        seg.px = nx; seg.py = ny;
        seg.age++;
        seg.energy -= ENERGY_DISSIPATE * speed;

        if (t === T_SAND) {
          seg.energy *= SAND_SLOW;
          // Wet the sand
          const i2 = idx(cx, cy);
          wetness[i2] = Math.min(1, wetness[i2] + seg.energy * 0.4);
          flashEnergy[i2] = Math.min(1, flashEnergy[i2] + seg.energy * 0.25);
          // Accumulate erosion
          erosionAcc[i2] += seg.energy * 0.6;
          if (erosionAcc[i2] >= EROSION_THRESHOLD) {
            erodeSand(cx, cy, seg.dx, seg.dy, seg.energy);
            erosionAcc[i2] = 0;
          }
        }

        // Huygens diffraction: occasionally spawn secondary wavelets at edges
        if (t === T_WATER && Math.random() < 0.012 * seg.energy) {
          const spreadAngle = (Math.random() - 0.5) * SEG_SPLIT_ANGLE * 2;
          const cos = Math.cos(spreadAngle), sin2 = Math.sin(spreadAngle);
          const ndx = seg.dx * cos - seg.dy * sin2;
          const ndy = seg.dx * sin2 + seg.dy * cos;
          const child = new Segment(seg.px, seg.py, ndx, ndy, seg.energy * 0.25);
          newSegs.push(child);
          seg.energy *= 0.92;
        }
      }

      if (seg.energy < MIN_ENERGY) seg.dead = true;
      if (inBounds(Math.floor(seg.px), Math.floor(seg.py)) &&
          Math.floor(seg.px) >= GW - 2) {
        seg.dead = true;
      }
      if (!seg.dead) totalSegs++;
    }

    // Merge new secondary segments into the front
    wf.segments.push(...newSegs);
    // Cull dead
    wf.segments = wf.segments.filter(s => !s.dead);
    if (wf.segments.length > 0) newFronts.push(wf);
  }

  wavefronts = newFronts;

  // Wall erosion from heavy repeated wave impact
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i2 = idx(x, y);
      if (grid[i2] === T_WALL && erosionAcc[i2] >= WALL_THRESHOLD) {
        grid[i2] = T_SAND;
        erosionAcc[i2] = 0;
        totalErosion++;
      }
    }
  }

  // Slump unstable sand
  slump();
}

function computeWallNormal(wx, wy, dx, dy) {
  // Check neighbouring cells to find which face was hit
  const candidates = [
    { nx: -1, ny: 0 }, { nx: 1, ny: 0 },
    { nx: 0,  ny: -1 }, { nx: 0, ny: 1 },
  ];
  // The normal should point roughly opposite to the incoming direction
  let bestDot = 0, bestN = null;
  for (const c of candidates) {
    const nx2 = wx + c.nx, ny2 = wy + c.ny;
    if (!inBounds(nx2, ny2) || cellType(nx2, ny2) !== T_WALL) {
      // This face is exposed — its outward normal is c
      const dot = -(dx * c.nx + dy * c.ny); // should be positive if hitting this face
      if (dot > bestDot) { bestDot = dot; bestN = c; }
    }
  }
  return bestN ? { nx: bestN.nx, ny: bestN.ny } : null;
}

function applyImpact(cx, cy, energy) {
  // Splash in a small radius
  const r = 2;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const gx = cx + dx, gy = cy + dy;
      if (!inBounds(gx, gy)) continue;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const e2 = energy * Math.max(0, 1 - dist / r);
      const i2 = idx(gx, gy);
      flashEnergy[i2] = Math.min(1, flashEnergy[i2] + e2 * 0.5);
      wetness[i2] = Math.min(1, wetness[i2] + e2 * 0.3);
      if (grid[i2] === T_WALL) {
        erosionAcc[i2] += e2 * 0.4;
      }
    }
  }
}

function erodeSand(cx, cy, dx, dy, energy) {
  if (cellType(cx, cy) !== T_SAND) return;
  grid[idx(cx, cy)] = T_WATER;
  totalErosion++;
  flashEnergy[idx(cx, cy)] = Math.min(1, flashEnergy[idx(cx, cy)] + 0.8);

  // Transport sand downstream
  let tx = Math.round(cx + dx * TRANSPORT_DIST);
  let ty = Math.round(cy + dy * TRANSPORT_DIST);
  tx = Math.max(0, Math.min(GW - 1, tx));
  ty = Math.max(0, Math.min(GH - 1, ty));

  if (cellType(tx, ty) === T_WATER) {
    // Deposit sand
    grid[idx(tx, ty)] = T_SAND;
  } else if (cellType(tx, ty) === T_SAND && energy < 0.2) {
    // Build up
    // (already sand, just leave it)
  }
}

function slump() {
  // Very lightweight slump: scan a random subset of cells
  const samples = Math.floor(GW * GH * 0.003);
  for (let s = 0; s < samples; s++) {
    const x = Math.floor(Math.random() * GW);
    const y = Math.floor(Math.random() * GH);
    if (grid[idx(x, y)] !== T_SAND) continue;
    // Check 4-neighbours
    const neighbours = [
      [x-1,y],[x+1,y],[x,y-1],[x,y+1]
    ];
    for (const [nx, ny] of neighbours) {
      if (!inBounds(nx, ny)) continue;
      if (grid[idx(nx, ny)] === T_WATER) {
        // Sand cell next to water — may slump in
        if (Math.random() < SLUMP_RATIO * 0.02) {
          grid[idx(x, y)] = T_WATER;
          break;
        }
      }
    }
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────────

// Colour palette
const COL_DEEP    = [8,   20,  45];
const COL_SHALLOW = [15,  55,  90];
const COL_SAND    = [194, 168, 110];
const COL_SAND_WET= [140, 120, 75];
const COL_WALL    = [80,  80,  90];
const COL_WALL_WET= [100, 130, 160];
const COL_FLASH   = [220, 240, 255];

function lerpRGB(a, b, t) {
  return [
    a[0] + (b[0]-a[0])*t | 0,
    a[1] + (b[1]-a[1])*t | 0,
    a[2] + (b[2]-a[2])*t | 0,
  ];
}

function rgbStr(r,g,b,a) {
  if (a !== undefined) return `rgba(${r},${g},${b},${a})`;
  return `rgb(${r},${g},${b})`;
}

function render() {
  const W = canvas.width, H = canvas.height;
  const imageData = ctx.createImageData(W, H);
  const data = imageData.data;

  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const i2 = idx(x, y);
      const t  = grid[i2];
      const w  = wetness[i2];
      const f  = flashEnergy[i2];

      let base;
      if (t === T_WATER) {
        // Depth tint by x position
        const depthT = Math.min(1, x / (GW * 0.25));
        base = lerpRGB(COL_DEEP, COL_SHALLOW, depthT);
        // Wave ripple on water near wavefronts
        base = lerpRGB(base, [30, 110, 160], w * 0.6);
      } else if (t === T_SAND) {
        base = lerpRGB(COL_SAND, COL_SAND_WET, w);
      } else {
        base = lerpRGB(COL_WALL, COL_WALL_WET, w * 0.6);
      }

      // Flash overlay
      if (f > 0) {
        base = lerpRGB(base, COL_FLASH, f * 0.75);
      }

      // Pixel write — each cell is CELL×CELL pixels
      const px0 = x * CELL, py0 = y * CELL;
      for (let py = py0; py < py0 + CELL && py < H; py++) {
        for (let px = px0; px < px0 + CELL && px < W; px++) {
          const off = (py * W + px) * 4;
          data[off]   = base[0];
          data[off+1] = base[1];
          data[off+2] = base[2];
          data[off+3] = 255;
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);

  // Draw wavefront segments as lines
  renderWavefronts();

  // Draw brush preview
  renderBrushPreview();
}

function renderWavefronts() {
  for (const wf of wavefronts) {
    const segs = wf.segments;
    if (segs.length === 0) continue;

    // Sort segments by their Y position to draw connected lines
    // We draw each segment as a small line from prev to current position
    // and connect adjacent segments with polyline

    // Draw individual segment traces
    for (const seg of segs) {
      const energy = seg.energy;
      const alpha = Math.min(1, energy * 1.5);

      // Segment velocity line (trail)
      ctx.beginPath();
      ctx.moveTo(seg.ppx * CELL + CELL/2, seg.ppy * CELL + CELL/2);
      ctx.lineTo(seg.px  * CELL + CELL/2, seg.py  * CELL + CELL/2);
      const r = 100 + (wf.hue - 180) * 0.5 | 0;
      ctx.strokeStyle = `rgba(${r}, 200, 255, ${alpha * 0.5})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw wavefront polyline — connect sorted segments
    if (segs.length > 2) {
      const sorted = [...segs].sort((a, b) => a.py - b.py);
      ctx.beginPath();
      ctx.moveTo(sorted[0].px * CELL + CELL/2, sorted[0].py * CELL + CELL/2);
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i-1], cur = sorted[i];
        // Only connect if segments are reasonably close
        const dist = Math.hypot(cur.px - prev.px, cur.py - prev.py);
        if (dist < 8) {
          ctx.lineTo(cur.px * CELL + CELL/2, cur.py * CELL + CELL/2);
        } else {
          ctx.moveTo(cur.px * CELL + CELL/2, cur.py * CELL + CELL/2);
        }
      }
      const avgE = segs.reduce((s, sg) => s + sg.energy, 0) / segs.length;
      const alpha = Math.min(0.9, avgE * 2.0);
      ctx.strokeStyle = `rgba(120, 200, 255, ${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function renderBrushPreview() {
  if (!lastMouse) return;
  const {x, y} = lastMouse;
  const r = brushSize * CELL;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  const col = eraseMode ? 'rgba(255,80,80,0.4)' :
              brushMode === 'wall' ? 'rgba(160,160,200,0.5)' :
              'rgba(220,190,100,0.4)';
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

// ── Input ──────────────────────────────────────────────────────────────────────

function setupInput() {
  canvas.addEventListener('mousedown', e => {
    mouseDown = true;
    eraseMode = e.shiftKey;
    paintAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', e => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (mouseDown) {
      eraseMode = e.shiftKey;
      paintAt(e.clientX, e.clientY);
    }
  });
  canvas.addEventListener('mouseup', () => { mouseDown = false; });
  canvas.addEventListener('mouseleave', () => { mouseDown = false; lastMouse = null; });

  // Touch support
  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    mouseDown = true;
    const t = e.touches[0];
    lastMouse = { x: t.clientX, y: t.clientY };
    paintAt(t.clientX, t.clientY);
  });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.touches[0];
    lastMouse = { x: t.clientX, y: t.clientY };
    if (mouseDown) paintAt(t.clientX, t.clientY);
  });
  canvas.addEventListener('touchend', () => { mouseDown = false; });

  window.addEventListener('keydown', e => {
    if (e.key === 'p' || e.key === 'P') togglePause();
    if (e.key === 'r' || e.key === 'R') reset();
    if (e.key === 'w' || e.key === 'W') spawnWave();
    if (e.key === '1') setBrushMode('sand');
    if (e.key === '2') setBrushMode('wall');
    if (e.key === '[') brushSize = Math.max(1, brushSize - 1);
    if (e.key === ']') brushSize = Math.min(12, brushSize + 1);
  });
}

function paintAt(mx, my) {
  const gx = Math.floor(mx / CELL);
  const gy = Math.floor(my / CELL);
  const r = brushSize;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx*dx + dy*dy > r*r) continue;
      const x = gx + dx, y = gy + dy;
      if (!inBounds(x, y)) continue;
      const i2 = idx(x, y);
      if (eraseMode) {
        grid[i2] = T_WATER;
        erosionAcc[i2] = 0;
      } else {
        grid[i2] = brushMode === 'wall' ? T_WALL : T_SAND;
      }
    }
  }
}

function setBrushMode(mode) {
  brushMode = mode;
  document.getElementById('mode-text').textContent = mode.toUpperCase();
  updateModeButton();
}

function updateModeButton() {
  document.getElementById('btn-mode').textContent =
    `BRUSH: ${brushMode.toUpperCase()}`;
}

function togglePause() {
  paused = !paused;
  document.getElementById('btn-pause').textContent = paused ? 'PLAY' : 'PAUSE';
}

function setupButtons() {
  document.getElementById('btn-reset').addEventListener('click', reset);
  document.getElementById('btn-pause').addEventListener('click', togglePause);
  document.getElementById('btn-wave').addEventListener('click', spawnWave);
  document.getElementById('btn-mode').addEventListener('click', () => {
    setBrushMode(brushMode === 'sand' ? 'wall' : 'sand');
  });
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function updateMetrics(now) {
  fpsFrames++;
  fpsAccum += now - lastFrame;
  if (fpsAccum >= 500) {
    fps = Math.round(fpsFrames * 1000 / fpsAccum);
    fpsFrames = 0;
    fpsAccum  = 0;
  }

  const totalSegs = wavefronts.reduce((s, wf) => s + wf.segments.length, 0);

  document.getElementById('m-fronts').textContent = wavefronts.length;
  document.getElementById('m-segs').textContent   = totalSegs;
  document.getElementById('m-erosion').textContent = totalErosion;
  document.getElementById('m-waves').textContent  = wavesSent;
  document.getElementById('m-fps').textContent    = fps;

  // Castle HP: fraction of original walls still standing
  let walls = 0;
  for (let i = 0; i < GW * GH; i++) {
    if (grid[i] === T_WALL) walls++;
  }
  const hp = initialWallCount > 0
    ? Math.round(100 * walls / initialWallCount)
    : 100;
  document.getElementById('m-hp').textContent = `${hp}%`;

  // Wave countdown
  const nextWave = Math.max(0, WAVE_INTERVAL - (now - lastWaveTime));
  document.getElementById('wave-countdown').textContent =
    (nextWave / 1000).toFixed(1);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function loop(now) {
  const dt = Math.min(now - lastFrame, 50); // cap dt
  lastFrame = now;

  if (!paused) {
    step(dt);

    // Auto-spawn waves
    if (now - lastWaveTime >= WAVE_INTERVAL) {
      spawnWave();
    }
  }

  render();
  updateMetrics(now);

  requestAnimationFrame(loop);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
