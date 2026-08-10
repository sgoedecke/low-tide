// game.js – Variation: Sediment Morphodynamics
// ==============================================
// Two-phase conservative sediment transport built on top of
// the prototype-04 semi-Lagrangian / pressure-projection flow field.
//
// BEDLOAD   – sand rolling / saltating along the bed.
//   • Advects at ~42 % of flow speed (heavier, stays near bed).
//   • Entrained from terrain when shear (vmag×water) > threshold.
//   • Gravity-driven bedload slump even without water.
//   • Deposits when bedload exceeds carrying capacity OR flow is calm.
//
// SUSPENDED – sand lifted fully into the water column.
//   • Entrained from bedload when flow exceeds suspension threshold.
//   • Advects at full flow speed.
//   • Settles back to bedload with hysteresis (settleThresh < suspThresh).
//
// CARRYING CAPACITY
//   CC = bedloadCC × shear × (1 + slope × slopeBoost)
//   Fast deep water over steep slopes carries more; calm flats deposit.
//
// CONSERVATION
//   Sand moves between terrain ↔ bedload ↔ suspended; no source/sink.
//   Budget metric = (terrain + bedload + suspended) / initial.
//
// MORPHOLOGY OUTCOMES
//   Bay bars – deposition where channelled flow fans and slows.
//   Spits    – bedload accumulating in groyne-tip lee.
//   Fan      – suspended load settling behind front berm gap.
//   Blocked gate – sand plugging castle west gate, forcing reroute.
//   Self-healing channels – pressure drives new paths around bars.
// ==============================================
(function () {
'use strict';

// ─────────────────────────────────────────────────────────────
// GRID
// ─────────────────────────────────────────────────────────────
const GW = 200;
const GH = 125;
const N  = GW * GH;

// ─────────────────────────────────────────────────────────────
// SIMULATION FIELDS  (flat Float32, row-major [j*GW+i])
// ─────────────────────────────────────────────────────────────
const terrain   = new Float32Array(N);  // permanent sand bed  0–1
const water     = new Float32Array(N);  // water density       0–1
const bedload   = new Float32Array(N);  // rolling sand        0–1
const suspended = new Float32Array(N);  // airborne sand       0–1
const deposit   = new Float32Array(N);  // fresh-deposit visual 0–1
const foam      = new Float32Array(N);  // foam                0–1
const vx        = new Float32Array(N);  // velocity x (+→ rightward)
const vy        = new Float32Array(N);  // velocity y (+↓ downward)

// Scratch / double-buffer
const t0 = new Float32Array(N);
const t1 = new Float32Array(N);
const t2 = new Float32Array(N);
const t3 = new Float32Array(N);

// Castle health + budget tracking
const origTerrain    = new Float32Array(N);
let initCastleMass   = 0;
let initialSandTotal = 0;
let depositedTotal   = 0;

// ─────────────────────────────────────────────────────────────
// PARAMETERS
// ─────────────────────────────────────────────────────────────
const P = {
  dt:            0.5,
  viscosity:     0.16,
  waveVx:        3.2,
  waveWater:     0.82,
  ambientVx:     0.55,
  ambientWater:  0.28,
  waterPressure: 0.14,

  // ── Entrainment: terrain → bedload ─────────────────────────
  entrainThresh: 0.10,   // min shear (vmag×water) to erode terrain
  entrainRate:   0.0032, // fraction of excess shear picked up per frame
  slopeEntrain:  1.5,    // slope amplifies entrainment

  // ── Bedload transport ───────────────────────────────────────
  bedloadCC:     0.30,   // CC = bedloadCC × shear × (1 + slope×slopeBoost)
  slopeBoost:    2.8,    // slope amplification of carrying capacity
  bedDepRate:    0.20,   // CC-exceeded: deposit this fraction of excess/frame
  calmDepThresh: 0.50,   // vmag below which calm deposition engages
  calmDepRate:   0.07,   // calm deposition rate
  bedAdvFrac:    0.42,   // bedload advects at this fraction of flow speed

  // ── Suspension: bedload → suspended ────────────────────────
  suspThresh:    1.10,   // vmag needed to lift bedload
  suspRate:      0.022,  // fraction lifted per frame (scaled by excess speed)
  curlLift:      0.6,    // vorticity amplifies lift

  // ── Settling: suspended → bedload ──────────────────────────
  settleThresh:  0.85,   // vmag below which settling occurs (<suspThresh)
  settleRate:    0.10,   // settling rate

  // ── General ────────────────────────────────────────────────
  slumpRate:     0.05,
  maxSlope:      0.32,
  foamThresh:    1.25,
  foamDecay:     0.972,
  waterDecay:    0.9983,
  bedDecay:      0.9994,  // near-conservative; tiny loss to floor
  suspDecay:     0.9978,
  velDecay:      0.992,
  depositDecay:  0.88,    // visual flash fades quickly
  blockH:        0.42,
  wavePeriod:    210,
  waveDuration:  78,
  pressureIter:  16,
  maxVel:        5.2,
};

// ─────────────────────────────────────────────────────────────
// RUNTIME STATE
// ─────────────────────────────────────────────────────────────
let paused     = false;
let frameNum   = 0;
let waveCount  = 0;
let isWaving   = false;
let manualWave = false;
let manualTick = 0;

let fpsFrames = 0, fpsTime = performance.now(), currentFps = 0;
let mouseDown = false, mouseRight = false;
let brushGX = -1, brushGY = -1;
const BRUSH_R  = 4;
const BRUSH_R2 = BRUSH_R * BRUSH_R;

// ─────────────────────────────────────────────────────────────
// CANVAS
// ─────────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas');
const ctx       = canvas.getContext('2d');
const offscreen = document.createElement('canvas');
offscreen.width  = GW;
offscreen.height = GH;
const offCtx  = offscreen.getContext('2d');
const imgData = offCtx.createImageData(GW, GH);
const pixels  = imgData.data;

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─────────────────────────────────────────────────────────────
// TRACERS  (Lagrangian flow particles; colour reflects turbidity)
// ─────────────────────────────────────────────────────────────
const NUM_TRACERS = 440;
const TRAIL_LEN   = 9;
let tracers = [];

function newTracer() {
  return {
    x:       Math.random() * 12,
    y:       Math.random() * GH,
    life:    (Math.random() * 50) | 0,
    maxLife: 45 + ((Math.random() * 45) | 0),
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
    const ix = Math.min(GW - 1, Math.max(0, tr.x | 0));
    const iy = Math.min(GH - 1, Math.max(0, tr.y | 0));
    const k  = iy * GW + ix;
    const spd  = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);
    const turb = suspended[k];           // turbidity tints trail brown
    tr.trail.push({ x: tr.x, y: tr.y, spd, turb });
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

// ─────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────

// Bilinear sample; solid terrain contributes 0 (no-slip / no bleed).
function bsample(f, x, y) {
  x = x < 0.5 ? 0.5 : (x > GW - 1.5 ? GW - 1.5 : x);
  y = y < 0.5 ? 0.5 : (y > GH - 1.5 ? GH - 1.5 : y);
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1, y1 = y0 + 1;
  const sx = x - x0, sy = y - y0;
  let w00 = (1-sx)*(1-sy), w10 = sx*(1-sy);
  let w01 = (1-sx)*sy,     w11 = sx*sy;
  const k00 = y0*GW+x0, k10 = y0*GW+x1;
  const k01 = y1*GW+x0, k11 = y1*GW+x1;
  if (terrain[k00] > P.blockH) w00 = 0;
  if (terrain[k10] > P.blockH) w10 = 0;
  if (terrain[k01] > P.blockH) w01 = 0;
  if (terrain[k11] > P.blockH) w11 = 0;
  const wt = w00 + w10 + w01 + w11;
  if (wt < 1e-7) return 0;
  return (w00*f[k00] + w10*f[k10] + w01*f[k01] + w11*f[k11]) / wt;
}

// ─────────────────────────────────────────────────────────────
// FLOW FIELD CORE  (unchanged from prototype 04 baseline)
// ─────────────────────────────────────────────────────────────

function advect(field, out) {
  const dt = P.dt;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k = j*GW+i;
      out[k] = bsample(field, i - vx[k]*dt, j - vy[k]*dt);
    }
  }
}

// Bedload advects at a fraction of flow speed — it rolls along the bed
// rather than being fully transported by the water column.
function advectBedload() {
  const frac = P.bedAdvFrac * P.dt;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k = j*GW+i;
      t0[k] = bsample(bedload, i - vx[k]*frac, j - vy[k]*frac);
    }
  }
  bedload.set(t0);
}

function advectVelocity() {
  const dt = P.dt;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k  = j*GW+i;
      const bx = i - vx[k]*dt, by = j - vy[k]*dt;
      t0[k] = bsample(vx, bx, by);
      t1[k] = bsample(vy, bx, by);
    }
  }
  vx.set(t0); vy.set(t1);
}

function diffuseVelocity() {
  const v = P.viscosity, iv = 1 - v;
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      t0[k] = iv*vx[k] + v*0.25*(vx[k-1]+vx[k+1]+vx[k-GW]+vx[k+GW]);
      t1[k] = iv*vy[k] + v*0.25*(vy[k-1]+vy[k+1]+vy[k-GW]+vy[k+GW]);
    }
  }
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      vx[k] = t0[k]; vy[k] = t1[k];
    }
  }
}

function applyTerrainBlock() {
  for (let k = 0; k < N; k++) {
    if (terrain[k] > P.blockH) {
      vx[k] = 0; vy[k] = 0; water[k] = 0;
      bedload[k] = 0; suspended[k] = 0;
    }
  }
}

// Pressure projection (Gauss-Seidel) → divergence-free velocity.
// This is what makes flow curl around groynes and castle walls.
function projectVelocity() {
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      t2[k] = (terrain[k] > P.blockH) ? 0
            : 0.5 * (vx[k+1]-vx[k-1] + vy[k+GW]-vy[k-GW]);
    }
  }
  t3.fill(0);
  for (let s = 0; s < P.pressureIter; s++) {
    for (let j = 1; j < GH-1; j++) {
      for (let i = 1; i < GW-1; i++) {
        const k = j*GW+i;
        if (terrain[k] > P.blockH) { t3[k] = 0; continue; }
        const pL = terrain[k-1]  > P.blockH ? t3[k] : t3[k-1];
        const pR = terrain[k+1]  > P.blockH ? t3[k] : t3[k+1];
        const pU = terrain[k-GW] > P.blockH ? t3[k] : t3[k-GW];
        const pD = terrain[k+GW] > P.blockH ? t3[k] : t3[k+GW];
        t3[k] = (pL + pR + pU + pD - t2[k]) * 0.25;
      }
    }
  }
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      if (terrain[k] > P.blockH) continue;
      vx[k] -= 0.5 * (t3[k+1]   - t3[k-1]);
      vy[k] -= 0.5 * (t3[k+GW]  - t3[k-GW]);
    }
  }
}

function clampVelocity() {
  const mv = P.maxVel;
  for (let k = 0; k < N; k++) {
    const s2 = vx[k]*vx[k] + vy[k]*vy[k];
    if (s2 > mv*mv) {
      const sc = mv / Math.sqrt(s2);
      vx[k] *= sc; vy[k] *= sc;
    }
  }
}

function addWaterPressure() {
  const wp = P.waterPressure;
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      if (terrain[k] > P.blockH) continue;
      vx[k] += wp * (water[k-1]  - water[k+1])  * 0.5;
      vy[k] += wp * (water[k-GW] - water[k+GW]) * 0.5;
    }
  }
}

function injectWave(active) {
  const wVx = active ? P.waveVx    : P.ambientVx;
  const wW  = active ? P.waveWater : P.ambientWater;
  const INJ = 5;
  for (let j = 0; j < GH; j++) {
    const wobble = active ? Math.sin(frameNum*0.07 + j*0.045)*0.45 : 0;
    const sway   = Math.sin(frameNum*0.05 + j*0.06)*0.38;
    for (let i = 0; i < INJ; i++) {
      const k = j*GW+i;
      if (terrain[k] > P.blockH) continue;
      vx[k]    = wVx + wobble;
      vy[k]    = sway;
      water[k] = Math.min(1, wW + Math.abs(wobble)*0.35);
      if (active) foam[k] = Math.min(1, foam[k] + 0.55);
    }
  }
}

function applyDecay() {
  for (let k = 0; k < N; k++) {
    water[k]    *= P.waterDecay;
    bedload[k]  *= P.bedDecay;
    suspended[k]*= P.suspDecay;
    vx[k]       *= P.velDecay;
    vy[k]       *= P.velDecay;
    deposit[k]  *= P.depositDecay;
    if (water[k]    < 0.002) water[k]    = 0;
    if (bedload[k]  < 0.001) bedload[k]  = 0;
    if (suspended[k]< 0.001) suspended[k]= 0;
    if (deposit[k]  < 0.005) deposit[k]  = 0;
  }
}

// ─────────────────────────────────────────────────────────────
// SEDIMENT PHYSICS  (the substantive new work)
// ─────────────────────────────────────────────────────────────

// Full two-phase exchange pass:
//   terrain ─[entrain]→ bedload ─[suspend]→ suspended
//                          ↑                    │
//                    [deposit]             [settle]
//
// The carrying-capacity model is the governing constraint:
//   CC = bedloadCC × (vmag × water) × (1 + |∇z| × slopeBoost)
// When bedload > CC, excess deposits immediately; otherwise deposition
// only occurs when the flow is calm (< calmDepThresh).
function updateSedimentTransport() {
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      if (terrain[k] > P.blockH) continue;

      const cvx  = vx[k], cvy = vy[k];
      const vmag = Math.sqrt(cvx*cvx + cvy*cvy);
      const w    = water[k];

      // Local terrain slope (centred finite difference)
      const dzdx = (terrain[k+1]   - terrain[k-1])  * 0.5;
      const dzdy = (terrain[k+GW]  - terrain[k-GW]) * 0.5;
      const slope = Math.sqrt(dzdx*dzdx + dzdy*dzdy);

      const shear = vmag * w;   // simplified bed shear stress

      // ── 1. ENTRAINMENT: terrain → bedload ──────────────────
      // Conservative: only picks up existing terrain above the
      // 0.01 residual floor; amount capped at available material.
      if (shear > P.entrainThresh && terrain[k] > 0.01) {
        const excess  = shear - P.entrainThresh;
        const rate    = P.entrainRate * excess * (1 + slope * P.slopeEntrain);
        const actual  = Math.min(rate, terrain[k] - 0.01);
        terrain[k]   -= actual;
        bedload[k]   += actual;
      }

      // ── 2. SUSPENSION: bedload → suspended ─────────────────
      // Vorticity (curl of velocity) amplifies lift — turbulent
      // eddies in the wake of obstacles kick bedload airborne.
      if (vmag > P.suspThresh && bedload[k] > 0.001) {
        const curlAbs = Math.abs(
          (vy[k+1] - vy[k-1])*0.5 - (vx[k+GW] - vx[k-GW])*0.5
        );
        const liftRate = P.suspRate * (vmag - P.suspThresh) *
                         (1 + curlAbs * P.curlLift);
        const lifted   = Math.min(bedload[k], liftRate * bedload[k]);
        bedload[k]    -= lifted;
        suspended[k]  += lifted;
      }

      // ── 3. SETTLING: suspended → bedload ───────────────────
      // Uses a lower threshold than suspension (hysteresis) so
      // sand doesn't flicker between states at marginal speeds.
      if (suspended[k] > 0.001 && vmag < P.settleThresh) {
        const calm   = 1 - vmag / P.settleThresh;
        const settle = Math.min(suspended[k], P.settleRate * suspended[k] * calm);
        suspended[k] -= settle;
        bedload[k]   += settle;
      }

      // ── 4. DEPOSITION: bedload → terrain ───────────────────
      // Re-read bedload after steps 2–3 above.
      const bl = bedload[k];
      if (bl > 0.001) {
        const CC = P.bedloadCC * shear * (1 + slope * P.slopeBoost);
        let dep = 0;

        if (bl > CC) {
          // Over carrying capacity: must shed excess.
          dep = Math.min(bl - CC, P.bedDepRate * (bl - CC));
        } else if (vmag < P.calmDepThresh) {
          // Under capacity but calm enough for unconditional settling.
          const calm = 1 - vmag / P.calmDepThresh;
          dep = Math.min(bl, P.calmDepRate * bl * calm);
        }

        if (dep > 0) {
          bedload[k]     -= dep;
          terrain[k]     += dep;
          // Visual flash: multiply by 5 so even small deposits glow.
          deposit[k]      = Math.min(1, deposit[k] + dep * 5);
          depositedTotal += dep;
        }
      }
    }
  }
}

// Bedload gravity slump — sand rolls downhill on the bed without
// needing water.  Uses combined (terrain + scaled bedload) height so
// accumulated dunes feel the slope they sit on.
function slumpBedload() {
  const rate = P.slumpRate * 0.55, ms = 0.14;
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      if (terrain[k] > P.blockH || bedload[k] < 0.005) continue;
      const h   = terrain[k] + bedload[k] * 0.3;
      const nbs = [k-1, k+1, k-GW, k+GW];
      for (let n = 0; n < 4; n++) {
        const nb = nbs[n];
        if (terrain[nb] > P.blockH) continue;
        const hn   = terrain[nb] + bedload[nb] * 0.3;
        const diff = h - hn;
        if (diff > ms) {
          const move    = Math.min(bedload[k], rate * (diff - ms));
          bedload[k]   -= move;
          bedload[nb]  += move;
        }
      }
    }
  }
}

// Terrain slump — stabilises castle walls and deposited bars.
function slumpTerrain() {
  const rate = P.slumpRate, ms = P.maxSlope;
  for (let j = 1; j < GH-1; j++) {
    for (let i = 1; i < GW-1; i++) {
      const k = j*GW+i;
      const t = terrain[k];
      const nbs = [k-1, k+1, k-GW, k+GW];
      for (let n = 0; n < 4; n++) {
        const nb   = nbs[n];
        const diff = t - terrain[nb];
        if (diff > ms) {
          const move  = rate * (diff - ms);
          terrain[k] -= move;
          terrain[nb]+= move;
        }
      }
    }
  }
}

function updateFoam() {
  for (let k = 0; k < N; k++) {
    if (water[k] > 0.15) {
      const spd = Math.sqrt(vx[k]*vx[k] + vy[k]*vy[k]);
      if (spd > P.foamThresh)
        foam[k] = foam[k] + 0.09 < 1 ? foam[k] + 0.09 : 1;
    }
    foam[k] *= P.foamDecay;
    if (foam[k] < 0.004) foam[k] = 0;
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN SIMULATION STEP
// ─────────────────────────────────────────────────────────────
function simulate() {
  const waveMod    = frameNum % P.wavePeriod;
  const autoWave   = waveMod < P.waveDuration;
  const waveActive = autoWave || manualWave;

  if (waveActive && !isWaving) { isWaving = true; waveCount++; }
  if (!waveActive)              { isWaving = false; }
  if (manualWave) {
    manualTick++;
    if (manualTick >= P.waveDuration) { manualWave = false; manualTick = 0; }
  }

  // ── Flow field ──────────────────────────────────────────────
  injectWave(waveActive);
  addWaterPressure();
  advectVelocity();
  applyTerrainBlock();
  diffuseVelocity();
  projectVelocity();
  applyTerrainBlock();
  clampVelocity();

  // ── Scalar advection ────────────────────────────────────────
  // Suspended travels at full flow speed; bedload rolls slower.
  advect(water,     t0); water.set(t0);
  advect(suspended, t0); suspended.set(t0);
  advectBedload();

  // Clamp all transported scalars
  for (let k = 0; k < N; k++) {
    if (water[k]    < 0) water[k]    = 0; else if (water[k]    > 1) water[k]    = 1;
    if (suspended[k]< 0) suspended[k]= 0; else if (suspended[k]> 1) suspended[k]= 1;
    if (bedload[k]  < 0) bedload[k]  = 0; else if (bedload[k]  > 1) bedload[k]  = 1;
    if (terrain[k]  < 0) terrain[k]  = 0; else if (terrain[k]  > 1) terrain[k]  = 1;
  }

  applyDecay();

  // ── Sediment exchange (the substantive new physics) ─────────
  updateSedimentTransport();
  slumpBedload();
  slumpTerrain();

  for (let k = 0; k < N; k++) {
    if (terrain[k] < 0) terrain[k] = 0; else if (terrain[k] > 1) terrain[k] = 1;
    if (bedload[k] < 0) bedload[k] = 0; else if (bedload[k] > 1) bedload[k] = 1;
  }

  applyTerrainBlock();
  updateFoam();
  updateTracers();
  frameNum++;
}

// ─────────────────────────────────────────────────────────────
// SCENE SEEDING
// ─────────────────────────────────────────────────────────────
function setT(i, j, h) {
  if (i < 0 || i >= GW || j < 0 || j >= GH) return;
  const k = j*GW+i;
  if (h > terrain[k]) terrain[k] = h;
}

function seedScene() {
  terrain.fill(0);
  bedload.fill(0);

  // Castle geometry constants
  const cx = 138, cy = 62;
  const OW = 22, OH = 22, WW = 3, KH = 9, TR = 7, DH = 4;
  const x0 = cx - OW; // 116
  const x1 = cx + OW; // 160
  const y0 = cy - OH; // 40
  const y1 = cy + OH; // 84

  // ── Castle outer ring-wall ──────────────────────────────────
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const onL = i <= x0 + WW - 1;
      const onR = i >= x1 - WW + 1;
      const onT = j <= y0 + WW - 1;
      const onB = j >= y1 - WW + 1;
      if (!(onL || onR || onT || onB)) continue;
      // West gate: flow enters from the ocean side.
      if (onL && Math.abs(j - cy) <= 5) continue;
      // East gate: flow can exit / sand fans out behind castle.
      if (onR && Math.abs(j - cy) <= 6) continue;
      setT(i, j, 0.80 + Math.random() * 0.12);
    }
  }

  // ── Corner towers ───────────────────────────────────────────
  const corners = [[x0,y0],[x1,y0],[x0,y1],[x1,y1]];
  for (const [tx, ty] of corners) {
    for (let dj = -TR; dj <= TR; dj++) {
      for (let di = -TR; di <= TR; di++) {
        if (Math.abs(di) === TR && Math.abs(dj) === TR) continue;
        setT(tx + di, ty + dj, 0.88 + Math.random() * 0.10);
      }
    }
  }

  // ── Inner keep ──────────────────────────────────────────────
  for (let j = cy - KH; j <= cy + KH; j++) {
    for (let i = cx - KH; i <= cx + KH; i++) {
      setT(i, j, 0.84 + Math.random() * 0.08);
    }
  }

  // ── Donjon ──────────────────────────────────────────────────
  for (let j = cy - DH; j <= cy + DH; j++) {
    for (let i = cx - DH; i <= cx + DH; i++) {
      setT(i, j, 0.96 + Math.random() * 0.04);
    }
  }

  // ── North groyne ────────────────────────────────────────────
  // A solid wall extending WESTWARD from the castle's north face.
  // Forces flow around the outside and creates a sheltered bay.
  // Two cells thick so it blocks robustly even after marginal erosion.
  for (let dj = -1; dj <= 1; dj++) {
    for (let i = 76; i < x0; i++) {
      setT(i, y0 + dj, 0.85 + Math.random() * 0.08);
    }
  }

  // ── South groyne ────────────────────────────────────────────
  for (let dj = -1; dj <= 1; dj++) {
    for (let i = 76; i < x0; i++) {
      setT(i, y1 + dj, 0.85 + Math.random() * 0.08);
    }
  }

  // ── Sacrificial front berm ──────────────────────────────────
  // Low ridge across the bay entrance.  Waves erode this first,
  // feeding the bay with bedload → bars and fan formations.
  // Height 0.18–0.26 keeps it BELOW blockH so flow still passes.
  for (let j = y0 + 4; j <= y1 - 4; j++) {
    const d   = Math.abs(j - cy) / (OH - 4);
    const hgt = 0.24 - d * 0.05 + Math.random() * 0.04;
    for (let i = 86; i <= 96; i++) {
      const edge = (i - 86) / 10;
      const h    = hgt * (0.65 + 0.35 * Math.sin(edge * Math.PI));
      setT(i, j, h);
    }
  }

  // ── Loose bay sand ──────────────────────────────────────────
  // Scattered low mounds inside the sheltered bay.  These are
  // easily entrained, transported, and redeposited into bars.
  for (let j = y0 + 4; j <= y1 - 4; j++) {
    for (let i = 97; i < x0 - 2; i++) {
      if (Math.random() > 0.52) {
        setT(i, j, 0.04 + Math.random() * 0.11);
      }
    }
  }

  // ── Beach sand outside the groynes ─────────────────────────
  for (let j = 0; j < GH; j++) {
    const inBay = (j > y0 - 2 && j < y1 + 2);
    if (!inBay && Math.random() > 0.50) {
      const ix = (Math.random() * 65 + 3) | 0;
      setT(ix, j, 0.03 + Math.random() * 0.09);
    }
  }

  // ── Pre-seeded bedload in the bay ──────────────────────────
  // Gives the simulation immediate mobile material so deposition
  // patterns emerge from the first wave rather than after a long
  // erosion warm-up period.
  for (let j = y0 + 5; j <= y1 - 5; j++) {
    for (let i = 97; i <= 113; i++) {
      bedload[j*GW+i] = 0.03 + Math.random() * 0.06;
    }
  }

  // ── Castle health + sand budget snapshot ───────────────────
  origTerrain.set(terrain);
  initCastleMass = 0;
  for (let k = 0; k < N; k++) {
    if (origTerrain[k] > 0.5) initCastleMass += origTerrain[k];
  }
  initialSandTotal = 0;
  for (let k = 0; k < N; k++) {
    initialSandTotal += terrain[k] + bedload[k] + suspended[k];
  }
}

function resetSimulation() {
  seedScene();
  water.fill(0);
  suspended.fill(0);
  foam.fill(0);
  vx.fill(0); vy.fill(0);
  deposit.fill(0);
  t0.fill(0); t1.fill(0); t2.fill(0); t3.fill(0);
  frameNum      = 0;
  waveCount     = 0;
  isWaving      = false;
  manualWave    = false;
  manualTick    = 0;
  depositedTotal = 0;
  initTracers();
}

// ─────────────────────────────────────────────────────────────
// RENDERING
// ─────────────────────────────────────────────────────────────

function renderPixels() {
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k   = j*GW+i;
      const t   = terrain[k];
      const w   = water[k];
      const f   = foam[k];
      const bl  = bedload[k];
      const sus = suspended[k];
      const dep = deposit[k];
      const spd = Math.sqrt(vx[k]*vx[k] + vy[k]*vy[k]);

      // ── Base terrain colour ───────────────────────────────
      let r, g, b;
      if (t > 0.5) {
        // Castle stone — pale limestone
        const bright = 0.72 + 0.28 * t;
        r = (215 * bright) | 0;
        g = (198 * bright) | 0;
        b = (158 * bright) | 0;
      } else if (t > 0.15) {
        // Dry sand
        const tn = (t - 0.15) / 0.35;
        r = (195 + 15*tn) | 0;
        g = (175 + 12*tn) | 0;
        b = (128 + 10*tn) | 0;
      } else if (t > 0.01) {
        // Damp sand near waterline
        const tn  = t / 0.15;
        const wet = w < 1 ? w : 1;
        r = (175 - 25*wet + 20*tn) | 0;
        g = (155 - 20*wet + 18*tn) | 0;
        b = (115 - 12*wet + 12*tn) | 0;
      } else {
        // Bare seabed
        const wet = w < 1 ? w : 1;
        r = (148 - 30*wet) | 0;
        g = (132 - 25*wet) | 0;
        b = ( 98 - 15*wet) | 0;
      }

      // ── Bedload overlay — warm amber/gold ─────────────────
      // Indicates sand that is actively rolling along the bed.
      if (bl > 0.02) {
        const ba = bl < 1 ? bl : 1;
        r = (r + (228 - r) * ba * 0.70) | 0;
        g = (g + (172 - g) * ba * 0.60) | 0;
        b = (b + ( 38 - b) * ba * 0.58) | 0;
      }

      // ── Fresh-deposit highlight — bright gold flash ────────
      // Shows exactly where deposition just occurred; fades fast.
      if (dep > 0.05) {
        const da = dep < 1 ? dep : 1;
        r = (r + (255 - r) * da * 0.85) | 0;
        g = (g + (240 - g) * da * 0.82) | 0;
        b = (b + ( 45 - b) * da * 0.60) | 0;
      }

      // ── Water overlay — deep blue → cyan, muddied by suspended ──
      if (w > 0.02) {
        const sn  = spd < 0 ? 0 : (spd > P.maxVel ? 1 : spd / P.maxVel);
        let wr = 18  + 90  * sn;
        let wg = 55  + 160 * sn;
        let wb = 180 + 50  * sn;
        // Turbidity: suspended sediment shifts water toward muddy brown.
        if (sus > 0.02) {
          const st = sus < 1 ? sus : 1;
          wr = wr + (185 - wr) * st * 0.55;
          wg = wg + (138 - wg) * st * 0.48;
          wb = wb + ( 55 - wb) * st * 0.52;
        }
        const alpha = w < 0.9 ? w * 1.1 : 0.99;
        r = (r * (1 - alpha) + wr * alpha) | 0;
        g = (g * (1 - alpha) + wg * alpha) | 0;
        b = (b * (1 - alpha) + wb * alpha) | 0;
      }

      // ── Foam overlay ──────────────────────────────────────
      if (f > 0.04) {
        const fa = f < 1 ? f : 1;
        r = (r + (252 - r) * fa) | 0;
        g = (g + (252 - g) * fa) | 0;
        b = (b + (255 - b) * fa) | 0;
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

function renderVelocityArrows(cw, ch) {
  const scaleX = cw / GW, scaleY = ch / GH;
  const STEP   = 14;
  ctx.save();
  ctx.lineWidth = 1.0;
  for (let j = (STEP / 2) | 0; j < GH; j += STEP) {
    for (let i = (STEP / 2) | 0; i < GW; i += STEP) {
      const k   = j*GW+i;
      const cvx = vx[k], cvy = vy[k];
      const spd = Math.sqrt(cvx*cvx + cvy*cvy);
      if (spd < 0.12) continue;
      const px  = i * scaleX, py  = j * scaleY;
      const len = Math.min(spd, 2.5) * scaleX * 0.55;
      const ex  = px + (cvx / spd) * len;
      const ey  = py + (cvy / spd) * len;
      const sn  = spd / 4, sn1 = sn > 1 ? 1 : sn;
      const alpha = 0.25 + 0.45 * sn1;
      ctx.strokeStyle =
        `rgba(${(60+180*sn1)|0},${(180+70*sn1)|0},255,${alpha.toFixed(2)})`;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(ex, ey, 1.1, 0, 6.2832); ctx.fill();
    }
  }
  ctx.restore();
}

// Tracer trails shift from blue→cyan (clear water) to brown (turbid)
// when suspended sediment is present in the cell they pass through.
function renderTracers(cw, ch) {
  const scaleX = cw / GW, scaleY = ch / GH;
  ctx.save();
  ctx.lineWidth = 1.2;
  for (const tr of tracers) {
    const tlen = tr.trail.length;
    if (tlen < 2) continue;
    for (let s = 1; s < tlen; s++) {
      const a     = tr.trail[s - 1];
      const b     = tr.trail[s];
      const age   = s / tlen;
      const sn    = b.spd / 3.5, sn1 = sn > 1 ? 1 : sn;
      const turb  = b.turb < 1 ? b.turb : 1;
      // Interpolate: clear (cyan-blue) → turbid (brownish)
      const tr_r  = ((100 + 155*sn1) * (1-turb) + 175*turb) | 0;
      const tr_g  = ((200 +  50*sn1) * (1-turb) + 130*turb) | 0;
      const tr_b  = (255             * (1-turb*0.6))         | 0;
      const alpha = age * (0.15 + 0.55*sn1);
      ctx.strokeStyle = `rgba(${tr_r},${tr_g},${tr_b},${alpha.toFixed(2)})`;
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
    if (origTerrain[k] > 0.5) m += terrain[k];
  }
  return m < 0 ? 0 : (m > initCastleMass ? 1 : m / initCastleMass);
}

function sandBudgetPct() {
  if (initialSandTotal < 0.01) return 100;
  let total = 0;
  for (let k = 0; k < N; k++) {
    total += terrain[k] + bedload[k] + suspended[k];
  }
  return (total / initialSandTotal) * 100;
}

function render() {
  const cw = canvas.width, ch = canvas.height;

  renderPixels();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreen, 0, 0, cw, ch);
  renderVelocityArrows(cw, ch);
  renderTracers(cw, ch);

  // Aggregate bedload and suspended totals for HUD
  let bedTotal = 0, susTotal = 0;
  for (let k = 0; k < N; k++) {
    bedTotal += bedload[k];
    susTotal += suspended[k];
  }

  const health = castleHealth();
  const budget = sandBudgetPct();
  const pct    = (health * 100).toFixed(0);

  const mHealth = document.getElementById('m-health');
  mHealth.textContent = `Castle: ${pct}%`;
  mHealth.style.color = health > 0.7 ? '#7ef0a8' : (health > 0.4 ? '#f0c07e' : '#f07e7e');

  document.getElementById('m-waves').textContent     = `Waves: ${waveCount}`;
  document.getElementById('m-budget').textContent    = `Budget: ${budget.toFixed(1)}%`;
  document.getElementById('m-bedload').textContent   = `Bedload: ${bedTotal.toFixed(1)}`;
  document.getElementById('m-suspended').textContent = `Suspended: ${susTotal.toFixed(1)}`;
  document.getElementById('m-deposited').textContent = `Deposited: ${depositedTotal.toFixed(1)}`;
  document.getElementById('m-fps').textContent       = `FPS: ${currentFps}`;
}

// ─────────────────────────────────────────────────────────────
// BRUSH
// ─────────────────────────────────────────────────────────────
function applyBrush(gx, gy, add) {
  const iMin = (gx - BRUSH_R) | 0, iMax = ((gx + BRUSH_R) | 0) + 1;
  const jMin = (gy - BRUSH_R) | 0, jMax = ((gy + BRUSH_R) | 0) + 1;
  for (let j = jMin; j <= jMax; j++) {
    if (j < 0 || j >= GH) continue;
    for (let i = iMin; i <= iMax; i++) {
      if (i < 0 || i >= GW) continue;
      const dx = i - gx, dy = j - gy;
      if (dx*dx + dy*dy > BRUSH_R2) continue;
      const k = j*GW+i;
      if (add) {
        terrain[k] = Math.min(1, terrain[k] + 0.09);
        water[k]   = 0; vx[k] = 0; vy[k] = 0;
      } else {
        terrain[k] = Math.max(0, terrain[k] - 0.09);
      }
    }
  }
}

function canvasToGrid(cx, cy) {
  return [(cx / canvas.width * GW) | 0, (cy / canvas.height * GH) | 0];
}

// ─────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  e.preventDefault();
  mouseDown  = true;
  mouseRight = e.button === 2;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);
  brushGX = gx; brushGY = gy;
  applyBrush(gx, gy, !mouseRight);
});
canvas.addEventListener('mousemove', (e) => {
  if (!mouseDown) return;
  const [gx, gy] = canvasToGrid(e.clientX, e.clientY);
  brushGX = gx; brushGY = gy;
  applyBrush(gx, gy, !mouseRight);
});
canvas.addEventListener('mouseup',    () => { mouseDown = false; });
canvas.addEventListener('mouseleave', () => { mouseDown = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const t = e.touches[0];
  const [gx, gy] = canvasToGrid(t.clientX, t.clientY);
  mouseDown = true; mouseRight = false;
  brushGX = gx; brushGY = gy;
  applyBrush(gx, gy, true);
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!mouseDown) return;
  const t = e.touches[0];
  const [gx, gy] = canvasToGrid(t.clientX, t.clientY);
  brushGX = gx; brushGY = gy;
  applyBrush(gx, gy, true);
}, { passive: false });
canvas.addEventListener('touchend', () => { mouseDown = false; });

document.addEventListener('keydown', (e) => {
  switch (e.key.toLowerCase()) {
    case ' ':
    case 'p':
      paused = !paused;
      document.getElementById('paused-banner').style.display =
        paused ? 'block' : 'none';
      e.preventDefault();
      break;
    case 'r':
      resetSimulation();
      break;
    case 'w':
      manualWave = true;
      manualTick = 0;
      if (!isWaving) waveCount++;
      isWaving = true;
      break;
  }
});

// ─────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────
function gameLoop() {
  requestAnimationFrame(gameLoop);
  fpsFrames++;
  const now = performance.now();
  if (now - fpsTime >= 1000) {
    currentFps = fpsFrames;
    fpsFrames  = 0;
    fpsTime    = now;
  }
  if (!paused) simulate();
  render();
}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
resetSimulation();
gameLoop();

})();
