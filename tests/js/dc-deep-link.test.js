/**
 * tests/js/dc-deep-link.test.js — Step 9.3: Deep links with ?location=, ?rack=, ?asset=
 *
 * Tests that dc.js supports deep linking via URL parameters:
 * - _readDeepLink() reads and parses location, rack, asset params
 * - URL params are coerced to numbers with Number()
 * - _applyDeepLinkTarget() applies the deep link after room build
 * - _copyDeepLink() copies current URL with appropriate params
 * - Copy link button appears in the info panel (showInfo)
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// _readDeepLink source analysis — verify URL param parsing and coercion
// ---------------------------------------------------------------------------
describe('dc.js — _readDeepLink URL parameter parsing', () => {

    it('_readDeepLink is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function _readDeepLink\(/m);
    });

    it('uses URLSearchParams to read location.search', () => {
        const src = extractFn('_readDeepLink');
        // Implementation uses try/catch to safely access location.search
        expect(src).toMatch(/new URLSearchParams\(search\)/);
        expect(src).toMatch(/try\s*\{\s*search\s*=\s*location\.search/);
    });

    it('reads location param with Number() coercion', () => {
        const src = extractFn('_readDeepLink');
        expect(src).toMatch(/params\.has\(['"]location['"]\)/);
        expect(src).toMatch(/Number\(params\.get\(['"]location['"]\)\)/);
    });

    it('reads rack param with Number() coercion', () => {
        const src = extractFn('_readDeepLink');
        expect(src).toMatch(/params\.has\(['"]rack['"]\)/);
        expect(src).toMatch(/Number\(params\.get\(['"]rack['"]\)\)/);
    });

    it('reads asset param with Number() coercion', () => {
        const src = extractFn('_readDeepLink');
        expect(src).toMatch(/params\.has\(['"]asset['"]\)/);
        expect(src).toMatch(/Number\(params\.get\(['"]asset['"]\)\)/);
    });

    it('returns null when param is not present (using nullish ?? or ||)', () => {
        const src = extractFn('_readDeepLink');
        // When param is absent, should return null (not 0, which could be a valid id)
        expect(src).toMatch(/\?\?\s*null|\|\|\s*null/);
    });

    it('returns an object with location, rack, asset properties', () => {
        const src = extractFn('_readDeepLink');
        expect(src).toMatch(/return\s*\{\s*[^}]*location\s*:/);
        expect(src).toMatch(/rack\s*:/);
        expect(src).toMatch(/asset\s*:/);
    });
});

// ---------------------------------------------------------------------------
// _applyDeepLinkTarget source analysis — verify deep link application
// ---------------------------------------------------------------------------
describe('dc.js — _applyDeepLinkTarget deep link application', () => {

    it('_applyDeepLinkTarget is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function _applyDeepLinkTarget\(/m);
    });

    it('checks _deepLinkTarget module variable', () => {
        const src = extractFn('_applyDeepLinkTarget');
        expect(src).toMatch(/_deepLinkTarget/);
    });

    it('switches location when target.location differs from options.location', () => {
        const src = extractFn('_applyDeepLinkTarget');
        expect(src).toMatch(/target\.location\s*!==\s*null/);
        expect(src).toMatch(/target\.location\s*!==\s*options\.location/);
        expect(src).toMatch(/switchLocation\(\)/);
    });

    it('flies to rack when target.rack is set', () => {
        const src = extractFn('_applyDeepLinkTarget');
        expect(src).toMatch(/target\.rack\s*!==\s*null/);
        expect(src).toMatch(/flyToRackPosition|flyToServer/);
    });

    it('flies to asset when target.asset is set', () => {
        const src = extractFn('_applyDeepLinkTarget');
        expect(src).toMatch(/target\.asset\s*!==\s*null/);
        expect(src).toMatch(/flyToServer/);
    });

    it('searches racks for asset ID', () => {
        const src = extractFn('_applyDeepLinkTarget');
        expect(src).toMatch(/locations\[options\.location\]/);
        expect(src).toMatch(/\.racks/);
        expect(src).toMatch(/servers\[serverId\]\.id/);
    });

    it('returns early if _deepLinkTarget is null', () => {
        const src = extractFn('_applyDeepLinkTarget');
        // The function stores _deepLinkTarget in a local variable first
        expect(src).toMatch(/const target\s*=\s*_deepLinkTarget/);
        expect(src).toMatch(/if\s*\(\s*!target\s*\)\s*return/);
    });
});

// ---------------------------------------------------------------------------
// _deepLinkTarget module variable declaration
// ---------------------------------------------------------------------------
describe('dc.js — _deepLinkTarget module variable', () => {

    it('_deepLinkTarget is declared as module-level variable', () => {
        expect(DC_SOURCE).toMatch(/let _deepLinkTarget\s*=\s*null;/);
    });
});

// ---------------------------------------------------------------------------
// flyToRackPosition function
// ---------------------------------------------------------------------------
describe('dc.js — flyToRackPosition function', () => {

    it('flyToRackPosition is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function flyToRackPosition\(/m);
    });

    it('sets flyTo.from, flyTo.to, flyTo.look for camera animation', () => {
        const src = extractFn('flyToRackPosition');
        expect(src).toMatch(/flyTo\.from\.copy\(camera\.position\)/);
        expect(src).toMatch(/flyTo\.to\.set/);
        expect(src).toMatch(/flyTo\.look\.set/);
        expect(src).toMatch(/flyTo\.t\s*=\s*0/);
        expect(src).toMatch(/flyTo\.active\s*=\s*true/);
    });
});

// ---------------------------------------------------------------------------
// _copyDeepLink function and copy button in showInfo
// ---------------------------------------------------------------------------
describe('dc.js — _copyDeepLink function', () => {

    it('_copyDeepLink is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function _copyDeepLink\(/m);
    });

    it('uses URLSearchParams to build URL', () => {
        const src = extractFn('_copyDeepLink');
        expect(src).toMatch(/new URLSearchParams/);
        expect(src).toMatch(/params\.set\(['"]location['"]/);
    });

    it('sets rack param from rackKey when provided', () => {
        const src = extractFn('_copyDeepLink');
        expect(src).toMatch(/params\.set\(['"]rack['"]/);
    });

    it('sets asset param when rackKey is not provided', () => {
        const src = extractFn('_copyDeepLink');
        expect(src).toMatch(/params\.set\(['"]asset['"]/);
    });

    it('uses navigator.clipboard to write text', () => {
        const src = extractFn('_copyDeepLink');
        expect(src).toMatch(/navigator\.clipboard\.writeText/);
    });

    it('creates URL with location.href', () => {
        const src = extractFn('_copyDeepLink');
        expect(src).toMatch(/new URL\(location\.href\)/);
    });
});

// ---------------------------------------------------------------------------
// showInfo copy link button presence
// ---------------------------------------------------------------------------
describe('dc.js — showInfo copy link button', () => {

    it('showInfo includes dc-info-copy onclick handler', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/dc-info-copy/);
        expect(src).toMatch(/_copyDeepLink/);
    });

    it('copy button uses rackKey from placements for servers', () => {
        const src = extractFn('showInfo');
        // For servers, rackKey comes from hit.mesh.userData.placements[hit.instanceId].rackKey
        expect(src).toMatch(/placements\[hit\.instanceId\]\.rackKey/);
    });

    it('copy button uses rackKey from userData for racks', () => {
        const src = extractFn('showInfo');
        // For racks, rackKey comes from hit.mesh.userData.rackKey
        expect(src).toMatch(/userData\.rackKey/);
    });

    it('copy button appears in server info panel innerHTML', () => {
        const src = extractFn('showInfo');
        // Should have dc-info-copy-btn wrapper div
        expect(src).toMatch(/dc-info-copy-btn/);
    });

    it('copy button appears in rack info panel innerHTML', () => {
        const src = extractFn('showInfo');
        // The else branch (rack case) should also have the copy button
        // Check that the rack case has copyBtn variable
        expect(src).toMatch(/const copyBtn\s*=\s*'<button class="dc-info-copy"/);
    });
});

// ---------------------------------------------------------------------------
// loadDatacenter integration — _deepLinkTarget set early, _applyDeepLinkTarget called late
// ---------------------------------------------------------------------------
describe('dc.js — loadDatacenter deep link integration', () => {

    it('sets _deepLinkTarget early in loadDatacenter function body', () => {
        // Just verify the pattern exists somewhere after "function loadDatacenter"
        const idx = DC_SOURCE.indexOf('function loadDatacenter() {');
        expect(idx).toBeGreaterThan(-1);
        const after = DC_SOURCE.slice(idx, idx + 600);
        expect(after).toMatch(/_deepLinkTarget\s*=\s*_readDeepLink/);
    });

    it('updates options.location from deep link target if location is set', () => {
        const idx = DC_SOURCE.indexOf('function loadDatacenter() {');
        expect(idx).toBeGreaterThan(-1);
        const after = DC_SOURCE.slice(idx, idx + 600);
        expect(after).toMatch(/if\s*\(\s*_deepLinkTarget\.location\s*!==\s*null/);
        expect(after).toMatch(/options\.location\s*=\s*_deepLinkTarget\.location/);
    });

    it('calls _applyDeepLinkTarget at end of promise chain', () => {
        // _applyDeepLinkTarget should be called in the final .then() block of loadDatacenter
        expect(DC_SOURCE).toMatch(/_applyDeepLinkTarget\(\)/);
    });
});
