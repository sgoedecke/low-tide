import { Beach, clamp } from './simulation.mjs';
import { BeachRenderer } from './renderer.mjs';

const $ = selector => document.querySelector(selector);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const rect = canvas.getBoundingClientRect();
const gridWidth = rect.width < 600 ? 160 : 256;
const beach = new Beach(gridWidth, clamp(Math.round(gridWidth * rect.height / rect.width), 96, 320));
const { width: W, height: H, size: N } = beach;
const buffer = document.createElement('canvas');
buffer.width = W;
buffer.height = H;
const bufferCtx = buffer.getContext('2d');
const image = bufferCtx.createImageData(W, H);
const grain = new Float32Array(N);
let seed = 76491;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
for (let i = 0; i < N; i++) grain[i] = (random() - .5) * 8;
const shells = Array.from({ length: 70 }, () => ({
  x: W * (.08 + random() * .86), y: H * (.39 + random() * .59),
  size: .35 + random() * .45, angle: random() * Math.PI * 2, kind: random(),
}));
const motes = Array.from({ length: 320 }, () => ({
  x: random() * W, y: random() * H * .38, life: random() * 5,
}));
const BRUSH_RADIUS = 5;
const state = { tool: 'build', pointer: null, stroke: null };
let cssWidth = rect.width, cssHeight = rect.height, scaleX = 1, scaleY = 1;
const renderer = new BeachRenderer($('#surface'), beach);

function resize() {
  const bounds = canvas.getBoundingClientRect();
  cssWidth = bounds.width;
  cssHeight = bounds.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scaleX = cssWidth / W;
  scaleY = cssHeight / H;
  renderer.resize(canvas.width, canvas.height);
}
new ResizeObserver(resize).observe(canvas);
resize();

function renderTerrain() {
  canvas.dataset.renderer = renderer.ready ? 'detailed' : 'basic';
  if (renderer.ready) {
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    renderer.render();
    return;
  }
  const { bed, water, wet, foam } = beach;
  const pixels = image.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x, p = i * 4;
      const z = bed[i], d = water[i];
      const left = bed[y * W + Math.max(0, x - 1)];
      const right = bed[y * W + Math.min(W - 1, x + 1)];
      const up = bed[Math.max(0, y - 1) * W + x];
      const down = bed[Math.min(H - 1, y + 1) * W + x];
      const slope = (left - right) * .72 + (up - down) * .95;
      const shadow = Math.max(0, bed[Math.max(0, y - 3) * W + Math.max(0, x - 3)] - z - .25);
      const light = clamp(slope * 57 - shadow * 22, -65, 38);
      const moisture = wet[i];
      const height = z - beach.base[i];
      const elevation = Math.sign(height) * Math.log1p(Math.abs(height));
      const texture = grain[i] + Math.sin(x * 1.7 + y * 2.3) * 1.2;
      let r = 232 - moisture * 51 + light + elevation * 7 + texture;
      let g = 211 - moisture * 43 + light + elevation * 6 + texture;
      let b = 169 - moisture * 29 + light + elevation * 4 + texture;
      if (d > .002) {
        const opacity = 1 - Math.exp(-d * 3.3);
        const deep = clamp(d / 1.5, 0, 1);
        const ripple = Math.sin(y * .56 + x * .14 - beach.time * 1.9)
          * Math.sin(x * .49 - y * .09 + beach.time * .7);
        const shimmer = ripple * 3.5 + grain[i] * .25;
        const wr = 91 - deep * 58 + shimmer;
        const wg = 162 - deep * 47 + shimmer;
        const wb = 155 - deep * 23 + shimmer;
        r += (wr - r) * opacity;
        g += (wg - g) * opacity;
        b += (wb - b) * opacity;
        const edge = d < .08 ? Math.max(0, 1 - Math.abs(d - .026) / .028) * .2 * wet[i] : 0;
        const froth = clamp(foam[i] * .85 + edge, 0, .78);
        r += (244 - r) * froth;
        g += (249 - g) * froth;
        b += (225 - b) * froth;
      }
      pixels[p] = r;
      pixels[p + 1] = g;
      pixels[p + 2] = b;
      pixels[p + 3] = 255;
    }
  }
  bufferCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buffer, 0, 0, cssWidth, cssHeight);
}

function renderDetails() {
  ctx.save();
  ctx.scale(scaleX, scaleY);
  for (const shell of shells) {
    const i = Math.floor(shell.y) * W + Math.floor(shell.x);
    if (beach.water[i] > .02 || Math.abs(beach.bed[i] - beach.base[i]) > .12) continue;
    ctx.save();
    ctx.translate(shell.x, shell.y);
    ctx.rotate(shell.angle);
    ctx.fillStyle = '#756e4b30';
    ctx.beginPath();
    ctx.ellipse(.25, .3, shell.size * 1.15, shell.size * .65, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shell.kind > .4 ? '#fbefd1' : '#bbad8a';
    ctx.beginPath();
    ctx.ellipse(0, 0, shell.size, shell.size * .6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ac997566';
    ctx.lineWidth = .12;
    ctx.beginPath();
    ctx.moveTo(-shell.size * .5, 0);
    ctx.lineTo(shell.size * .5, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function updateMotes(dt) {
  for (const mote of motes) {
    const i = clamp(Math.floor(mote.y), 0, H - 1) * W + clamp(Math.floor(mote.x), 0, W - 1);
    mote.life -= dt;
    if (mote.life <= 0 || beach.water[i] < .015 || mote.x < 0 || mote.x >= W || mote.y < 0 || mote.y >= H) {
      mote.x = random() * W;
      mote.y = random() * H * .67;
      mote.life = 1 + random() * 5;
      continue;
    }
    const depth = Math.max(.08, beach.water[i]);
    mote.x += beach.flowX[i] / depth * dt;
    mote.y += beach.flowY[i] / depth * dt;
  }
}

function renderMotes() {
  ctx.strokeStyle = '#eef7dc40';
  ctx.lineWidth = .65;
  ctx.beginPath();
  for (const mote of motes) {
    if (mote.x < 0 || mote.x >= W || mote.y < 0 || mote.y >= H) continue;
    const i = Math.floor(mote.y) * W + Math.floor(mote.x);
    if (beach.water[i] < .02) continue;
    const vx = beach.flowX[i], vy = beach.flowY[i];
    const speed = Math.hypot(vx, vy);
    if (speed < .03) continue;
    const length = Math.min(.4, speed * .08) / speed;
    ctx.moveTo(mote.x * scaleX, mote.y * scaleY);
    ctx.lineTo((mote.x + vx * length) * scaleX, (mote.y + vy * length) * scaleY);
  }
  ctx.stroke();
}

function renderCursor() {
  if (!state.pointer) return;
  const { x, y } = state.pointer;
  ctx.save();
  ctx.translate(x * scaleX, y * scaleY);
  ctx.strokeStyle = '#fff9e5e0';
  ctx.lineWidth = 1.4;
  ctx.shadowColor = '#3b4d3d55';
  ctx.shadowBlur = 3;
  ctx.fillStyle = (state.stroke?.tool ?? state.tool) === 'dig' ? '#345f6315' : '#fff5ce25';
  ctx.beginPath();
  ctx.ellipse(0, 0, BRUSH_RADIUS * scaleX, BRUSH_RADIUS * scaleY, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-3, 0); ctx.lineTo(3, 0);
  ctx.moveTo(0, -3); ctx.lineTo(0, 3);
  ctx.stroke();
  ctx.restore();
}

function selectTool(tool) {
  endStroke();
  state.tool = tool;
  for (const button of document.querySelectorAll('[data-tool]')) {
    const selected = button.dataset.tool === tool;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
}
function position(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: clamp((event.clientX - bounds.left) / bounds.width * W, 0, W - 1),
    y: clamp((event.clientY - bounds.top) / bounds.height * H, 0, H - 1) };
}
function paintLine(from, to, tool) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / (BRUSH_RADIUS * .3)));
  for (let step = 1; step <= steps; step++) {
    const f = step / steps;
    beach.brush(from.x + (to.x - from.x) * f, from.y + (to.y - from.y) * f, BRUSH_RADIUS, tool, .22);
  }
}
function endStroke() {
  if (state.stroke && canvas.hasPointerCapture(state.stroke.id)) canvas.releasePointerCapture(state.stroke.id);
  state.stroke = null;
  if (!canvas.matches(':hover')) state.pointer = null;
}
canvas.addEventListener('pointerdown', event => {
  if (state.stroke || (event.button !== 0 && event.button !== 2)) return;
  event.preventDefault();
  const point = position(event);
  state.pointer = point;
  const tool = event.button === 2 ? 'dig' : state.tool;
  state.stroke = { id: event.pointerId, last: point, tool };
  canvas.setPointerCapture(event.pointerId);
  beach.brush(point.x, point.y, BRUSH_RADIUS, tool, .25);
});
canvas.addEventListener('pointermove', event => {
  if (state.stroke && event.pointerId !== state.stroke.id) return;
  const point = position(event);
  state.pointer = point;
  if (!state.stroke) return;
  paintLine(state.stroke.last, point, state.stroke.tool);
  state.stroke.last = point;
});
canvas.addEventListener('pointerup', event => {
  if (state.stroke?.id === event.pointerId) endStroke();
  if (event.pointerType === 'touch') state.pointer = null;
});
canvas.addEventListener('pointercancel', () => { endStroke(); state.pointer = null; });
canvas.addEventListener('lostpointercapture', () => { state.stroke = null; });
canvas.addEventListener('pointerleave', () => { if (!state.stroke) state.pointer = null; });
canvas.addEventListener('contextmenu', event => event.preventDefault());
window.addEventListener('blur', () => { endStroke(); state.pointer = null; });
document.addEventListener('visibilitychange', () => { endStroke(); previousTime = performance.now(); accumulator = 0; });
for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => selectTool(button.dataset.tool));
document.addEventListener('keydown', event => {
  if (event.target.closest('input, select, textarea, [contenteditable]')) return;
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
  if (event.key === '1') selectTool('dig');
  else if (event.key === '2') selectTool('build');
});

let previousTime = performance.now(), accumulator = 0;
function frame(now) {
  const elapsed = Math.min(.1, (now - previousTime) / 1000);
  previousTime = now;
  accumulator += elapsed;
  const dt = 1 / 60;
  while (accumulator >= dt) {
    if (state.stroke) {
      beach.brush(state.stroke.last.x, state.stroke.last.y, BRUSH_RADIUS, state.stroke.tool, dt * 2.2);
    }
    beach.step(dt);
    updateMotes(dt);
    accumulator -= dt;
  }
  renderTerrain();
  renderDetails();
  renderMotes();
  renderCursor();
  requestAnimationFrame(frame);
}
beach.wave();
requestAnimationFrame(frame);
