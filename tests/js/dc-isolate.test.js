/**
 * tests/js/dc-isolate.test.js — Step 9.5 isolate render pass
 *
 * Verifies:
 * (a) setIsolate(keepSet) function exists
 * (b) clearIsolate() function exists
 * (c) Isolated objects are dimmed (material opacity changed to 0.3)
 * (d) Clear restores opacity
 * (e) Escape key handling calls clearIsolate
 * (f) clearScene calls clearIsolate
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc.js isolate render pass — Step 9.5', () => {

    describe('setIsolate function', () => {

        it('(a) setIsolate function exists', () => {
            expect(snippetExists('function setIsolate(keepSet)')).toBe(true);
        });

        it('setIsolate is exported on window.DC', () => {
            expect(DC_SOURCE).toMatch(/setIsolate:\s*setIsolate/);
        });

        it('dims non-isolated meshes by setting opacity to 0.3', () => {
            // The function should set opacity = 0.3 for meshes NOT in keepSet
            expect(DC_SOURCE).toMatch(/m\.opacity\s*=\s*0\.3/);
        });

        it('preserves original opacity in _isolateOriginalOpacities Map', () => {
            expect(DC_SOURCE).toMatch(/_isolateOriginalOpacities\.set\(/);
        });

        it('restores opacity for meshes IN the keepSet', () => {
            // Isolated meshes should get their original opacity restored
            expect(DC_SOURCE).toMatch(/_isolateOriginalOpacities\.get\(obj\.id\)/);
        });
    });

    describe('clearIsolate function', () => {

        it('(b) clearIsolate function exists', () => {
            expect(snippetExists('function clearIsolate()')).toBe(true);
        });

        it('clearIsolate is exported on window.DC', () => {
            expect(DC_SOURCE).toMatch(/clearIsolate:\s*clearIsolate/);
        });

        it('(d) restores opacity from _isolateOriginalOpacities', () => {
            expect(DC_SOURCE).toMatch(/_isolateOriginalOpacities\.get\(obj\.id\)/);
        });

        it('clears the _isolateOriginalOpacities Map', () => {
            expect(DC_SOURCE).toMatch(/_isolateOriginalOpacities\.clear\(\)/);
        });
    });

    describe('isolate state management', () => {

        it('_isolateOriginalOpacities Map declared at module scope', () => {
            expect(DC_SOURCE).toMatch(/^const _isolateOriginalOpacities\s*=\s*new Map\(\)/m);
        });

        it('only processes transparent materials', () => {
            expect(DC_SOURCE).toMatch(/if \(!m\.transparent\) continue/);
        });

        it('skips meshes without an id', () => {
            expect(DC_SOURCE).toMatch(/if \(obj\.id\s*===\s*undefined\) return/);
        });
    });

    describe('Escape key integration', () => {

        it('(e) Escape key case in onKeyDown calls clearIsolate', () => {
            expect(DC_SOURCE).toMatch(/case\s+"Escape":/);
            expect(DC_SOURCE).toMatch(/clearIsolate\(\);/);
        });
    });

    describe('clearScene integration', () => {

        it('(f) clearScene calls clearIsolate', () => {
            // Find the clearScene function and verify clearIsolate is called inside it
            const clearSceneRe = /^function clearScene\(\)[\s\S]*?^(?:function |\nconst |\nlet |\n$)/m;
            const match = DC_SOURCE.match(clearSceneRe);
            expect(match).not.toBeNull();
            expect(match[0]).toMatch(/clearIsolate\(\)/);
        });
    });
});
