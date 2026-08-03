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

    it('showInfo renders the copy button and wires it with a LISTENER', () => {
        // R2.6: this used to require `_copyDeepLink` inside showInfo, which it satisfied via an
        // inline onclick="_copyDeepLink(...)". dc.js loads as type="module", so that attribute
        // resolved the name in GLOBAL scope and threw `ReferenceError: _copyDeepLink is not
        // defined` on every click — the button was dead in the product while this test passed.
        const src = extractFn('showInfo');
        expect(src).toMatch(/dc-info-copy/);
        expect(src).not.toMatch(/onclick=/);
        const wire = extractFn('_wireInfoPanel');
        expect(wire).toMatch(/\.dc-info-copy/);
        expect(wire).toMatch(/_copyDeepLink\(/);
    });

    it('a server deep-links by asset id, not by a rackKey that never existed', () => {
        // It read `placements[hit.instanceId].rackKey`. buildInstanced() stores `assetId` on
        // placements and has never stored a rackKey, so this was always undefined — and
        // `rackKey || ''` then made _copyDeepLink take its RACK branch with an empty string,
        // producing a bare `?rack=` that resolves to nothing.
        const src = extractFn('showInfo');
        expect(src).not.toMatch(/placements\[hit\.instanceId\]\.rackKey/);
        expect(src).toMatch(/_wireInfoPanel\(panel,\s*\{\s*assetId:\s*a\.id/);
    });

    it('a rack deep-links by its rack key, which is the asset id displayRacks() assigns', () => {
        // It read `hit.mesh.userData.rackKey`, which buildInstanced() never sets either.
        // displayRacks() does `rack.id = rackKey`, so a.id IS the key the endpoint uses.
        // Comments stripped first: the code deliberately NAMES userData.rackKey to explain why
        // it is gone, and that documentation must not trip its own guard.
        const src = extractFn('showInfo').replace(/\/\/[^\n]*/g, '');
        expect(src).not.toMatch(/userData\.rackKey/);
        expect(src).toMatch(/_wireInfoPanel\(panel,\s*\{\s*assetId:\s*null,\s*rackKey:\s*a\.id/);
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

// ---------------------------------------------------------------------------
// The behavioural half (R2.6). Everything above is source text; these run the real
// _copyDeepLink() and _applyDeepLinkTarget() and assert on the URL that comes out and the rack
// that gets found. Both defects below were invisible to source matching, because the code did
// contain every string the old assertions looked for.
// ---------------------------------------------------------------------------
describe('dc.js — the deep link round-trips', () => {

    /** Run _copyDeepLink() with a fake clipboard and return the URL it wrote. */
    function copyLink(assetId, rackKey, { location = 4, href = 'https://mystage.interserver.net/admin/dc.php?renderer=webgl' } = {}) {
        let written = null;
        const navigatorStub = { clipboard: { writeText: (t) => { written = t; return Promise.resolve(); } } };
        // eslint-disable-next-line no-new-func
        const fn = new Function('options', 'location', 'navigator', 'URL', 'URLSearchParams',
            extractFn('_copyDeepLink') + '\nreturn _copyDeepLink;')(
            { location }, { href }, navigatorStub, URL, URLSearchParams);
        fn(assetId, rackKey);
        return written;
    }

    it('a rack link carries ?rack=<bare id>, with no rack_ prefix', () => {
        const url = new URL(copyLink(null, '101'));
        expect(url.searchParams.get('rack')).toBe('101');
        expect(url.searchParams.get('asset')).toBeNull();
    });

    it('a server link carries ?asset=<id>', () => {
        const url = new URL(copyLink('5150', null));
        expect(url.searchParams.get('asset')).toBe('5150');
        expect(url.searchParams.get('rack')).toBeNull();
    });

    it('an empty rackKey does not win over the asset id', () => {
        // The server panel used to pass '' (from `rackKey || ''`), which took the rack branch and
        // produced a bare `?rack=` — a link that resolves to nothing at all.
        const url = new URL(copyLink('5150', ''));
        expect(url.searchParams.get('asset')).toBe('5150');
        expect(url.searchParams.get('rack')).toBeNull();
    });

    it('always carries the location, and drops unrelated params like ?renderer=', () => {
        const url = new URL(copyLink('5150', null, { location: 9 }));
        expect(url.searchParams.get('location')).toBe('9');
        expect(url.searchParams.get('renderer')).toBeNull();
    });

    it('?rack= from a copied link resolves against the real racks map', () => {
        // datacenter.php keys racks by the bare rack_id. _applyDeepLinkTarget() looked up
        // 'rack_' + id, which matched nothing, so every rack deep link silently did nothing.
        const flown = [];
        const locations = { 4: { racks: { 101: { x: 3, y: 2 } } } };
        // eslint-disable-next-line no-new-func
        const fn = new Function('_deepLinkTarget', 'locations', 'options', 'flyToRackPosition',
            'switchLocation', 'flyToServer',
            extractFn('_applyDeepLinkTarget') + '\nreturn _applyDeepLinkTarget;')(
            { location: null, rack: 101, asset: null }, locations, { location: 4 },
            (x, y) => flown.push([x, y]), () => {}, () => {});
        fn();
        expect(flown).toEqual([[3, 2]]);
    });

    it('the full round-trip: copy a rack link, then resolve it', () => {
        const rackId = '101';
        const url = new URL(copyLink(null, rackId));
        const target = Number(url.searchParams.get('rack'));
        const flown = [];
        // eslint-disable-next-line no-new-func
        const fn = new Function('_deepLinkTarget', 'locations', 'options', 'flyToRackPosition',
            'switchLocation', 'flyToServer',
            extractFn('_applyDeepLinkTarget') + '\nreturn _applyDeepLinkTarget;')(
            { location: null, rack: target, asset: null },
            { 4: { racks: { 101: { x: 3, y: 2 } } } }, { location: 4 },
            (x, y) => flown.push([x, y]), () => {}, () => {});
        fn();
        expect(flown).toHaveLength(1);
    });

});

// ---------------------------------------------------------------------------
// The XSS test the original plan called "the important one" and which was never written.
// ---------------------------------------------------------------------------
describe('dc.js — showInfo escapes hostile asset data', () => {

    it('escapes every field it interpolates', () => {
        // escapeHtml() is applied per field in showInfo(); this runs the real one over the
        // payloads that reach it. A hostname is operator-supplied data from the assets table.
        // eslint-disable-next-line no-new-func
        const escapeHtml = new Function(extractFn('escapeHtml') + '\nreturn escapeHtml;')();
        const hostile = '<script>alert(1)</script>';
        const out = escapeHtml(hostile);
        expect(out).not.toContain('<script>');
        expect(out).toContain('&lt;script&gt;');
    });

    it('escapes the quote characters that break out of an HTML attribute', () => {
        // eslint-disable-next-line no-new-func
        const escapeHtml = new Function(extractFn('escapeHtml') + '\nreturn escapeHtml;')();
        expect(escapeHtml('" onmouseover="alert(1)')).not.toContain('"');
        expect(escapeHtml("' onmouseover='alert(1)")).not.toContain("'");
        expect(escapeHtml('&')).toBe('&amp;');
    });

    it('every interpolated field in showInfo goes through escapeHtml', () => {
        // The panel builds innerHTML by concatenation, so an unescaped field is a stored-XSS
        // sink reachable by anyone who can name a server. Guarding this as source text is the
        // right tool: the risk is a NEW field being added without the wrapper.
        const src = extractFn('showInfo');
        const interpolations = src.match(/'\s*\+\s*(a\.[A-Za-z_]+|hw|position|statusDot)/g) || [];
        for (const frag of interpolations) {
            const name = frag.replace(/^'\s*\+\s*/, '');
            // statusDot is pre-escaped where it is built; the rest must be wrapped at use.
            if (name === 'statusDot') continue;
            expect(src, `${name} is interpolated without escapeHtml()`).toMatch(
                new RegExp('escapeHtml\\(' + name.replace('.', '\\.'))
            );
        }
    });

    it('the ids are no longer interpolated into a JS string inside an HTML attribute', () => {
        // The sink the original plan singled out: onclick="_copyDeepLink(<id>, '<rackKey>')".
        // Listeners close over the values, so nothing is parsed as code — the sink is removed
        // rather than escaped.
        const src = extractFn('showInfo');
        expect(src).not.toMatch(/onclick="/);
        expect(src).not.toMatch(/_copyDeepLink\(' \+/);
    });

});
