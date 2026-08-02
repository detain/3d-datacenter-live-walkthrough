/**
 * Unit tests for the idle-skip mechanism in public_html/js/dc.js
 *
 * Verifies that F-17 is fixed: setLodFocus no longer resets the idle skip
 * counter every frame — it only resets when the player position actually
 * changes, allowing the idle-skip to trigger after real user inactivity.
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

/** Strip single-line and multi-line comments so embedded identifiers don't cause false positives. */
function stripComments(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Extract a method body from an object literal property.
 * Handles:  setLodFocus: function (x, z) { ... },
 * Returns the full method text between the opening { and closing }.
 */
function getObjectMethodBody(source, propName) {
  // Match:  propName: function (args) {
  const startRe = new RegExp(`${propName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{`);
  const lines = source.split('\n');
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

// ----------------------------------------------------------------
// Tests — F-17: idle-skip triggers on real idleness
// ----------------------------------------------------------------
describe('dc.js — F-17 idle-skip triggers on real idleness', () => {

  it('setLodFocus checks position change before resetting idle skip counter', () => {
    // The setLodFocus method must NOT unconditionally reset _tickSkippedFrames
    // every frame — it should only reset when position actually changes.
    // This was the root cause of F-17: setLodFocus was called every frame from
    // dc-multi.js, resetting the counter before it could ever reach the threshold.
    const body = getObjectMethodBody(DC_SOURCE, 'setLodFocus');
    expect(body).not.toBeNull();

    // Must NOT have the old buggy pattern: unconditional reset on every call
    // The fix requires a position-change check before resetting.
    // We verify the position comparison is present (Math.abs or similar check).
    const codeOnly = stripComments(body);
    expect(codeOnly).toMatch(/Math\.abs.*lodFocus\.x/);
    expect(codeOnly).toMatch(/Math\.abs.*lodFocus\.z/);
  });

  it('setLodFocus only resets idle skip when moved === true', () => {
    // After the position-change check, the reset must be conditional on
    // the 'moved' flag, not unconditional.
    const body = getObjectMethodBody(DC_SOURCE, 'setLodFocus');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // The reset lines must appear AFTER a conditional check, not as the first statement.
    // We verify there's a conditional (if/moved) wrapping the reset.
    expect(codeOnly).toMatch(/if\s*\(\s*moved\s*\)[\s\S]*_tickSkippedFrames\s*=\s*0/);
    expect(codeOnly).toMatch(/if\s*\(\s*moved\s*\)[\s\S]*_skipExpensiveUpdates\s*=\s*false/);
  });

  it('idle skip threshold is 18000 frames (5 min at 60fps)', () => {
    // Verify the threshold constant matches the comment (5 minutes at 60fps = 18000 frames)
    expect(DC_SOURCE).toMatch(/_IDLE_FRAME_THRESHOLD\s*=\s*18000/);
    expect(DC_SOURCE).toMatch(/18000 idle frames.*5 min/);
  });

  it('tick() increments _tickSkippedFrames and sets _skipExpensiveUpdates after threshold', () => {
    // The tick() function must increment the counter every frame and set the
    // skip flag once threshold is exceeded.
    const codeOnly = stripComments(DC_SOURCE);
    expect(codeOnly).toMatch(/\+\+_tickSkippedFrames\s*>\s*_IDLE_FRAME_THRESHOLD.*_skipExpensiveUpdates\s*=\s*true/);
  });

  it('setLodFocus does NOT unconditionally reset idle skip in the function body', () => {
    // Critical negative test: the old buggy pattern was:
    //   setLodFocus: function (x, z) { lodFocus = { x, z }; _tickSkippedFrames = 0; _skipExpensiveUpdates = false; }
    // After the fix, the resets must be inside a conditional, not direct assignments
    // at the top of the function.
    const body = getObjectMethodBody(DC_SOURCE, 'setLodFocus');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);
    const lines = codeOnly.split('\n').map(l => l.trim()).filter(l => l && l !== '}');

    // The very first statement after the opening brace must NOT be the reset
    // (unless it's part of a const/let declaration for 'moved')
    expect(lines[0]).not.toMatch(/^_tickSkippedFrames\s*=\s*0\s*;?\s*$/);
    expect(lines[0]).not.toMatch(/^_skipExpensiveUpdates\s*=\s*false\s*;?\s*$/);
  });

  it('when idle, tick() takes the fast path and skips expensive updates', () => {
    // When _skipExpensiveUpdates is true, tick() must render and return early
    // without doing the full update chain.
    const codeOnly = stripComments(DC_SOURCE);
    expect(codeOnly).toMatch(/if\s*\(\s*_skipExpensiveUpdates\s*\)[\s\S]{0,200}renderer\.render\(/);
  });

  it('setLodFocus comment references F-17 bug fix', () => {
    // The fix must include a comment referencing the bug it fixes (F-17)
    const body = getObjectMethodBody(DC_SOURCE, 'setLodFocus');
    expect(body).not.toBeNull();
    expect(body).toMatch(/F-17/);
  });

});
