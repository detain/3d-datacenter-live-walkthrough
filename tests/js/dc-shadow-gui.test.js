/**
 * tests/js/dc-shadow-gui.test.js — Step 6.2 shadow GUI controls
 *
 * Verifies:
 * (a) options.shadows = true exists in options object
 * (b) options.shadowQuality = 'Medium' exists in options object
 * (c) setShadowsEnabled(bool) function exists
 * (d) setShadowMapSize(quality) function exists
 * (e) GUI adds checkbox for options.shadows
 * (f) GUI adds dropdown for options.shadowQuality with Low/Medium/High
 * (g) window.DC.setShadowsEnabled is exposed
 * (h) window.DC.setShadowMapSize is exposed
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
describe('dc.js shadow GUI controls — Step 6.2', () => {

    describe('options object', () => {

        it('(a) options.shadows = true', () => {
            expect(snippetExists('shadows: true')).toBe(true);
        });

        it('(b) options.shadowQuality = \'Medium\'', () => {
            expect(snippetExists("shadowQuality: 'Medium'")).toBe(true);
        });
    });

    describe('setShadowsEnabled function', () => {

        it('(c) setShadowsEnabled(bool) function exists', () => {
            const fn = DC_SOURCE.match(/^function setShadowsEnabled\(/m);
            expect(fn).not.toBeNull();
        });

        it('sets renderer.shadowMap.enabled', () => {
            expect(snippetExists('renderer.shadowMap.enabled = bool')).toBe(true);
        });

        it('marks materials needsUpdate', () => {
            expect(snippetExists('m.needsUpdate = true')).toBe(true);
        });
    });

    describe('setShadowMapSize function', () => {

        it('(d) setShadowMapSize(quality) function exists', () => {
            const fn = DC_SOURCE.match(/^function setShadowMapSize\(/m);
            expect(fn).not.toBeNull();
        });

        it('maps Low/Medium/High to 512/1024/2048', () => {
            expect(snippetExists("'Low': 512")).toBe(true);
            expect(snippetExists("'Medium': 1024")).toBe(true);
            expect(snippetExists("'High': 2048")).toBe(true);
        });

        it('disposes old shadow map', () => {
            expect(snippetExists('_sunLight.shadow.map.dispose()')).toBe(true);
        });
    });

    describe('GUI controls', () => {

        it('(e) GUI adds checkbox for options.shadows', () => {
            expect(snippetExists("displayFolder.add(options, 'shadows')")).toBe(true);
        });

        it('(f) GUI adds dropdown for options.shadowQuality with Low/Medium/High', () => {
            expect(snippetExists("'shadowQuality', ['Low', 'Medium', 'High']")).toBe(true);
        });

        it('shadows checkbox calls setShadowsEnabled', () => {
            expect(snippetExists("setShadowsEnabled(v)")).toBe(true);
        });

        it('shadowQuality dropdown calls setShadowMapSize', () => {
            expect(snippetExists("setShadowMapSize(v)")).toBe(true);
        });
    });

    describe('window.DC exposure', () => {

        it('(g) window.DC.setShadowsEnabled is exposed', () => {
            expect(snippetExists('setShadowsEnabled: setShadowsEnabled')).toBe(true);
        });

        it('(h) window.DC.setShadowMapSize is exposed', () => {
            expect(snippetExists('setShadowMapSize: setShadowMapSize')).toBe(true);
        });
    });
});
