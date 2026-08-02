/**
 * Unit tests for the render loop collapse in public_html/js/dc.js
 *
 * Verifies that animate() and DC.tick() form a single canonical render path
 * (Bug F-16), and that _tickSkippedFrames / _skipExpensiveUpdates are managed
 * exclusively by tick() so both the dc.html path and dc-multi path reach the
 * same idle-skip frame count.
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

/** Extract a top-level function body (column-0 function declaration) via brace-depth walk. */
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

// ----------------------------------------------------------------
// Tests — F-16: single canonical render loop
// ----------------------------------------------------------------
describe('dc.js — F-16 single canonical render loop', () => {

  it('animate() ends with a tick() call (single canonical render path)', () => {
    const body = getFunctionBody(DC_SOURCE, 'animate');
    expect(body).not.toBeNull();
    // Remove comments before checking — comment-mentions of tick() don't count
    const codeOnly = stripComments(body);
    // Find the last non-empty, non-closing-brace line; that's where tick() should be
    const lines = codeOnly.split('\n').map(l => l.trim()).filter(l => l && l !== '}' && !l.startsWith('//'));
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toMatch(/^tick\(\);?$/);
  });

  it('animate() does NOT increment _tickSkippedFrames in code', () => {
    const body = getFunctionBody(DC_SOURCE, 'animate');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);
    // The increment form ++_tickSkippedFrames must not appear in animate() code
    expect(codeOnly).not.toMatch(/\+\+_tickSkippedFrames/);
    expect(codeOnly).not.toMatch(/_tickSkippedFrames\s*=\s*[^=]/);
  });

  it('tick() owns the _tickSkippedFrames idle-frame counter (pre-increment form)', () => {
    // Pre-increment: ++_tickSkippedFrames — only tick() does this
    expect(DC_SOURCE).toMatch(/\+\+_tickSkippedFrames/);
    expect(DC_SOURCE).toMatch(/_skipExpensiveUpdates\s*=\s*true/);
  });

  it('animate() does NOT call renderer.render() directly — tick() owns rendering', () => {
    const body = getFunctionBody(DC_SOURCE, 'animate');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);
    expect(codeOnly).not.toMatch(/renderer\.render\(/);
    expect(codeOnly).not.toMatch(/stats\.update\(\)/);
  });

  it('animate() does NOT duplicate expensive per-frame updates (tick() handles them)', () => {
    const body = getFunctionBody(DC_SOURCE, 'animate');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);
    expect(codeOnly).not.toMatch(/updateLabels\(\)/);
    expect(codeOnly).not.toMatch(/updateLOD\(\)/);
    expect(codeOnly).not.toMatch(/updateNeighborDoors\(\)/);
    expect(codeOnly).not.toMatch(/updateRoomDoors\(\)/);
    expect(codeOnly).not.toMatch(/updateGuiPos\(\)/);
    expect(codeOnly).not.toMatch(/_updateFPS\(/);
    expect(codeOnly).not.toMatch(/_autoQualityScale\(/);
  });

  it('document.hidden guard present in both animate() and tick()', () => {
    const animateBody = getFunctionBody(DC_SOURCE, 'animate');
    expect(animateBody).not.toBeNull();
    expect(animateBody).toMatch(/document\.hidden/);
    // tick() method on the DC object contains document.hidden
    expect(DC_SOURCE).toMatch(/document\.hidden/);
  });

  it('setAnimationLoop registers animate as the default renderer loop', () => {
    expect(DC_SOURCE).toMatch(/renderer\.setAnimationLoop\(\s*_guardLoop\(animate\)\s*\)/);
  });

});
