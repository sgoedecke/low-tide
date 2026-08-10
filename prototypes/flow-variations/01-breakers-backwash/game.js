// game.js – Variation 1: Breakers & Backwash  (Lagrangian–Eulerian hybrid)
// ==========================================================================
// Architecture: Lagrangian particles are AUTHORITATIVE for water transport.
//
// Each frame:
//   1. maintainOcean       — keep ocean zone filled with ambient particles
//   2. injectWaveParticles — burst-spawn wave packet during INCOMING/RUNUP
//   3. updateParticles     — physics: surface-slope force, drag, collide, erode
//   4. rasterise           — splat particles -> depth / vx / vy / sediment
//   5. smoothDepth         — 2-pass box blur for smooth visual coverage
//   6. slumpTerrain / updateFoam / updateTracers
//
// Removed: BFS channel solver, semi-Lagrangian field advection,
//          instant channel-ingress propagation, field-only depth transport.
// Channels fill naturally: excavated cells have negative terrain, creating a
// strong surface-slope gradient that pulls particles in with finite travel time.
// ==========================================================================
(function () {
'use strict';

// -- GRID ------------------------------------------------------------------
const BASE_GW      = 200;
const BASE_GH      = 125;
const GW           = 240;
const GH           = 150;
const N            = GW * GH;
const GRID_SCALE_X = GW / BASE_GW;
const GRID_SCALE_Y = GH / BASE_GH;
const GRID_SCALE   = (GRID_SCALE_X + GRID_SCALE_Y) * 0.5;
const OCEAN_WIDTH  = Math.round(GW * 0.17);
const MIN_TERRAIN  = -0.22;

function gridX(v)      { return Math.round(v * GRID_SCALE_X); }
function gridY(v)      { return Math.round(v * GRID_SCALE_Y); }
function gridRadius(v) { return Math.max(1, Math.round(v * GRID_SCALE)); }

// -- TERRAIN & STATIC FIELDS -----------------------------------------------
const terrain   = new Float32Array(N);   // sand height (true simulation state)
const foam      = new Float32Array(N);   // grid foam (velocity-driven, for render)

// -- DERIVED RASTER FIELDS --------------------------------------------------
// depth / vx / vy / sediment are computed from particles each frame.
// The renderer reads these identically to the original code.
const depth    = new Float32Array(N);
const sediment = new Float32Array(N);
const vx       = new Float32Array(N);
const vy       = new Float32Array(N);

const origTerrain    = new Float32Array(N);
let   initCastleMass = 0;

// -- PARTICLE POOL (typed arrays + free-list stack) ------------------------
const MAX_P    = 5000;
const pX       = new Float32Array(MAX_P);   // position x  (grid coords)
const pY       = new Float32Array(MAX_P);   // position y
const pVx      = new Float32Array(MAX_P);   // velocity x
const pVy      = new Float32Array(MAX_P);   // velocity y
const pVol     = new Float32Array(MAX_P);   // splatting volume weight
const pSed     = new Float32Array(MAX_P);   // carried sediment (0-1)
const pFm      = new Float32Array(MAX_P);   // foam / kinetic energy (0-1)
const pAge     = new Int16Array(MAX_P);     // age in frames
const pLive    = new Uint8Array(MAX_P);     // alive flag

const pFreeStk = new Int32Array(MAX_P);     // stack of free indices
let   pFreeN   = 0;
let   nLive    = 0;

function pInit() {
  pLive.fill(0); pFreeN = 0; nLive = 0;
  for (let i = MAX_P - 1; i >= 0; i--) pFreeStk[pFreeN++] = i;
}

function pSpawn(x, y, vxv, vyv, vol, sed, fm) {
  if (pFreeN === 0) return;
  const i = pFreeStk[--pFreeN];
  pX[i] = x;  pY[i] = y;
  pVx[i] = vxv; pVy[i] = vyv;
  pVol[i] = vol; pSed[i] = sed; pFm[i] = fm;
  pAge[i] = 0; pLive[i] = 1;
  nLive++;
}

function pDie(i) {
  if (!pLive[i]) return;
  pLive[i] = 0; pFreeStk[pFreeN++] = i; nLive--;
}

// -- SPLAT KERNEL -----------------------------------------------------------
// Circular, linear-falloff kernel of radius SPLAT_R.
// Weights normalised to sum=1 so each particle contributes pVol*DEPTH_SCALE
// total depth-units spread smoothly across neighbouring cells.
const SPLAT_R = 3;
const _kDI = [], _kDJ = [], _kW = [];
let   SK_N  = 0;
(function buildKernel() {
  let ws = 0;
  for (let dj = -SPLAT_R; dj <= SPLAT_R; dj++) {
    for (let di = -SPLAT_R; di <= SPLAT_R; di++) {
      const d = Math.sqrt(di * di + dj * dj);
      if (d > SPLAT_R) continue;
      const w = 1 - d / SPLAT_R;
      _kDI.push(di); _kDJ.push(dj); _kW.push(w);
      ws += w; SK_N++;
    }
  }
  for (let s = 0; s < SK_N; s++) _kW[s] /= ws;
})();
const SK_DI = new Int8Array(_kDI);
const SK_DJ = new Int8Array(_kDJ);
const SK_W  = new Float32Array(_kW);

// -- RASTERISATION ACCUMULATORS --------------------------------------------
const velWX  = new Float32Array(N);
const velWY  = new Float32Array(N);
const volAcc = new Float32Array(N);
const sedAcc = new Float32Array(N);
const smBuf  = new Float32Array(N);

// -- PARTICLE / WAVE CONSTANTS ---------------------------------------------
const DEPTH_SCALE     = 5.0;   // depth contributed by one vol=1 particle
const OCEAN_P_TARGET  = 900;   // steady-state count in ocean zone
const P_VOL_OCEAN     = 0.80;  // volume of an ambient ocean particle
const P_VOL_WAVE      = 2.20;  // volume of a wave-injected particle
const P_MAX_AGE       = 380;   // frames before a beach particle expires
const P_SURF_PRESS    = 0.40;  // -(nabla surface) force coefficient
const P_DRAG_FLUID    = 0.984; // velocity multiplier per frame in water
const P_DRAG_SAND     = 0.905; // velocity multiplier per frame on sandy bed
const P_MAX_VEL       = 6.0 * GRID_SCALE;
const P_BKWSH_FORCE   = 0.055 * GRID_SCALE;  // seaward body force, BACKWASH
const P_DRAIN_FORCE   = 0.022 * GRID_SCALE;  // seaward body force, DRAIN
const WAVE_SPAWN_PEAK = 30;   // particles/frame at peak injection

// -- PHASE STATE MACHINE ---------------------------------------------------
const PHASE       = { IDLE: 0, INCOMING: 1, RUNUP: 2, BACKWASH: 3, DRAIN: 4 };
const PHASE_NAMES = ['Idle', 'Breaker', 'Run-Up', 'Backwash', 'Drain'];
const PHASE_DUR   = [100, 55, 40, 70, 50];

let phase     = PHASE.IDLE;
let phaseTick = 0;

// -- PARAMETERS (unchanged subset used by rendering / erosion / terrain) ---
const P = {
  dt:               0.5,
  slumpRate:        0.042,
  maxSlope:         0.28,
  foamThresh:       1.3  * GRID_SCALE,
  foamDecay:        0.942,
  blockH:           0.68,
  frictionBase:     0.55,
  maxVel:           P_MAX_VEL,
  impactErosion:    0.0055 / GRID_SCALE,
  rillErosion:      0.0035 / GRID_SCALE,
  rillConcavity:    0.65,
  depositRate:      0.0028,
  depositThreshIn:  0.70 * GRID_SCALE,
  depositThreshOut: 0.45 * GRID_SCALE,
  ambientVx:        0.28 * GRID_SCALE,
  incomingVx:       4.2  * GRID_SCALE,
  runupVx:          1.6  * GRID_SCALE,
};

// -- RUNTIME STATE ---------------------------------------------------------
let paused          = false;
let frameNum        = 0;
let waveCount       = 0;
let erosionTotal    = 0;
let depositionTotal = 0;
let manualWave      = false;

let fpsFrames = 0, fpsTime = performance.now(), currentFps = 0;
let mouseDown = false, mouseRight = false;
let lastBrushGX = -1, lastBrushGY = -1;
const BRUSH_R  = gridRadius(4);
const BRUSH_R2 = BRUSH_R * BRUSH_R;

// -- CANVAS SETUP ----------------------------------------------------------
const canvas    = document.getElementById('canvas');
const ctx       = canvas.getContext('2d');
const offscreen = document.createElement('canvas');
offscreen.width  = GW;
offscreen.height = GH;
const offCtx  = offscreen.getContext('2d');
const imgData = offCtx.createImageData(GW, GH);
const pixels  = imgData.data;
let renderPixelRatio = 1;

function resizeCanvas() {
  renderPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = Math.max(1, Math.round(window.innerWidth  * renderPixelRatio));
  canvas.height = Math.max(1, Math.round(window.innerHeight * renderPixelRatio));
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// -- TRACERS (visual layer -- follow derived velocity field) ---------------
const NUM_TRACERS = 620;
const TRAIL_LEN   = 12;
let   tracers     = [];

function newTracer() {
  return {
    x:       Math.random() * gridX(14),
    y:       Math.random() * GH,
    life:    (Math.random() * 55) | 0,
    maxLife: 45 + ((Math.random() * 65) | 0),
    trail:   [],
  };
}

function initTracers() {
  tracers = [];
  for (let i = 0; i < NUM_TRACERS; i++) tracers.push(newTracer());
}

function updateTracers() {
  for (let i = 0; i < tracers.length; i++) {
    const tr = tracers[i];
    tr.life++;
    const ix  = Math.min(GW - 1, Math.max(0, tr.x | 0));
    const iy  = Math.min(GH - 1, Math.max(0, tr.y | 0));
    const k   = iy * GW + ix;
    const spd = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);
    tr.trail.push({ x: tr.x, y: tr.y, spd, ph: phase });
    if (tr.trail.length > TRAIL_LEN) tr.trail.shift();
    tr.x += vx[k] * 0.55;
    tr.y += vy[k] * 0.55;
    const dead = tr.life > tr.maxLife
              || tr.x < 0 || tr.x >= GW
              || tr.y < 0 || tr.y >= GH
              || terrain[k] > P.blockH;
    if (dead) tracers[i] = newTracer();
  }
}

// -- UTILITY ---------------------------------------------------------------
// Bilinear sample -- solid cells contribute zero (no-slip for tracers).
function bsample(f, x, y) {
  x = x < 0.5 ? 0.5 : (x > GW - 1.5 ? GW - 1.5 : x);
  y = y < 0.5 ? 0.5 : (y > GH - 1.5 ? GH - 1.5 : y);
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1, y1 = y0 + 1;
  const sx = x - x0, sy = y - y0;
  let w00 = (1 - sx) * (1 - sy), w10 = sx * (1 - sy);
  let w01 = (1 - sx) * sy,       w11 = sx * sy;
  const k00 = y0 * GW + x0, k10 = y0 * GW + x1;
  const k01 = y1 * GW + x0, k11 = y1 * GW + x1;
  if (terrain[k00] > P.blockH) w00 = 0;
  if (terrain[k10] > P.blockH) w10 = 0;
  if (terrain[k01] > P.blockH) w01 = 0;
  if (terrain[k11] > P.blockH) w11 = 0;
  const wt = w00 + w10 + w01 + w11;
  if (wt < 1e-7) return 0;
  return (w00 * f[k00] + w10 * f[k10] + w01 * f[k01] + w11 * f[k11]) / wt;
}

// -- OCEAN MAINTENANCE -----------------------------------------------------
// Keeps the leftmost OCEAN_WIDTH columns stocked with ambient particles so
// the ocean stays visibly blue between waves.
function maintainOcean() {
  let oceanCount = 0;
  for (let i = 0; i < MAX_P; i++) {
    if (pLive[i] && pX[i] < OCEAN_WIDTH) oceanCount++;
  }
  const deficit   = OCEAN_P_TARGET - oceanCount;
  const spawnRate = deficit > 25 ? 25 : (deficit < 0 ? 0 : deficit);

  for (let s = 0; s < spawnRate; s++) {
    if (pFreeN === 0) break;
    const y = Math.random() * GH;
    const x = Math.random() * (OCEAN_WIDTH - 1) + 0.5;
    const k = ((y | 0) * GW + (x | 0));
    if (terrain[k] > P.blockH) continue;
    const ripple = Math.sin(frameNum * 0.035 + y * 0.08) * 0.15 * GRID_SCALE;
    const vxv    = P.ambientVx * (0.4 + Math.random() * 0.8) + ripple;
    const vyv    = (Math.random() - 0.5) * 0.35 * GRID_SCALE;
    pSpawn(x, y, vxv, vyv, P_VOL_OCEAN, 0, 0);
  }
}

// -- WAVE INJECTION --------------------------------------------------------
// Spawns coherent wave-packet particles from the left boundary.
// Particles travel inland under their own momentum and surface-slope pressure.
function injectWaveParticles() {
  const INJ = gridX(6);
  let spawnRate = 0, targetVx = 0, fm0 = 0, vol = P_VOL_WAVE;

  switch (phase) {
    case PHASE.INCOMING: {
      const tf  = phaseTick / PHASE_DUR[PHASE.INCOMING];
      const env = Math.min(1, tf * 3.5) * (1 - 0.15 * tf);
      spawnRate = Math.round(WAVE_SPAWN_PEAK * (0.15 + 0.85 * env));
      targetVx  = P.incomingVx * env;
      fm0       = 0.15 + env * 0.40;
      break;
    }
    case PHASE.RUNUP: {
      const tf  = phaseTick / PHASE_DUR[PHASE.RUNUP];
      spawnRate = Math.round(12 * (1 - tf));
      targetVx  = P.runupVx * (1 - tf * 0.7);
      fm0       = 0.05;
      vol       = P_VOL_WAVE * 0.65;
      break;
    }
    default: return;
  }

  for (let s = 0; s < spawnRate; s++) {
    if (pFreeN === 0) break;
    const y = Math.random() * GH;
    const x = Math.random() * INJ;
    const k = ((y | 0) * GW + (x | 0));
    if (terrain[k] > P.blockH) continue;
    const wobble = Math.sin(frameNum * 0.07 + y * (0.048 / GRID_SCALE_Y)) * 0.42 * GRID_SCALE;
    const sway   = Math.sin(frameNum * 0.05 + y * (0.058 / GRID_SCALE_Y)) * 0.30 * GRID_SCALE;
    pSpawn(x, y, targetVx + wobble, sway, vol, 0, fm0);
  }
}

// -- PER-PARTICLE EROSION & DEPOSITION ------------------------------------
// Fast particles over erodible terrain pick up sediment; slow ones deposit.
function pErode(i, k) {
  if (k < 0 || k >= N) return;
  const t   = terrain[k];
  const cvx = pVx[i], cvy = pVy[i];
  const spd = Math.sqrt(cvx * cvx + cvy * cvy);
  const inIncoming = (phase === PHASE.INCOMING || phase === PHASE.RUNUP);
  const inBackwash = (phase === PHASE.BACKWASH || phase === PHASE.DRAIN);

  if (t > 0.02 && spd > 0.15 * GRID_SCALE) {
    let rate;
    if (inIncoming) {
      rate = P.impactErosion * spd;
    } else {
      const i0 = k - 1, i1 = k + 1, i2 = k - GW, i3 = k + GW;
      const concavity = (i0 >= 0 && i1 < N && i2 >= 0 && i3 < N)
        ? Math.max(0, (terrain[i0] + terrain[i1] + terrain[i2] + terrain[i3]) * 0.25 - t)
        : 0;
      rate = P.rillErosion * spd * (1 + P.rillConcavity * concavity * 8);
    }
    const actual = t < rate ? t : rate;
    terrain[k] -= actual;
    pSed[i]     = Math.min(1, pSed[i] + actual * 5);
    erosionTotal += actual;
  }

  const sed        = pSed[i];
  const depositCap = inBackwash ? P.depositThreshOut : P.depositThreshIn;
  if (sed > 0.001 && spd < depositCap) {
    const deposit = P.depositRate * sed * (1 - spd / depositCap);
    terrain[k]   = terrain[k] + deposit < 1 ? terrain[k] + deposit : 1;
    pSed[i]     -= deposit;
    if (pSed[i] < 0) pSed[i] = 0;
    depositionTotal += deposit;
  }
}

// -- PARTICLE PHYSICS UPDATE -----------------------------------------------
// Reads depth[] from the PREVIOUS frame for pressure stability.
function updateParticles() {
  const dt = P.dt;

  for (let i = 0; i < MAX_P; i++) {
    if (!pLive[i]) continue;
    pAge[i]++;

    const x  = pX[i], y = pY[i];
    const gx = x < 1 ? 1 : (x > GW - 2 ? GW - 2 : x | 0);
    const gy = y < 1 ? 1 : (y > GH - 2 ? GH - 2 : y | 0);
    const k  = gy * GW + gx;

    // Surface-slope force: -(nabla)(terrain + depth) drives flow downhill.
    // Below-grade terrain (excavated channels) creates a strong gradient that
    // naturally draws particles in -- no BFS or instant-fill hack required.
    const sL = terrain[k - 1]  + depth[k - 1];
    const sR = terrain[k + 1]  + depth[k + 1];
    const sU = terrain[k - GW] + depth[k - GW];
    const sD = terrain[k + GW] + depth[k + GW];
    pVx[i] += (sL - sR) * 0.5 * P_SURF_PRESS;
    pVy[i] += (sU - sD) * 0.5 * P_SURF_PRESS;

    // Phase body forces: seaward acceleration during backwash / drain.
    if (phase === PHASE.BACKWASH)   pVx[i] -= P_BKWSH_FORCE;
    else if (phase === PHASE.DRAIN) pVx[i] -= P_DRAIN_FORCE;

    // Terrain drag
    const t = terrain[k];
    let drag = P_DRAG_FLUID;
    if (t > 0.02 && t < P.blockH) {
      drag = P_DRAG_FLUID - (P_DRAG_FLUID - P_DRAG_SAND) * (t / P.blockH);
    }
    pVx[i] *= drag;
    pVy[i] *= drag;

    // Speed cap
    const spd2 = pVx[i] * pVx[i] + pVy[i] * pVy[i];
    if (spd2 > P_MAX_VEL * P_MAX_VEL) {
      const sc = P_MAX_VEL / Math.sqrt(spd2);
      pVx[i] *= sc; pVy[i] *= sc;
    }

    // Integrate
    let nx = x + pVx[i] * dt;
    let ny = y + pVy[i] * dt;

    // Solid terrain collision: try full move, fall back to axis-only slides.
    const nxC = nx < 0 ? 0 : (nx > GW - 1 ? GW - 1 : nx);
    const nyC = ny < 0 ? 0 : (ny > GH - 1 ? GH - 1 : ny);
    if (terrain[(nyC | 0) * GW + (nxC | 0)] > P.blockH) {
      if (terrain[gy * GW + (nxC | 0)] <= P.blockH) {
        ny = y; pVy[i] *= -0.15;                   // slide in x
      } else if (terrain[(nyC | 0) * GW + gx] <= P.blockH) {
        nx = x; pVx[i] *= -0.15;                   // slide in y
      } else {
        nx = x; ny = y; pVx[i] *= 0.2; pVy[i] *= 0.2;  // fully blocked
      }
    }

    // Boundary conditions
    if (ny < 0)        { ny = 0.5;      pVy[i] =  Math.abs(pVy[i]) * 0.5; }
    else if (ny >= GH) { ny = GH - 0.5; pVy[i] = -Math.abs(pVy[i]) * 0.5; }
    if (nx < 0)        { nx = 0.5;      pVx[i] =  Math.abs(pVx[i]) * 0.4; }
    else if (nx >= GW) { pDie(i); continue; }

    pX[i] = nx; pY[i] = ny;

    pErode(i, (ny | 0) * GW + (nx | 0));

    // Per-particle foam energy
    const spd = Math.sqrt(pVx[i] * pVx[i] + pVy[i] * pVy[i]);
    if (spd > P.foamThresh * 0.7) pFm[i] = Math.min(1, pFm[i] + 0.018);
    pFm[i] *= 0.95;

    // Lifetime: beach particles expire; ocean-zone particles refresh age
    if (pAge[i] > P_MAX_AGE && pX[i] >= OCEAN_WIDTH) {
      pDie(i);
    } else if (pAge[i] > P_MAX_AGE * 4) {
      pAge[i] = 0;
    }
  }
}

// -- RASTERISATION ---------------------------------------------------------
// Splat each live particle onto the grid via the precomputed kernel.
function rasterise() {
  depth.fill(0);
  velWX.fill(0); velWY.fill(0);
  volAcc.fill(0); sedAcc.fill(0);

  for (let i = 0; i < MAX_P; i++) {
    if (!pLive[i]) continue;
    const cx  = pX[i] | 0;
    const cy  = pY[i] | 0;
    const vol = pVol[i];
    const svx = pVx[i], svy = pVy[i];
    const sed = pSed[i];

    for (let s = 0; s < SK_N; s++) {
      const gx = cx + SK_DI[s];
      const gy = cy + SK_DJ[s];
      if (gx < 0 || gx >= GW || gy < 0 || gy >= GH) continue;
      const k  = gy * GW + gx;
      if (terrain[k] > P.blockH) continue;
      const w    = SK_W[s] * vol;
      depth[k]  += w * DEPTH_SCALE;
      velWX[k]  += w * svx;
      velWY[k]  += w * svy;
      volAcc[k] += w;
      sedAcc[k] += w * sed;
    }
  }

  for (let k = 0; k < N; k++) {
    if (depth[k] > 1) depth[k] = 1;
    if (volAcc[k] > 1e-6) {
      vx[k]       = velWX[k] / volAcc[k];
      vy[k]       = velWY[k] / volAcc[k];
      sediment[k] = Math.min(1, sedAcc[k] / volAcc[k]);
    } else {
      vx[k] = 0; vy[k] = 0; sediment[k] = 0;
    }
  }
}

// Two-pass 3x3 box blur on depth for smooth, artifact-free water coverage.
function smoothDepth() {
  const inv9 = 1 / 9;
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < GH - 1; j++) {
      for (let i = 1; i < GW - 1; i++) {
        const k = j * GW + i;
        if (terrain[k] > P.blockH) { smBuf[k] = 0; continue; }
        smBuf[k] = (
          depth[k - GW - 1] + depth[k - GW] + depth[k - GW + 1] +
          depth[k - 1]      + depth[k]       + depth[k + 1]      +
          depth[k + GW - 1] + depth[k + GW]  + depth[k + GW + 1]
        ) * inv9;
      }
    }
    for (let j = 1; j < GH - 1; j++) {
      for (let i = 1; i < GW - 1; i++) {
        depth[j * GW + i] = smBuf[j * GW + i];
      }
    }
  }
}

// -- GRID FOAM (velocity-driven, decays each frame) -------------------------
function updateFoam() {
  for (let k = 0; k < N; k++) {
    if (depth[k] > 0.10) {
      const spd = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);
      if (spd > P.foamThresh) {
        const excess = Math.min(1, (spd - P.foamThresh) / (P.maxVel - P.foamThresh));
        foam[k] = Math.min(1, foam[k] + 0.012 + excess * 0.025);
      }
    }
    foam[k] *= P.foamDecay;
    if (foam[k] < 0.004) foam[k] = 0;
  }
}

// -- SAND SLUMPING ---------------------------------------------------------
function slumpTerrain() {
  const rate = P.slumpRate, ms = P.maxSlope;
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      const t = terrain[k];
      const nbs = [k - 1, k + 1, k - GW, k + GW];
      for (let n = 0; n < 4; n++) {
        const nb   = nbs[n];
        const diff = t - terrain[nb];
        if (diff > ms) {
          const move   = rate * (diff - ms);
          terrain[k]  -= move;
          terrain[nb] += move;
        }
      }
    }
  }
}

// -- PHASE ADVANCE ---------------------------------------------------------
function advancePhase() {
  phaseTick++;
  if (phaseTick >= PHASE_DUR[phase]) {
    phaseTick = 0;
    if (phase === PHASE.IDLE) return;
    phase++;
    if (phase > PHASE.DRAIN) { phase = PHASE.IDLE; manualWave = false; }
  }
}

function triggerWave() {
  if (phase !== PHASE.IDLE) return;
  phase = PHASE.INCOMING; phaseTick = 0; waveCount++; manualWave = false;
}

let autoWaveClock      = 0;
const AUTO_WAVE_PERIOD = 315;

// -- MAIN SIMULATION STEP --------------------------------------------------
function simulate() {
  if (phase === PHASE.IDLE) {
    autoWaveClock++;
    if (autoWaveClock >= AUTO_WAVE_PERIOD) { autoWaveClock = 0; triggerWave(); }
  }

  maintainOcean();
  injectWaveParticles();

  // updateParticles reads depth[] from the PREVIOUS frame for stable pressure.
  updateParticles();

  // Build fresh derived fields from updated particle positions.
  rasterise();
  smoothDepth();

  slumpTerrain();

  for (let k = 0; k < N; k++) {
    if (terrain[k] < MIN_TERRAIN) terrain[k] = MIN_TERRAIN;
    else if (terrain[k] > 1)     terrain[k] = 1;
  }

  updateFoam();
  updateTracers();
  advancePhase();
  frameNum++;
}

// -- CASTLE SEEDING --------------------------------------------------------

function setT(i, j, h) {
  if (i < 0 || i >= GW || j < 0 || j >= GH) return;
  const k = j * GW + i;
  if (h > terrain[k]) terrain[k] = h;
}

function seedBeach() {
  const beachEnd   = gridX(85);
  const wetZoneEnd = gridX(12);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < beachEnd; i++) {
      const h = 0.04 + (i / beachEnd) * 0.06 + Math.random() * 0.012;
      setT(i, j, h);
    }
  }
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < wetZoneEnd; i++) {
      terrain[j * GW + i] = 0.015 + Math.random() * 0.008;
    }
  }
}

function seedOuterBerm(cx, cy) {
  const x0b = cx - gridX(44), x1b = cx - gridX(38);
  const bermH = 0.36, gapH = 0.16;
  const gapRows   = [cy - gridY(8), cy, cy + gridY(8)];
  const gapRadius = gridY(1);
  for (let j = cy - gridY(22); j <= cy + gridY(22); j++) {
    const isGap = gapRows.some(gy => Math.abs(j - gy) <= gapRadius);
    const h     = isGap ? gapH + Math.random() * 0.05 : bermH + Math.random() * 0.05;
    for (let i = x0b; i <= x1b; i++) setT(i, j, h);
  }
}

function seedInnerWall(cx, cy) {
  const OW = gridX(20), OH = gridY(18);
  const WWX = gridX(3), WWY = gridY(3);
  const x0 = cx - OW, x1 = cx + OW;
  const y0 = cy - OH, y1 = cy + OH;
  const wallH = 0.58;
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const onL = i <= x0 + WWX - 1, onR = i >= x1 - WWX + 1;
      const onT = j <= y0 + WWY - 1, onB = j >= y1 - WWY + 1;
      if (!(onL || onR || onT || onB)) continue;
      if (onL && Math.abs(j - cy) <= gridY(5)) continue;
      if (onR && Math.abs(j - cy) <= gridY(3)) continue;
      setT(i, j, wallH + Math.random() * 0.06);
    }
  }
}

function seedInnerStructures(cx, cy) {
  const OW = gridX(20), OH = gridY(18);
  const x0 = cx - OW, x1 = cx + OW;
  const y0 = cy - OH, y1 = cy + OH;
  const TRX = gridX(5), TRY = gridY(5);
  const corners = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
  for (const [tx, ty] of corners) {
    for (let dj = -TRY; dj <= TRY; dj++) {
      for (let di = -TRX; di <= TRX; di++) {
        if (Math.abs(di) === TRX && Math.abs(dj) === TRY) continue;
        setT(tx + di, ty + dj, 0.80 + Math.random() * 0.10);
      }
    }
  }
  const KHX = gridX(7), KHY = gridY(7);
  for (let j = cy - KHY; j <= cy + KHY; j++) {
    for (let i = cx - KHX; i <= cx + KHX; i++) setT(i, j, 0.78 + Math.random() * 0.08);
  }
  const DHX = gridX(3), DHY = gridY(3);
  for (let j = cy - DHY; j <= cy + DHY; j++) {
    for (let i = cx - DHX; i <= cx + DHX; i++) setT(i, j, 0.90 + Math.random() * 0.06);
  }
}

function seedCastle() {
  terrain.fill(0);
  const cx = gridX(140), cy = gridY(62);
  seedBeach();
  seedOuterBerm(cx, cy);
  seedInnerWall(cx, cy);
  seedInnerStructures(cx, cy);
  for (let j = 0; j < GH; j++) {
    for (let i = cx + gridX(30); i < GW; i++) {
      const bv = Math.sin(i * 0.075 + j * 0.045) * 0.0025
               + Math.sin(i * 0.021 - j * 0.063) * 0.0015;
      setT(i, j, 0.069 + bv);
    }
  }
  origTerrain.set(terrain);
  initCastleMass = 0;
  for (let k = 0; k < N; k++) {
    if (origTerrain[k] > 0.45) initCastleMass += origTerrain[k];
  }
}

// -- RESET -----------------------------------------------------------------
function resetSimulation() {
  seedCastle();

  for (let i = 0; i < MAX_P; i++) if (pLive[i]) pDie(i);
  pInit();

  depth.fill(0); sediment.fill(0); foam.fill(0);
  vx.fill(0); vy.fill(0);
  velWX.fill(0); velWY.fill(0); volAcc.fill(0); sedAcc.fill(0); smBuf.fill(0);

  frameNum = 0; waveCount = 0; phase = PHASE.IDLE; phaseTick = 0;
  autoWaveClock = 0; manualWave = false;
  erosionTotal = 0; depositionTotal = 0;

  // Pre-fill the ocean zone so it looks full immediately.
  for (let s = 0; s < OCEAN_P_TARGET; s++) {
    if (pFreeN === 0) break;
    const y = Math.random() * GH;
    const x = Math.random() * (OCEAN_WIDTH - 1) + 0.5;
    const k = ((y | 0) * GW + (x | 0));
    if (terrain[k] > P.blockH) continue;
    const vxv = P.ambientVx * (0.3 + Math.random() * 0.9);
    const vyv = (Math.random() - 0.5) * 0.35 * GRID_SCALE;
    pSpawn(x, y, vxv, vyv, P_VOL_OCEAN, 0, 0);
  }

  rasterise();
  smoothDepth();
  initTracers();
}

// -- RENDERING -------------------------------------------------------------
// All rendering functions are unchanged -- they read the derived fields.

function waterColorRGB(speed, d, sed, oceanFactor) {
  const sn = speed < 0 ? 0 : (speed > P.maxVel ? 1 : speed / P.maxVel);
  let r, g, b;
  if (phase === PHASE.INCOMING || phase === PHASE.RUNUP) {
    r =   6 + 42  * sn;
    g =  64 + 105 * sn;
    b = 170 + 60  * sn;
  } else if (phase === PHASE.BACKWASH) {
    r =  55 + 140 * sn;
    g = 120 + 90  * sn;
    b = 140 + 60  * sn;
  } else if (phase === PHASE.DRAIN) {
    r =  70 + 110 * sn;
    g = 100 + 80  * sn;
    b = 120 + 50  * sn;
  } else {
    r =  15 + 55  * sn;
    g =  50 + 90  * sn;
    b = 170 + 50  * sn;
  }
  if (oceanFactor > 0) {
    const ob = oceanFactor * 0.88;
    r += (4   - r) * ob;
    g += (76  - g) * ob;
    b += (198 - b) * ob;
  }
  if (sed > 0.02) {
    const st = sed < 1 ? sed : 1;
    r = r + (195 - r) * st * 0.60;
    g = g + (150 - g) * st * 0.50;
    b = b + ( 55 - b) * st * 0.55;
  }
  return [r | 0, g | 0, b | 0];
}

function renderPixels() {
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k   = j * GW + i;
      const t   = terrain[k];
      const d   = depth[k];
      const f   = foam[k];
      const sed = sediment[k];
      const spd = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);
      let r, g, b;

      if (t > P.blockH) {
        const bright = 0.68 + 0.32 * t;
        r = (220 * bright) | 0;
        g = (198 * bright) | 0;
        b = (155 * bright) | 0;
      } else if (t > 0.32) {
        const bright = 0.55 + 0.45 * (t / P.blockH);
        r = (185 * bright) | 0;
        g = (170 * bright) | 0;
        b = (130 * bright) | 0;
      } else if (t > 0.08) {
        const bright = 0.72 + 0.28 * (t / 0.32);
        r = (212 * bright) | 0;
        g = (188 * bright) | 0;
        b = (138 * bright) | 0;
      } else if (t < 0) {
        const depression = Math.min(1, t / MIN_TERRAIN);
        r = (176 - 58 * depression) | 0;
        g = (151 - 48 * depression) | 0;
        b = (110 - 34 * depression) | 0;
      } else {
        const wetness = d < 1 ? d : 1;
        r = (205 - 30 * wetness) | 0;
        g = (180 - 24 * wetness) | 0;
        b = (132 - 20 * wetness) | 0;
      }

      if (d > 0.015) {
        const oceanFactor = Math.max(0, 1 - i / OCEAN_WIDTH);
        const depthAlpha  = d < 0.90 ? d * 1.15 : 0.99;
        const alpha       = Math.max(depthAlpha, oceanFactor * 0.84);
        const [wr, wg, wb] = waterColorRGB(spd, d, sed, oceanFactor);
        r = (r * (1 - alpha) + wr * alpha) | 0;
        g = (g * (1 - alpha) + wg * alpha) | 0;
        b = (b * (1 - alpha) + wb * alpha) | 0;
      }

      if (f > 0.04) {
        const fa = Math.min(0.34, Math.pow(Math.min(1, f), 1.35) * 0.34);
        r = (r + (188 - r) * fa) | 0;
        g = (g + (232 - g) * fa) | 0;
        b = (b + (242 - b) * fa) | 0;
      }

      const p = k << 2;
      pixels[p]     = r > 255 ? 255 : (r < 0 ? 0 : r);
      pixels[p + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
      pixels[p + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
      pixels[p + 3] = 255;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
}

function arrowColor(speed, ph) {
  const sn = speed / (4 * GRID_SCALE) > 1 ? 1 : speed / (4 * GRID_SCALE);
  const a  = (0.20 + 0.50 * sn).toFixed(2);
  switch (ph) {
    case PHASE.INCOMING: return `rgba(${(40 + 190 * sn)|0},${(190 + 60 * sn)|0},255,${a})`;
    case PHASE.RUNUP:    return `rgba(${(80 + 120 * sn)|0},${(220 + 30 * sn)|0},${(100 + 60 * sn)|0},${a})`;
    case PHASE.BACKWASH: return `rgba(${(230 + 20 * sn)|0},${(130 + 60 * sn)|0},${(30 + 40 * sn)|0},${a})`;
    case PHASE.DRAIN:    return `rgba(${(190 + 40 * sn)|0},${(120 + 50 * sn)|0},${(50 + 30 * sn)|0},${a})`;
    default:             return `rgba(${(40 + 100 * sn)|0},${(100 + 100 * sn)|0},${(200 + 40 * sn)|0},${a})`;
  }
}

function renderVelocityArrows(cw, ch) {
  const scaleX = cw / GW, scaleY = ch / GH;
  const STEP   = gridRadius(14);
  ctx.save();
  ctx.lineWidth = renderPixelRatio;
  for (let j = STEP / 2 | 0; j < GH; j += STEP) {
    const row    = Math.floor(j / STEP);
    const startI = (STEP / 2 + (row % 2) * STEP * 0.5) | 0;
    for (let i = startI; i < GW; i += STEP) {
      const k   = j * GW + i;
      const cvx = vx[k], cvy = vy[k];
      const spd = Math.sqrt(cvx * cvx + cvy * cvy);
      if (depth[k] < 0.045 || spd < 0.10 * GRID_SCALE) continue;
      const px  = i * scaleX, py = j * scaleY;
      const len = Math.min(spd, 2.8 * GRID_SCALE) * scaleX * 0.52;
      const ex  = px + (cvx / spd) * len;
      const ey  = py + (cvy / spd) * len;
      ctx.strokeStyle = arrowColor(spd, phase);
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
    }
  }
  ctx.restore();
}

function tracerColor(spd, ph) {
  const sn = spd / (3.5 * GRID_SCALE) > 1 ? 1 : spd / (3.5 * GRID_SCALE);
  switch (ph) {
    case PHASE.INCOMING: return [(100 + 140 * sn)|0, (200 + 50 * sn)|0, 255, sn];
    case PHASE.RUNUP:    return [(80  + 100 * sn)|0, (210 + 40 * sn)|0, (100 + 80 * sn)|0, sn];
    case PHASE.BACKWASH: return [(230 + 20  * sn)|0, (140 + 60 * sn)|0, ( 40 + 30 * sn)|0, sn];
    case PHASE.DRAIN:    return [(190 + 40  * sn)|0, (110 + 60 * sn)|0, ( 60 + 30 * sn)|0, sn];
    default:             return [( 60 + 80  * sn)|0, (130 + 80 * sn)|0, (200 + 40 * sn)|0, sn];
  }
}

function renderTracers(cw, ch) {
  const scaleX = cw / GW, scaleY = ch / GH;
  ctx.save();
  ctx.lineWidth = 1.2 * renderPixelRatio;
  for (const tr of tracers) {
    const tlen = tr.trail.length;
    if (tlen < 2) continue;
    for (let s = 1; s < tlen; s++) {
      const a = tr.trail[s - 1], b = tr.trail[s];
      const age   = s / tlen;
      const [cr, cg, cb, sn] = tracerColor(b.spd, b.ph);
      const alpha = age * (0.12 + 0.55 * sn);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(a.x * scaleX, a.y * scaleY);
      ctx.lineTo(b.x * scaleX, b.y * scaleY);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function castleHealth() {
  if (initCastleMass < 0.01) return 1;
  let m = 0;
  for (let k = 0; k < N; k++) {
    if (origTerrain[k] > 0.45) m += terrain[k];
  }
  const h = m / initCastleMass;
  return h < 0 ? 0 : (h > 1 ? 1 : h);
}

function render() {
  const cw = canvas.width, ch = canvas.height;
  renderPixels();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, 0, 0, cw, ch);
  renderVelocityArrows(cw, ch);
  renderTracers(cw, ch);

  const health  = castleHealth();
  const pct     = (health * 100).toFixed(0);
  const phName  = document.getElementById('phase-name');
  const phBar   = document.getElementById('phase-bar');
  const phFrac  = PHASE_DUR[phase] > 0 ? phaseTick / PHASE_DUR[phase] : 0;

  phName.textContent   = PHASE_NAMES[phase];
  phName.dataset.phase = phase;
  phBar.style.width    = (phFrac * 100).toFixed(1) + '%';
  phBar.dataset.phase  = phase;

  document.getElementById('m-health').textContent    = `Castle: ${pct}%`;
  document.getElementById('m-health').style.color    =
    health > 0.7 ? '#70e898' : (health > 0.4 ? '#f0c070' : '#f07878');
  document.getElementById('m-waves').textContent     = `Wave: ${waveCount}`;
  document.getElementById('m-eroded').textContent    = `Eroded: ${erosionTotal.toFixed(1)}`;
  document.getElementById('m-deposited').textContent = `Deposited: ${depositionTotal.toFixed(1)}`;
  document.getElementById('m-particles').textContent = `Particles: ${nLive}`;
  document.getElementById('m-fps').textContent       = `FPS: ${currentFps}`;
}

// -- BRUSH -----------------------------------------------------------------

function applyBrush(gx, gy, add) {
  const iMin = (gx - BRUSH_R) | 0, iMax = ((gx + BRUSH_R) | 0) + 1;
  const jMin = (gy - BRUSH_R) | 0, jMax = ((gy + BRUSH_R) | 0) + 1;
  for (let j = jMin; j <= jMax; j++) {
    if (j < 0 || j >= GH) continue;
    for (let i = iMin; i <= iMax; i++) {
      if (i < 0 || i >= GW) continue;
      const dx = i - gx, dy = j - gy;
      const d2 = dx * dx + dy * dy;
      if (d2 > BRUSH_R2) continue;
      const falloff = 1 - Math.sqrt(d2) / (BRUSH_R + 0.5);
      const k = j * GW + i;
      if (add) {
        terrain[k] = Math.min(1, terrain[k] + 0.055 + falloff * 0.055);
      } else {
        terrain[k] = Math.max(MIN_TERRAIN, terrain[k] - (0.11 + falloff * 0.13));
      }
    }
  }
}

function applyBrushLine(fromX, fromY, toX, toY, add) {
  const dx = toX - fromX, dy = toY - fromY;
  const dist    = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(1, BRUSH_R * 0.35);
  const steps   = Math.max(1, Math.ceil(dist / spacing));
  for (let step = 0; step <= steps; step++) {
    const prog = step / steps;
    applyBrush(fromX + dx * prog, fromY + dy * prog, add);
  }
}

function canvasToGrid(cx, cy) {
  const bounds = canvas.getBoundingClientRect();
  return [
    (((cx - bounds.left) / bounds.width)  * GW) | 0,
    (((cy - bounds.top)  / bounds.height) * GH) | 0,
  ];
}

// -- EVENT HANDLERS --------------------------------------------------------

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  mouseDown = true; mouseRight = e.button === 2;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);
  lastBrushGX = gx; lastBrushGY = gy;
  applyBrush(gx, gy, !mouseRight);
});
canvas.addEventListener('mousemove', (e) => {
  if (!mouseDown) return;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);
  applyBrushLine(lastBrushGX, lastBrushGY, gx, gy, !mouseRight);
  lastBrushGX = gx; lastBrushGY = gy;
});
window.addEventListener('mouseup', () => {
  mouseDown = false; lastBrushGX = -1; lastBrushGY = -1;
});
canvas.addEventListener('mouseleave', () => {
  mouseDown = false; lastBrushGX = -1; lastBrushGY = -1;
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  const [gx, gy] = canvasToGrid(t.clientX, t.clientY);
  mouseDown = true; mouseRight = false;
  lastBrushGX = gx; lastBrushGY = gy;
  applyBrush(gx, gy, true);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!mouseDown) return;
  const t = e.touches[0];
  const [gx, gy] = canvasToGrid(t.clientX, t.clientY);
  applyBrushLine(lastBrushGX, lastBrushGY, gx, gy, true);
  lastBrushGX = gx; lastBrushGY = gy;
}, { passive: false });
canvas.addEventListener('touchend', () => {
  mouseDown = false; lastBrushGX = -1; lastBrushGY = -1;
});

document.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case ' ':
    case 'p':
      paused = !paused;
      document.getElementById('paused-banner').style.display = paused ? 'block' : 'none';
      e.preventDefault(); break;
    case 'r': resetSimulation(); break;
    case 'w': triggerWave();     break;
  }
});

document.getElementById('btn-wave').addEventListener('click',  () => triggerWave());
document.getElementById('btn-pause').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('paused-banner').style.display = paused ? 'block' : 'none';
});
document.getElementById('btn-reset').addEventListener('click', () => resetSimulation());

// -- MAIN LOOP -------------------------------------------------------------

function gameLoop() {
  requestAnimationFrame(gameLoop);
  fpsFrames++;
  const now = performance.now();
  if (now - fpsTime >= 1000) { currentFps = fpsFrames; fpsFrames = 0; fpsTime = now; }
  if (!paused) simulate();
  render();
}

// -- INIT ------------------------------------------------------------------
pInit();
resetSimulation();
gameLoop();

})();
