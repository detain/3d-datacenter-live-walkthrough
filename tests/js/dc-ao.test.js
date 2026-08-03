/**
 * tests/js/dc-ao.test.js — Step 7.3 ambient occlusion (GTAOPass on WebGL path)
 *
 * Verifies:
 * (a) GTAOPass, RenderPass, OutputPass are available in three.js 0.185.1
 * (b) dc-caps.js correctly sets supportsEffectComposer for WebGLRenderer
 * (c) dc.js options object contains ambientOcclusion
 * (d) dc.js source contains _setupWebglPostFX function definition
 *     (only expected when GTAOPass is available)
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { describeRenderer } from '../../public_html/js/dc-caps.js';
import * as path from 'path';
import * as fs from 'fs';

const DC_JS      = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_CAPS_JS = path.resolve(__dirname, '../../public_html/js/dc-caps.js');
const GTAO_PASS = path.resolve(__dirname, '../../node_modules/three/examples/jsm/postprocessing/GTAOPass.js');
const RENDER_PASS = path.resolve(__dirname, '../../node_modules/three/examples/jsm/postprocessing/RenderPass.js');
const OUTPUT_PASS = path.resolve(__dirname, '../../node_modules/three/examples/jsm/postprocessing/OutputPass.js');

const DC_JS_SOURCE     = fs.readFileSync(DC_JS,      'utf8');
const DC_CAPS_SOURCE   = fs.readFileSync(DC_CAPS_JS, 'utf8');

const GTAO_AVAILABLE = fs.existsSync(GTAO_PASS)
    && fs.existsSync(RENDER_PASS)
    && fs.existsSync(OUTPUT_PASS);

// ---------------------------------------------------------------------------
// Mock WebGL renderer for caps test
// ---------------------------------------------------------------------------

// Shapes taken from what three.js actually sets — see tests/js/dc-caps.test.js for the
// node_modules/three references. A classic WebGLRenderer has no .backend; the node renderer
// (WebGPURenderer) always does.
function mockWebGLRenderer() {
    return { isWebGLRenderer: true, shadowMap: {} };
}

function mockNodeRenderer() {
    return { isWebGPURenderer: true, backend: { isWebGPUBackend: true }, shadowMap: {} };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dc-ao.test.js — Step 7.3 ambient occlusion on WebGL path', () => {

    describe('GTAOPass availability', () => {

        it('(a) GTAOPass, RenderPass, and OutputPass are present in three.js postprocessing', () => {
            expect(fs.existsSync(GTAO_PASS)).toBe(true);
            expect(fs.existsSync(RENDER_PASS)).toBe(true);
            expect(fs.existsSync(OUTPUT_PASS)).toBe(true);
        });

    });

    describe('dc-caps.js — supportsEffectComposer for WebGLRenderer', () => {

        it('(b) supportsEffectComposer is exported in dc-caps.js source', () => {
            expect(DC_CAPS_SOURCE).toMatch(/supportsEffectComposer/);
        });

        it('supportsEffectComposer returns true for WebGLRenderer', () => {
            const mockRenderer = mockWebGLRenderer();
            const caps = describeRenderer(mockRenderer);
            expect(caps.supportsEffectComposer).toBe(true);
        });

        it('supportsEffectComposer returns false for the node renderer', () => {
            // R2.4: this used to assert `false` for a made-up 'UnknownRenderer', which tested a
            // constructor-name allowlist rather than a capability. The property that actually
            // matters is this one: EffectComposer is the classic GLSL chain and does nothing on
            // the node renderer, so the AO toggle must not be offered there.
            expect(describeRenderer(mockNodeRenderer()).supportsEffectComposer).toBe(false);
        });

        it('describeRenderer(null) returns a safe descriptor instead of throwing', () => {
            expect(() => describeRenderer(null)).not.toThrow();
            expect(describeRenderer(null).supportsEffectComposer).toBe(false);
        });

    });

    describe('dc.js — ambientOcclusion option', () => {

        it('(c) options object contains ambientOcclusion property in source', () => {
            // Match: ambientOcclusion: false (with optional whitespace/comments between)
            expect(DC_JS_SOURCE).toMatch(/ambientOcclusion\s*:\s*false/);
        });

    });

    describe('dc.js — _setupWebglPostFX function', () => {

        // Step 7.3 spec: only expected when GTAOPass is available
        if (GTAO_AVAILABLE) {
            it('(d) _setupWebglPostFX function is defined in dc.js source', () => {
                expect(DC_JS_SOURCE).toMatch(/async\s+function\s+_setupWebglPostFX\s*\(/);
            });

            it('(d) _setupWebglPostFX imports GTAOPass from three/addons/postprocessing', () => {
                expect(DC_JS_SOURCE).toMatch(/await\s+import\s*\(\s*['"]three\/addons\/postprocessing\/GTAOPass\.js['"]\s*\)/);
            });

            it('(d) _setupWebglPostFX imports RenderPass and OutputPass', () => {
                // These imports use dynamic import() (not ES `from` syntax), so match await import(...)
                expect(DC_JS_SOURCE).toMatch(/await\s+import\s*\(\s*['"]three\/addons\/postprocessing\/RenderPass\.js['"]\s*\)/);
                expect(DC_JS_SOURCE).toMatch(/await\s+import\s*\(\s*['"]three\/addons\/postprocessing\/OutputPass\.js['"]\s*\)/);
            });

            it('(d) dc.js calls _setupWebglPostFX in init() for the WebGL path', () => {
                expect(DC_JS_SOURCE).toMatch(/_setupWebglPostFX\(\)/);
            });

            it('(d) the composer is what draws the frame when AO is on', () => {
                // R3.11/R3.7: this used to grep for `options.ambientOcclusion && _composer`,
                // pinning the exact text of a render branch that has since been collapsed into
                // drawFrame(). The behaviour it was reaching for is exercised properly in
                // tests/js/dc-ao-webgpu.test.js ("drawFrame() — what actually paints the frame"),
                // which runs the real function, and in tests/playwright/dc.spec.ts Group 13,
                // which compares the rendered pixels. What is left here is the one-line contract
                // that the composer is reachable from the draw path at all.
                const code = DC_JS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
                expect(code).toMatch(/_composer\.render\(\)/);
                expect(code).toMatch(/function drawFrame\(\)/);
            });

            it('(d) _composer and _aoPass are declared as module variables', () => {
                expect(DC_JS_SOURCE).toMatch(/_composer\s*=\s*null/);
                expect(DC_JS_SOURCE).toMatch(/_aoPass\s*=\s*null/);
            });
        } else {
            it('(d) SKIPPED — GTAOPass not available in this three.js installation', () => {
                expect(true).toBe(true);
            });
        }

    });

});
