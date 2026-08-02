/**
 * tests/js/dc-shadow.test.js — Step 6.1 shadow rendering
 *
 * Verifies:
 * (a) renderer.shadowMap.enabled = true
 * (b) renderer.shadowMap.type = THREE.PCFSoftShadowMap
 * (c) _sunLight.castShadow = true
 * (d) _sunLight.shadow.bias and .normalBias are set
 * (e) scene.add(_sunLight.target) is called
 * (f) _fitShadowCamera() function exists and uses roomBounds
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
function snippetExists(pattern) {
    return DC_SOURCE.includes(pattern);
}

function extractBlock(fnName, blockName) {
    const re = new RegExp(
        `function ${fnName}\\([\\s\\S]*?//\\s*${blockName}[\\s\\S]*?^(?:\\nfunction |\\nconst |\\nlet |\\n$)`,
        'm'
    );
    const m = DC_SOURCE.match(re);
    if (!m) throw new Error(`Could not find "${blockName}" inside ${fnName}()`);
    return m[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc.js shadow rendering — Step 6.1', () => {

    describe('renderer shadow map', () => {

        it('(a) renderer.shadowMap.enabled = true', () => {
            expect(snippetExists('renderer.shadowMap.enabled = true')).toBe(true);
        });

        it('(b) renderer.shadowMap.type = THREE.PCFSoftShadowMap', () => {
            expect(snippetExists('renderer.shadowMap.type = THREE.PCFSoftShadowMap')).toBe(true);
        });
    });

    describe('sun directional light', () => {

        it('(c) _sunLight.castShadow = true', () => {
            expect(snippetExists('_sunLight.castShadow = true')).toBe(true);
        });

        it('(d) _sunLight.shadow.bias is set', () => {
            expect(snippetExists('_sunLight.shadow.bias')).toBe(true);
        });

        it('(d) _sunLight.shadow.normalBias is set', () => {
            expect(snippetExists('_sunLight.shadow.normalBias')).toBe(true);
        });

        it('_sunLight declared at module scope', () => {
            // let _sunLight = null;  // Phase 6: ...
            expect(DC_SOURCE).toMatch(/^let _sunLight\s*=/m);
        });
    });

    describe('shadow camera target in scene', () => {

        it('(e) scene.add(_sunLight.target) is called', () => {
            expect(snippetExists('scene.add(_sunLight.target)')).toBe(true);
        });
    });

    describe('_fitShadowCamera function', () => {

        it('_fitShadowCamera() function exists', () => {
            const fn = DC_SOURCE.match(/^function _fitShadowCamera\(/m);
            expect(fn).not.toBeNull();
        });

        it('(f) uses roomBounds to set shadow camera left/right/top/bottom', () => {
            const fn = DC_SOURCE.match(
                /^function _fitShadowCamera\([\s\S]*?^}/m
            );
            expect(fn).not.toBeNull();
            const src = fn[0];
            // Must reference roomBounds
            expect(src).toMatch(/roomBounds/);
            // Must set camera bounds
            expect(src).toMatch(/cam\.left/);
            expect(src).toMatch(/cam\.right/);
            expect(src).toMatch(/cam\.top/);
            expect(src).toMatch(/cam\.bottom/);
            // Must call updateProjectionMatrix
            expect(src).toMatch(/updateProjectionMatrix/);
        });
    });
});
