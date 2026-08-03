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
    // KNOWN DEFECT — see dc_remediation_plan.md step R3.7. `ao` is hardcoded false with a
    // comment claiming AO is "not yet implemented", but Step 7.3 implemented it on the WebGL
    // path: when options.ambientOcclusion is on, _composer renders with GTAOPass and every
    // bench result still reports ao:false. The field that exists to make runs comparable
    // actively lies. When R3.7 lands this must become a behavioural assertion:
    //     expect(bench().ao).toBe(true)   with AO enabled and a composer present
    // Asserting the wrong value here is deliberate — deleting the assertion would lose the
    // only signal that the field exists at all.
    expect(body).toMatch(/\bao\s*:\s*false/);
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

  // R3.3: these three used to assert bench()'s `window.DC.noteUserInput ? … : reset the counters`
  // dance and the frame counter behind it. noteUserInput() is now a module-scope function that
  // bench() calls directly — there is no counter to fall back to, and no reason to reach through
  // window for a function in the same module. The behavioural coverage lives in
  // tests/js/dc-idle-skip.test.js, which runs it against an injected clock.

  it('bench calls noteUserInput() directly, with no window round-trip or counter fallback', () => {
    const body = getObjectMethodBody(DC_SOURCE, 'bench');
    expect(body).not.toBeNull();
    const codeOnly = stripComments(body);
    expect(codeOnly).toMatch(/noteUserInput\(\)/);
    expect(codeOnly).not.toMatch(/window\.DC\.noteUserInput/);
    expect(codeOnly).not.toMatch(/_tickSkippedFrames/);
  });

  it('noteUserInput is exposed on window.DC', () => {
    // bench() is the in-module caller; the export is for the console and for tests.
    expect(stripComments(DC_SOURCE)).toMatch(/noteUserInput:\s*noteUserInput/);
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
