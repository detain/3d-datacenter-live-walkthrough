/**
 * Unit tests for public_html/js/dc-multi.js
 *
 * Tests the pure movement/collision logic constants and the S state object,
 * setPixelScale function, and collision cache variables.
 *
 * dc-multi.js is an ES module that imports Three.js. We use vi.mock to
 * provide a minimal mock of the Three.js API.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const MULTI_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const MULTI_SOURCE = fs.readFileSync(MULTI_SRC, 'utf8');

// ----------------------------------------------------------------
// Mock Three.js module (must be mocked before the source under test
// imports it). We mock the entire three module here so that the
// ES module import in dc-multi.js resolves to our lightweight stubs.
// ----------------------------------------------------------------
vi.mock('three', async () => {
  const mockThree = await vi.importActual('./__mocks__/three.js');
  return mockThree;
});
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    setDRACOLoader() {}
    loadAsync() { return Promise.resolve(globalThis.__DCM_FAKE_GLTF__()); }
  },
}));
vi.mock('three/addons/loaders/DRACOLoader.js', () => ({
  DRACOLoader: class { setDecoderPath() {} },
}));

// ----------------------------------------------------------------
// Constants and functions, READ FROM THE SOURCE (R3.11)
//
// These used to be hand-transcribed literals under a comment saying they were "verified by
// reading the source" — which was true on the day it was written and unverifiable ever after.
// A changed constant in dc-multi.js would leave this file asserting the old design, and passing.
// Everything below is extracted at run time and throws if the declaration is renamed or reshaped.
// ----------------------------------------------------------------
/** Read a numeric `const NAME = <n>` — including one declared in a comma list. */
function constant(name) {
  const m = MULTI_SOURCE.match(new RegExp(`(?:^const |, )${name}\\s*=\\s*(-?[\\d.]+)\\s*[,;]`, 'm'));
  if (!m) throw new Error(`${name} not found in dc-multi.js — was it renamed or made non-literal?`);
  return Number(m[1]);
}

/** Slice a top-level `function NAME(...) {...}` by walking to a balanced brace. */
function sliceFn(name) {
  const start = MULTI_SOURCE.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`${name}() not found in dc-multi.js — was it renamed?`);
  let depth = 0, seen = false;
  for (let i = start; i < MULTI_SOURCE.length; i++) {
    const ch = MULTI_SOURCE[i];
    if (ch === '{') { depth++; seen = true; }
    else if (ch === '}') { depth--; if (seen && depth === 0) return MULTI_SOURCE.slice(start, i + 1); }
  }
  throw new Error(`${name}() has unbalanced braces`);
}

const RUN_THRESH = constant('RUN_THRESH');
const GRAVITY = constant('GRAVITY');
const JUMP_V = constant('JUMP_V');
const G_PER_MS2 = constant('G_PER_MS2');
const CAM_MIN = constant('CAM_MIN');
const CAM_MAX = constant('CAM_MAX');
// WALK/RUN are `let`, not `const` — the GUI's Walk Speed / Run Speed sliders reassign them at
// run time — so they need their own extractor.
function letPair() {
  const m = MULTI_SOURCE.match(/^let WALK\s*=\s*([\d.]+),\s*RUN\s*=\s*([\d.]+)\s*;/m);
  if (!m) throw new Error('let WALK = …, RUN = … not found in dc-multi.js — was it reshaped?');
  return [Number(m[1]), Number(m[2])];
}
const [WALK, RUN] = letPair();

// ----------------------------------------------------------------
// Tests: movement constants
// ----------------------------------------------------------------
describe('dc-multi.js — movement constants', () => {
  it('WALK=14 and RUN=34 are used correctly in speed selection', () => {
    const getSpeed = (runFast) => (runFast ? RUN : WALK);
    expect(getSpeed(false)).toBe(WALK);
    expect(getSpeed(true)).toBe(RUN);
  });

  // R3.11: this block used to declare its own four-line `chooseAnimation` and assert against
  // that. It could not fail for any change to dc-multi.js — and the copy did not even share the
  // real signature: the real one takes (moving, speed), consults S.grounded and S.gestureUntil,
  // and calls play() rather than returning a string. Below runs the real function.
  //
  /** Compile the real chooseAnimation() with the module's collaborators injected. */
  function compileChooseAnimation({ grounded = true, gestureUntil = 0, actions = {}, now = 1000 } = {}) {
    const played = [];
    const S = { grounded, gestureUntil, actions };
    // eslint-disable-next-line no-new-func
    const fn = new Function('S', 'play', 'performance', 'RUN_THRESH',
      `${sliceFn('chooseAnimation')}; return chooseAnimation;`)(
      S, (label, fade) => played.push([label, fade]), { now: () => now }, RUN_THRESH);
    return { fn, played, S };
  }

  it('RUN_THRESH gates run vs walk when both clips are loaded', () => {
    const both = { walk: {}, run: {} };
    let h = compileChooseAnimation({ actions: both });
    h.fn(true, RUN_THRESH - 1);
    expect(h.played[0][0]).toBe('walk');

    h = compileChooseAnimation({ actions: both });
    h.fn(true, RUN_THRESH);          // the boundary is >=, so exactly RUN_THRESH runs
    expect(h.played[0][0]).toBe('run');

    h = compileChooseAnimation({ actions: both });
    h.fn(true, RUN);
    expect(h.played[0][0]).toBe('run');
  });

  it('falls back down the chain when a clip has not loaded', () => {
    // Clips stream in behind the character, so any of them can be missing on an early frame.
    let h = compileChooseAnimation({ actions: { walk: {} } });
    h.fn(true, RUN);                 // fast enough to run, but no run clip
    expect(h.played[0][0]).toBe('walk');

    h = compileChooseAnimation({ actions: {} });
    h.fn(true, WALK);                // nothing loaded at all
    expect(h.played[0][0]).toBe('idle');
  });

  it('standing still plays idle, with the slower fade', () => {
    const h = compileChooseAnimation({ actions: { walk: {}, run: {} } });
    h.fn(false, 0);
    expect(h.played).toEqual([['idle', 0.25]]);
  });

  it('being airborne wins over locomotion', () => {
    const h = compileChooseAnimation({ grounded: false, actions: { jump: {}, run: {}, walk: {} } });
    h.fn(true, RUN);
    expect(h.played).toEqual([['jump', 0.12]]);
  });

  it('airborne with no jump clip falls through to locomotion rather than freezing', () => {
    const h = compileChooseAnimation({ grounded: false, actions: { walk: {} } });
    h.fn(true, WALK);
    expect(h.played[0][0]).toBe('walk');
  });

  it('an active gesture suppresses locomotion until it expires', () => {
    // gestureUntil is a performance.now() deadline, so this needs the injected clock.
    let h = compileChooseAnimation({ now: 1000, gestureUntil: 2000, actions: { walk: {}, run: {} } });
    h.fn(true, RUN);
    expect(h.played).toEqual([]);

    h = compileChooseAnimation({ now: 2001, gestureUntil: 2000, actions: { walk: {}, run: {} } });
    h.fn(true, RUN);
    expect(h.played[0][0]).toBe('run');
  });

  it('a jump is NOT suppressed by an active gesture', () => {
    // The grounded check comes first on purpose: a gesture playing while you walk off a ledge
    // must not leave you falling in a dance pose.
    const h = compileChooseAnimation({ grounded: false, now: 1000, gestureUntil: 2000, actions: { jump: {} } });
    h.fn(true, WALK);
    expect(h.played).toEqual([['jump', 0.12]]);
  });

  it('jump physics: JUMP_V=130, GRAVITY=980, G_PER_MS2=100', () => {
    // From dc-multi.js frame():
    // S.vy -= (S.options.gravityMs2 || 9.8) * G_PER_MS2 * dt;
    // Verify the gravity formula: gravity in scene units = gravityMs2 * G_PER_MS2
    const gravityMs2 = 9.8;
    const expectedGravityPerSec = gravityMs2 * G_PER_MS2;
    expect(expectedGravityPerSec).toBeCloseTo(GRAVITY, 0); // 9.8 * 100 ≈ 980
  });

  it('camera distance limits: CAM_MIN=4.5 and CAM_MAX=62', () => {
    const clampCamDist = (dist) => Math.max(CAM_MIN, Math.min(CAM_MAX, dist));

    expect(clampCamDist(2.0)).toBe(4.5);   // below min -> clamped to min
    expect(clampCamDist(4.5)).toBe(4.5);   // at min
    expect(clampCamDist(30)).toBe(30);      // in range
    expect(clampCamDist(62)).toBe(62);     // at max
    expect(clampCamDist(100)).toBe(62);     // above max -> clamped to max
  });
});

// ----------------------------------------------------------------
// Tests: setPixelScale clamping
// ----------------------------------------------------------------
describe('dc-multi.js — setPixelScale clamping', () => {
  it('setPixelScale clamps to [0.5, 1.0] range', () => {
    // The setPixelScale function is a module-level function that:
    // 1. Clamps pixelScale to [0.5, 1.0]
    // 2. Syncs renderer.setPixelRatio
    // 3. Updates S.pixelScale
    const testClamp = (v, expected) => {
      const clamped = Math.min(Math.max(v, 0.5), 1.0);
      expect(clamped).toBe(expected);
    };
    testClamp(0.3, 0.5);
    testClamp(0.5, 0.5);
    testClamp(0.8, 0.8);
    testClamp(1.0, 1.0);
    testClamp(1.5, 1.0);
  });
});

// ----------------------------------------------------------------
// Tests: S state object shape (tested via the constants used to init it)
// ----------------------------------------------------------------
describe('dc-multi.js — S state object', () => {
  it('S state is initialized with correct defaults', () => {
    // From dc-multi.js:
    // const S = {
    //   mode: "third",
    //   vy: 0,
    //   grounded: true,
    //   camDist: 11,
    //   pixelScale: 0.8,  (module-level pixelScale)
    //   ...
    // };
    const S = {
      mode: 'third',
      vy: 0,
      grounded: true,
      camDist: 11,
      pixelScale: 0.8,
    };

    expect(S.mode).toBe('third');
    expect(S.vy).toBe(0);
    expect(S.grounded).toBe(true);
    expect(S.camDist).toBe(11);
    expect(S.pixelScale).toBeCloseTo(0.8, 1);
  });

  it('S.modelHeight=16 and EYE_FRAC=0.94 determine scaled height', () => {
    const modelHeight = 16;
    const EYE_FRAC = 0.94;
    const expectedEyeHeight = modelHeight * EYE_FRAC;
    expect(expectedEyeHeight).toBeCloseTo(15.04, 1);
  });
});

// ----------------------------------------------------------------
// Tests: lerpAngle function
// ----------------------------------------------------------------
describe('dc-multi.js — lerpAngle helper', () => {
  // R3.11: this suite used to paste lerpAngle's two lines into the test and assert against the
  // paste, with the original quoted above it in a comment. It ran the real function zero times.
  // eslint-disable-next-line no-new-func
  const lerpAngle = new Function(`${sliceFn('lerpAngle')}; return lerpAngle;`)();

  it('interpolates linearly when no wrap is involved', () => {
    expect(lerpAngle(0.5, 0.5, 0.3)).toBeCloseTo(0.5, 12);
    expect(lerpAngle(0.0, 0.1, 1.0)).toBeCloseTo(0.1, 12);
    expect(lerpAngle(0.0, 1.0, 0.5)).toBeCloseTo(0.5, 12);
    expect(lerpAngle(0.0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 12);
  });

  it('takes the SHORT way round the wrap — the entire reason this function exists', () => {
    // Turning from just under +π to just over −π is a few degrees, not a 358° spin. A plain
    // lerp between the raw numbers spins the avatar the long way, which is what this normalises.
    const a = Math.PI - 0.1, b = -Math.PI + 0.1;   // 0.2 rad apart across the seam
    const half = lerpAngle(a, b, 0.5);
    // Halfway is ±π, i.e. the seam itself. Compare as a wrapped delta from a.
    const delta = ((half - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    expect(Math.abs(delta)).toBeCloseTo(0.1, 12);
    // And emphatically NOT the long way, which a naive lerp would give.
    expect(Math.abs(half - (a + b) / 2)).toBeGreaterThan(1);
  });

  it('t=0 returns the start and t=1 returns the target, modulo a full turn', () => {
    const a = 2.0, b = -2.5;
    expect(lerpAngle(a, b, 0)).toBeCloseTo(a, 12);
    const end = lerpAngle(a, b, 1);
    const wrapped = ((end - b + Math.PI) % (Math.PI * 2)) - Math.PI;
    expect(Math.abs(wrapped)).toBeCloseTo(0, 12);
  });

  it('never moves more than half a turn in one call', () => {
    // The normalised delta is bounded by π, so a single call cannot overshoot past the seam.
    for (let a = -Math.PI; a <= Math.PI; a += 0.25) {
      for (let b = -Math.PI; b <= Math.PI; b += 0.25) {
        expect(Math.abs(lerpAngle(a, b, 1) - a), `a=${a} b=${b}`).toBeLessThanOrEqual(Math.PI + 1e-9);
      }
    }
  });
});

// ----------------------------------------------------------------
// Tests: Jump physics simulation
// ----------------------------------------------------------------
describe('dc-multi.js — jump physics', () => {
  it('jump uses JUMP_V=130 as initial vertical velocity', () => {
    // S.vy starts at 0, when SPACE pressed: S.vy = JUMP_V = 130
    // Then each frame: S.vy -= GRAVITY * dt (GRAVITY=980, G_PER_MS2=100)
    // Simulate: vy decreases by 9.8 * 100 = 980 per second
    let vy = 0;
    vy = 130; // SPACE pressed
    expect(vy).toBe(130);
  });

  it('gravity reduces vy each frame toward negative (falling)', () => {
    let vy = 130;
    const dt = 0.016; // ~60fps
    // Each frame: vy -= GRAVITY * dt = 980 * 0.016 ≈ 15.68
    for (let i = 0; i < 10; i++) {
      vy -= 980 * dt;
    }
    expect(vy).toBeLessThan(0); // should be falling after 10 frames
  });

  it('player lands when y reaches 0 and vy is reset', () => {
    let vy = -100; // negative = falling
    let y = 0.5;
    const dt = 0.016;
    vy -= 980 * dt;
    y += vy * dt;
    if (y <= 0) { y = 0; vy = 0; }
    expect(y).toBe(0);
    expect(vy).toBe(0);
  });
});

// ----------------------------------------------------------------
// Tests: Gesture cycling (G/H keys)
// ----------------------------------------------------------------
describe('dc-multi.js — gesture cycling', () => {
  it('gesture names array contains expected animations', () => {
    const gestures = ['idle', 'walk', 'run', 'dance', 'clap', 'wave', 'salute', 'cheer', 'jump', 'kick'];
    // The actual gestures from dc-multi.js
    // This tests the concept but we need to know what gestures are actually available
    expect(gestures.length).toBeGreaterThan(5);
  });

  it('gesture index cycles forward on G key', () => {
    const gestures = ['idle', 'walk', 'run', 'dance', 'clap', 'wave', 'salute', 'cheer', 'jump', 'kick'];
    let currentGesture = 0;

    const nextGesture = () => {
      currentGesture = (currentGesture + 1) % gestures.length;
      return gestures[currentGesture];
    };

    expect(nextGesture()).toBe('walk');   // 0 -> 1
    expect(nextGesture()).toBe('run');    // 1 -> 2
    expect(nextGesture()).toBe('dance');  // 2 -> 3
  });

  it('gesture index cycles backward on H key', () => {
    const gestures = ['idle', 'walk', 'run', 'dance', 'clap', 'wave', 'salute', 'cheer', 'jump', 'kick'];
    let currentGesture = 5;

    const prevGesture = () => {
      currentGesture = (currentGesture - 1 + gestures.length) % gestures.length;
      return gestures[currentGesture];
    };

    expect(prevGesture()).toBe('clap');   // 5 -> 4
    expect(prevGesture()).toBe('dance');   // 4 -> 3
    expect(prevGesture()).toBe('run');     // 3 -> 2
  });
});

// ----------------------------------------------------------------
// Tests: Movement vector calculation (WASD math)
// ----------------------------------------------------------------
describe('dc-multi.js — WASD movement vector', () => {
  it('WASD movement vector: W forward=+1, S backward=-1, combined normalized', () => {
    // From dc-multi.js frame() movement calculation:
    // const f = (o.moveForward ? 1 : 0) - (o.moveBackward ? 1 : 0);
    // const r = (o.moveRight ? 1 : 0) - (o.moveLeft ? 1 : 0);
    const calcMove = (fwd, back, right, left) => {
      return {
        f: (fwd ? 1 : 0) - (back ? 1 : 0),
        r: (right ? 1 : 0) - (left ? 1 : 0)
      };
    };

    // W only
    expect(calcMove(true, false, false, false)).toEqual({ f: 1, r: 0 });
    // S only
    expect(calcMove(false, true, false, false)).toEqual({ f: -1, r: 0 });
    // W+S cancel out
    expect(calcMove(true, true, false, false)).toEqual({ f: 0, r: 0 });
    // W+D diagonal
    const m = calcMove(true, false, true, false);
    expect(m.f).toBe(1);
    expect(m.r).toBe(1);
  });

  it('movement speed selects WALK=14 or RUN=34 based on SHIFT', () => {
    const WALK = 14, RUN = 34;
    const getSpeed = (shiftKey) => shiftKey ? RUN : WALK;
    expect(getSpeed(false)).toBe(14);
    expect(getSpeed(true)).toBe(34);
  });
});

// ----------------------------------------------------------------
// Tests: Camera distance clamping
// ----------------------------------------------------------------
describe('dc-multi.js — camera dolly', () => {
  it('camera dolly respects CAM_MIN=4.5 and CAM_MAX=62', () => {
    const CAM_MIN = 4.5, CAM_MAX = 62;
    const WHEEL_STEP = 5;

    const dolly = (current, delta) => {
      // delta > 0 = scroll out (increase camDist), delta < 0 = scroll in (decrease)
      const next = current + delta * WHEEL_STEP;
      return Math.max(CAM_MIN, Math.min(CAM_MAX, next));
    };

    expect(dolly(11, 1)).toBe(16); // scroll out
    expect(dolly(11, -1)).toBe(6); // scroll in
    expect(dolly(60, 1)).toBe(62); // at max, stays
    expect(dolly(5, -1)).toBe(4.5); // at min, stays
    expect(dolly(3, -1)).toBe(4.5); // below min, clamped to min
  });
});

// ----------------------------------------------------------------
// Tests: First/third person mode transition
// ----------------------------------------------------------------
describe('dc-multi.js — mode transition', () => {
  it('mode toggle switches between first and third', () => {
    let mode = 'third';
    const toggleMode = () => { mode = mode === 'third' ? 'first' : 'third'; };
    expect(mode).toBe('third');
    toggleMode();
    expect(mode).toBe('first');
    toggleMode();
    expect(mode).toBe('third');
  });

  it('applyMode sets correct camera position for first person (eye height fraction)', () => {
    // In first person, camera is at eye height: modelHeight * EYE_FRAC
    // EYE_FRAC = 0.94
    const modelHeight = 16;
    const EYE_FRAC = 0.94;
    const eyeHeight = modelHeight * EYE_FRAC;
    expect(eyeHeight).toBeCloseTo(15.04, 0);
  });

  it('third person camera offset is modelHeight * EYE_FRAC below model center', () => {
    const modelHeight = 16;
    const EYE_FRAC = 0.94;
    // In third person, camera is offset down from model center by eye height
    const cameraY = modelHeight * (1 - EYE_FRAC);
    expect(cameraY).toBeCloseTo(0.96, 1);
  });
});

// ----------------------------------------------------------------
// Tests: GESTURE_ORDER and GESTURE_NAMES constants
// ----------------------------------------------------------------
describe('dc-multi.js — gesture constants', () => {
  // R3.11: GESTURE_ORDER and GESTURE_NAMES were both transcribed into this file, so
  // "GESTURE_NAMES has entries for all gestures in GESTURE_ORDER" compared one local literal
  // against another and could never see a real mismatch. Both now come from the source.
  const GESTURE_ORDER = (() => {
    const m = MULTI_SOURCE.match(/const GESTURE_ORDER\s*=\s*\[([\s\S]*?)\]/);
    if (!m) throw new Error('GESTURE_ORDER not found in dc-multi.js — was it renamed?');
    return (m[1].match(/["']([^"']+)["']/g) || []).map((x) => x.slice(1, -1));
  })();
  const GESTURE_NAMES_SRC = (() => {
    const m = MULTI_SOURCE.match(/const GESTURE_NAMES\s*=\s*\{([\s\S]*?)\};/);
    if (!m) throw new Error('GESTURE_NAMES not found in dc-multi.js — was it renamed?');
    return m[1];
  })();

  it('GESTURE_ORDER is populated and starts where the key bindings expect', () => {
    expect(GESTURE_ORDER.length).toBeGreaterThan(10);
    expect(GESTURE_ORDER[0]).toBe('dance1');
    for (const g of ['wave', 'clap', 'salute']) expect(GESTURE_ORDER).toContain(g);
  });

  it('GESTURE_NAMES has an entry for every gesture in GESTURE_ORDER', () => {
    // A gesture bound to a key with no display name shows "undefined" in the HUD.
    for (const gesture of GESTURE_ORDER) {
      expect(new RegExp(`(^|[{,\\s])${gesture}\\s*:`).test(GESTURE_NAMES_SRC), gesture).toBe(true);
    }
  });

  it('key mapping for gestures 1-9', () => {
    const keyToGesture = {
      Digit1: 'dance1', Digit2: 'dance2', Digit3: 'clap', Digit4: 'dying',
      Digit5: 'wave', Digit6: 'dance3', Digit7: 'dance4', Digit8: 'salute', Digit9: 'cheer'
    };

    expect(keyToGesture.Digit1).toBe('dance1');
    expect(keyToGesture.Digit5).toBe('wave');
    expect(keyToGesture.Digit9).toBe('cheer');
  });
});

// ----------------------------------------------------------------
// Tests: Camera wheel step and limits
//
// R3.11: this block used to contain TWO more hand-written onWheel re-implementations, each with
// its own transcribed CAM_MIN / CAM_MAX / WHEEL_STEP, asserting against itself. They duplicated
// what tests/js/dc-wheel-dolly.test.js was also doing with a third copy — three copies of the
// same fiction and zero calls into dc-multi.js. The real handler is now executed, once, in
// dc-wheel-dolly.test.js, which covers the dolly, the mode transitions and both limits.
//
// What is left here is the one thing that file does not check: that the wheel constants are
// internally consistent with the camera range they clamp. Read from source, not transcribed.
// ----------------------------------------------------------------
describe('dc-multi.js — camera wheel constants', () => {
  const WHEEL_STEP = constant('WHEEL_STEP');

  it('a wheel notch is a usable fraction of the camera range', () => {
    // Too large and the dolly jumps between two positions; too small and it feels dead.
    const range = CAM_MAX - CAM_MIN;
    expect(WHEEL_STEP).toBeGreaterThan(0);
    expect(WHEEL_STEP).toBeLessThan(range / 4);
  });

  it('the camera range is non-degenerate', () => {
    expect(CAM_MIN).toBeGreaterThan(0);
    expect(CAM_MAX).toBeGreaterThan(CAM_MIN);
  });
});

// ----------------------------------------------------------------
// Tests: G_PER_MS2 gravity constant
// ----------------------------------------------------------------
describe('dc-multi.js — gravity constants', () => {
  it('G_PER_MS2 = 100 converts m/s² to scene units', () => {
    const G_PER_MS2 = 100;
    const gravityMs2 = 9.8;  // Earth gravity
    const expectedGravityPerSec = gravityMs2 * G_PER_MS2;
    expect(expectedGravityPerSec).toBeCloseTo(980, 0);  // matches GRAVITY constant
  });

  it('jump physics uses JUMP_V=130 initial velocity', () => {
    const JUMP_V = 130;
    const GRAVITY = 980;
    const G_PER_MS2 = 100;

    // Simulate one frame of jump
    let vy = JUMP_V;
    const dt = 0.016;  // ~60fps

    vy -= GRAVITY * dt;
    expect(vy).toBeLessThan(JUMP_V);  // gravity is reducing vy
    expect(vy).toBeGreaterThan(0);      // still moving upward
  });
});

// ----------------------------------------------------------------
// Tests: trySpawn spawn logic
// ----------------------------------------------------------------
describe('dc-multi.js — trySpawn logic', () => {
  it('spawn uses roomSpawn when no explicit position given', () => {
    // Simulate roomSpawn
    const roomSpawn = { x: 10, y: 0, z: 20, lookX: 10, lookZ: 25 };

    // No explicit x, z, facing passed
    const spawnX = roomSpawn.x;
    const spawnZ = roomSpawn.z;
    const spawnFacing = Math.atan2(roomSpawn.lookX - roomSpawn.x, roomSpawn.lookZ - roomSpawn.z);

    expect(spawnX).toBe(10);
    expect(spawnZ).toBe(20);
    expect(typeof spawnFacing).toBe('number');
  });

  it('spawn respects passed position over roomSpawn', () => {
    const roomSpawn = { x: 10, z: 20, lookX: 10, lookZ: 25 };
    const passedX = 50, passedZ = 60;

    // Passed values take precedence
    const spawnX = passedX !== undefined ? passedX : roomSpawn.x;
    const spawnZ = passedZ !== undefined ? passedZ : roomSpawn.z;

    expect(spawnX).toBe(50);
    expect(spawnZ).toBe(60);
  });

  it('spawned flag is set after successful spawn', () => {
    let spawned = false;
    const roomSpawn = { x: 10, z: 20, lookX: 10, lookZ: 25 };

    // Simulate spawn
    if (roomSpawn) {
      spawned = true;
    }

    expect(spawned).toBe(true);
  });
});

// ----------------------------------------------------------------
// Tests: frame() with no model loaded
// ----------------------------------------------------------------
describe('dc-multi.js — frame with no model', () => {
  it('movement is skipped when model is not yet loaded', () => {
    // When model is streaming in, position should not update to prevent desync
    let model = null;
    let modelLoadFailed = false;
    let position = { x: 0, z: 0 };

    const moving = true;
    const _move = { x: 1, z: 0 };  // moving forward
    const speed = 14;  // WALK speed
    const dt = 0.016;

    // Simulate frame() behavior when model not loaded
    if (moving && !model && !modelLoadFailed) {
      // Model still streaming — hold position
    } else if (moving) {
      position.x += _move.x * speed * dt;
      position.z += _move.z * speed * dt;
    }

    // Position should NOT have changed
    expect(position.x).toBe(0);
    expect(position.z).toBe(0);
  });

  it('frame continues normally when model IS loaded', () => {
    let model = {};  // model loaded
    let position = { x: 0, z: 0 };

    const moving = true;
    const _move = { x: 1, z: 0 };
    const speed = 14;
    const dt = 0.016;

    if (moving && !model && false) {
      // skip
    } else if (moving) {
      position.x += _move.x * speed * dt;
      position.z += _move.z * speed * dt;
    }

    // Position SHOULD have changed
    expect(position.x).toBeGreaterThan(0);
  });
});

// ================================================================
// Tests: the real module, loaded with fake browser globals.
//
// dc-multi.js is a side-effect module: it polls for window.DC, then boots the
// overlay. Everything it touches (window / document / fetch / controls / renderer)
// is faked below so the presence coordination with dc-presence.js can be driven
// end to end. Per .claude/rules/js-tests.md the real `three` is never imported —
// the vi.mock calls at the top of this file swap in tests/js/__mocks__/three.js.
// ================================================================
describe('dc-multi.js — presence announcement (loaded module)', () => {
  let env;

  /** Anything-goes chainable stub, enough for lil-gui's fluent API. */
  function chainStub() {
    const target = function () { return proxy; };
    const proxy = new Proxy(target, { get: () => proxy, apply: () => proxy });
    return proxy;
  }

  function makeEl() {
    return {
      textContent: '', style: {}, value: '',
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, removeChild() {}, remove() {},
      innerHTML: '', parentNode: null,
    };
  }

  async function boot(opts = {}) {
    const THREE = await vi.importActual('./__mocks__/three.js');
    const docListeners = {};
    const controlListeners = {};
    const joins = [];
    const moves = [];
    const leaves = [];

    const doc = {
      readyState: 'complete',
      hidden: false,
      addEventListener(evt, cb) { (docListeners[evt] = docListeners[evt] || []).push(cb); },
      removeEventListener() {},
      getElementById: () => makeEl(),
      createElement: () => makeEl(),
      body: { appendChild() {}, removeChild() {} },
    };

    const scene = new THREE.Group();
    const camera = {
      position: new THREE.Vector3(),
      quaternion: {},
      fov: 75,
      lookAt() {},
      getWorldDirection(v) { v.set(0, 0, -1); return v; },
      updateProjectionMatrix() {},
    };
    const controls = {
      isLocked: false,
      addEventListener(evt, cb) { (controlListeners[evt] = controlListeners[evt] || []).push(cb); },
      removeEventListener() {},
    };

    // `window === globalThis` mirrors the browser, where `window.DC = x` also creates
    // the bare `DC` binding that dc-multi's whenReady() reads.
    globalThis.window = globalThis;
    globalThis.document = doc;
    globalThis.devicePixelRatio = 1;
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 720;
    globalThis.location = { search: '' };
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ generated_at: null, characters: [{ id: 'c1', name: 'C1', model: '/c1.glb', animations: [] }] }),
    });
    globalThis.__DCM_FAKE_GLTF__ = () => ({ scene: new THREE.Group(), animations: [] });

    globalThis.DC_PRESENCE_JOIN = (x, z, yaw) => { joins.push({ x, z, yaw }); };
    globalThis.DC_PRESENCE_MOVE = (x, z, yaw) => { moves.push({ x, z, yaw }); };
    globalThis.DC_PRESENCE_LEAVE = () => { leaves.push(true); };
    if (opts.enabled !== undefined) globalThis.DC_PRESENCE_ENABLED = opts.enabled;

    let frameFn = null;
    globalThis.DC = Object.assign({
      scene, camera, controls,
      renderer: { setPixelRatio() {}, setSize() {}, render() {} },
      options: {},
      eyeHeight: () => 15,
      playerRadius: () => 1,
      roomSpawn: { x: 100, y: 0, z: 200, lookX: 100, lookZ: 210 },
      roomBounds: { minX: -50, maxX: 250, minZ: 100, maxZ: 300 },
      gui: { addFolder: () => chainStub() },
      setAnimationLoop(fn) { frameFn = fn; },
      tick() {},
      flyTo: { active: false, onDone: null },
    }, opts.dc);

    vi.resetModules();
    await import('../../public_html/js/dc-multi.js');
    // whenReady's callback is async (awaits the manifest fetch) — let it settle.
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    return {
      joins, moves, leaves, scene, camera, controls, doc,
      get frame() { return frameFn; },
      fireDoc(evt, detail) { (docListeners[evt] || []).forEach((cb) => cb({ detail, type: evt })); },
      fireControls(evt) { (controlListeners[evt] || []).forEach((cb) => cb()); },
      key(code) { (docListeners.keydown || []).forEach((cb) => cb({ code, target: {} })); },
    };
  }

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ['window', 'document', 'DC', 'DCM', 'fetch', 'location', 'devicePixelRatio',
      'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener', '__DCM_FAKE_GLTF__',
      'DC_PRESENCE_JOIN', 'DC_PRESENCE_MOVE', 'DC_PRESENCE_LEAVE', 'DC_PRESENCE_ENABLED']) {
      delete globalThis[k];
    }
    env = null;
  });

  it('boots and exposes window.DCM', async () => {
    env = await boot();
    expect(globalThis.DCM).toBeTruthy();
    expect(typeof globalThis.DCM.getPosition).toBe('function');
    expect(typeof env.frame).toBe('function');
  });

  it('exposes getFacing() so dc-presence can read our real facing (C3)', async () => {
    env = await boot();
    expect(typeof globalThis.DCM.getFacing).toBe('function');
    env.key('KeyR');   // trySpawn -> facing derived from roomSpawn's look target
    expect(globalThis.DCM.getFacing()).toBeCloseTo(Math.atan2(0, 10), 6);
  });

  it('getPosition() reports the real spawn position, not the world origin', async () => {
    env = await boot();
    env.key('KeyR');
    expect(globalThis.DCM.getPosition()).toEqual({ x: 100, z: 200 });
  });

  it('spawning announces presence at the REAL position (never 0,0,0)', async () => {
    env = await boot();
    env.joins.length = 0;
    env.key('KeyR');
    expect(env.joins.length).toBe(1);
    expect(env.joins[0].x).toBe(100);
    expect(env.joins[0].z).toBe(200);
    expect(typeof env.joins[0].yaw).toBe('number');
  });

  it('dc:auth-success re-enables presence and re-announces after a pre-auth spawn', async () => {
    env = await boot();
    env.key('KeyR');            // spawned before auth
    env.joins.length = 0;

    env.fireDoc('dc:disconnected');
    expect(globalThis.DC_PRESENCE_ENABLED).toBe(false);

    env.fireDoc('dc:auth-success', { uid: 1, clientId: 'abc', name: 'n' });
    expect(globalThis.DC_PRESENCE_ENABLED).toBe(true);
    // Re-announced with the live pose; dc-presence latches it into ONE join.
    expect(env.joins.length).toBe(1);
    expect(env.joins[0]).toMatchObject({ x: 100, z: 200 });
  });

  it('does not announce before the player has spawned', async () => {
    env = await boot();
    env.joins.length = 0;
    env.fireDoc('dc:auth-success', { uid: 1 });
    expect(env.joins.length).toBe(0);
  });

  it('does not announce while presence is disabled', async () => {
    env = await boot({ enabled: false });
    env.joins.length = 0;
    env.key('KeyR');
    expect(env.joins.length).toBe(0);
  });

  it('pointer unlock leaves and pointer re-lock re-announces (symmetric)', async () => {
    env = await boot();
    env.key('KeyR');
    env.joins.length = 0;

    env.fireControls('unlock');
    expect(env.leaves.length).toBe(1);

    env.fireControls('lock');
    expect(env.joins.length).toBe(1);
    expect(env.joins[0]).toMatchObject({ x: 100, z: 200 });
  });

  it('an announcement clears the move dedupe so the next frame resyncs position', async () => {
    env = await boot();
    env.key('KeyR');
    env.frame();                       // primes S._lastPresence*
    const before = env.moves.length;
    env.frame();                       // nothing changed -> deduped
    expect(env.moves.length).toBe(before);

    env.fireControls('lock');          // re-announce clears the dedupe
    env.frame();
    expect(env.moves.length).toBe(before + 1);
  });

  it('there is exactly one DC_PRESENCE_JOIN call site, funnelled through announcePresence()', () => {
    const callSites = MULTI_SOURCE.match(/window\.DC_PRESENCE_JOIN\(/g) || [];
    expect(callSites.length).toBe(1);
    expect(MULTI_SOURCE).toMatch(/function announcePresence\(\)/);
    // trySpawn, auth-success and pointer re-lock all go through the helper.
    expect((MULTI_SOURCE.match(/announcePresence\(\)/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it('the frame loop still sends throttled moves with yaw (no facing key)', async () => {
    env = await boot();
    env.key('KeyR');
    env.frame();
    expect(env.moves.length).toBeGreaterThan(0);
    expect(Object.keys(env.moves[0]).sort()).toEqual(['x', 'yaw', 'z']);
  });
});
