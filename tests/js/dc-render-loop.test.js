/**
 * Unit tests for the render loop collapse in public_html/js/dc.js
 *
 * Verifies that animate() and DC.tick() form a single canonical render path (Bug F-16), and
 * that _tickSkippedFrames / _skipExpensiveUpdates are managed exclusively by tick() so both
 * the dc.html path and the dc-multi path reach the same idle-skip frame count.
 *
 * WHY THIS FILE WAS REWRITTEN (dc_remediation_plan.md step R1.4)
 * The previous version asserted `expect(lastLine).toMatch(/^tick\(\);?$/)` — i.e. that the
 * last line of animate() is a bare `tick();`. There is no module-scope `tick` in dc.js; the
 * only one is a property on the window.DC object literal. So that call threw
 * `ReferenceError: tick is not defined` on every single frame, _guardLoop swallowed it, and
 * after 10 frames _loopErrorCount stopped even logging. The scene never painted on the
 * dc.html path — the exact path Step 4.1 existed to protect — and the test asserted that it
 * must stay that way.
 *
 * The lesson: a test that pattern-matches the source it was written against can only ever
 * confirm that nobody edited the file. animate() is now EXECUTED here, with the same free
 * identifiers injected that the module provides, so a call to something that does not exist
 * fails loudly.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_SRC = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_SRC, 'utf8');

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

/** Strip comments so identifiers mentioned in prose don't cause false positives. */
function stripComments(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extract a top-level function declaration (column-0) via a brace-depth walk. */
function getFunctionBody(source, fnName) {
  const lines = source.split('\n');
  const startRe = new RegExp(`^function ${fnName}\\(\\)\\s*\\{`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx < 0) return null;
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    if (depth === 0 && i > startIdx) return lines.slice(startIdx, i + 1).join('\n');
  }
  return null;
}

/**
 * Compile a body of `function animate() {...}` source into a callable, injecting every free
 * identifier animate() reads. Returns { run, calls } where calls records what animate did.
 *
 * Deliberately takes the source as an argument rather than reading it, so the non-vacuity
 * test below can compile a deliberately-broken variant through the identical harness.
 */
function compileAnimate(bodySource, { contextLost = false, hidden = false, locked = true } = {}) {
  const calls = { tick: 0, updateControls: 0, maybeCycleIdleView: 0, maybeFlicker: 0, updateDisco: 0 };
  const fakeWindow = { DC: { tick: () => { calls.tick++; } } };
  const deps = {
    _contextLost: contextLost,
    document: { hidden },
    performance: { now: () => 1000 },
    options: { useFirstPerson: false },
    controls: { isLocked: locked, update: () => {} },
    clock: { getDelta: () => 0.016 },
    flyTo: { active: false },
    updateControls: () => { calls.updateControls++; },
    maybeCycleIdleView: () => { calls.maybeCycleIdleView++; },
    maybeFlicker: () => { calls.maybeFlicker++; },
    updateDisco: () => { calls.updateDisco++; },
    window: fakeWindow,
  };
  const names = Object.keys(deps);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${bodySource}; return animate;`);
  return { run: factory(...names.map((n) => deps[n])), calls };
}

// ----------------------------------------------------------------
// Behavioural — animate() actually runs
// ----------------------------------------------------------------
describe('dc.js — animate() executes and drives DC.tick()', () => {

  it('the animate() declaration can be found in dc.js', () => {
    // If this throws, animate() was renamed and every test below is silently testing nothing.
    expect(getFunctionBody(DC_SOURCE, 'animate')).not.toBeNull();
  });

  it('runs without throwing and calls DC.tick() exactly once per frame', () => {
    const { run, calls } = compileAnimate(getFunctionBody(DC_SOURCE, 'animate'));
    expect(() => run()).not.toThrow();
    expect(calls.tick).toBe(1);
    run();
    expect(calls.tick).toBe(2);
  });

  it('runs the per-frame overlays before delegating', () => {
    const { run, calls } = compileAnimate(getFunctionBody(DC_SOURCE, 'animate'));
    run();
    expect(calls.maybeCycleIdleView).toBe(1);
    expect(calls.maybeFlicker).toBe(1);
    expect(calls.updateDisco).toBe(1);
  });

  it('short-circuits on a lost WebGL context — no tick, no overlays', () => {
    const { run, calls } = compileAnimate(getFunctionBody(DC_SOURCE, 'animate'), { contextLost: true });
    run();
    expect(calls.tick).toBe(0);
    expect(calls.updateDisco).toBe(0);
  });

  it('short-circuits on a hidden document — no tick', () => {
    const { run, calls } = compileAnimate(getFunctionBody(DC_SOURCE, 'animate'), { hidden: true });
    run();
    expect(calls.tick).toBe(0);
  });

  it('tolerates window.DC not yet being assigned (init still in flight)', () => {
    const body = getFunctionBody(DC_SOURCE, 'animate');
    const names = ['_contextLost', 'document', 'performance', 'options', 'controls', 'clock',
      'flyTo', 'updateControls', 'maybeCycleIdleView', 'maybeFlicker', 'updateDisco', 'window'];
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `${body}; return animate;`)(
      false, { hidden: false }, { now: () => 0 }, { useFirstPerson: false },
      { isLocked: true, update: () => {} }, { getDelta: () => 0 }, { active: false },
      () => {}, () => {}, () => {}, () => {}, {} /* window with no DC */);
    expect(() => fn()).not.toThrow();
  });

  it('NON-VACUITY: the same harness fails on the pre-fix bare tick() call', () => {
    // This is the test the original file should have had. Compile the defect and prove the
    // harness catches it — otherwise every assertion above could be passing for free.
    const broken = getFunctionBody(DC_SOURCE, 'animate')
      .replace(/if \(window\.DC && typeof window\.DC\.tick === 'function'\) window\.DC\.tick\(\);/, 'tick();');
    expect(broken).toMatch(/^\s*tick\(\);$/m);   // the substitution really happened
    const { run } = compileAnimate(broken);
    expect(() => run()).toThrow(/tick is not defined/);
  });

});

// ----------------------------------------------------------------
// Structural — contracts that must not silently drift
// ----------------------------------------------------------------
describe('dc.js — F-16 single canonical render loop', () => {

  // R3.3: the idle gate is no longer a frame counter — it is wall-clock time since the last real
  // input. The contract these two guard is unchanged (tick() owns the gate, animate() does not
  // touch it); only the mechanism moved. See tests/js/dc-idle-skip.test.js for the behaviour.

  it('animate() does NOT own the idle gate', () => {
    const codeOnly = stripComments(getFunctionBody(DC_SOURCE, 'animate'));
    expect(codeOnly).not.toMatch(/_refreshIdleState/);
    expect(codeOnly).not.toMatch(/_skipExpensiveUpdates\s*=/);
  });

  it('tick() owns the idle gate', () => {
    // tick is a property on the window.DC object literal, not a top-level declaration, so it is
    // located by its `tick: function () {` head and walked to a balanced brace.
    const start = DC_SOURCE.indexOf('tick: function () {');
    expect(start, 'dc.js no longer declares a tick: property on window.DC').toBeGreaterThan(-1);
    let depth = 0, end = start;
    for (let i = DC_SOURCE.indexOf('{', start); i < DC_SOURCE.length; i++) {
      if (DC_SOURCE[i] === '{') depth++;
      else if (DC_SOURCE[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const codeOnly = stripComments(DC_SOURCE.slice(start, end + 1));
    expect(codeOnly).toMatch(/_refreshIdleState\(now\)/);
    expect(codeOnly).toMatch(/if\s*\(\s*_skipExpensiveUpdates\s*\)/);
  });

  it('animate() does NOT render directly — tick() owns rendering', () => {
    const codeOnly = stripComments(getFunctionBody(DC_SOURCE, 'animate'));
    expect(codeOnly).not.toMatch(/renderer\.render\(/);
    expect(codeOnly).not.toMatch(/stats\.update\(\)/);
  });

  it('animate() does NOT duplicate the expensive per-frame updates tick() handles', () => {
    const codeOnly = stripComments(getFunctionBody(DC_SOURCE, 'animate'));
    for (const fn of ['updateLabels\\(\\)', 'updateLOD\\(\\)', 'updateNeighborDoors\\(\\)',
      'updateRoomDoors\\(\\)', 'updateGuiPos\\(\\)', '_updateFPS\\(', '_autoQualityScale\\(']) {
      expect(codeOnly).not.toMatch(new RegExp(fn));
    }
  });

  it('setAnimationLoop registers animate as the default renderer loop', () => {
    expect(DC_SOURCE).toMatch(/renderer\.setAnimationLoop\(\s*_guardLoop\(animate\)\s*\)/);
  });

});
