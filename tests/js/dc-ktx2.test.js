/**
 * tests/js/dc-ktx2.test.js — Step 8.2 KTX2 compressed texture support (rewritten by R3.11)
 *
 * WHAT WAS WRONG WITH THE OLD VERSION
 * All eight `it()` blocks were regexes over source text or over a markdown file. Four asserted
 * that four lines of `dc.js` still read the way they read on the day the test was written; four
 * asserted that `docs/dc_asset_pipeline.md` contained certain substrings.
 *
 * That combination has a specific blind spot, and it is the one that matters here: a regex derived
 * from a line of code cannot tell you the line is WRONG. `setTranscoderPath('/node_modules/…')`
 * matched a regex built from that exact string, so the test would have passed just as happily if
 * the path had pointed nowhere — and a wrong transcoder path is silent until the first KTX2
 * texture is loaded, which in CI never happens because `public_html/images/3d` is gitignored.
 * Meanwhile the doc-content tests passed against a document whose conversion section was
 * substantially fabricated (see R3.10) — matching `'gltf-transform'`, `'uastc'` and `'etc1s'` says
 * nothing about whether the commands around those words are real.
 *
 * WHAT THIS VERSION DOES
 *   1. Executes the real setup lines from dc.js against instrumented fakes, so registration and
 *      CALL ORDER are observed rather than pattern-matched.
 *   2. Resolves the transcoder path against the filesystem and asserts the Basis transcoder files
 *      are really there — the check the regex could not make.
 *   3. Asserts the ordering constraint the node renderer imposes (`detectSupport` after
 *      `await renderer.init()`), which is invisible to a grep because it is about sequence.
 *   4. Checks the documentation for the specific claims that were false, rather than for keywords
 *      that were present in a wrong document.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const DC_JS = path.join(REPO, 'public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

const DOCS_PIPELINE = path.join(REPO, 'docs/dc_asset_pipeline.md');
const DOCS = fs.readFileSync(DOCS_PIPELINE, 'utf8');

/**
 * The document with its self-referential prose removed.
 *
 * The rewrite note at the top of dc_asset_pipeline.md NAMES the fabrications it removed — "JPEG
 * BC", `--rdo-g`, "native GPU transcoding" — so a naive "this string must not appear" assertion
 * fires on the paragraph explaining that the string was deleted. Blockquotes and sentences that
 * refer to a previous version are documentation ABOUT the claims, not the claims themselves.
 */
const DOCS_CLAIMS = DOCS
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('>'))
  .filter((l) => !/previous version|was rewritten|used to (say|claim)/i.test(l))
  .join('\n');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
// Extract the KTX2 registration block from init() and run it.
// ---------------------------------------------------------------------------

/**
 * Slice the three consecutive `loaderGltf.ktx2Loader…` statements out of dc.js. Deliberately
 * anchored on the first assignment and ended at the detectSupport call, so inserting a fourth
 * step between them is picked up rather than skipped.
 */
function sliceKtx2Setup() {
  const code = stripComments(SRC);
  const start = code.indexOf('loaderGltf.ktx2Loader = new KTX2Loader()');
  if (start < 0) throw new Error('the KTX2Loader registration was not found in dc.js — was it removed?');
  const endMarker = 'detectSupport(renderer);';
  const end = code.indexOf(endMarker, start);
  if (end < 0) throw new Error('detectSupport(renderer) was not found after the KTX2Loader registration');
  return code.slice(start, end + endMarker.length);
}

const SETUP_SRC = sliceKtx2Setup();

/** Run the sliced setup with instrumented fakes and record what happened, in order. */
function runSetup() {
  const events = [];
  const loaderGltf = {};
  const renderer = { isWebGPURenderer: false, extensions: { has: () => false } };
  class KTX2Loader {
    constructor() { events.push(['construct']); }
    setTranscoderPath(p) { events.push(['setTranscoderPath', p]); return this; }
    detectSupport(r) { events.push(['detectSupport', r]); return this; }
  }
  // eslint-disable-next-line no-new-func
  new Function('loaderGltf', 'KTX2Loader', 'renderer', SETUP_SRC)(loaderGltf, KTX2Loader, renderer);
  return { events, loaderGltf, renderer };
}

/** Turn the transcoder path dc.js passes into a filesystem path under the repo. */
function transcoderDirOnDisk() {
  const m = SRC.match(/setTranscoderPath\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!m) throw new Error('setTranscoderPath() was not found in dc.js');
  const webPath = m[1];
  expect(webPath.startsWith('/'), 'the transcoder path must be absolute').toBe(true);
  return { webPath, dir: path.join(REPO, 'public_html', webPath) };
}

// ---------------------------------------------------------------------------
describe('KTX2Loader registration — executed, not grepped', () => {

  it('the setup block is found and is the three real statements', () => {
    // If this throws or shrinks, everything below is testing a fragment.
    expect(SETUP_SRC).toMatch(/new KTX2Loader\(\)/);
    expect(SETUP_SRC).toMatch(/setTranscoderPath\(/);
    expect(SETUP_SRC).toMatch(/detectSupport\(renderer\)/);
  });

  it('constructs a KTX2Loader and hangs it on loaderGltf', () => {
    const { events, loaderGltf } = runSetup();
    expect(events[0]).toEqual(['construct']);
    expect(loaderGltf.ktx2Loader).toBeTruthy();
  });

  it('sets the transcoder path BEFORE detecting support', () => {
    // Order is real: detectSupport() spawns the worker that fetches the transcoder, so a path set
    // afterwards is set too late. A source grep sees both lines and cannot see their order.
    const { events } = runSetup();
    const names = events.map((e) => e[0]);
    expect(names).toEqual(['construct', 'setTranscoderPath', 'detectSupport']);
  });

  it('passes the live renderer to detectSupport, not a copy or a string', () => {
    // detectSupport() reads renderer.isWebGPURenderer / renderer.extensions off the instance; a
    // stale or duplicated object would report the wrong compressed-format support.
    const { events, renderer } = runSetup();
    expect(events[2][1]).toBe(renderer);
  });

  it('KTX2Loader is imported from three/addons, not vendored', () => {
    // The one thing here that genuinely is a source contract: the import specifier has to resolve
    // through the page's import map. Kept as a text assertion, deliberately.
    expect(stripComments(SRC)).toMatch(
      /import\s*{\s*KTX2Loader\s*}\s*from\s*["']three\/addons\/loaders\/KTX2Loader\.js["']/);
  });

});

// ---------------------------------------------------------------------------
describe('KTX2 transcoder path — resolved against the filesystem', () => {

  // The check the old regex could not make. A wrong path is silent until a KTX2 texture is
  // loaded, and CI never loads one because public_html/images/3d is gitignored.

  it('the transcoder directory exists at the path the page will request', () => {
    const { webPath, dir } = transcoderDirOnDisk();
    expect(fs.existsSync(dir), `${webPath} resolves to ${dir}, which does not exist`).toBe(true);
  });

  it('both Basis transcoder files are present there', () => {
    // KTX2Loader fetches basis_transcoder.js and basis_transcoder.wasm from this directory.
    const { dir } = transcoderDirOnDisk();
    for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      expect(fs.existsSync(path.join(dir, f)), `${f} missing from the transcoder path`).toBe(true);
    }
  });

  it('the path resolves through public_html/lib, the symlink postinstall actually creates', () => {
    // This used to assert public_html/node_modules, and it passed only on machines where someone
    // had hand-made a SECOND symlink years ago. package.json's postinstall creates exactly one —
    // public_html/lib — so on a clean checkout /node_modules/… was a 404 and every compressed
    // texture silently failed to decode. CI proved it: the directory simply was not there.
    const link = path.join(REPO, 'public_html/lib');
    expect(fs.existsSync(link), 'public_html/lib is missing — postinstall did not run or failed').toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(REPO, 'node_modules')));
  });

  it('requests the transcoder from /lib/, the path the rest of the page uses', () => {
    // dc.html references /lib/ seventeen times; this was the one /node_modules/ URL in the whole
    // page. Keeping them consistent is what stops the next clean deploy losing textures again.
    const setup = stripComments(SRC);
    expect(setup).toMatch(/setTranscoderPath\(\s*['"]\/lib\//);
    expect(setup).not.toMatch(/setTranscoderPath\(\s*['"]\/node_modules\//);
  });

});

// ---------------------------------------------------------------------------
describe('KTX2 renderer-init ordering', () => {

  it('detectSupport runs after `await renderer.init()` on the node path', () => {
    // On the node renderer the feature list does not exist until the device has been acquired, so
    // calling detectSupport() first records "no compressed formats supported" and every KTX2
    // texture transcodes to uncompressed RGBA — the exact opposite of the point. This is a
    // SEQUENCE contract, so it is checked by position rather than by executing init().
    const code = stripComments(SRC);
    const initAt = code.indexOf('await renderer.init()');
    const detectAt = code.indexOf('ktx2Loader.detectSupport(renderer)');
    expect(initAt, '`await renderer.init()` not found in dc.js').toBeGreaterThan(-1);
    expect(detectAt, 'detectSupport(renderer) not found in dc.js').toBeGreaterThan(-1);
    expect(detectAt).toBeGreaterThan(initAt);
  });

});

// ---------------------------------------------------------------------------
describe('docs/dc_asset_pipeline.md — the claims that were false', () => {

  // The old doc tests matched 'gltf-transform', 'uastc' and 'etc1s' — all three of which appeared
  // in a document whose commands did not work. These check the specific fabrications R3.10 fixed,
  // so a future rewrite that reintroduces them fails here.

  it('does not claim WebGPU transcodes natively without WASM', () => {
    // KTX2Loader.js resolves basis_transcoder.wasm unconditionally, WebGPU included.
    // The exact shape of the old bullet: "**WebGPU**: Native GPU transcoding (no WASM needed)".
    // Matched as an ASSERTION, not as a phrase — the current document contains the words "native
    // GPU transcoding" inside the sentence denying that any browser API offers it, and a bare
    // substring test cannot tell a claim from its refutation.
    expect(DOCS_CLAIMS).not.toMatch(/no WASM needed/i);
    expect(DOCS_CLAIMS).not.toMatch(/WebGPU\s*\**\s*:\s*Native GPU transcoding/i);
    expect(DOCS_CLAIMS).toMatch(/(no|not) .{0,40}native GPU transcoding/i);
    expect(DOCS).toMatch(/WASM transcoder is used on every path/i);
  });

  it('the real loader really does resolve the WASM on every path', () => {
    // Pins the claim above to the library rather than to our prose.
    const loader = fs.readFileSync(
      path.join(REPO, 'node_modules/three/examples/jsm/loaders/KTX2Loader.js'), 'utf8');
    const wasmRef = loader.match(/^const WASM_BIN_URL = .*$/m);
    expect(wasmRef, 'KTX2Loader no longer declares WASM_BIN_URL — recheck the docs').not.toBeNull();
    expect(wasmRef[0]).toMatch(/basis_transcoder\.wasm/);
    // It is a module-level constant, not inside a WebGL-only branch.
    expect(loader.indexOf('const WASM_BIN_URL')).toBeLessThan(loader.indexOf('detectSupport('));
  });

  it('does not invent a "JPEG BC" texture format', () => {
    expect(DOCS_CLAIMS).not.toMatch(/JPEG BC/i);
  });

  it('does not tell readers ETC1S suits normal maps', () => {
    // Inverted: ETC1S quantises hardest, and a quantised normal reads as faceted lighting. UASTC
    // is the one for normal maps, which is what the tool's own rdo-lambda guidance says.
    expect(DOCS_CLAIMS).not.toMatch(/ETC1S[^.]*suitable for normal maps/i);
    expect(DOCS).toMatch(/UASTC[\s\S]{0,200}normal maps/i);
  });

  it('does not use flags the CLI does not have', () => {
    // --rdo-g and --split-threshold do not exist in @gltf-transform/cli. --rdo, --rdo-lambda,
    // --zstd and --quality do.
    expect(DOCS_CLAIMS).not.toMatch(/--rdo-g\b/);
    expect(DOCS_CLAIMS).not.toMatch(/--split-threshold\b/);
  });

  it('shows the conversion commands as glTF in, glTF out', () => {
    // `gltf-transform uastc in.glb out.ktx2` produces a glTF file with a misleading extension —
    // the command compresses the textures INSIDE the model, it does not emit loose .ktx2 files.
    const cmds = DOCS.match(/^gltf-transform (uastc|etc1s) .*$/gm) || [];
    expect(cmds.length, 'no gltf-transform uastc/etc1s command found in the docs').toBeGreaterThan(0);
    for (const c of cmds) {
      expect(c, `"${c}" writes a .ktx2 output — the command is glTF-in/glTF-out`).not.toMatch(/\.ktx2\b/);
      expect(c).toMatch(/\.glb\b[\s\S]*\.glb\b/);
    }
  });

  it('the self-reference filter strips prose without gutting the document', () => {
    // If DOCS_CLAIMS ever collapses to nothing, every "must not appear" assertion above passes
    // for free. It must still hold the conversion commands and the integration section.
    expect(DOCS_CLAIMS.length).toBeGreaterThan(DOCS.length * 0.7);
    expect(DOCS_CLAIMS).toMatch(/gltf-transform uastc/);
    expect(DOCS_CLAIMS).toMatch(/setTranscoderPath/);
    // And it must still be capable of catching a fabrication: the filter drops blockquotes and
    // "previous version" lines only, so a plain sentence containing one survives.
    expect(DOCS_CLAIMS.split('\n').some((l) => /--zstd/.test(l))).toBe(true);
  });

  it('still documents the transcoder path dc.js actually uses', () => {
    const { webPath } = transcoderDirOnDisk();
    expect(DOCS).toContain(webPath);
  });

  it('still records that public_html/images/3d is gitignored, and what that costs CI', () => {
    expect(DOCS).toMatch(/public_html\/images\/3d\/?\*{0,2}[\s\S]{0,80}gitignored/i);
    expect(DOCS).toMatch(/CI/);
  });

});
