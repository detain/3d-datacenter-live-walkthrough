/**
 * Unit tests for DC.bench() in public_html/js/dc.js
 *
 * Verifies:
 * - bench result has ao, shadows, shadowMapSize, pixelScale, triangles fields
 * - The idle mechanism uses noteUserInput() (not a raw frame counter)
 * - Warning is logged when FPS ring buffer never fills
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
 * Extract a method body from an object literal property OR a standalone function declaration.
 * Handles both:
 *   - Object property:  bench: async function (seconds = 10) { ... },
 *   - Standalone function:  async function bench(seconds = 10) { ... }
 * Returns the full method text between the opening { and closing }.
 */
function getObjectMethodBody(source, propName) {
  // Try object property pattern first:  propName: async function (args) {
  let startRe = new RegExp(`${propName}\\s*:\\s*(async\\s+)?function\\s*\\([^)]*\\)\\s*\\{`);
  let lines = source.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx < 0) {
    // Try standalone function pattern:  async function propName(args) {
    startRe = new RegExp(`(async\\s+)?function\\s+${propName}\\s*\\([^)]*\\)\\s*\\{`);
    for (let i = 0; i < lines.length; i++) {
      if (startRe.test(lines[i])) { startIdx = i; break; }
    }
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
// Tests — bench result fields (Step 7.6)
// ----------------------------------------------------------------

describe('dc.js — DC.bench() result has all required fields', () => {

  it('bench return object includes ao, shadows, shadowMapSize, pixelScale, triangles', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();

    // The return statement must include all five new fields
    expect(body).toMatch(/\bao\s*:\s*false/);           // ao: false (not yet implemented)
    expect(body).toMatch(/\bshadows\s*:\s*S\.shadowsEnabled/);
    expect(body).toMatch(/\bshadowMapSize\s*:\s*_shadowMapSize/);
    expect(body).toMatch(/\bpixelScale\s*:\s*S\.pixelScale/);
    expect(body).toMatch(/\btriangles\s*:/);
  });

  it('bench result includes renderer state fields that enable cross-backend FPS comparison', () => {
    // These fields allow meaningful FPS comparison: two runs with different shadow or
    // pixelScale settings are not comparable, so they are recorded alongside the FPS.
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // All five renderer-state fields must be present in the return object
    expect(codeOnly).toMatch(/\bao\s*:/);
    expect(codeOnly).toMatch(/\bshadows\s*:/);
    expect(codeOnly).toMatch(/\bshadowMapSize\s*:/);
    expect(codeOnly).toMatch(/\bpixelScale\s*:/);
    expect(codeOnly).toMatch(/\btriangles\s*:/);
  });

});

// ----------------------------------------------------------------
// Tests — idle mechanism (Step 7.6)
// ----------------------------------------------------------------

describe('dc.js — DC.bench() idle mechanism uses noteUserInput()', () => {

  it('bench calls noteUserInput() to reset idle, not _tickSkippedFrames directly', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // The idle reset must go through noteUserInput() when available
    expect(codeOnly).toMatch(/if\s*\(\s*window\.DC\.noteUserInput\s*\)\s*window\.DC\.noteUserInput\(\)/);
  });

  it('bench falls back to direct reset only when noteUserInput is not available', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // The fallback pattern: if noteUserInput doesn't exist, set counters directly
    // Look for: else { _tickSkippedFrames = 0; _skipExpensiveUpdates = false; }
    expect(codeOnly).toMatch(/else\s*\{[^}]*_tickSkippedFrames\s*=\s*0[^}]*_skipExpensiveUpdates\s*=\s*false[^}]*\}/);
  });

  it('noteUserInput is exposed on window.DC and resets idle skip unconditionally', () => {
    const codeOnly = stripComments(DC_SOURCE);

    // noteUserInput must be defined in the window.DC object
    expect(codeOnly).toMatch(/noteUserInput\s*:\s*function\s*\(\)\s*\{/);

    // It must unconditionally reset _tickSkippedFrames and _skipExpensiveUpdates
    // (unlike setLodFocus which checks for position change first)
    expect(codeOnly).toMatch(/noteUserInput[\s\S]{0,300}_tickSkippedFrames\s*=\s*0/);
    expect(codeOnly).toMatch(/noteUserInput[\s\S]{0,300}_skipExpensiveUpdates\s*=\s*false/);
  });

  it('setLodFocus still uses the moved check (not unconditional reset)', () => {
    // setLodFocus should still use the F-17 fix: position-change check before reset
    const body = getObjectMethodBody(DC_SOURCE, 'setLodFocus');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // The moved check pattern must be present
    expect(codeOnly).toMatch(/const\s+moved\s*=/);
    expect(codeOnly).toMatch(/if\s*\(\s*moved\s*\)/);
  });

});

// ----------------------------------------------------------------
// Tests — FPS ring buffer warning (Step 7.6)
// ----------------------------------------------------------------

describe('dc.js — DC.bench() warns when FPS ring buffer never fills', () => {

  it('bench logs a console.warn when samples array is empty', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // Must check if samples.length is 0 and warn
    expect(codeOnly).toMatch(/if\s*\(\s*!samples\.length\s*\)/);
    expect(codeOnly).toMatch(/console\.warn\(/);
  });

  it('warning message mentions FPS ring buffer never filled', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);

    // The warning should reference the ring buffer not filling
    expect(codeOnly).toMatch(/FPS ring buffer never filled/);
  });

});
