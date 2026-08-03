/**
 * tests/js/dc-ao-webgpu.test.js — Step 7.4 WebGPU ambient occlusion via TSL
 *
 * Verifies:
 * (a) _postProcessing module variable is declared in dc.js
 * (b) _setupWebgpuPostFX() async function exists in dc.js
 * (c) The 3-way branch pattern exists in tick() checking:
 *     - caps.supportsEffectComposer
 *     - caps.supportsTSL && _postProcessing
 *     - else: plain renderer.render()
 * (d) The WebGPU TSL path (_setupWebgpuPostFX) is called only when caps.backend === 'WebGPURenderer'
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { describeRenderer } from '../../public_html/js/dc-caps.js';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip single-line and multi-line comments so embedded identifiers don't cause false positives. */
function stripComments(src) {
    return src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extract a top-level function body (column-0 function declaration) via brace-depth walk. Handles async functions. */
function getFunctionBody(source, fnName) {
    const lines = source.split('\n');
    // Match both regular and async function declarations at column 0
    const startRe = new RegExp(`^(?:async\\s+)?function\\s+${fnName}\\s*\\(\\)\\s*\\{`);
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

/** Extract a method body from the DC.tick anonymous function (window.DC = { tick: function () { ... } }) */
function getTickBody(source) {
    // Find window.DC = { ... tick: function () { ... } }
    const tickFnStart = source.indexOf('tick: function ()');
    if (tickFnStart < 0) return null;
    // Find the opening brace of tick's function
    let braceStart = -1;
    for (let i = tickFnStart; i < source.length; i++) {
        if (source[i] === '{') { braceStart = i; break; }
    }
    if (braceStart < 0) return null;
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(braceStart, i + 1);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Tests — Step 7.4 WebGPU AO via TSL
// ---------------------------------------------------------------------------
describe('dc.js — Step 7.4 WebGPU ambient occlusion via TSL', () => {

    describe('module-level variables', () => {

        it('(a) _postProcessing module variable is declared', () => {
            // _postProcessing should be declared at module scope, initialized to null
            expect(DC_SOURCE).toMatch(/_postProcessing\s*=\s*null/);
        });

    });

    describe('async setup function', () => {

        it('(b) _setupWebgpuPostFX() async function exists in dc.js', () => {
            const body = getFunctionBody(DC_SOURCE, '_setupWebgpuPostFX');
            expect(body).not.toBeNull();
        });

        it('_setupWebgpuPostFX() dynamically imports GTAONode from three/addons/tsl/display/GTAONode.js', () => {
            const body = getFunctionBody(DC_SOURCE, '_setupWebgpuPostFX');
            expect(body).not.toBeNull();
            expect(body).toMatch(/three\/addons\/tsl\/display\/GTAONode\.js/);
        });

        it('_setupWebgpuPostFX() sets _postProcessing to null on error (graceful fallback)', () => {
            const body = getFunctionBody(DC_SOURCE, '_setupWebgpuPostFX');
            expect(body).not.toBeNull();
            expect(body).toMatch(/_postProcessing\s*=\s*null/);
        });

    });

    describe('init() calls _setupWebgpuPostFX only for WebGPURenderer backend', () => {

        it('(d) _setupWebgpuPostFX() is called only under caps.supportsTSL', () => {
            // R2.4: the gate used to be `caps.backend === 'WebGPURenderer'`. describeRenderer()
            // never returns a class name — backend is 'webgl' | 'webgpu' | 'webgl2-fallback' —
            // so that comparison was false in every mode, and it would ALSO have excluded
            // ?renderer=webgpu-gl, which compiles TSL through the WebGL2 backend.
            const code = stripComments(DC_SOURCE);
            expect(code).not.toMatch(/caps\.backend\s*===\s*['"]WebGPURenderer['"]/);
            const gate = code.match(/if\s*\(\s*caps\.supportsTSL\s*\)\s*\{([\s\S]{0,200}?)\n\s*\}/);
            expect(gate, 'no `if (caps.supportsTSL) { … }` block found in dc.js').not.toBeNull();
            expect(gate[1]).toMatch(/_setupWebgpuPostFX\s*\(\s*\)/);
        });

        it('the WebGL composer setup is gated on supportsEffectComposer, which excludes the node path', () => {
            // supportsEffectComposer is !isNode and supportsTSL is isNode, so the two setup calls
            // are mutually exclusive by construction — no backend-string test is needed, and
            // adding one back is how they start overlapping again.
            const code = stripComments(DC_SOURCE);
            // There is more than one supportsEffectComposer gate (the GUI's AO toggle is the
            // other), so match them all and require that one of them wraps the setup call.
            const gates = [...code.matchAll(/if\s*\(\s*caps\.supportsEffectComposer\s*\)\s*\{([\s\S]{0,200}?)\n\s*\}/g)];
            expect(gates.length, 'no `if (caps.supportsEffectComposer) { … }` block found in dc.js').toBeGreaterThan(0);
            expect(gates.some((g) => /_setupWebglPostFX\s*\(\s*\)/.test(g[1]))).toBe(true);
            // And the setup call must exist nowhere else — an ungated one would run on the node
            // renderer, where EffectComposer does nothing.
            // (?<!function\s) so the declaration itself is not counted as a call site.
            const calls = code.match(/(?<!function\s)_setupWebglPostFX\s*\(\s*\)/g) || [];
            expect(calls.length).toBe(1);
        });

    });

    // -----------------------------------------------------------------------
    // R3.11 / R3.7: this block used to pin the 3-way render branch by regex —
    //
    //     if (options.ambientOcclusion && _composer) { _composer.render(); }
    //     else if (caps.supportsTSL && _postProcessing) { renderer.render(scene, camera); }
    //     else { renderer.render(scene, camera); }
    //
    // Four tests asserted that shape stayed exactly so. The second branch was BYTE-IDENTICAL to
    // the third: the "WebGPU TSL path" rendered a plain frame, and a test that matched the text
    // could not tell that. It was also unreachable, because supportsTSL was false everywhere at
    // the time. The tests passed for four years' worth of nothing happening.
    //
    // R3.7 replaced the branch with a single drawFrame(), which both the normal and the idle-skip
    // paths call, and gave the pipelines a real implementation. These run drawFrame() and
    // aoActive() and observe what gets drawn.
    // -----------------------------------------------------------------------
    describe('drawFrame() — what actually paints the frame', () => {

        /** Compile the real drawFrame() + aoActive() over injected pipeline state. */
        function compile({ ao = false, composer = false, postFX = false } = {}) {
            const drew = [];
            const options = { ambientOcclusion: ao };
            const renderer = { render: (sc, cam) => drew.push(['plain', sc, cam]) };
            const _composer = composer ? { render: () => drew.push(['composer']) } : null;
            const _postProcessing = postFX ? { post: { render: () => drew.push(['node']) } } : null;
            const src = [
                getFunctionBody(DC_SOURCE, 'aoActive'),
                getFunctionBody(DC_SOURCE, 'drawFrame'),
                'return { drawFrame, aoActive };',
            ].join('\n');
            // eslint-disable-next-line no-new-func
            const api = new Function('options', 'renderer', 'scene', 'camera', '_composer', '_postProcessing', src)(
                options, renderer, 'SCENE', 'CAMERA', _composer, _postProcessing);
            return { ...api, drew, options };
        }

        it('both functions are present in dc.js', () => {
            // If either is renamed the harness silently compiles nothing useful.
            expect(getFunctionBody(DC_SOURCE, 'drawFrame')).not.toBeNull();
            expect(getFunctionBody(DC_SOURCE, 'aoActive')).not.toBeNull();
        });

        it('draws plainly when ambient occlusion is off, whatever pipelines exist', () => {
            const h = compile({ ao: false, composer: true, postFX: true });
            h.drawFrame();
            expect(h.drew).toEqual([['plain', 'SCENE', 'CAMERA']]);
        });

        it('renders through the EffectComposer on the classic path', () => {
            const h = compile({ ao: true, composer: true });
            h.drawFrame();
            expect(h.drew).toEqual([['composer']]);
        });

        it('renders through the node pipeline when there is no composer', () => {
            // The branch that was byte-identical to the fallback. It now draws something else.
            const h = compile({ ao: true, postFX: true });
            h.drawFrame();
            expect(h.drew).toEqual([['node']]);
        });

        it('falls back to a plain render when AO is asked for but nothing built', () => {
            // Both setups are async and either can fail to a null — the toggle must not break
            // rendering when it does.
            const h = compile({ ao: true });
            h.drawFrame();
            expect(h.drew).toEqual([['plain', 'SCENE', 'CAMERA']]);
        });

        it('draws exactly once per call on every path', () => {
            for (const opts of [{ ao: false }, { ao: true, composer: true },
                { ao: true, postFX: true }, { ao: true }]) {
                const h = compile(opts);
                h.drawFrame();
                expect(h.drew.length, JSON.stringify(opts)).toBe(1);
            }
        });

        it('aoActive() agrees with what drawFrame() does', () => {
            // bench() and DC.postFX() both report aoActive(). If it disagreed with the renderer,
            // a benchmark could claim AO was on for a frame drawn without it — which is exactly
            // what bench()'s hardcoded `ao: false` did before R3.7.
            for (const opts of [{ ao: false, composer: true }, { ao: true, composer: true },
                { ao: true, postFX: true }, { ao: true }, { ao: false }]) {
                const h = compile(opts);
                h.drawFrame();
                const drewPlain = h.drew[0][0] === 'plain';
                expect(h.aoActive(), JSON.stringify(opts)).toBe(!drewPlain);
            }
        });

        it('tick() delegates to drawFrame() on BOTH the normal and the idle-skip paths', () => {
            // The idle branch used to know about the WebGL composer and not the node pipeline, so
            // AO switched itself off after five idle minutes on the WebGPU path only. A single
            // call site is what stops the two drifting again — this is a structural contract, so
            // it is checked structurally, on purpose.
            const tick = stripComments(getTickBody(DC_SOURCE));
            expect((tick.match(/drawFrame\(\)/g) || []).length).toBe(2);
            expect(tick).not.toMatch(/_composer\.render\(/);
            expect(tick).not.toMatch(/renderer\.render\(/);
        });

    });

    describe('dc-caps.js integration', () => {

        it('caps.supportsTSL is true for the node renderer and false for classic WebGL', () => {
            // R2.4 (was a KNOWN DEFECT): this asserted supportsTSL derived from `renderer._tslm`,
            // a property that exists nowhere in three.js — so supportsTSL was permanently false
            // and the WebGPU AO branch below was unreachable no matter what dc.js did. It now
            // calls the real module against renderer shapes three.js actually ships.
            expect(describeRenderer({ isWebGLRenderer: true }).supportsTSL).toBe(false);
            expect(describeRenderer({ isWebGPURenderer: true, backend: { isWebGPUBackend: true } }).supportsTSL).toBe(true);
            // Both node backends compile TSL — the WebGL2 fallback lowers the same node graph to
            // GLSL — so ?renderer=webgpu-gl must reach this path too.
            expect(describeRenderer({ isWebGPURenderer: true, backend: {} }).supportsTSL).toBe(true);
        });

    });

});
