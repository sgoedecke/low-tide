import test from 'node:test';
import assert from 'node:assert/strict';
import { Beach } from './simulation.mjs';

test('pointer strokes honor tool selection while right-click remains a dig shortcut', async t => {
  const target = () => ({
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    dispatch(name, event = {}) { this.listeners[name](event); },
  });
  const context = {
    createImageData: (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) }),
    setTransform() {},
  };
  for (const name of ['clearRect', 'putImageData', 'drawImage', 'save', 'restore', 'scale',
    'translate', 'rotate', 'beginPath', 'ellipse', 'fill', 'stroke', 'moveTo', 'lineTo']) context[name] = () => {};
  const canvas = Object.assign(target(), {
    dataset: {},
    getContext: () => context,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 200 }),
    hasPointerCapture: () => false,
    setPointerCapture() {},
    matches: () => true,
  });
  const buttons = ['dig', 'build'].map(tool => Object.assign(target(), {
    dataset: { tool },
    classList: { toggle() {} },
    setAttribute() {},
  }));
  const supply = {
    style: {},
    dataset: {},
    setAttribute(name, value) { this[name] = value; },
  };
  const document = Object.assign(target(), {
    querySelector: selector => ({ '#canvas': canvas, '#sand-supply': supply, '#surface': { getContext: () => null } })[selector],
    querySelectorAll: () => buttons,
    createElement: () => ({ getContext: () => context }),
  });
  let nextFrame;
  const globals = {
    document,
    window: Object.assign(target(), { devicePixelRatio: 1 }),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame(callback) { nextFrame = callback; },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    });
  }
  t.mock.method(console, 'warn', () => {});
  let beach;
  const originalBrush = Beach.prototype.brush;
  const brush = t.mock.method(Beach.prototype, 'brush', function (...args) {
    beach = this;
    return originalBrush.apply(this, args);
  });
  await import('./game.mjs');

  function stroke(button, expected, pointerType = 'mouse') {
    const event = { button, pointerType, pointerId: 1, clientX: 150, clientY: 100, preventDefault() {} };
    const before = brush.mock.callCount();
    canvas.dispatch('pointerdown', event);
    assert.equal(brush.mock.callCount(), before + 1);
    assert.equal(brush.mock.calls.at(-1).arguments[3], expected);
    canvas.dispatch('pointermove', { ...event, clientX: 160 });
    assert.equal(brush.mock.calls.at(-1).arguments[3], expected);
    canvas.dispatch('pointerup', event);
  }

  stroke(0, 'build');
  buttons[0].dispatch('click');
  stroke(0, 'dig');
  stroke(0, 'dig', 'touch');
  buttons[1].dispatch('click');
  stroke(0, 'build');
  stroke(2, 'dig');
  stroke(0, 'build', 'pen');
  document.dispatch('keydown', { key: '1', target: { closest: () => null } });
  stroke(0, 'dig');
  document.dispatch('keydown', { key: '2', target: { closest: () => null } });
  stroke(0, 'build');

  const render = () => nextFrame(performance.now());
  beach.sand = 500;
  render();
  const initialSize = parseFloat(supply.style.width);
  const initialLeft = parseFloat(supply.style.left);
  stroke(0, 'build');
  render();
  assert.ok(parseFloat(supply.style.width) < initialSize, 'Spending sand should shrink the indicator');
  beach.sand = 0;
  render();
  assert.equal(supply.dataset.empty, 'true');
  assert.match(supply['aria-label'], /Out of sand/);
  const emptySize = parseFloat(supply.style.width);
  stroke(2, 'dig');
  render();
  assert.equal(supply.dataset.empty, 'false');
  assert.ok(parseFloat(supply.style.width) > emptySize);
  beach.sand = 2000;
  render();
  assert.ok(parseFloat(supply.style.width) > initialSize, 'The supply can grow beyond its starting amount');
  canvas.dispatch('pointermove', { pointerType: 'mouse', clientX: 20, clientY: 20 });
  render();
  assert.ok(parseFloat(supply.style.left) < initialLeft, 'The supply indicator should follow the pointer');
  assert.ok(parseFloat(supply.style.top) >= 8, 'The indicator should stay inside the viewport');
  canvas.dispatch('pointerleave');
  render();
  assert.ok(parseFloat(supply.style.left) > 200, 'Without a pointer the indicator should rest at the upper right');
});
