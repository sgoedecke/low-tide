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
  const canvas = Object.assign(target(), {
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
  const document = Object.assign(target(), {
    querySelector: selector => selector === '#canvas' ? canvas : { getContext: () => null },
    querySelectorAll: () => buttons,
    createElement: () => ({ getContext: () => context }),
  });
  const globals = {
    document,
    window: Object.assign(target(), { devicePixelRatio: 1 }),
    ResizeObserver: class { observe() {} },
    requestAnimationFrame() {},
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
  const brush = t.mock.method(Beach.prototype, 'brush', () => {});
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
});
