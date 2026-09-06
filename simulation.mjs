export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const GRAVITY = 220;
const WAVE_HEIGHT = 1.25;
const WAVE_DURATION = 7;
const WAVE_SPEED = 18;
const MAX_WAVE_ANGLE = Math.PI / 14;
const WAVE_COOLDOWN = .65;
const SURF_RAMP_SECONDS = 90;

// Water lives in cells; signed face fluxes transfer volume between neighbours.
// An offshore reservoir exchanges water with the sea. Sand walls are elevations,
// not binary obstacles: water can pool, find a gap, or overtop a low wall.
export class Beach {
  constructor(width = 256, height = 160) {
    this.width = width;
    this.height = height;
    this.size = width * height;
    for (const name of ['bed', 'water', 'wet', 'foam', 'sediment', 'flowX', 'flowY',
      'outgoing', 'sedimentDelta', 'change', 'base', 'previousFlowX', 'previousFlowY']) {
      this[name] = new Float32Array(this.size);
    }
    this.offshore = new Int32Array(width);
    this.autoWaves = true;
    this.reset();
  }

  reset() {
    for (const name of ['water', 'wet', 'foam', 'sediment', 'flowX', 'flowY', 'change']) this[name].fill(0);
    this.time = 0;
    this.waves = [];
    this.lastWaveAt = -Infinity;
    this.nextWaveAt = 4.5;
    this.waveCount = 0;
    this.seaLevel = 0;
    const { width: w, height: h, bed, base, water } = this;
    for (let x = 0; x < w; x++) {
      const shore = this.shoreline(x);
      this.offshore[x] = Math.max(1, Math.floor(shore - 15));
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        const ripple = .018 * Math.sin(x * .22 + y * .1) + .012 * Math.sin(y * .33 - x * .12);
        const distance = y - shore;
        bed[i] = clamp(distance < 0 ? distance * .032
          : Math.min(distance, 20) * .016 + Math.max(0, distance - 20) * .004, -1.5, .95) + ripple;
        base[i] = bed[i];
        if (y < shore - 2) water[i] = Math.max(0, -bed[i]);
        this.wet[i] = water[i] > .001 ? 1 : 0;
      }
    }
  }

  shoreline(x) {
    return this.height * .275 + 7 * Math.sin(x / this.width * 5.5) + 3 * Math.cos(x * .065);
  }

  wave({ angle = Math.sin((this.waveCount + 1) * 2.399963) * MAX_WAVE_ANGLE } = {}) {
    if (!Number.isFinite(angle) || Math.abs(angle) > MAX_WAVE_ANGLE) {
      throw new RangeError('Wave angle must be within 13 degrees of the shoreward direction.');
    }
    if (this.time - this.lastWaveAt < WAVE_COOLDOWN) return false;
    const intensity = 1 + this.time / SURF_RAMP_SECONDS;
    const height = WAVE_HEIGHT * intensity;
    // Shorten crests along with the gaps so faster sets still look like waves,
    // rather than merging into a sustained rise in the reservoir.
    const duration = Math.max(WAVE_DURATION / intensity, WAVE_COOLDOWN * 2);
    const directionX = Math.sin(angle), directionY = Math.cos(angle);
    // Shift the oblique front so its earliest point enters at age zero.
    const offset = Math.max(0, -(this.width - 1) * directionX);
    let travelTime = 0;
    for (let x = 0; x < this.width; x++) {
      travelTime = Math.max(travelTime,
        (x * directionX + (this.offshore[x] - 1) * directionY + offset) / WAVE_SPEED);
    }
    this.waves.push({
      startedAt: this.time, height, duration, angle, directionX, directionY, offset,
      endsAt: this.time + travelTime + duration,
    });
    this.lastWaveAt = this.time;
    this.waveCount++;
    // Small sets overlap, followed by a lull that lets the beach drain.
    const gap = this.waveCount % 3 === 0 ? 15 : this.waveCount % 3 === 1 ? 2.8 : 4.5;
    const interval = (gap + .4 * Math.sin(this.waveCount * 1.73)) / intensity;
    this.nextWaveAt = this.time + Math.max(WAVE_COOLDOWN, interval);
    return true;
  }

  wavePhaseAt(wave, x, y, time = this.time) {
    const travel = (x * wave.directionX + y * wave.directionY + wave.offset) / WAVE_SPEED;
    return (time - wave.startedAt - travel) / wave.duration;
  }

  oceanLevelAt(x, y, time = this.time) {
    let swell = 0, largest = 0;
    for (const wave of this.waves) {
      largest = Math.max(largest, wave.height);
      const phase = this.wavePhaseAt(wave, x, y, time);
      // A narrower crest leaves a trough between nearby swells instead of
      // making overlapping packets look like one sustained rise in sea level.
      if (phase > 0 && phase < 1) swell += wave.height * Math.sin(Math.PI * phase) ** 4;
    }
    // Limit overlaps relative to the current waves, not the starting height,
    // so the safety bound does not flatten the progression later in a session.
    if (swell > largest) {
      swell = largest + largest * Math.tanh((swell - largest) / largest);
    }
    return .025 * Math.sin(time * .3) + swell;
  }

  brush(cx, cy, radius, tool, strength = .12) {
    const { width: w, height: h, bed } = this;
    if (tool !== 'dig' && tool !== 'build') {
      throw new RangeError('Sand tool must be dig or build.');
    }
    for (let y = Math.max(2, Math.floor(cy - radius)); y <= Math.min(h - 2, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(1, Math.floor(cx - radius)); x <= Math.min(w - 2, Math.ceil(cx + radius)); x++) {
        const d = Math.hypot(x - cx, y - cy) / radius;
        if (d >= 1) continue;
        const i = y * w + x;
        const falloff = .5 + .5 * Math.cos(d * Math.PI);
        bed[i] += strength * falloff * (tool === 'dig' ? -1.8 : 1);
      }
    }
  }

  step(dt = 1 / 60, { ocean = true, erosion = true } = {}) {
    let maxDepth = 0;
    for (let i = 0; i < this.size; i++) maxDepth = Math.max(maxDepth, this.water[i]);
    if (ocean) {
      const startingHeight = this.autoWaves && this.nextWaveAt <= this.time + dt
        ? WAVE_HEIGHT * (1 + (this.time + dt) / SURF_RAMP_SECONDS) : 0;
      let largest = startingHeight, combined = startingHeight;
      for (const wave of this.waves) {
        largest = Math.max(largest, wave.height);
        combined += wave.height;
      }
      const maxSwell = Math.min(largest * 2, combined);
      for (let x = 0; x < this.width; x++) {
        const offshore = this.offshore[x];
        for (let y = 0; y < offshore; y++) {
          maxDepth = Math.max(maxDepth, maxSwell + .025 - this.bed[y * this.width + x]);
        }
      }
    }
    // Deeper player-dug pools carry faster waves. Substep their flow rather
    // than limiting how far the player can excavate or how high they can build.
    const steps = Math.max(1, Math.ceil(dt * Math.sqrt(GRAVITY * maxDepth) / .45));
    for (let i = 0; i < steps; i++) this.advance(dt / steps, ocean, erosion);
  }

  advance(dt, ocean, erosion) {
    const { width: w, height: h, size: n, bed, water, flowX: fx, flowY: fy, outgoing } = this;
    this.time += dt;
    this.waves = this.waves.filter(wave => this.time < wave.endsAt);
    if (ocean && this.autoWaves && this.time >= this.nextWaveAt) this.wave();
    const middle = Math.floor(w / 2);
    this.seaLevel = this.oceanLevelAt(middle, this.offshore[middle] - 1);
    if (ocean) {
      for (let x = 0; x < w; x++) {
        // Moving, angled packets enter through the offshore reservoir. The
        // foreshore, channels and backwash remain entirely flux-driven.
        const offshore = this.offshore[x];
        for (let y = 0; y < offshore; y++) {
          const i = y * w + x;
          water[i] = Math.max(0, this.oceanLevelAt(x, y) - bed[i]);
        }
      }
    }
    outgoing.fill(0);
    const damping = Math.exp(-dt * .35);
    // Mix momentum in deeper swells to suppress cell-sized ringing, while
    // keeping thin wetting fronts free to advance into newly dug channels.
    const viscosity = Math.min(.24, dt * 9);
    const oldX = this.previousFlowX, oldY = this.previousFlowY;
    oldX.set(fx);
    oldY.set(fy);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const surface = bed[i] + water[i];
        if (x < w - 1) {
          const j = i + 1;
          const faceDepth = Math.max(0, Math.max(surface, bed[j] + water[j]) - Math.max(bed[i], bed[j]));
          const mixing = viscosity * clamp((Math.min(water[i], water[j]) - .35) / .2, 0, 1);
          const momentum = oldX[i] + mixing * (oldX[x > 0 ? i - 1 : i] + oldX[i + 1] - 2 * oldX[i]);
          fx[i] = faceDepth > 0 ? (momentum + dt * GRAVITY * faceDepth * (surface - bed[j] - water[j])) * damping : 0;
          outgoing[fx[i] > 0 ? i : j] += Math.abs(fx[i]);
        }
        if (y < h - 1) {
          const j = i + w;
          const faceDepth = Math.max(0, Math.max(surface, bed[j] + water[j]) - Math.max(bed[i], bed[j]));
          const mixing = viscosity * clamp((Math.min(water[i], water[j]) - .35) / .2, 0, 1);
          const momentum = oldY[i] + mixing * (oldY[y > 0 ? i - w : i] + oldY[i + w] - 2 * oldY[i]);
          fy[i] = faceDepth > 0 ? (momentum + dt * GRAVITY * faceDepth * (surface - bed[j] - water[j])) * damping : 0;
          outgoing[fy[i] > 0 ? i : j] += Math.abs(fy[i]);
        }
      }
    }
    // Scale all outflows by the same donor budget before changing any depth.
    // This preserves volume and positivity even at four-way junctions.
    for (let i = 0; i < n; i++) outgoing[i] = outgoing[i] > 0 ? Math.min(1, water[i] / (dt * outgoing[i])) : 1;
    this.change.fill(0);
    this.sedimentDelta.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x < w - 1) {
          fx[i] *= outgoing[fx[i] > 0 ? i : i + 1];
          this.transfer(i, i + 1, fx[i] * dt);
        }
        if (y < h - 1) {
          fy[i] *= outgoing[fy[i] > 0 ? i : i + w];
          this.transfer(i, i + w, fy[i] * dt);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      water[i] = Math.max(0, water[i] + this.change[i]);
      this.sediment[i] = Math.max(0, this.sediment[i] + this.sedimentDelta[i]);
      this.wet[i] = water[i] > .008 ? 1 : Math.max(0, this.wet[i] - dt * .012);
      const speed = Math.hypot(fx[i], fy[i]);
      this.foam[i] = Math.max(this.foam[i] * Math.exp(-dt * 1.6),
        water[i] > .009 && water[i] < .16 ? Math.min(.45, speed * .4) : 0);
      if (erosion && i >= w * 2) {
        const capacity = water[i] > .015 ? Math.min(.3, speed * .05) : 0;
        if (this.sediment[i] < capacity) {
          const amount = (capacity - this.sediment[i]) * Math.min(1, dt * .75);
          bed[i] -= amount;
          this.sediment[i] += amount;
        } else {
          const amount = (this.sediment[i] - capacity) * Math.min(1, dt * .8);
          bed[i] += amount;
          this.sediment[i] -= amount;
        }
      }
    }
    if (erosion) this.slump(dt);
  }

  transfer(i, j, volume) {
    this.change[i] -= volume;
    this.change[j] += volume;
    const donor = volume > 0 ? i : j;
    const carried = this.water[donor] > 0 ? volume * this.sediment[donor] / this.water[donor] : 0;
    this.sedimentDelta[i] -= carried;
    this.sedimentDelta[j] += carried;
  }

  slump(dt) {
    const { bed, width: w, height: h } = this;
    for (let y = 2; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        for (const j of [i + 1, i + w]) {
          const difference = bed[i] - bed[j];
          const slope = this.wet[i] > .5 ? .48 : .62;
          if (Math.abs(difference) > slope) {
            const amount = Math.sign(difference) * (Math.abs(difference) - slope) * dt * .6;
            bed[i] -= amount;
            bed[j] += amount;
          }
        }
      }
    }
  }

}
