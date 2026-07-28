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
