/**
 * tests/js/dc-stub-sanity.test.js — the three.js stub is checked against real three.js (R3.9)
 *
 * WHY THIS FILE EXISTS
 * Step 0.1 mandated it and it was never written. In the gap, `tests/js/__mocks__/three.js` shipped
 * a `Euler.setFromQuaternion` that computed the wrong yaw — 90° came out as 45°, 180° came out as
 * 0° — and a comment above it asserting that 45° was correct. Nothing caught it, because a stub is
 * the one piece of test infrastructure that nothing else can check: every other test trusts it by
 * construction, so a wrong stub makes the suite quieter, not louder.
 *
 * So this file does the one thing the rest of the suite must not: it imports the REAL `three`
 * package and runs it side by side with the stub. That is a deliberate exception to the
 * "never import the real three" rule in .claude/rules/js-tests.md — that rule protects the modules
 * under test from pulling in a WebGL-dependent 1.2 MB dependency. Here the real class IS the
 * expectation. Nothing in this file imports anything from public_html/js.
 *
 * WHAT IT GUARDS
 * Only the stub methods that compute something. A stub that stores a value handed to it cannot be
 * wrong; a stub that does arithmetic can be, silently, forever. Every method asserted on here was
 * at some point a `return this` no-op, which is the failure mode the project rule names: the test
 * passes because the mock never moved, not because the code is right.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import * as REAL from 'three';
import * as STUB from './__mocks__/three.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

/** Build a real quaternion from YXZ Euler degrees — the real class is the source of the input. */
function quat(pitchDeg, yawDeg, rollDeg) {
  return new REAL.Quaternion().setFromEuler(
    new REAL.Euler(pitchDeg * DEG, yawDeg * DEG, rollDeg * DEG, 'YXZ'));
}

/** Decompose with the real class and with the stub, returning both. */
function decompose(q) {
  const real = new REAL.Euler().setFromQuaternion(q, 'YXZ');
  const stub = new STUB.Euler().setFromQuaternion(q, 'YXZ');
  return { real, stub };
}

/** A plain quaternion literal, to prove the stub does not require a real three.js object. */
const plain = (x, y, z, w) => ({ x, y, z, w });

// ---------------------------------------------------------------------------
describe('three.js stub — the real package is present and is the version the app ships', () => {

  it('imports the real three, not the stub, under the name REAL', () => {
    // If a future vitest alias maps 'three' at the stub, every comparison below becomes the stub
    // agreeing with itself and this file stops testing anything at all.
    expect(REAL.REVISION).toBeTruthy();
    expect(REAL.Euler).not.toBe(STUB.Euler);
    expect(typeof REAL.Quaternion).toBe('function');
    // The stub has no REVISION; the real one does. A cheap second discriminator.
    expect(STUB.REVISION).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
describe('three.js stub — Euler.setFromQuaternion matches real three.js (YXZ)', () => {

  // The four the remediation plan measured. Each one is a yaw the old stub got wrong.
  it.each([
    ['30°', 30],
    ['45°', 45],
    ['90°', 90],
    ['180°', 180],
  ])('a pure %s yaw decomposes to the same yaw as real three.js', (_label, deg) => {
    const { real, stub } = decompose(quat(0, deg, 0));
    expect(stub.y).toBeCloseTo(real.y, 12);
    expect(stub.y).toBeCloseTo(deg * DEG, 12);
  });

  it('a 90° yaw is π/2, not π/4 — the value the old comment claimed', () => {
    // Spelled out because the wrong answer was written down as the right one, in a comment
    // directly above the code that produced it. π/4 is what the transposed element gave.
    const { real, stub } = decompose(quat(0, 90, 0));
    expect(real.y).toBeCloseTo(Math.PI / 2, 12);
    expect(stub.y).toBeCloseTo(Math.PI / 2, 12);
    expect(stub.y).not.toBeCloseTo(Math.PI / 4, 6);
  });

  it('a 180° yaw does not collapse to zero', () => {
    // The worst of the four: a character facing directly away read as facing the camera.
    const { stub } = decompose(quat(0, 180, 0));
    expect(Math.abs(stub.y)).toBeCloseTo(Math.PI, 12);
  });

  it('agrees across a full yaw sweep at 5° steps', () => {
    for (let deg = -180; deg <= 180; deg += 5) {
      const { real, stub } = decompose(quat(0, deg, 0));
      expect(stub.y, `yaw ${deg}°`).toBeCloseTo(real.y, 12);
    }
  });

  it('agrees on mixed pitch / yaw / roll, all three components', () => {
    const cases = [
      [20, 30, 10], [-35, 120, -25], [5, -170, 80], [60, 45, -60], [-10, 5, 175],
    ];
    for (const [p, y, r] of cases) {
      const { real, stub } = decompose(quat(p, y, r));
      const where = `pitch ${p}° yaw ${y}° roll ${r}°`;
      expect(stub.x, `${where} — x`).toBeCloseTo(real.x, 12);
      expect(stub.y, `${where} — y`).toBeCloseTo(real.y, 12);
      expect(stub.z, `${where} — z`).toBeCloseTo(real.z, 12);
    }
  });

  it('agrees at both gimbal poles, where the degenerate branch runs', () => {
    for (const [pitch, yaw] of [[90, 40], [-90, -70], [90, 0], [-90, 180]]) {
      const { real, stub } = decompose(quat(pitch, yaw, 0));
      const where = `pitch ${pitch}° yaw ${yaw}°`;
      expect(stub.x, `${where} — x`).toBeCloseTo(real.x, 9);
      expect(stub.y, `${where} — y`).toBeCloseTo(real.y, 9);
      expect(stub.z, `${where} — z`).toBe(0);
      expect(real.z, `${where} — real z`).toBe(0);
    }
  });

  it('agrees when the roll denominator is exactly zero', () => {
    // q = (0.5, 0.5, 0.5, 0.5) makes xx + zz exactly 1.0 in floating point, so the m11 term is a
    // true zero. The old stub special-cased that to 1 "to avoid dividing by zero" — atan2 has no
    // such problem, and the guard turned 90° of roll into 45°.
    const q = plain(0.5, 0.5, 0.5, 0.5);
    const real = new REAL.Euler().setFromQuaternion(new REAL.Quaternion(0.5, 0.5, 0.5, 0.5), 'YXZ');
    const stub = new STUB.Euler().setFromQuaternion(q, 'YXZ');
    expect(real.z).toBeCloseTo(Math.PI / 2, 12);
    expect(stub.z).toBeCloseTo(real.z, 12);
  });

  it('accepts a plain {x,y,z,w} object, and treats a missing w as 1', () => {
    // dc-multi.js hands it camera.quaternion, but tests hand it literals.
    // toBeCloseTo, not toEqual: asin(-0) is -0, and so is real three.js's. Distinguishing the two
    // zeroes here would be asserting on an IEEE-754 sign bit, not on the decomposition.
    const identity = new REAL.Euler().setFromQuaternion(new REAL.Quaternion(0, 0, 0, 1), 'YXZ');
    for (const q of [plain(0, 0, 0, 1), {}]) {
      const e = new STUB.Euler().setFromQuaternion(q, 'YXZ');
      expect(e.x).toBeCloseTo(identity.x, 12);
      expect(e.y).toBeCloseTo(identity.y, 12);
      expect(e.z).toBeCloseTo(identity.z, 12);
    }
  });

  it('records the order it was asked for', () => {
    const e = new STUB.Euler().setFromQuaternion(quat(0, 30, 0), 'YXZ');
    expect(e.order).toBe('YXZ');
  });

  it('throws on any order it has not implemented rather than answering wrongly', () => {
    // The default parameter used to be 'XYZ' while the body only ever computed YXZ, so calling it
    // the way three.js documents — with no order — returned a YXZ decomposition labelled XYZ.
    for (const order of ['XYZ', 'ZXY', 'ZYX', 'YZX', 'XZY']) {
      expect(() => new STUB.Euler().setFromQuaternion(quat(0, 30, 0), order)).toThrow(/only implements 'YXZ'/);
    }
    expect(() => new STUB.Euler().setFromQuaternion(quat(0, 30, 0))).toThrow(/only implements 'YXZ'/);
  });

  it('NON-VACUITY: the pre-fix element assignment fails this comparison', () => {
    // Reproduce the defect exactly — m22 as 1-(xx+zz) instead of 1-(xx+yy) — and confirm the
    // comparison above would have caught it. Without this the whole file could be passing because
    // toBeCloseTo is lenient, not because the maths is right.
    const broken = (q) => {
      const x = q.x, y = q.y, z = q.z, w = q.w;
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2;
      const m12 = yz - wx;
      if (Math.abs(m12) >= 0.9999999) return null;
      return Math.atan2(xz + wy, 1 - (xx + zz));   // the transposed element
    };
    const q = quat(0, 90, 0);
    const realY = new REAL.Euler().setFromQuaternion(q, 'YXZ').y;
    expect(broken(q)).toBeCloseTo(Math.PI / 4, 12);       // the wrong answer, reproduced
    expect(broken(q)).not.toBeCloseTo(realY, 6);          // and it is not the right one
    expect(new STUB.Euler().setFromQuaternion(q, 'YXZ').y).toBeCloseTo(realY, 12);
  });

});

// ---------------------------------------------------------------------------
describe('three.js stub — Vector3 arithmetic matches real three.js', () => {

  // All four of these were `return this` no-ops at some point in this file's history.

  it('addScaledVector', () => {
    const r = new REAL.Vector3(1, 2, 3).addScaledVector(new REAL.Vector3(4, 5, 6), 2.5);
    const s = new STUB.Vector3(1, 2, 3).addScaledVector(new STUB.Vector3(4, 5, 6), 2.5);
    expect([s.x, s.y, s.z]).toEqual([r.x, r.y, r.z]);
  });

  it('normalize', () => {
    const r = new REAL.Vector3(3, 4, 12).normalize();
    const s = new STUB.Vector3(3, 4, 12).normalize();
    expect(s.x).toBeCloseTo(r.x, 12);
    expect(s.y).toBeCloseTo(r.y, 12);
    expect(s.z).toBeCloseTo(r.z, 12);
  });

  it('normalize leaves a zero vector alone instead of producing NaN', () => {
    const r = new REAL.Vector3(0, 0, 0).normalize();
    const s = new STUB.Vector3(0, 0, 0).normalize();
    expect([s.x, s.y, s.z]).toEqual([r.x, r.y, r.z]);
  });

  it('lerp', () => {
    for (const a of [0, 0.25, 0.5, 1]) {
      const r = new REAL.Vector3(0, 10, -4).lerp(new REAL.Vector3(8, -6, 4), a);
      const s = new STUB.Vector3(0, 10, -4).lerp(new STUB.Vector3(8, -6, 4), a);
      expect([s.x, s.y, s.z], `alpha ${a}`).toEqual([r.x, r.y, r.z]);
    }
  });

  it('lengthSq and distanceToSquared', () => {
    expect(new STUB.Vector3(3, 4, 12).lengthSq()).toBe(new REAL.Vector3(3, 4, 12).lengthSq());
    expect(new STUB.Vector3(1, 2, 3).distanceToSquared(new STUB.Vector3(-4, 6, 0)))
      .toBe(new REAL.Vector3(1, 2, 3).distanceToSquared(new REAL.Vector3(-4, 6, 0)));
  });

  it('setScalar', () => {
    const r = new REAL.Vector3().setScalar(7), s = new STUB.Vector3().setScalar(7);
    expect([s.x, s.y, s.z]).toEqual([r.x, r.y, r.z]);
  });

});

// ---------------------------------------------------------------------------
describe('three.js stub — Box3.getSize / getCenter match real three.js', () => {

  // dc.js:3675-3676 sizes and positions the hover highlight from these. They did not exist.

  const BOUNDS = { min: { x: -2, y: 0, z: 4 }, max: { x: 6, y: 3, z: 10 } };

  function bothBoxes() {
    const real = new REAL.Box3(
      new REAL.Vector3(BOUNDS.min.x, BOUNDS.min.y, BOUNDS.min.z),
      new REAL.Vector3(BOUNDS.max.x, BOUNDS.max.y, BOUNDS.max.z));
    const stub = new STUB.Box3();
    Object.assign(stub.min, BOUNDS.min);
    Object.assign(stub.max, BOUNDS.max);
    return { real, stub };
  }

  it('getSize writes the extent into the target and returns it', () => {
    const { real, stub } = bothBoxes();
    const rt = new REAL.Vector3(), st = new STUB.Vector3();
    const returned = stub.getSize(st);
    real.getSize(rt);
    expect([st.x, st.y, st.z]).toEqual([rt.x, rt.y, rt.z]);
    expect([st.x, st.y, st.z]).toEqual([8, 3, 6]);
    expect(returned).toBe(st);
  });

  it('getCenter writes the midpoint into the target and returns it', () => {
    const { real, stub } = bothBoxes();
    const rt = new REAL.Vector3(), st = new STUB.Vector3();
    const returned = stub.getCenter(st);
    real.getCenter(rt);
    expect([st.x, st.y, st.z]).toEqual([rt.x, rt.y, rt.z]);
    expect([st.x, st.y, st.z]).toEqual([2, 1.5, 7]);
    expect(returned).toBe(st);
  });

  it('both throw without a target rather than silently doing nothing', () => {
    const { stub } = bothBoxes();
    expect(() => stub.getSize()).toThrow(/requires a target/);
    expect(() => stub.getCenter()).toThrow(/requires a target/);
  });

  it('isEmpty agrees with real three.js on a normal and an inverted box', () => {
    const { real, stub } = bothBoxes();
    expect(stub.isEmpty()).toBe(real.isEmpty());
    expect(stub.isEmpty()).toBe(false);
    stub.max.y = -1;
    expect(stub.isEmpty()).toBe(true);
  });

  it('setFromObject honours an explicit userData.__testBounds', () => {
    // The stub cannot walk geometry, so a test supplies the bounds. Without this every model
    // measured exactly 1 unit tall and dc-multi.js's auto-scale divide was untestable.
    const b = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1.8, z: 1 } };
    const box = new STUB.Box3().setFromObject({ userData: { __testBounds: b } });
    expect(box.max.y - box.min.y).toBe(1.8);
    const size = box.getSize(new STUB.Vector3());
    expect(size.y).toBe(1.8);
  });

});

// ---------------------------------------------------------------------------
describe('three.js stub — misc values that must match the real package', () => {

  it('DoubleSide is the real constant', () => {
    // It was undefined, so `side: THREE.DoubleSide` was falsy and read as FrontSide under test.
    expect(STUB.DoubleSide).toBe(REAL.DoubleSide);
  });

  it('SRGBColorSpace is the real constant', () => {
    expect(STUB.SRGBColorSpace).toBe(REAL.SRGBColorSpace);
  });

  it('MathUtils.lerp matches', () => {
    for (const t of [0, 0.3, 1]) {
      expect(STUB.MathUtils.lerp(-5, 15, t)).toBe(REAL.MathUtils.lerp(-5, 15, t));
    }
  });

  it('AnimationAction.setEffectiveWeight records the weight', () => {
    // It returned `this` and stored nothing, so a faded-out action and a full-weight one were
    // indistinguishable — and the crossfade in dc-multi.js play() is entirely about weights.
    const act = new STUB.AnimationAction();
    expect(act.weight).toBe(1);
    expect(act.setEffectiveWeight(0)).toBe(act);
    expect(act.weight).toBe(0);
    act.setEffectiveWeight(0.35);
    expect(act.weight).toBe(0.35);
  });

  it('Group.add reparents, the way Object3D does', () => {
    // A shared child looked like it was in two groups at once, which hid dc-presence handing the
    // same Sprite to every avatar with the same name.
    const a = new STUB.Group(), b = new STUB.Group(), child = new STUB.Group();
    a.add(child);
    b.add(child);
    expect(a.children).toHaveLength(0);
    expect(b.children).toEqual([child]);
    expect(child.parent).toBe(b);

    const ra = new REAL.Group(), rb = new REAL.Group(), rc = new REAL.Group();
    ra.add(rc); rb.add(rc);
    expect(ra.children).toHaveLength(0);
    expect(rb.children).toEqual([rc]);
  });

  it('Group.traverse visits self then the whole subtree', () => {
    const root = new STUB.Group(), mid = new STUB.Group(), leaf = new STUB.Group();
    root.add(mid); mid.add(leaf);
    const seen = [];
    root.traverse((o) => seen.push(o));
    expect(seen).toEqual([root, mid, leaf]);
  });

});
