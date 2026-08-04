/**
 * tests/js/dc-playable-labels.test.js — the two playable-label lists must not drift (R3.8)
 *
 * WHY THIS FILE EXISTS
 * The same set of animation labels is written down twice, in two languages, in two repositories'
 * worth of tooling:
 *
 *   - `PLAYABLE_LABELS` in public_html/js/dc-multi.js — what the viewer will request and play.
 *   - `VIEWER_PLAYABLE_LABELS` in scripts/mixamo_downloader/mixamo_downloader.py — what the
 *     downloader writes into public_html/images/3d/mixamo/manifest.json.
 *
 * Step 3.3 added the Python filter specifically so the manifest would stop listing thousands of
 * clips the viewer can never play (one character carried 3,346), and mandated a test pinning the
 * two lists together. The test was never written, and the failure mode it guards is silent in both
 * directions:
 *
 *   - a label in the Python but not the JS → the downloader fetches and ships GLBs nothing plays;
 *   - a label in the JS but not the Python → the viewer has a keybinding for a clip that is not in
 *     the manifest, so the gesture key does nothing and no error is raised anywhere.
 *
 * Neither shows up as a broken page. Both show up here.
 *
 * WHY THIS FILE IS SOURCE-TEXT MATCHING, DELIBERATELY
 * .claude/rules/js-tests.md says not to assert on source text where behaviour can be executed
 * instead. This is the exception the rule allows for: the subject IS a pair of literals in two
 * different languages, and the contract IS that the two texts agree. There is no behaviour to run —
 * the Python cannot be imported into vitest, and executing the JS constant would only prove it
 * equals itself. The extractors below throw rather than return empty when a list is renamed or
 * reshaped, so this cannot silently degrade into a test of nothing.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const JS_SRC = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const PY_SRC = path.resolve(__dirname, '../../scripts/mixamo_downloader/mixamo_downloader.py');

const JS = fs.readFileSync(JS_SRC, 'utf8');
// scripts/mixamo_downloader/ lives in the MyAdmin monorepo, not in this standalone repo (see README
// "Provenance"). When the downloader is absent, the assertions that compare the two languages are
// skipped rather than failing; the JS-only halves of both blocks always run.
const PY = fs.existsSync(PY_SRC) ? fs.readFileSync(PY_SRC, 'utf8') : null;
const HAS_PY = PY !== null;

// ---------------------------------------------------------------------------
// Extractors. Each throws on a shape it does not recognise — a rename must fail loudly rather
// than yield an empty set that trivially matches another empty set.
// ---------------------------------------------------------------------------

/** Pull the quoted strings out of a JS array literal, e.g. `const GESTURE_ORDER = [...]`. */
function jsArrayLiteral(name) {
  const m = JS.match(new RegExp(`const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`${name} not found in dc-multi.js — was it renamed or reshaped?`);
  const items = m[1].match(/['"]([^'"]+)['"]/g);
  if (!items || !items.length) throw new Error(`${name} is empty in dc-multi.js`);
  return items.map((s) => s.slice(1, -1));
}

/**
 * `PLAYABLE_LABELS = new Set(['idle', 'walk', 'run', 'jump', ...GESTURE_ORDER])` — resolve the
 * inline strings and expand any spread of another array literal in this file.
 */
function jsPlayableLabels() {
  const m = JS.match(/const PLAYABLE_LABELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('PLAYABLE_LABELS not found in dc-multi.js — was it renamed or reshaped?');
  const body = m[1];
  const out = (body.match(/['"]([^'"]+)['"]/g) || []).map((s) => s.slice(1, -1));
  for (const spread of body.match(/\.\.\.([A-Za-z_$][\w$]*)/g) || []) {
    out.push(...jsArrayLiteral(spread.slice(3)));
  }
  if (!out.length) throw new Error('PLAYABLE_LABELS resolved to nothing');
  return new Set(out);
}

/** `VIEWER_PLAYABLE_LABELS = { "idle", "walk", ... }` — a Python set literal of plain strings. */
function pyViewerLabels() {
  const m = PY.match(/^VIEWER_PLAYABLE_LABELS\s*=\s*\{([\s\S]*?)^\}/m);
  if (!m) throw new Error('VIEWER_PLAYABLE_LABELS not found in mixamo_downloader.py — renamed?');
  const items = m[1].match(/['"]([^'"]+)['"]/g);
  if (!items || !items.length) throw new Error('VIEWER_PLAYABLE_LABELS is empty');
  return new Set(items.map((s) => s.slice(1, -1)));
}

const sorted = (set) => [...set].sort();

// ---------------------------------------------------------------------------
describe('mixamo playable labels — the JS and Python lists agree', () => {

  it.skipIf(!HAS_PY)('both lists are found and non-trivially sized', () => {
    // The guard against this whole file passing because two extractors both returned nothing.
    expect(jsPlayableLabels().size).toBeGreaterThan(10);
    expect(pyViewerLabels().size).toBeGreaterThan(10);
  });

  it.skipIf(!HAS_PY)('the sets are identical', () => {
    expect(sorted(jsPlayableLabels())).toEqual(sorted(pyViewerLabels()));
  });

  it.skipIf(!HAS_PY)('nothing is downloaded that the viewer cannot play', () => {
    // Direction 1: Python ⊄ JS means shipped GLBs no code path ever requests.
    const js = jsPlayableLabels();
    const extra = sorted(pyViewerLabels()).filter((l) => !js.has(l));
    expect(extra, `downloader ships labels the viewer never plays: ${extra.join(', ')}`).toEqual([]);
  });

  it.skipIf(!HAS_PY)('nothing the viewer plays is missing from the manifest filter', () => {
    // Direction 2: JS ⊄ Python means a gesture key bound to a clip that was never downloaded.
    // This one is the quieter failure — the key simply does nothing.
    const py = pyViewerLabels();
    const missing = sorted(jsPlayableLabels()).filter((l) => !py.has(l));
    expect(missing, `viewer plays labels the downloader filters out: ${missing.join(', ')}`).toEqual([]);
  });

  it('every gesture in GESTURE_ORDER is playable, and every gesture has a display name', () => {
    // GESTURE_ORDER drives the key bindings; GESTURE_NAMES drives the HUD text. A gesture in the
    // first without an entry in the second shows up as "undefined" on screen.
    const order = jsArrayLiteral('GESTURE_ORDER');
    const playable = jsPlayableLabels();
    for (const g of order) expect(playable.has(g), `${g} is bound but not playable`).toBe(true);
    const namesBlock = JS.match(/const GESTURE_NAMES\s*=\s*\{([\s\S]*?)\};/);
    expect(namesBlock, 'GESTURE_NAMES not found in dc-multi.js').not.toBeNull();
    for (const g of order) {
      expect(new RegExp(`(^|[{,\\s])${g}\\s*:`).test(namesBlock[1]), `${g} has no display name`).toBe(true);
    }
  });

  it('the locomotion labels chooseAnimation() selects between are all playable', () => {
    // These four are not gestures and are not in GESTURE_ORDER, so nothing else covers them.
    const playable = jsPlayableLabels();
    for (const l of ['idle', 'walk', 'run', 'jump']) expect(playable.has(l), l).toBe(true);
  });

  it.skipIf(!HAS_PY)('the downloader filters the manifest against this exact set', () => {
    // A list that agrees with the viewer but is never applied would pass every test above while
    // the manifest still carried thousands of unplayable clips — which is the state Step 3.3
    // existed to fix.
    expect(PY).toMatch(/label["']?\s*\)?\s*in VIEWER_PLAYABLE_LABELS/);
  });

  it.skipIf(!HAS_PY)('records the two labels the Mixamo DB carries that neither list wants', () => {
    // scripts/mixamo_downloader/database/mixamo.db has `look` (2 rows) and `type` (2 rows). They
    // are on nobody's list, which is a decision rather than an oversight: they exist for only 2 of
    // 114 characters, so binding a key to them would do nothing for 98% of the roster. Pinned here
    // so that adding either one becomes a conscious edit to this test rather than a silent one.
    const both = new Set([...jsPlayableLabels(), ...pyViewerLabels()]);
    expect(both.has('look')).toBe(false);
    expect(both.has('type')).toBe(false);
  });

});

// ---------------------------------------------------------------------------
describe('mixamo playable labels — the extractors fail loudly', () => {

  // Non-vacuity. Every assertion above rests on these three functions returning real data; if a
  // rename made them return an empty set the suite would go green on nothing at all.

  it('jsArrayLiteral throws on an unknown name', () => {
    expect(() => jsArrayLiteral('NOT_A_REAL_CONSTANT')).toThrow(/not found/);
  });

  it('the JS extractor resolves the spread, not just the inline strings', () => {
    // PLAYABLE_LABELS spells out four labels and spreads GESTURE_ORDER for the rest. An extractor
    // that only read the quoted strings would return 4 and silently disagree with the Python.
    const labels = jsPlayableLabels();
    expect(labels.size).toBeGreaterThan(4);
    for (const g of jsArrayLiteral('GESTURE_ORDER')) expect(labels.has(g), g).toBe(true);
  });

  it.skipIf(!HAS_PY)('the Python extractor reads a set literal, not the comment above it', () => {
    const py = pyViewerLabels();
    expect(py.has('idle')).toBe(true);
    expect(py.has('mirrors')).toBe(false);   // a word from the comment line directly above it
  });

});
