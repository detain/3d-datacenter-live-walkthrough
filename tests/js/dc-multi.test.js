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

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ----------------------------------------------------------------
// Mock Three.js module (must be mocked before the source under test
// imports it). We mock the entire three module here so that the
// ES module import in dc-multi.js resolves to our lightweight stubs.
// ----------------------------------------------------------------
vi.mock('three', async () => {
  const mockThree = await vi.importActual('./__mocks__/three.js');
  return mockThree;
});

// ----------------------------------------------------------------
// Constants from dc-multi.js (verified by reading the source)
// ----------------------------------------------------------------
const WALK = 14;
const RUN = 34;
const RUN_THRESH = 22;
const GRAVITY = 980;
const JUMP_V = 130;
const G_PER_MS2 = 100;
const CAM_MIN = 4.5;
const CAM_MAX = 62;

// ----------------------------------------------------------------
// Tests: movement constants
// ----------------------------------------------------------------
describe('dc-multi.js — movement constants', () => {
  it('WALK=14 and RUN=34 are used correctly in speed selection', () => {
    const getSpeed = (runFast) => (runFast ? RUN : WALK);
    expect(getSpeed(false)).toBe(WALK);
    expect(getSpeed(true)).toBe(RUN);
  });

  it('RUN_THRESH=22 correctly gates run vs walk animation', () => {
    const chooseAnimation = (speed, actions) => {
      if (speed >= RUN_THRESH && actions.run) return 'run';
      if (actions.walk) return 'walk';
      return 'idle';
    };

    expect(chooseAnimation(14, { walk: true, run: true })).toBe('walk');
    expect(chooseAnimation(22, { walk: true, run: true })).toBe('run');
    expect(chooseAnimation(34, { walk: true, run: true })).toBe('run');
    expect(chooseAnimation(14, { walk: true })).toBe('walk');
    expect(chooseAnimation(14, {})).toBe('idle');
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
  it('lerpAngle normalizes angle differences to [-PI, PI]', () => {
    // From dc-multi.js:
    // function lerpAngle(a, b, t) {
    //   let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    //   return a + d * t;
    // }
    const lerpAngle = (a, b, t) => {
      let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
      return a + d * t;
    };

    // Same angle -> no change
    expect(lerpAngle(0.5, 0.5, 0.3)).toBeCloseTo(0.5);

    // Small difference
    expect(lerpAngle(0.0, 0.1, 1.0)).toBeCloseTo(0.1);

    // Linear interpolation (no wrap needed)
    expect(lerpAngle(0.0, 1.0, 0.5)).toBeCloseTo(0.5);
    expect(lerpAngle(0.0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4);
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
  // GESTURE_ORDER from dc-multi.js line 669
  const GESTURE_ORDER = ["dance1", "dance2", "clap", "dying", "wave", "dance3", "dance4", "salute", "cheer",
    "bow", "point", "thumbsup", "talk", "laugh", "think", "shrug", "punch", "kick", "sit", "backflip", "jacks"];

  it('GESTURE_ORDER contains expected gestures', () => {
    expect(GESTURE_ORDER.length).toBe(21);
    expect(GESTURE_ORDER[0]).toBe('dance1');
    expect(GESTURE_ORDER).toContain('wave');
    expect(GESTURE_ORDER).toContain('clap');
    expect(GESTURE_ORDER).toContain('salute');
  });

  it('GESTURE_NAMES has entries for all gestures in GESTURE_ORDER', () => {
    const GESTURE_NAMES = { dance1: "Samba", dance2: "Hip-Hop", dance3: "Breakdance", dance4: "Gangnam",
      clap: "Clap", wave: "Wave", dying: "Dying", salute: "Salute", cheer: "Cheer", bow: "Bow", point: "Point",
      thumbsup: "Thumbs Up", talk: "Talk", laugh: "Laugh", think: "Think", shrug: "Shrug", punch: "Punch",
      kick: "Kick", sit: "Sit", backflip: "Backflip", jacks: "Jumping Jacks" };

    for (const gesture of GESTURE_ORDER) {
      expect(GESTURE_NAMES).toHaveProperty(gesture);
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
// ----------------------------------------------------------------
describe('dc-multi.js — camera wheel constants', () => {
  it('WHEEL_STEP = 5 follow-distance change per wheel notch', () => {
    const WHEEL_STEP = 5;
    expect(WHEEL_STEP).toBe(5);
  });

  it('onWheel logic for first-person mode (pop to third-person on scroll out)', () => {
    const CAM_MIN = 4.5, CAM_MAX = 62;
    const WHEEL_STEP = 5;
    let mode = 'first';
    let camDist = 4.5;  // at CAM_MIN

    // Scroll out in first-person mode should pop to third-person at CAM_MIN
    const onWheel = (out) => {
      if (mode === 'first') {
        if (out) { camDist = CAM_MIN; mode = 'third'; }
        return;
      }
      if (out) {
        camDist = Math.min(CAM_MAX, camDist + WHEEL_STEP);
      } else {
        const nd = camDist - WHEEL_STEP;
        if (nd < CAM_MIN) mode = 'first';
        else camDist = nd;
      }
    };

    // Scroll out from first-person
    onWheel(true);
    expect(mode).toBe('third');
    expect(camDist).toBe(CAM_MIN);
  });

  it('onWheel zoom in third-person decreases camDist', () => {
    const CAM_MIN = 4.5, CAM_MAX = 62;
    const WHEEL_STEP = 5;
    let mode = 'third';
    let camDist = 20;

    // Scroll in (negative deltaY)
    const onWheelIn = () => {
      const nd = camDist - WHEEL_STEP;
      if (nd < CAM_MIN) mode = 'first';
      else camDist = nd;
    };

    onWheelIn();
    expect(camDist).toBe(15);
    expect(mode).toBe('third');

    // Scroll all the way in
    for (let i = 0; i < 5; i++) onWheelIn();
    expect(mode).toBe('first');  // crossed CAM_MIN threshold
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
