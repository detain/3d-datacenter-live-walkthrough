/**
 * tests/js/dc-wheel-dolly.test.js — dc-multi.js onWheel (F-18), rewritten by R3.11
 *
 * WHAT WAS WRONG WITH THE OLD VERSION
 * It contained this, under a comment presenting it as a technique:
 *
 *     // Test helper: re-implement onWheel logic from source to test in isolation
 *     // We test the actual logic, not the import (which requires heavy mocking)
 *     function makeOnWheel() {
 *       return function onWheel(e) { … four lines copied out of dc-multi.js … };
 *     }
 *
 * Eleven `it()` blocks then exercised that copy. They could not fail for any change to
 * dc-multi.js, because dc-multi.js was never called — and the copy was already a partial one: it
 * stopped at `e.preventDefault()` and omitted the entire dolly body, so the camera-distance
 * behaviour the file is named after had no coverage at all. The two source-grep tests at the
 * bottom were the only thing tying any of it to the real file, and a grep cannot tell a working
 * handler from a broken one.
 *
 * WHAT THIS VERSION DOES
 * Slices the real `onWheel` out of `public_html/js/dc-multi.js` and compiles it with the module's
 * own free identifiers injected — `S`, `setMode`, `CAM_MIN`, `CAM_MAX`, `WHEEL_STEP`, `document`.
 * The constants are read FROM THE SOURCE, not transcribed, so a changed step size cannot leave a
 * stale copy behind in this file. `sliceFn()` throws if the function is renamed, so the suite
 * fails loudly rather than silently testing nothing.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const MULTI_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const SRC = fs.readFileSync(MULTI_SRC, 'utf8');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Slice a top-level `function NAME(...) { … }` by walking to a balanced brace. */
function sliceFn(name) {
  const start = SRC.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name}() not found in dc-multi.js — was it renamed?`);
  let depth = 0, seen = false;
  for (let i = start; i < SRC.length; i++) {
    const ch = SRC[i];
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') { depth--; if (seen && depth === 0) return SRC.slice(start, i + 1); }
  }
  throw new Error(`${name}() has unbalanced braces`);
}

/** Read a `const NAME = <number>;` out of the source. Never transcribe a constant. */
function constant(name) {
  const m = SRC.match(new RegExp(`^const ${name}\\s*=\\s*(-?[\\d.]+)\\s*;`, 'm'));
  if (!m) throw new Error(`${name} not found in dc-multi.js — was it renamed or made non-literal?`);
  return Number(m[1]);
}

const CAM_MIN = constant('CAM_MIN');
const CAM_MAX = constant('CAM_MAX');
const WHEEL_STEP = constant('WHEEL_STEP');

const ONWHEEL_SRC = sliceFn('onWheel');

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeEl(tagName, id = '', className = '') {
  return { tagName: tagName.toUpperCase(), id, className };
}

/**
 * Compile the real onWheel with the module's collaborators injected.
 *
 * @param {object} opts
 *   mode      'first' | 'third'          — S.mode at entry
 *   camDist   number                     — S.camDist at entry
 *   locked    boolean                    — document.pointerLockElement === canvas
 */
function compile({ mode = 'third', camDist = 20, locked = false } = {}) {
  const canvas = makeEl('canvas', 'dcCanvas');
  const S = { mode, camDist };
  const calls = { setMode: [] };
  const documentStub = {
    querySelector: (sel) => (sel === 'canvas' ? canvas : null),
    pointerLockElement: locked ? canvas : null,
  };
  const names = ['S', 'setMode', 'CAM_MIN', 'CAM_MAX', 'WHEEL_STEP', 'document'];
  const deps = [S, (m) => { calls.setMode.push(m); S.mode = m; }, CAM_MIN, CAM_MAX, WHEEL_STEP, documentStub];
  // eslint-disable-next-line no-new-func
  const onWheel = new Function(...names, `${ONWHEEL_SRC}; return onWheel;`)(...deps);

  /** Fire a wheel event. `deltaY > 0` is scrolling OUT (away from the model). */
  const wheel = (deltaY, target = canvas) => {
    const e = { target, deltaY, preventDefault: vi.fn() };
    onWheel(e);
    return e;
  };
  return { onWheel, wheel, canvas, S, calls, document: documentStub };
}

// ---------------------------------------------------------------------------
describe('dc-multi onWheel — F-18: preventDefault is scoped to the canvas', () => {

  it('prevents default when the wheel event targets the canvas', () => {
    const h = compile();
    expect(h.wheel(10).preventDefault).toHaveBeenCalledTimes(1);
  });

  it('prevents default when the pointer is locked to the canvas, whatever the target', () => {
    // While locked the canvas does not receive the event — the document does — so without this
    // second condition scrolling while walking around did nothing.
    const h = compile({ locked: true });
    expect(h.wheel(10, makeEl('div', '', 'some-overlay')).preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['lil-gui', makeEl('div', '', 'lil-gui')],
    ['.parameters', makeEl('div', '', 'parameters')],
    ['.dc-chat-frame', makeEl('iframe', '', 'dc-chat-frame')],
    ['#dcSearchResults', makeEl('div', 'dcSearchResults', '')],
    ['an unrelated div', makeEl('div', 'someOtherId', 'some-class')],
  ])('does NOT prevent default over %s — those panels must stay scrollable', (_label, el) => {
    const h = compile();
    expect(h.wheel(10, el).preventDefault).not.toHaveBeenCalled();
  });

  it.each(['input', 'textarea'])('does NOT prevent default over a %s', (tag) => {
    const h = compile({ locked: true });   // locked, so only the tag test can save it
    expect(h.wheel(10, makeEl(tag, 'x', '')).preventDefault).not.toHaveBeenCalled();
  });

  it('a wheel event over a form field does not dolly the camera either', () => {
    // The early return has to come before the dolly, not just before preventDefault.
    const h = compile({ camDist: 20, locked: true });
    h.wheel(10, makeEl('input', 'x', ''));
    expect(h.S.camDist).toBe(20);
  });

});

// ---------------------------------------------------------------------------
describe('dc-multi onWheel — the dolly itself', () => {

  // None of this had any coverage: the old file re-implemented onWheel down to preventDefault
  // and stopped, so every line below was untested.

  it('scrolling out moves the camera back by one step', () => {
    const h = compile({ camDist: 20 });
    h.wheel(10);
    expect(h.S.camDist).toBe(20 + WHEEL_STEP);
  });

  it('scrolling in moves the camera closer by one step', () => {
    const h = compile({ camDist: 20 });
    h.wheel(-10);
    expect(h.S.camDist).toBe(20 - WHEEL_STEP);
  });

  it('scrolling out is capped at CAM_MAX', () => {
    const h = compile({ camDist: CAM_MAX });
    h.wheel(10);
    expect(h.S.camDist).toBe(CAM_MAX);
  });

  it('repeated scrolling out never exceeds CAM_MAX', () => {
    const h = compile({ camDist: CAM_MIN });
    for (let i = 0; i < 200; i++) h.wheel(10);
    expect(h.S.camDist).toBe(CAM_MAX);
  });

  it('scrolling all the way in switches to first person instead of going negative', () => {
    const h = compile({ camDist: CAM_MIN });
    h.wheel(-10);
    expect(h.calls.setMode).toEqual(['first']);
    // camDist is deliberately left alone on the way in — applyMode() owns the camera from here.
    expect(h.S.camDist).toBe(CAM_MIN);
  });

  it('a scroll landing exactly on CAM_MIN stays in third person', () => {
    // Boundary: the switch is `nd < CAM_MIN`, not `<=`. Landing exactly on the minimum is a
    // legal third-person distance; one more step in is what crosses over.
    const h = compile({ camDist: CAM_MIN + WHEEL_STEP });
    h.wheel(-10);
    expect(h.S.camDist).toBe(CAM_MIN);
    expect(h.calls.setMode).toEqual([]);
  });

  it('scrolling out in first person pops straight back to third at CAM_MIN', () => {
    const h = compile({ mode: 'first', camDist: 999 });
    h.wheel(10);
    expect(h.calls.setMode).toEqual(['third']);
    expect(h.S.camDist).toBe(CAM_MIN);
  });

  it('scrolling IN while already first person does nothing', () => {
    // There is nowhere closer to go, and re-entering first person would restart the transition.
    const h = compile({ mode: 'first', camDist: 5 });
    h.wheel(-10);
    expect(h.calls.setMode).toEqual([]);
    expect(h.S.camDist).toBe(5);
    expect(h.S.mode).toBe('first');
  });

  it('out then in returns to the starting distance', () => {
    const h = compile({ camDist: 20 });
    h.wheel(10);
    h.wheel(-10);
    expect(h.S.camDist).toBe(20);
  });

  it('deltaY === 0 is treated as scrolling in, not as a no-op', () => {
    // `const out = e.deltaY > 0` — zero is not greater than zero. Pinned because it is the kind
    // of boundary a refactor to `Math.sign` would silently change.
    const h = compile({ camDist: 20 });
    h.wheel(0);
    expect(h.S.camDist).toBe(20 - WHEEL_STEP);
  });

});

// ---------------------------------------------------------------------------
describe('dc-multi onWheel — the harness is not testing a copy', () => {

  // The failure this whole rewrite exists to prevent: a test file that passes because it is
  // asserting against its own transcription of the subject.

  it('the constants come from the source, not from this file', () => {
    // If someone changes WHEEL_STEP in dc-multi.js, these read the new value. A transcribed
    // constant would not, and every dolly assertion above would quietly test the old design.
    expect(SRC).toMatch(new RegExp(`^const WHEEL_STEP\\s*=\\s*${WHEEL_STEP}\\s*;`, 'm'));
    expect(CAM_MIN).toBeLessThan(CAM_MAX);
    expect(WHEEL_STEP).toBeGreaterThan(0);
  });

  it('constant() throws rather than returning a default when a constant is renamed', () => {
    expect(() => constant('NOT_A_REAL_CONSTANT')).toThrow(/not found/);
  });

  it('sliceFn() throws rather than returning empty when a function is renamed', () => {
    expect(() => sliceFn('notOnWheel')).toThrow(/not found/);
  });

  it('the compiled function really is the source text, dolly body included', () => {
    // The old copy stopped at preventDefault. This asserts the slice reaches the far end.
    expect(ONWHEEL_SRC).toMatch(/e\.preventDefault\(\)/);
    expect(ONWHEEL_SRC).toMatch(/S\.camDist/);
    expect(ONWHEEL_SRC).toMatch(/setMode\("first"\)/);
  });

  it('NON-VACUITY: removing the canvas guard makes the exemption tests fail', () => {
    // Compile the pre-F-18 handler through the identical harness and confirm it prevents default
    // over lil-gui — the exact regression F-18 fixed.
    const broken = ONWHEEL_SRC.replace(
      /if \(e\.target !== canvas && document\.pointerLockElement !== canvas\) return;\n/, '');
    expect(broken).not.toMatch(/pointerLockElement !== canvas/);   // the substitution happened
    const S = { mode: 'third', camDist: 20 };
    const canvas = makeEl('canvas', 'dcCanvas');
    // eslint-disable-next-line no-new-func
    const fn = new Function('S', 'setMode', 'CAM_MIN', 'CAM_MAX', 'WHEEL_STEP', 'document',
      `${broken}; return onWheel;`)(
      S, () => {}, CAM_MIN, CAM_MAX, WHEEL_STEP,
      { querySelector: () => canvas, pointerLockElement: null });
    const e = { target: makeEl('div', '', 'lil-gui'), deltaY: 10, preventDefault: vi.fn() };
    fn(e);
    expect(e.preventDefault).toHaveBeenCalled();   // the bug, reproduced
  });

});
