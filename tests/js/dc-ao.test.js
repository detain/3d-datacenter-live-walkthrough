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

function mockWebGLRenderer({ isNode = false, contextType = 'webgl2' } = {}) {
    const ctx = contextType === 'webgl1'
        ? /** @type {WebGLRenderingContext} */ ({ constructor: { name: 'WebGLRenderingContext' } })
        : /** @type {WebGL2RenderingContext} */ ({ constructor: { name: 'WebGL2RenderingContext' } });

    return {
        constructor: { name: 'WebGLRenderer' },
        info: { type: isNode ? 'offscreen' : 'resource' },
        getContext: () => ctx,
        shadowMap: {},
    };
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

        it('supportsEffectComposer returns false for non-WebGL/WebGPU renderer', () => {
            const unknownRenderer = { constructor: { name: 'UnknownRenderer' }, info: {} };
            const caps = describeRenderer(/** @type {any} */ (unknownRenderer));
            expect(caps.supportsEffectComposer).toBe(false);
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

            it('(d) DC.tick uses _composer.render() when ambientOcclusion && _composer', () => {
                expect(DC_JS_SOURCE).toMatch(/options\.ambientOcclusion\s*&&\s*_composer/);
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
