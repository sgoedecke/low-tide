import test from 'node:test';
import assert from 'node:assert/strict';
import { Beach } from './simulation.mjs';

const total = field => field.reduce((sum, value) => sum + value, 0);
function fixture() {
  const beach = new Beach(48, 32);
  for (const name of ['bed', 'water', 'wet', 'foam', 'sediment', 'flowX', 'flowY']) beach[name].fill(0);
  beach.autoWaves = false;
  return beach;
}
function advance(beach, steps, options = { ocean: false, erosion: false }) {
  for (let i = 0; i < steps; i++) beach.step(1 / 60, options);
}

test('a fresh beach has water across the top and no prebuilt structures', () => {
  const beach = new Beach();
  assert.equal(beach.offshore.length, beach.width);
  assert.deepEqual(beach.bed, beach.base);
  for (let x = 0; x < beach.width; x++) {
    assert.ok(beach.water[x] > 0, `The top edge must be ocean at column ${x}`);
    assert.equal(beach.water[(beach.height - 1) * beach.width + x], 0);
    assert.ok(beach.offshore[x] < beach.shoreline(x));
  }
  const side = Math.floor(beach.height * .7) * beach.width;
  assert.equal(beach.water[side], 0, 'The left edge below the shore must be sand');
  assert.equal(beach.water[side + beach.width - 1], 0);
});

test('the ocean deepens toward the top without changing the foreshore', () => {
  for (const [width, height] of [[160, 96], [256, 160], [256, 320]]) {
    const beach = new Beach(width, height);
    for (let x = 0; x < width; x++) {
      assert.ok(beach.water[x] > 6, 'The top edge should have room for underwater deposition');
      for (let y = 1; y < beach.offshore[x]; y++) {
        const i = y * width + x;
        assert.ok(beach.bed[i - width] < beach.bed[i], 'The offshore bed should slope toward deep water');
        assert.ok(Math.abs(beach.bed[i] + beach.water[i]) < 1e-6, 'Initial sea surface should stay level');
      }
      for (let y = beach.offshore[x]; y < height; y++) {
        const distance = y - beach.shoreline(x);
        const ripple = .018 * Math.sin(x * .22 + y * .1) + .012 * Math.sin(y * .33 - x * .12);
        const original = Math.max(-1.5, Math.min(.95, distance < 0 ? distance * .032
          : Math.min(distance, 20) * .016 + Math.max(0, distance - 20) * .004)) + ripple;
        assert.ok(Math.abs(beach.bed[y * width + x] - original) < 1e-6);
      }
    }
    const bed = beach.bed.slice();
    beach.brush(20, 3, 5, 'build');
    beach.reset();
    assert.deepEqual(beach.bed, bed);
    assert.deepEqual(beach.base, bed);
  }
});

test('the upper ocean stays predominantly submerged after prolonged sediment transport', () => {
  const beach = new Beach(96, 160);
  beach.wave();
  advance(beach, 7200, { ocean: true, erosion: true });
  let exposed = 0, cells = 0, deposited = 0;
  for (let x = 0; x < beach.width; x++) {
    for (let y = 0; y < beach.offshore[x] / 2; y++) {
      const i = y * beach.width + x;
      cells++;
      if (beach.bed[i] >= -.025) exposed++;
      deposited += Math.max(0, beach.bed[i] - beach.base[i]);
    }
  }
  assert.ok(deposited > 1, 'Sediment should still be able to build up offshore');
  assert.ok(exposed / cells < .01, `${exposed} of ${cells} upper-ocean cells rose above low tide`);
  for (const field of ['water', 'bed', 'flowX', 'flowY', 'sediment']) {
    assert.ok(beach[field].every(Number.isFinite), `${field} must remain finite`);
  }
});

test('closed water flow conserves volume and never produces negative or non-finite depths', () => {
  const beach = fixture();
  for (let y = 0; y < beach.height; y++) {
    for (let x = 0; x < beach.width; x++) {
      const i = y * beach.width + x;
      beach.bed[i] = .3 * Math.sin(x * .7 + y);
      beach.water[i] = x < 12 ? 1.4 : 0;
    }
  }
  const before = total(beach.water);
  advance(beach, 900);
  assert.ok(Math.abs(total(beach.water) - before) < .002);
  assert.ok(beach.water.every(value => Number.isFinite(value) && value >= 0));
});

test('a lake at rest stays at rest over an uneven bed', () => {
  const beach = fixture();
  for (let i = 0; i < beach.size; i++) {
    beach.bed[i] = Math.sin(i * .3) * .25;
    beach.water[i] = 1 - beach.bed[i];
  }
  advance(beach, 240);
  assert.ok(beach.water.every((depth, i) => Math.abs(depth + beach.bed[i] - 1) < .00001));
});

test('a sand wall holds water; a dug breach lets it fill the other side', () => {
  const beach = fixture();
  for (let y = 0; y < beach.height; y++) {
    for (let x = 0; x < beach.width; x++) {
      const i = y * beach.width + x;
      beach.bed[i] = x === 20 ? 2 : -.5;
      beach.water[i] = x < 20 ? .5 : 0;
    }
  }
  const rightWater = () => total(beach.water.filter((_, i) => i % beach.width > 20));
  advance(beach, 240);
  assert.equal(rightWater(), 0);
  for (let i = 0; i < 12; i++) beach.brush(20, 16, 4, 'dig', .25);
  advance(beach, 900);
  assert.ok(rightWater() > 20, `Only ${rightWater()} water reached the basin`);
});

test('water overtops a low sand wall but does not teleport into a detached pit', () => {
  const beach = fixture();
  beach.bed.fill(1.5);
  for (let y = 8; y < 24; y++) {
    for (let x = 3; x < 17; x++) {
      const i = y * beach.width + x;
      beach.bed[i] = -.5;
      beach.water[i] = 1;
    }
    beach.bed[y * beach.width + 17] = .1;
    beach.bed[y * beach.width + 18] = -.5;
  }
  beach.bed[16 * beach.width + 35] = -1;
  advance(beach, 500);
  assert.ok(beach.water[16 * beach.width + 18] > .1);
  assert.equal(beach.water[16 * beach.width + 35], 0);
});

test('erosion and deposition conserve combined bed and suspended sand', () => {
  const beach = fixture();
  for (let i = 0; i < beach.size; i++) {
    beach.water[i] = i % beach.width < 18 ? .9 : .1;
    beach.sediment[i] = .01;
  }
  const before = total(beach.bed) + total(beach.sediment);
  advance(beach, 600, { ocean: false, erosion: true });
  assert.ok(Math.abs(total(beach.bed) + total(beach.sediment) - before) < .002);
  assert.ok(beach.sediment.every(value => value >= 0 && Number.isFinite(value)));
});

test('dig and build sculpt the terrain; removed tools cannot silently build sand', () => {
  const beach = fixture();
  const i = 16 * beach.width + 24;
  beach.brush(24, 16, 5, 'build');
  assert.ok(beach.bed[i] > 0);
  beach.brush(24, 16, 5, 'dig');
  assert.ok(beach.bed[i] < 0);
  const before = beach.bed.slice();
  assert.throws(() => beach.brush(24, 16, 5, 'smooth'), RangeError);
  assert.throws(() => beach.brush(24, 16, 5, 'castle'), RangeError);
  assert.deepEqual(beach.bed, before);
});

test('digging collects sand and building spends only the volume inside the brush', () => {
  const beach = fixture();
  assert.equal(beach.sand, 500);
  const combined = total(beach.bed) + beach.sand;
  for (const [x, y, tool] of [[24, 16, 'build'], [24, 16, 'dig'], [0, 2, 'dig'], [0, 2, 'build']]) {
    const beforeBed = total(beach.bed), beforeSand = beach.sand;
    beach.brush(x, y, 5, tool, .25);
    const change = total(beach.bed) - beforeBed;
    assert.ok(tool === 'dig' ? change < 0 : change > 0);
    assert.ok(Math.abs(beach.sand - beforeSand + change) < 1e-5);
    assert.ok(Math.abs(total(beach.bed) + beach.sand - combined) < 1e-5);
  }
  const before = beach.sand;
  beach.brush(-100, -100, 5, 'build');
  assert.equal(beach.sand, before, 'An empty footprint must not spend sand');
  advance(beach, 60, { ocean: false, erosion: true });
  assert.equal(beach.sand, before, 'Natural sediment movement must not change inventory');
  beach.reset();
  assert.equal(beach.sand, 500);
});

test('a partial supply scales the entire build footprint and empty builders can dig again', () => {
  const full = fixture(), partial = fixture();
  full.brush(24, 16, 5, 'build', .25);
  const cost = 500 - full.sand;
  partial.sand = cost / 4;
  partial.brush(24, 16, 5, 'build', .25);
  assert.equal(partial.sand, 0);
  for (let i = 0; i < partial.size; i++) {
    assert.ok(Math.abs(partial.bed[i] - full.bed[i] / 4) < 1e-7);
  }
  const emptyBed = partial.bed.slice();
  for (let i = 0; i < 10; i++) partial.brush(24, 16, 5, 'build');
  assert.deepEqual(partial.bed, emptyBed);
  assert.equal(partial.sand, 0);
  partial.brush(24, 16, 5, 'dig');
  assert.ok(partial.sand > 0);
  const dugBed = partial.bed.slice();
  partial.brush(24, 16, 5, 'build');
  assert.ok(partial.bed[16 * partial.width + 24] > dugBed[16 * partial.width + 24]);
  assert.ok(partial.sand >= 0);
});

test('waves finish, rolling waves can be disabled, and reset clears transient state', () => {
  const beach = fixture();
  assert.equal(beach.wave(), true);
  assert.equal(beach.wave(), false);
  advance(beach, 500);
  assert.equal(beach.waveCount, 1);
  assert.ok(Math.abs(beach.seaLevel) < .03);
  beach.reset();
  assert.equal(beach.waveCount, 0);
  assert.equal(beach.autoWaves, false);
  assert.ok(beach.flowX.every(value => value === 0));
});

test('a player-dug channel brings water down from the sea into an inland pool', () => {
  const beach = new Beach();
  beach.autoWaves = false;
  const cx = Math.floor(beach.width / 2), cy = Math.floor(beach.height * .56);
  const target = cy * beach.width + cx;
  beach.brush(cx, cy, 7, 'dig', .35);
  assert.equal(beach.water[target], 0);
  for (let y = Math.floor(beach.shoreline(cx)) - 8; y <= cy; y++) {
    beach.brush(cx, y, 5, 'dig', .22);
  }
  assert.equal(beach.water[target], 0, 'Digging alone must not create water');
  advance(beach, 900, { ocean: true, erosion: true });
  assert.ok(beach.water[target] > .03, `Pool depth was ${beach.water[target]}`);
});

test('a full-size beach wave washes onto dry sand and then recedes', () => {
  const beach = new Beach();
  beach.autoWaves = false;
  const x = 30, y = Math.ceil(beach.shoreline(x)) + 30;
  const target = y * beach.width + x;
  assert.equal(beach.water[target], 0);
  beach.wave();
  let peak = 0, crest = 0;
  for (let i = 0; i < 900; i++) {
    beach.step();
    peak = Math.max(peak, beach.water[target]);
    crest = Math.max(crest, beach.seaLevel);
  }
  assert.ok(crest > 1.2, `Wave crest only reached ${crest}`);
  assert.ok(peak > .1, `Wave depth only reached ${peak}`);
  advance(beach, 1500, { ocean: true, erosion: true });
  assert.ok(beach.water[target] < peak * .5);
  assert.ok(beach.wet[target] > 0);
});

test('repeated digging and building keep changing the same spot beyond the old limits', () => {
  const beach = fixture();
  const i = 16 * beach.width + 24;
  for (const tool of ['dig', 'build']) {
    beach.bed.fill(0);
    for (let stroke = 0; stroke < 40; stroke++) {
      const before = beach.bed[i];
      beach.brush(24, 16, 5, tool, .25);
      const expected = tool === 'dig' ? -.45 : .25;
      assert.ok(Math.abs(beach.bed[i] - before - expected) < .00001);
    }
    assert.ok(tool === 'dig' ? beach.bed[i] < -17 : beach.bed[i] > 9);
  }
});

test('deep excavations retain finite, nonnegative, conserved water under adaptive stepping', () => {
  const beach = fixture();
  beach.bed.fill(-18);
  for (let i = 0; i < beach.size; i++) beach.water[i] = i % beach.width < 20 ? 18 : 0;
  const before = total(beach.water);
  advance(beach, 600);
  assert.ok(beach.water.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(beach.flowX.every(value => Number.isFinite(value)));
  assert.ok(Math.abs(total(beach.water) - before) < .02);
  assert.ok(beach.water[16 * beach.width + 30] > 1);
});

test('one large wave from the top visibly erodes the foreshore', () => {
  const beach = new Beach();
  beach.autoWaves = false;
  const before = beach.bed.slice();
  beach.wave();
  advance(beach, 900, { ocean: true, erosion: true });
  let removed = 0, maxLoss = 0;
  for (let x = 10; x < 50; x++) {
    const shore = Math.ceil(beach.shoreline(x));
    for (let y = shore + 5; y < shore + 35; y++) {
      const i = y * beach.width + x;
      const loss = Math.max(0, before[i] - beach.bed[i]);
      removed += loss;
      maxLoss = Math.max(maxLoss, loss);
    }
  }
  assert.ok(removed > 20, `Only ${removed} sand was removed`);
  assert.ok(maxLoss > .08, `Maximum erosion was only ${maxLoss}`);
});

test('large receding swells do not break into alternating cell-wide water bands', () => {
  const beach = new Beach();
  beach.autoWaves = false;
  beach.wave();
  advance(beach, 540, { ocean: true, erosion: true });
  let roughness = 0;
  const start = Math.ceil(beach.shoreline(30)) + 8;
  for (let y = start; y < Math.min(start + 53, beach.height - 1); y++) {
    const i = y * beach.width + 30;
    roughness += Math.abs(beach.water[i - beach.width] - 2 * beach.water[i] + beach.water[i + beach.width]);
  }
  assert.ok(roughness < 3, `Wavefront ringing was ${roughness}`);
});

test('a new swell overlaps the previous one without restarting or replacing it', () => {
  const beach = fixture();
  beach.wave({ angle: .15 });
  const first = beach.waves[0];
  const firstLevel = beach.oceanLevelAt(16, 0, 4);
  advance(beach, 60);
  const phase = beach.wavePhaseAt(first, 16, 0);
  assert.equal(beach.wave({ angle: -.15 }), true);
  assert.equal(beach.waves.length, 2);
  assert.equal(beach.waves[0], first);
  assert.equal(first.startedAt, 0);
  assert.equal(beach.wavePhaseAt(first, 16, 0), phase);
  assert.equal(beach.waveCount, 2);
  assert.ok(beach.oceanLevelAt(16, 0, 4) > firstLevel + .3);
  assert.equal(beach.wave(), false, 'The brief repeat delay still prevents accidental rapid duplicates');
});

test('oblique swell profiles travel shoreward and mirror when their angles reverse', () => {
  const positive = fixture(), negative = fixture();
  positive.wave({ angle: .2 });
  negative.wave({ angle: -.2 });
  const time = 2, left = 3, right = positive.width - 1 - left;
  assert.ok(positive.oceanLevelAt(left, 5, time) > positive.oceanLevelAt(right, 5, time));
  assert.ok(negative.oceanLevelAt(right, 5, time) > negative.oceanLevelAt(left, 5, time));
  assert.ok(positive.oceanLevelAt(left, 5, time) > positive.oceanLevelAt(left, 15, time));
  assert.ok(Math.abs(positive.oceanLevelAt(left, 5, time) - negative.oceanLevelAt(right, 5, time)) < 1e-10);
  assert.ok(positive.waves[0].directionY > .95, 'Incoming swells must travel down the page');
  assert.throws(() => positive.wave({ angle: Math.PI }), RangeError);
  assert.throws(() => positive.wave({ angle: NaN }), RangeError);
});

test('nearby swells retain separate crests with a trough between them', () => {
  const beach = fixture();
  beach.wave({ angle: 0 });
  advance(beach, 192);
  beach.wave({ angle: 0 });
  const firstCrest = beach.oceanLevelAt(0, 0, 3.5);
  const secondCrest = beach.oceanLevelAt(0, 0, 6.7);
  const trough = beach.oceanLevelAt(0, 0, 5.1);
  assert.ok(trough < Math.min(firstCrest, secondCrest) * .7,
    `The trough (${trough}) should separate crests (${firstCrest}, ${secondCrest})`);
});

test('angled reservoir forcing changes actual water heights and alongshore flow', () => {
  const positive = new Beach(96, 160), negative = new Beach(96, 160);
  for (const [beach, angle] of [[positive, .2], [negative, -.2]]) {
    beach.autoWaves = false;
    beach.bed.fill(-1.5);
    beach.water.fill(1.5);
    beach.flowX.fill(0);
    beach.flowY.fill(0);
    beach.wave({ angle });
    advance(beach, 120, { ocean: true, erosion: false });
  }
  const left = 8 * positive.width + 12, right = 8 * positive.width + 82;
  assert.ok(positive.water[left] > positive.water[right] + .1);
  assert.ok(negative.water[right] > negative.water[left] + .1);
  const middle = 8 * positive.width + 48;
  assert.ok(positive.flowX[middle] > .01, `Positive-angle current was ${positive.flowX[middle]}`);
  assert.ok(negative.flowX[middle] < -.01, `Negative-angle current was ${negative.flowX[middle]}`);
});

test('automatic wave sets overlap at different angles and leave breathing room', () => {
  const beach = fixture();
  beach.autoWaves = true;
  beach.wave();
  let maxIncoming = 0, lull = false;
  const angles = new Set();
  for (let frame = 0; frame < 2400; frame++) {
    beach.step(1 / 60, { ocean: true, erosion: false });
    maxIncoming = Math.max(maxIncoming, beach.waves.length);
    for (const wave of beach.waves) angles.add(wave.angle);
    if (beach.waveCount >= 3 && beach.waves.length === 0) lull = true;
  }
  assert.ok(maxIncoming >= 2);
  assert.ok([...angles].some(angle => angle > .05) && [...angles].some(angle => angle < -.05));
  assert.ok(lull);
  const count = beach.waveCount;
  beach.autoWaves = false;
  advance(beach, 1200, { ocean: true, erosion: false });
  assert.equal(beach.waveCount, count);
  assert.equal(beach.waves.length, 0);
  assert.equal(beach.wave(), true, 'A wave packet can still be started independently');
  beach.reset();
  assert.equal(beach.waves.length, 0);
  assert.equal(beach.waveCount, 0);
  assert.equal(beach.autoWaves, false);
});

test('dense wave trains stay bounded, finite and eventually expire', () => {
  const beach = fixture();
  beach.bed.fill(-1.5);
  beach.water.fill(1.5);
  for (let wave = 0; wave < 12; wave++) {
    assert.equal(beach.wave(), true);
    advance(beach, 40, { ocean: true, erosion: true });
  }
  assert.ok(beach.waves.length > 2);
  const ceiling = Math.max(...beach.waves.map(wave => wave.height)) * 2 + .025;
  for (let time = beach.time; time < beach.time + 12; time += .25) {
    assert.ok(beach.oceanLevelAt(16, 0, time) <= ceiling);
  }
  advance(beach, 1200, { ocean: true, erosion: true });
  assert.equal(beach.waves.length, 0);
  assert.equal(beach.waveCount, 12);
  assert.ok(Math.abs(beach.seaLevel) < .03);
  for (const name of ['water', 'bed', 'flowX', 'flowY', 'sediment']) {
    assert.ok(beach[name].every(value => Number.isFinite(value)), `${name} must remain finite`);
  }
  assert.ok(beach.water.every(value => value >= 0));
  assert.ok(beach.sediment.every(value => value >= 0));
});

test('new waves grow and their gaps shrink steadily with elapsed play time', () => {
  const baseline = fixture();
  baseline.wave({ angle: 0 });
  const original = { ...baseline.waves[0] };
  const originalGap = baseline.nextWaveAt - baseline.time;
  for (const time of [30, 90, 180]) {
    const beach = fixture();
    beach.time = time;
    beach.wave({ angle: 0 });
    const wave = beach.waves[0], factor = 1 + time / 90;
    assert.ok(Math.abs(wave.height - original.height * factor) < 1e-10);
    assert.ok(Math.abs(wave.duration - original.duration / factor) < 1e-10);
    assert.ok(Math.abs(beach.nextWaveAt - time - originalGap / factor) < 1e-10);
    const peakTime = time + wave.duration / 2;
    const height = beach.oceanLevelAt(0, 0, peakTime) - .025 * Math.sin(peakTime * .3);
    assert.ok(Math.abs(height - wave.height) < 1e-10, 'The pressure source must use the larger height');
  }
  advance(baseline, 60);
  baseline.wave({ angle: .1 });
  assert.equal(baseline.waves[0].height, original.height);
  assert.equal(baseline.waves[0].duration, original.duration);
  assert.ok(baseline.waves[1].height > original.height);
});

test('automatic arrivals become more frequent throughout a running session', () => {
  const beach = fixture();
  beach.autoWaves = true;
  beach.wave();
  const arrivals = [{ time: 0, height: beach.waves[0].height }];
  for (let frame = 0; frame < 9000; frame++) {
    const count = beach.waveCount;
    beach.step(1 / 60, { ocean: true, erosion: false });
    if (beach.waveCount !== count) {
      const wave = beach.waves.at(-1);
      arrivals.push({ time: wave.startedAt, height: wave.height });
    }
  }
  const early = arrivals.filter(wave => wave.time < 30).length;
  const later = arrivals.filter(wave => wave.time >= 120).length;
  assert.ok(later > early * 1.5, `Expected more arrivals later, got ${early} early and ${later} later`);
  for (let i = 1; i < arrivals.length; i++) {
    assert.ok(arrivals[i].height > arrivals[i - 1].height);
    assert.ok(arrivals[i].time - arrivals[i - 1].time >= .65 - 1e-8);
  }
});

test('late-session storms exceed the old height ceiling and stay numerically stable', () => {
  const beach = new Beach(96, 160);
  beach.time = 600;
  beach.nextWaveAt = beach.time;
  let peak = 0;
  for (let frame = 0; frame < 600; frame++) {
    beach.step();
    peak = Math.max(peak, beach.seaLevel);
  }
  assert.ok(peak > 5, `Late-session waves were capped at ${peak}`);
  assert.ok(beach.waveCount >= 5, 'Late storms should keep sending frequent waves');
  for (const field of ['water', 'bed', 'flowX', 'flowY', 'sediment']) {
    assert.ok(beach[field].every(Number.isFinite), `${field} must remain finite`);
  }
  assert.ok(beach.water.every(value => value >= 0));
  assert.ok(beach.sediment.every(value => value >= 0));
});

test('a fresh beach restarts the wave progression', () => {
  const fresh = fixture(), storm = fixture();
  fresh.wave();
  storm.time = 180;
  storm.wave();
  assert.ok(storm.waves[0].height > fresh.waves[0].height);
  storm.reset();
  assert.equal(storm.time, 0);
  assert.equal(storm.waves.length, 0);
  storm.wave();
  assert.equal(storm.waves[0].height, fresh.waves[0].height);
  assert.equal(storm.waves[0].duration, fresh.waves[0].duration);
  assert.equal(storm.nextWaveAt, fresh.nextWaveAt);
});
