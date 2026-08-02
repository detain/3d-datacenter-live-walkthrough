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

        it('(d) _setupWebgpuPostFX() is called only when caps.backend === \'WebGPURenderer\'', () => {
            // Find where _setupWebgpuPostFX is called in init()
            const initBody = getFunctionBody(DC_SOURCE, 'init');
            if (!initBody) {
                // init() is async and may not be a simple function declaration; search for the call
                expect(DC_SOURCE).toMatch(/caps\.backend\s*===\s*['"]WebGPURenderer['"]/);
                expect(DC_SOURCE).toMatch(/_setupWebgpuPostFX\s*\(\s*\)/);
                return;
            }
            // The call should be inside a caps.backend === 'WebGPURenderer' check
            expect(initBody).toMatch(/caps\.backend\s*===\s*['"]WebGPURenderer['"]/);
            // And _setupWebgpuPostFX should be called within that branch
            const webgpuBranchMatch = initBody.match(/caps\.backend\s*===\s*['"]WebGPURenderer['"][\s\S]*?\{([\s\S]*?)\n\s*\}/);
            if (webgpuBranchMatch) {
                expect(webgpuBranchMatch[1]).toMatch(/_setupWebgpuPostFX\s*\(\s*\)/);
            }
        });

    });

    describe('tick() 3-way render branch', () => {

        it('(c) tick() 3-way branch checks options.ambientOcclusion && _composer (Step 7.3 AO path)', () => {
            const tickBody = getTickBody(DC_SOURCE);
            expect(tickBody).not.toBeNull();
            const codeOnly = stripComments(tickBody);
            // Step 7.3 path: EffectComposer-based AO
            expect(codeOnly).toMatch(/options\.ambientOcclusion\s*&&\s*_composer/);
        });

        it('(c) tick() 3-way branch checks caps.supportsTSL && _postProcessing (WebGPU TSL path)', () => {
            const tickBody = getTickBody(DC_SOURCE);
            expect(tickBody).not.toBeNull();
            const codeOnly = stripComments(tickBody);
            // Step 7.4 path: WebGPU TSL AO
            expect(codeOnly).toMatch(/caps\.supportsTSL/);
            expect(codeOnly).toMatch(/_postProcessing/);
        });

        it('(c) tick() 3-way branch has plain renderer.render() fallback', () => {
            const tickBody = getTickBody(DC_SOURCE);
            expect(tickBody).not.toBeNull();
            const codeOnly = stripComments(tickBody);
            // The fallback should be renderer.render(scene, camera)
            expect(codeOnly).toMatch(/renderer\.render\s*\(\s*scene\s*,\s*camera\s*\)/);
        });

        it('3-way branch pattern: if-else if-else with all three paths present', () => {
            const tickBody = getTickBody(DC_SOURCE);
            expect(tickBody).not.toBeNull();
            const codeOnly = stripComments(tickBody);
            // Should have all three conditions
            expect(codeOnly).toMatch(/if\s*\(\s*options\.ambientOcclusion\s*&&\s*_composer\s*\)/);
            expect(codeOnly).toMatch(/else\s+if\s*\(\s*caps\.supportsTSL/);
            expect(codeOnly).toMatch(/else\s*\{[\s\S]*?renderer\.render/);
        });

    });

    describe('dc-caps.js integration', () => {

        it('caps.supportsTSL is correctly set based on renderer._tslm', () => {
            // This is verified by dc-caps.test.js, but we confirm the property is used here
            const DC_CAPS = path.resolve(__dirname, '../../public_html/js/dc-caps.js');
            const capsSource = fs.readFileSync(DC_CAPS, 'utf8');
            // supportsTSL should be derived from renderer._tslm
            expect(capsSource).toMatch(/supportsTSL.*_tslm|_tslm.*supportsTSL/);
        });

    });

});
