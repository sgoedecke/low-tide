// game.js – Variation 2: Vortex Shedding
// ========================================
// Physics beyond baseline:
//   • Vorticity confinement (Fedkiw/Steinhoff–Underhill) keeps coherent
//     eddies alive instead of diffusing them away.
//   • Erosion is driven by |ω| (vorticity magnitude), wall-flank shear
//     (∇|ω| near solid boundaries), and flow-reversal stress—not just speed.
//   • Bank/corner undercut: vorticity gradient peaks at convex obstacle
//     corners; those cells erode faster, undercutting flanks and wakes.
//   • Round vs square towers behave differently: square corners generate
//     sharp, coherent Kármán-like alternating eddies; round towers produce
//     smoother, symmetric trailing vortices.
//   • Turbulence slider controls vorticity-confinement epsilon live.
//   • Curl heatmap toggle (signed ω: red=CW, cyan=CCW).
//   • Dense curl-coloured tracer streaks reveal eddies clearly.
// ========================================
(function () {
'use strict';

// ── GRID ──────────────────────────────────────────────────────────────────
const GW = 200;     // grid width  (cells; left = ocean, right = wake)
const GH = 130;     // grid height (cells)
const N  = GW * GH;

// ── SIMULATION FIELDS ─────────────────────────────────────────────────────
// All flat Float32 row-major [j*GW + i].
const terrain  = new Float32Array(N);  // sand height 0–1
const water    = new Float32Array(N);  // water density 0–1
const sediment = new Float32Array(N);  // suspended sediment 0–1
const foam     = new Float32Array(N);  // foam 0–1
const vx       = new Float32Array(N);  // velocity x (+→ toward castle)
const vy       = new Float32Array(N);  // velocity y (+↓)

// New fields for vortex shedding
const curlF  = new Float32Array(N);   // signed vorticity ω = ∂vy/∂x − ∂vx/∂y
const meanVx = new Float32Array(N);   // exponential-moving-average vx (reversal detection)
const meanVy = new Float32Array(N);   // exponential-moving-average vy

// Scratch / double-buffer temporaries
const t0 = new Float32Array(N);
const t1 = new Float32Array(N);
const t2 = new Float32Array(N);   // divergence
const t3 = new Float32Array(N);   // pressure

// Castle reference snapshot for health metric
const origTerrain = new Float32Array(N);
let initCastleMass = 0;

// ── PARAMETERS ────────────────────────────────────────────────────────────
const P = {
  dt:               0.5,
  viscosity:        0.10,    // lower than baseline → vortices persist longer
  waveVx:           3.2,
  waveWater:        0.82,
  ambientVx:        0.55,
  ambientWater:     0.28,
  waterPressure:    0.14,
  erosionRate:      0.0038,  // base speed×water erosion
  vortErosionRate:  0.0055,  // vorticity-magnitude erosion coefficient
  shearErosionRate: 0.0045,  // wall-flank/corner-undercut erosion coefficient
  depositRate:      0.003,
  slumpRate:        0.05,
  maxSlope:         0.32,
  foamThresh:       1.2,
  foamDecay:        0.969,
  waterDecay:       0.9983,
  sedDecay:         0.9978,
  velDecay:         0.992,
  blockH:           0.42,    // terrain height → solid obstacle
  wavePeriod:       210,     // frames between auto waves
  waveDuration:     82,      // frames each wave lasts
  pressureIter:     20,      // Gauss-Seidel iterations (more → cleaner flow)
  maxVel:           5.5,
  meanVelDecay:     0.97,    // decay rate for time-averaged velocity
};

// ── RUNTIME STATE ─────────────────────────────────────────────────────────
let paused         = false;
let frameNum       = 0;
let waveCount      = 0;
let isWaving       = false;
let manualWave     = false;
let manualTick     = 0;
let erosionTotal   = 0;
let maxCurlDisplay = 0;      // peak |ω| this frame (for HUD)

// turbulenceStrength 0–1 controls vorticity-confinement epsilon
// and vorticity-based erosion weight.
let turbulenceStrength = 0.5;
let showHeatmap        = false;

let fpsFrames  = 0;
let fpsTime    = performance.now();
let currentFps = 0;

// Mouse brush
let mouseDown  = false;
let mouseRight = false;
let brushGX    = -1, brushGY = -1;
const BRUSH_R  = 4;
const BRUSH_R2 = BRUSH_R * BRUSH_R;

// ── CANVAS SETUP ──────────────────────────────────────────────────────────
const canvas    = document.getElementById('canvas');
const ctx       = canvas.getContext('2d');
const offscreen = document.createElement('canvas');
offscreen.width  = GW;
offscreen.height = GH;
const offCtx = offscreen.getContext('2d');
const imgData = offCtx.createImageData(GW, GH);
const pixels  = imgData.data;

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── TRACERS ───────────────────────────────────────────────────────────────
// Denser and longer-trailed than baseline; each point stores curl for coloring.
const NUM_TRACERS = 720;
const TRAIL_LEN   = 15;
let tracers = [];

function newTracer() {
  return {
    x:       Math.random() * 13,
    y:       Math.random() * GH,
    life:    (Math.random() * 70) | 0,
    maxLife: 55 + ((Math.random() * 70) | 0),
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
    const curl = curlF[k];
    tr.trail.push({ x: tr.x, y: tr.y, spd, curl });
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

// ── BILINEAR INTERPOLATION (no-slip at solid walls) ───────────────────────
function bsample(f, x, y) {
  x = x < 0.5 ? 0.5 : (x > GW - 1.5 ? GW - 1.5 : x);
  y = y < 0.5 ? 0.5 : (y > GH - 1.5 ? GH - 1.5 : y);
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1, y1 = y0 + 1;
  const sx = x - x0, sy = y - y0;

  let w00 = (1 - sx) * (1 - sy);
  let w10 = sx        * (1 - sy);
  let w01 = (1 - sx) * sy;
  let w11 = sx        * sy;

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

// ── BASELINE FLUID PHYSICS ────────────────────────────────────────────────

function advect(field, out) {
  const dt = P.dt;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k = j * GW + i;
      out[k] = bsample(field, i - vx[k] * dt, j - vy[k] * dt);
    }
  }
}

function advectVelocity() {
  const dt = P.dt;
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k  = j * GW + i;
      const bx = i - vx[k] * dt;
      const by = j - vy[k] * dt;
      t0[k] = bsample(vx, bx, by);
      t1[k] = bsample(vy, bx, by);
    }
  }
  vx.set(t0);
  vy.set(t1);
}

// Velocity diffusion — kept intentionally low so eddies persist.
function diffuseVelocity() {
  const v = P.viscosity, iv = 1 - v;
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      t0[k] = iv * vx[k] + v * 0.25 * (vx[k-1] + vx[k+1] + vx[k-GW] + vx[k+GW]);
      t1[k] = iv * vy[k] + v * 0.25 * (vy[k-1] + vy[k+1] + vy[k-GW] + vy[k+GW]);
    }
  }
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      vx[k] = t0[k];
      vy[k] = t1[k];
    }
  }
}

// No-slip BC: zero velocity and fluid inside solid cells.
function applyTerrainBlock() {
  for (let k = 0; k < N; k++) {
    if (terrain[k] > P.blockH) {
      vx[k]       = 0;
      vy[k]       = 0;
      water[k]    = 0;
      sediment[k] = 0;
    }
  }
}

// Pressure projection (Gauss–Seidel) → divergence-free velocity.
// This is what makes flow curl around obstacle walls.
function projectVelocity() {
  // Divergence → t2
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      t2[k] = (terrain[k] > P.blockH) ? 0
            : 0.5 * (vx[k + 1] - vx[k - 1] + vy[k + GW] - vy[k - GW]);
    }
  }
  // Solve −∇²p = div → t3
  t3.fill(0);
  for (let s = 0; s < P.pressureIter; s++) {
    for (let j = 1; j < GH - 1; j++) {
      for (let i = 1; i < GW - 1; i++) {
        const k = j * GW + i;
        if (terrain[k] > P.blockH) { t3[k] = 0; continue; }
        // Neumann BC at solid boundaries: mirror own pressure
        const pL = terrain[k - 1]  > P.blockH ? t3[k] : t3[k - 1];
        const pR = terrain[k + 1]  > P.blockH ? t3[k] : t3[k + 1];
        const pU = terrain[k - GW] > P.blockH ? t3[k] : t3[k - GW];
        const pD = terrain[k + GW] > P.blockH ? t3[k] : t3[k + GW];
        t3[k] = (pL + pR + pU + pD - t2[k]) * 0.25;
      }
    }
  }
  // Subtract pressure gradient
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      if (terrain[k] > P.blockH) continue;
      vx[k] -= 0.5 * (t3[k + 1]  - t3[k - 1]);
      vy[k] -= 0.5 * (t3[k + GW] - t3[k - GW]);
    }
  }
}

function clampVelocity() {
  const maxV = P.maxVel;
  for (let k = 0; k < N; k++) {
    const s2 = vx[k] * vx[k] + vy[k] * vy[k];
    if (s2 > maxV * maxV) {
      const sc = maxV / Math.sqrt(s2);
      vx[k] *= sc;
      vy[k] *= sc;
    }
  }
}

function addWaterPressure() {
  const wp = P.waterPressure;
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      if (terrain[k] > P.blockH) continue;
      vx[k] += wp * (water[k - 1]  - water[k + 1])  * 0.5;
      vy[k] += wp * (water[k - GW] - water[k + GW]) * 0.5;
    }
  }
}

// Inject wave from the left edge.  A spatially-varying asymmetric
// perturbation seeds the Kelvin–Helmholtz / Kármán instability.
function injectWave(active) {
  const wVx = active ? P.waveVx    : P.ambientVx;
  const wW  = active ? P.waveWater : P.ambientWater;
  const INJ = 5;
  for (let j = 0; j < GH; j++) {
    const wobble = active
      ? Math.sin(frameNum * 0.07 + j * 0.045) * 0.45
      : 0;
    // Asymmetric component: slow sinusoid breaks top/bottom symmetry,
    // which is necessary for alternating vortex shedding to develop.
    const asymm = active
      ? Math.sin(frameNum * 0.025) * Math.cos(j * 0.085) * 0.18
      : 0;
    const sway = Math.sin(frameNum * 0.05 + j * 0.06) * 0.38 + asymm;
    for (let i = 0; i < INJ; i++) {
      const k = j * GW + i;
      if (terrain[k] > P.blockH) continue;
      vx[k]    = wVx + wobble;
      vy[k]    = sway;
      water[k] = Math.min(1, wW + Math.abs(wobble) * 0.35);
      if (active) foam[k] = Math.min(1, foam[k] + 0.55);
    }
  }
}

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
          const move  = rate * (diff - ms);
          terrain[k] -= move;
          terrain[nb]+= move;
        }
      }
    }
  }
}

function applyDecay() {
  for (let k = 0; k < N; k++) {
    water[k]    *= P.waterDecay;
    sediment[k] *= P.sedDecay;
    vx[k]       *= P.velDecay;
    vy[k]       *= P.velDecay;
    if (water[k]    < 0.002) water[k]    = 0;
    if (sediment[k] < 0.002) sediment[k] = 0;
  }
}

// ── VORTEX SHEDDING PHYSICS ───────────────────────────────────────────────

// 1. Compute vorticity field ω = ∂vy/∂x − ∂vx/∂y (scalar, 2D).
//    Positive ω = counter-clockwise rotation.
//    Also track the peak for HUD display.
function computeVorticity() {
  let mx = 0;
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k = j * GW + i;
      if (terrain[k] > P.blockH) { curlF[k] = 0; continue; }
      const omega = (vy[k + 1] - vy[k - 1]) * 0.5
                  - (vx[k + GW] - vx[k - GW]) * 0.5;
      curlF[k] = omega;
      const ao = omega < 0 ? -omega : omega;
      if (ao > mx) mx = ao;
    }
  }
  maxCurlDisplay = mx;
}

// 2. Vorticity confinement (Fedkiw et al. / Steinhoff–Underhill).
//    Prevents numerical dissipation from destroying coherent vortex cores.
//    Force: F = ε · (N̂ × ω)  where N̂ = ∇|ω| / |∇|ω||
//    In 2D with scalar ω: Fx = ε·Ny·ω,  Fy = −ε·Nx·ω
//    turbulenceStrength maps 0→ε=0.05 (barely active), 1→ε=0.95 (strong).
function applyVorticityConfinement() {
  const epsilon = turbulenceStrength * 0.90 + 0.05;
  const dt      = P.dt;

  for (let j = 2; j < GH - 2; j++) {
    for (let i = 2; i < GW - 2; i++) {
      const k = j * GW + i;
      if (terrain[k] > P.blockH) continue;

      // Gradient of |ω| via central differences
      const omL = Math.abs(curlF[k - 1]);
      const omR = Math.abs(curlF[k + 1]);
      const omU = Math.abs(curlF[k - GW]);
      const omD = Math.abs(curlF[k + GW]);

      let nx = (omR - omL) * 0.5;
      let ny = (omD - omU) * 0.5;
      const nLen = Math.sqrt(nx * nx + ny * ny) + 1e-9;
      nx /= nLen;
      ny /= nLen;

      const omega = curlF[k];
      // Cross product N̂ × ω_hat in 2D gives (Ny·ω, −Nx·ω)
      vx[k] += epsilon *  ny * omega * dt;
      vy[k] += epsilon * (-nx) * omega * dt;
    }
  }
}

// 3. Time-averaged velocity for flow-reversal detection.
//    meanVx/meanVy decay toward the current velocity slowly.
//    When the instantaneous velocity opposes the mean, flow has reversed—
//    an eddy is present—and erosion is boosted.
function updateMeanVelocity() {
  const d  = P.meanVelDecay;
  const id = 1.0 - d;
  for (let k = 0; k < N; k++) {
    meanVx[k] = d * meanVx[k] + id * vx[k];
    meanVy[k] = d * meanVy[k] + id * vy[k];
  }
}

// ── EROSION AND DEPOSITION ────────────────────────────────────────────────
// Three mechanisms work together:
//   A. Speed × water:         baseline drag erosion
//   B. |ω| × water:           eddy scouring (vortex cores / wake)
//   C. Wall-flank shear:      ∇|ω| at obstacle-adjacent cells (bank undercut)
//   D. Flow-reversal stress:  sign change of velocity → alternating eddy zone
function updateErosionDeposition() {
  for (let j = 1; j < GH - 1; j++) {
    for (let i = 1; i < GW - 1; i++) {
      const k  = j * GW + i;
      const t  = terrain[k];
      const w  = water[k];
      if (t < 0.001 || w < 0.03) continue;

      const cvx  = vx[k], cvy = vy[k];
      const vmag = Math.sqrt(cvx * cvx + cvy * cvy);
      const absO = Math.abs(curlF[k]);

      let rate = 0;

      // A. Speed-driven baseline erosion
      if (vmag > 0.18) {
        rate += P.erosionRate * vmag * w;
      }

      // B. Vorticity-driven eddy erosion (eddies scour even at low speed)
      if (absO > 0.06) {
        rate += P.vortErosionRate * absO * w * turbulenceStrength;
      }

      // C. Wall-flank shear / bank undercut.
      //    For cells directly adjacent to a solid, the vorticity gradient
      //    (∇|ω|) points from fluid toward the separation point on the wall
      //    face.  High gradient = strong shear layer = undercut erosion.
      //    Square-tower corners generate the steepest gradients; round-tower
      //    flanks see gentler gradients and erode more symmetrically.
      const solidL = terrain[k - 1]  > P.blockH;
      const solidR = terrain[k + 1]  > P.blockH;
      const solidU = terrain[k - GW] > P.blockH;
      const solidD = terrain[k + GW] > P.blockH;
      const wallAdj = solidL || solidR || solidU || solidD;

      if (wallAdj && w > 0.05) {
        // Vorticity gradient magnitude (proxy for shear stress on the wall)
        const dOmDx = (Math.abs(curlF[k + 1]) - Math.abs(curlF[k - 1])) * 0.5;
        const dOmDy = (Math.abs(curlF[k + GW]) - Math.abs(curlF[k - GW])) * 0.5;
        const omGrad = Math.sqrt(dOmDx * dOmDx + dOmDy * dOmDy);

        rate += P.shearErosionRate * (omGrad + vmag * 0.4) * w * turbulenceStrength;

        // Corner undercut bonus: cells at convex obstacle corners (two
        // perpendicular solid neighbours) sit at the primary separation
        // point and receive an extra erosion boost driven by vorticity.
        const atCorner = (solidL && solidU) || (solidR && solidU)
                      || (solidL && solidD) || (solidR && solidD);
        if (atCorner && absO > 0.04) {
          rate += P.shearErosionRate * absO * w * turbulenceStrength * 0.9;
        }
      }

      // D. Flow-reversal erosion (alternating eddy zone).
      //    Dot product of current and mean velocity < 0 means flow reversed.
      //    This fires in the recirculation bubbles alternating behind the
      //    castle walls—precisely where Kármán-like eddies live.
      const dot      = cvx * meanVx[k] + cvy * meanVy[k];
      const meanSpd  = Math.sqrt(meanVx[k] * meanVx[k] + meanVy[k] * meanVy[k]);
      if (dot < -0.4 && meanSpd > 0.25 && vmag > 0.25) {
        rate += P.erosionRate * 1.6 * vmag * w;
      }

      if (rate > 0 && t > 0.015) {
        const actual = t < rate ? t : rate;
        terrain[k]  -= actual;
        sediment[k]  = (sediment[k] + actual < 1) ? sediment[k] + actual : 1;
        erosionTotal += actual;
      }

      // Deposition: sediment settles when flow is slow
      const sed = sediment[k];
      if (sed > 0.004 && vmag < 0.75) {
        const deposit = P.depositRate * sed * (1.0 - vmag / 0.75);
        terrain[k]   += deposit;
        sediment[k]  -= deposit;
      }
    }
  }
}

// Foam: fast-flow surface foam + eddy-core foam in recirculation zones.
function updateFoam() {
  for (let k = 0; k < N; k++) {
    if (water[k] > 0.15) {
      const spd = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);
      if (spd > P.foamThresh) {
        foam[k] = (foam[k] + 0.09 < 1) ? foam[k] + 0.09 : 1;
      }
      // Eddy foam: high vorticity in the presence of water marks vortex cores
      const ao = Math.abs(curlF[k]);
      if (ao > 0.35 && turbulenceStrength > 0.15) {
        const fInc = ao * 0.04 * turbulenceStrength;
        foam[k] = (foam[k] + fInc < 1) ? foam[k] + fInc : 1;
      }
    }
    foam[k] *= P.foamDecay;
    if (foam[k] < 0.004) foam[k] = 0;
  }
}

// ── MAIN SIMULATION STEP ──────────────────────────────────────────────────
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

  // Vorticity confinement is an external force; compute ω from current
  // field first, apply force, then advect → project.
  computeVorticity();
  applyVorticityConfinement();

  injectWave(waveActive);
  addWaterPressure();
  advectVelocity();
  applyTerrainBlock();
  diffuseVelocity();
  projectVelocity();
  applyTerrainBlock();
  clampVelocity();

  // Update mean velocity for reversal-erosion detection
  updateMeanVelocity();

  advect(water,    t0); water.set(t0);
  advect(sediment, t0); sediment.set(t0);

  for (let k = 0; k < N; k++) {
    if (water[k]    < 0) water[k]    = 0; else if (water[k]    > 1) water[k]    = 1;
    if (sediment[k] < 0) sediment[k] = 0; else if (sediment[k] > 1) sediment[k] = 1;
    if (terrain[k]  < 0) terrain[k]  = 0; else if (terrain[k]  > 1) terrain[k]  = 1;
  }

  applyDecay();
  updateErosionDeposition();
  slumpTerrain();

  for (let k = 0; k < N; k++) {
    if (terrain[k] < 0) terrain[k] = 0; else if (terrain[k] > 1) terrain[k] = 1;
  }

  applyTerrainBlock();
  updateFoam();
  updateTracers();

  frameNum++;
}

// ── CASTLE SEEDING ────────────────────────────────────────────────────────
// Layout: rectangular outer wall.  Upstream (left-facing) corners have
// ROUND towers; downstream (right) corners have SQUARE towers.
// A prominent round bastion protrudes from the left wall centre.
// This lets the player compare vortex behaviour side-by-side:
//   Round towers:  smooth trailing vortex pair, symmetric shedding.
//   Square towers: sharp Kármán-like alternating eddies, higher drag,
//                  stronger wake turbulence and erosion.

function setT(i, j, h) {
  if (i < 0 || i >= GW || j < 0 || j >= GH) return;
  const k = j * GW + i;
  if (h > terrain[k]) terrain[k] = h;
}

function drawSquareTower(cx, cy, hw, h) {
  for (let dj = -hw; dj <= hw; dj++) {
    for (let di = -hw; di <= hw; di++) {
      setT(cx + di, cy + dj, h);
    }
  }
}

function drawRoundTower(cx, cy, r, h) {
  const r2 = r * r;
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      if (di * di + dj * dj <= r2) setT(cx + di, cy + dj, h);
    }
  }
}

function seedCastle() {
  terrain.fill(0);

  const cx = 135, cy = 65;   // castle centre (right-of-centre, clear of ocean)
  const OW = 24, OH = 23;    // outer wall half-extents
  const WW = 3;               // wall thickness in cells

  const x0 = cx - OW, x1 = cx + OW;
  const y0 = cy - OH, y1 = cy + OH;

  // Outer rectangular ring wall
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const onL = i <= x0 + WW - 1;
      const onR = i >= x1 - WW + 1;
      const onT = j <= y0 + WW - 1;
      const onB = j >= y1 - WW + 1;
      if (!(onL || onR || onT || onB)) continue;
      // Gate in the right (downstream) wall at the vertical centre
      if (onR && Math.abs(j - cy) <= 5) continue;
      setT(i, j, 0.80 + Math.random() * 0.12);
    }
  }

  // ── ROUND upstream towers (NW and SW corners, facing the waves) ──────────
  // Round geometry: smooth pressure distribution → boundary layer attached
  // further aft → symmetric trailing vortices → lower wake drag.
  const TR = 7;
  drawRoundTower(x0, y0, TR, 0.88 + Math.random() * 0.10);  // NW round
  drawRoundTower(x0, y1, TR, 0.88 + Math.random() * 0.10);  // SW round

  // ── SQUARE downstream towers (NE and SE corners, in the wake) ────────────
  // Sharp corners → immediate flow separation → strong alternating eddies →
  // higher wake turbulence → stronger vorticity-driven erosion of flanks.
  drawSquareTower(x1, y0, TR, 0.90 + Math.random() * 0.08); // NE square
  drawSquareTower(x1, y1, TR, 0.90 + Math.random() * 0.08); // SE square

  // ── Round bastion on the upstream (left) face ─────────────────────────────
  // Largest single obstacle; dominates the vortex shedding pattern.
  // Being round, it sheds the cleanest Kármán-like alternating vortex pair
  // of any structure in the castle when turbulenceStrength is high.
  drawRoundTower(x0 - 2, cy, 9, 0.87 + Math.random() * 0.10);

  // ── Inner square keep ─────────────────────────────────────────────────────
  const KH = 9;
  for (let dj = -KH; dj <= KH; dj++) {
    for (let di = -KH; di <= KH; di++) {
      setT(cx + di, cy + dj, 0.84 + Math.random() * 0.08);
    }
  }

  // ── Central round donjon (high tower on top of keep) ─────────────────────
  drawRoundTower(cx, cy, 5, 0.95 + Math.random() * 0.04);

  // ── Low beach berm directly in front of the castle ───────────────────────
  for (let j = cy - 15; j <= cy + 15; j++) {
    const d = Math.abs(j - cy);
    const h = 0.30 - d * 0.016;
    if (h <= 0) continue;
    for (let i = x0 - 16; i < x0 - 9; i++) {
      setT(i, j, h * (0.85 + Math.random() * 0.3));
    }
  }

  // Record for health metric
  origTerrain.set(terrain);
  initCastleMass = 0;
  for (let k = 0; k < N; k++) {
    if (origTerrain[k] > 0.5) initCastleMass += origTerrain[k];
  }
}

function resetSimulation() {
  seedCastle();
  water.fill(0);
  sediment.fill(0);
  foam.fill(0);
  vx.fill(0);
  vy.fill(0);
  curlF.fill(0);
  meanVx.fill(0);
  meanVy.fill(0);
  t0.fill(0); t1.fill(0); t2.fill(0); t3.fill(0);
  frameNum       = 0;
  waveCount      = 0;
  isWaving       = false;
  manualWave     = false;
  manualTick     = 0;
  erosionTotal   = 0;
  maxCurlDisplay = 0;
  initTracers();
}

// ── RENDERING ─────────────────────────────────────────────────────────────

function waterColorRGB(speed, w, sed) {
  const sn = speed < 0 ? 0 : (speed > P.maxVel ? 1 : speed / P.maxVel);
  let r =  18 + 90  * sn;
  let g =  55 + 160 * sn;
  let b = 180 + 50  * sn;
  if (sed > 0.02) {
    const st = sed < 1 ? sed : 1;
    r = r + (190 - r) * st * 0.55;
    g = g + (145 - g) * st * 0.45;
    b = b + ( 60 - b) * st * 0.50;
  }
  return [r, g, b];
}

// Fill the low-res ImageData pixel buffer.
// Optional curl heatmap: signed ω → red(CW) / cyan(CCW) tint on fluid cells.
function renderPixels() {
  const mxC = maxCurlDisplay + 0.01;

  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const k   = j * GW + i;
      const t   = terrain[k];
      const w   = water[k];
      const f   = foam[k];
      const sed = sediment[k];
      const spd = Math.sqrt(vx[k] * vx[k] + vy[k] * vy[k]);

      // ── Base terrain colour ───────────────────────────────
      let r, g, b;
      if (t > 0.5) {
        const bright = 0.72 + 0.28 * t;
        r = (215 * bright) | 0;
        g = (195 * bright) | 0;
        b = (155 * bright) | 0;
      } else if (t > 0.05) {
        const bright = 0.78 + 0.22 * (t / 0.5);
        r = (210 * bright) | 0;
        g = (185 * bright) | 0;
        b = (138 * bright) | 0;
      } else {
        const wetness = w < 1 ? w : 1;
        r = (205 - 28 * wetness) | 0;
        g = (182 - 22 * wetness) | 0;
        b = (135 - 18 * wetness) | 0;
      }

      // ── Water overlay ─────────────────────────────────────
      if (w > 0.02) {
        const alpha  = w < 0.9 ? w * 1.1 : 0.99;
        const [wr, wg, wb] = waterColorRGB(spd, w, sed);
        r = (r * (1 - alpha) + wr * alpha) | 0;
        g = (g * (1 - alpha) + wg * alpha) | 0;
        b = (b * (1 - alpha) + wb * alpha) | 0;
      }

      // ── Curl heatmap overlay (optional) ──────────────────
      // Red tint for CW rotation (ω < 0), cyan/blue for CCW (ω > 0).
      // Shows eddy cores and the alternating Kármán street clearly.
      if (showHeatmap && w > 0.02 && t < P.blockH) {
        const omega = curlF[k];
        const cn    = omega / mxC;       // normalised −1..+1
        if (Math.abs(cn) > 0.06) {
          const ha = Math.min(0.60, Math.abs(cn) * 0.65);
          if (cn > 0) {
            // CCW — cyan tint
            r = ((r * (1 - ha)) + ( 20 * ha)) | 0;
            g = ((g * (1 - ha)) + (200 * ha)) | 0;
            b = ((b * (1 - ha)) + (255 * ha)) | 0;
          } else {
            // CW — red-orange tint
            r = ((r * (1 - ha)) + (255 * ha)) | 0;
            g = ((g * (1 - ha)) + ( 70 * ha)) | 0;
            b = ((b * (1 - ha)) + ( 15 * ha)) | 0;
          }
        }
      }

      // ── Foam overlay ──────────────────────────────────────
      if (f > 0.04) {
        const fa = f < 1 ? f : 1;
        r = (r + (252 - r) * fa) | 0;
        g = (g + (252 - g) * fa) | 0;
        b = (b + (255 - b) * fa) | 0;
      }

      const p  = k << 2;
      pixels[p]     = r > 255 ? 255 : (r < 0 ? 0 : r);
      pixels[p + 1] = g > 255 ? 255 : (g < 0 ? 0 : g);
      pixels[p + 2] = b > 255 ? 255 : (b < 0 ? 0 : b);
      pixels[p + 3] = 255;
    }
  }
  offCtx.putImageData(imgData, 0, 0);
}

// Velocity arrows on a coarse grid
function renderVelocityArrows(cw, ch) {
  const scaleX = cw / GW;
  const scaleY = ch / GH;
  const STEP   = 14;

  ctx.save();
  ctx.lineWidth = 1.0;
  for (let j = (STEP / 2) | 0; j < GH; j += STEP) {
    for (let i = (STEP / 2) | 0; i < GW; i += STEP) {
      const k   = j * GW + i;
      const cvx = vx[k], cvy = vy[k];
      const spd = Math.sqrt(cvx * cvx + cvy * cvy);
      if (spd < 0.12) continue;

      const px  = i * scaleX;
      const py  = j * scaleY;
      const len = Math.min(spd, 2.5) * scaleX * 0.55;
      const ex  = px + (cvx / spd) * len;
      const ey  = py + (cvy / spd) * len;

      const sn1   = spd / 4 > 1 ? 1 : spd / 4;
      const alpha = 0.22 + 0.42 * sn1;
      ctx.strokeStyle = `rgba(${(60 + 180 * sn1) | 0},${(180 + 70 * sn1) | 0},255,${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.arc(ex, ey, 1.1, 0, 6.2832);
      ctx.fill();
    }
  }
  ctx.restore();
}

// Dense tracer trails coloured by local curl:
//   Low |ω|  → blue–white   (irrotational flow)
//   ω > 0    → cyan–green   (CCW eddy cores)
//   ω < 0    → red–magenta  (CW eddy cores)
function renderTracers(cw, ch) {
  const scaleX = cw / GW;
  const scaleY = ch / GH;
  const mxC    = maxCurlDisplay + 0.01;

  ctx.save();
  ctx.lineWidth = 1.3;
  for (const tr of tracers) {
    const tlen = tr.trail.length;
    if (tlen < 2) continue;
    for (let s = 1; s < tlen; s++) {
      const a    = tr.trail[s - 1];
      const b    = tr.trail[s];
      const age  = s / tlen;
      const sn   = b.spd / 3.5;
      const sn1  = sn > 1 ? 1 : sn;
      const cn   = b.curl / mxC;   // normalised curl −1..+1

      let cr, cg, cb;
      if (Math.abs(cn) < 0.12) {
        // Irrotational: blue→white based on speed
        cr = (100 + 155 * sn1) | 0;
        cg = (200 +  50 * sn1) | 0;
        cb = 255;
      } else if (cn > 0) {
        // CCW eddy: cyan→green
        const te = Math.min(1, Math.abs(cn) * 1.8);
        cr = ( 40 * (1 - te) +  20 * te) | 0;
        cg = (210 * (1 - te) + 255 * te) | 0;
        cb = (255 * (1 - te) +  80 * te) | 0;
      } else {
        // CW eddy: cyan→red-magenta
        const te = Math.min(1, Math.abs(cn) * 1.8);
        cr = ( 80 * (1 - te) + 255 * te) | 0;
        cg = (185 * (1 - te) +  40 * te) | 0;
        cb = (255 * (1 - te) + 140 * te) | 0;
      }

      const alpha = age * (0.14 + 0.52 * sn1);
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
    if (origTerrain[k] > 0.5) m += terrain[k];
  }
  return m < 0 ? 0 : (m > initCastleMass ? 1 : m / initCastleMass);
}

function render() {
  const cw = canvas.width, ch = canvas.height;

  renderPixels();

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(offscreen, 0, 0, cw, ch);

  renderVelocityArrows(cw, ch);
  renderTracers(cw, ch);

  // HUD
  const health = castleHealth();
  const pct    = (health * 100).toFixed(0);
  const mH     = document.getElementById('m-health');
  mH.textContent = `Castle: ${pct}%`;
  mH.style.color = health > 0.7 ? '#7ef0a8' : (health > 0.4 ? '#f0c07e' : '#f07e7e');
  document.getElementById('m-waves').textContent  = `Waves: ${waveCount}`;
  document.getElementById('m-eroded').textContent = `Eroded: ${erosionTotal.toFixed(1)}`;
  document.getElementById('m-curl').textContent   = `Max curl: ${maxCurlDisplay.toFixed(2)}`;
  document.getElementById('m-turb').textContent   = `Turb: ${(turbulenceStrength * 100).toFixed(0)}%`;
  document.getElementById('m-fps').textContent    = `FPS: ${currentFps}`;
}

// ── BRUSH ─────────────────────────────────────────────────────────────────

function applyBrush(gx, gy, add) {
  const iMin = (gx - BRUSH_R) | 0, iMax = ((gx + BRUSH_R) | 0) + 1;
  const jMin = (gy - BRUSH_R) | 0, jMax = ((gy + BRUSH_R) | 0) + 1;
  for (let j = jMin; j <= jMax; j++) {
    if (j < 0 || j >= GH) continue;
    for (let i = iMin; i <= iMax; i++) {
      if (i < 0 || i >= GW) continue;
      const dx = i - gx, dy = j - gy;
      if (dx * dx + dy * dy > BRUSH_R2) continue;
      const k = j * GW + i;
      if (add) {
        terrain[k] = Math.min(1, terrain[k] + 0.09);
        water[k] = 0; vx[k] = 0; vy[k] = 0;
      } else {
        terrain[k] = Math.max(0, terrain[k] - 0.09);
      }
    }
  }
}

function canvasToGrid(cx, cy) {
  return [
    (cx / canvas.width  * GW) | 0,
    (cy / canvas.height * GH) | 0,
  ];
}

// ── EVENT HANDLERS ────────────────────────────────────────────────────────

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

canvas.addEventListener('mouseup',     () => { mouseDown = false; });
canvas.addEventListener('mouseleave',  () => { mouseDown = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  mouseDown = true; mouseRight = false;
  const [gx, gy] = canvasToGrid(touch.clientX, touch.clientY);
  brushGX = gx; brushGY = gy;
  applyBrush(gx, gy, true);
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!mouseDown) return;
  const touch = e.touches[0];
  const [gx, gy] = canvasToGrid(touch.clientX, touch.clientY);
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

// Turbulence slider
const turbSlider = document.getElementById('turb-slider');
const turbValEl  = document.getElementById('turb-val');
turbSlider.addEventListener('input', () => {
  turbulenceStrength = turbSlider.value / 100;
  turbValEl.textContent = `${turbSlider.value}%`;
});
turbSlider.style.pointerEvents = 'auto';

// Curl heatmap toggle
const heatmapBtn = document.getElementById('heatmap-toggle');
heatmapBtn.addEventListener('click', () => {
  showHeatmap = !showHeatmap;
  heatmapBtn.textContent = `Curl heatmap: ${showHeatmap ? 'ON' : 'OFF'}`;
  heatmapBtn.classList.toggle('active', showHeatmap);
});

// ── MAIN LOOP ─────────────────────────────────────────────────────────────

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

// ── INIT ─────────────────────────────────────────────────────────────────
resetSimulation();
gameLoop();

})();
