/**
 * tests/js/dc-overlay.test.js — Step 9.7: Free-U capacity overlay
 *
 * Tests the overlay system added in Step 9.7:
 * - OVERLAY_SOURCES registry with 'none' and 'freeU' entries
 * - computeFreeU() returns Map with values 0..1
 * - GUI dropdown for overlay selection
 * - Legend element in CSS
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_CSS = path.resolve(__dirname, '../../public_html/css/dc-shared.css');
const DC_HTML = path.resolve(__dirname, '../../public_html/admin/dc.html');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');
const CSS_SOURCE = fs.readFileSync(DC_CSS, 'utf8');
const HTML_SOURCE = fs.readFileSync(DC_HTML, 'utf8');

// ---------------------------------------------------------------------------
// Slice extractors — same pattern as dc-core.test.js
// ---------------------------------------------------------------------------
function extractConst(name) {
    const m = DC_SOURCE.match(new RegExp('^const ' + name + ' = [\\s\\S]*?^};', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}

function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '[\\s\\S]*?^}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// OVERLAY_SOURCES registry
// ---------------------------------------------------------------------------
describe('OVERLAY_SOURCES registry', () => {
    it('exists in dc.js', () => {
        const overlaySrc = extractConst('OVERLAY_SOURCES');
        expect(overlaySrc).toBeTruthy();
    });

    it('has "none" entry set to null', () => {
        const overlaySrc = extractConst('OVERLAY_SOURCES');
        // Check that 'none: null' appears in the source
        expect(overlaySrc).toMatch(/none\s*:\s*null/);
    });

    it('has "freeU" entry referencing computeFreeU', () => {
        const overlaySrc = extractConst('OVERLAY_SOURCES');
        // Check that 'freeU: computeFreeU' appears in the source
        expect(overlaySrc).toMatch(/freeU\s*:\s*computeFreeU/);
    });
});

// ---------------------------------------------------------------------------
// computeFreeU() function
// ---------------------------------------------------------------------------
describe('computeFreeU()', () => {
    it('is declared in dc.js', () => {
        const fnSrc = extractFn('computeFreeU');
        expect(fnSrc).toBeTruthy();
        expect(fnSrc).toContain('function computeFreeU');
    });

    it('returns a Map', () => {
        const fnSrc = extractFn('computeFreeU');
        // The function body should contain "new Map()"
        expect(fnSrc).toContain('new Map()');
    });

    it('computes freeU as freeU/totalU ratio', () => {
        const fnSrc = extractFn('computeFreeU');
        // The function should divide freeU by totalU
        expect(fnSrc).toMatch(/freeU\s*\/\s*totalU/);
    });

    it('handles servers and switches in occupiedU calculation', () => {
        const fnSrc = extractFn('computeFreeU');
        // Should iterate over servers and switches
        expect(fnSrc).toContain('rack.servers');
        expect(fnSrc).toContain('rack.switches');
    });

    it('handles missing rack.u by defaulting to 42', () => {
        const fnSrc = extractFn('computeFreeU');
        // Should have "rack.u || 42" or similar default
        expect(fnSrc).toMatch(/rack\.u\s*\|\|\s*42/);
    });
});

// ---------------------------------------------------------------------------
// GUI dropdown for overlay
// ---------------------------------------------------------------------------
describe('GUI overlay dropdown', () => {
    it('options.overlay is declared with default "none"', () => {
        const optionsSrc = extractConst('options');
        expect(optionsSrc).toMatch(/overlay\s*:\s*'none'/);
    });

    it('displayGui adds overlay dropdown with capacity overlay name', () => {
        const displayGuiSrc = extractFn('displayGui');
        expect(displayGuiSrc).toMatch(/'capacity overlay'/);
    });

    it('overlay dropdown has None and Free U options', () => {
        const displayGuiSrc = extractFn('displayGui');
        expect(displayGuiSrc).toMatch(/'None'\s*:\s*'none'/);
        expect(displayGuiSrc).toMatch(/'Free U'\s*:\s*'freeU'/);
    });
});

// ---------------------------------------------------------------------------
// Legend element in CSS
// ---------------------------------------------------------------------------
describe('Legend element in CSS', () => {
    it('#dcOverlayLegend rule exists in dc-shared.css', () => {
        expect(CSS_SOURCE).toContain('#dcOverlayLegend');
    });

    it('legend has .visible class for showing it', () => {
        expect(CSS_SOURCE).toContain('#dcOverlayLegend.visible');
    });

    it('legend has swatch styles for full/half/empty colors', () => {
        expect(CSS_SOURCE).toContain('.legend-swatch.full');
        expect(CSS_SOURCE).toContain('.legend-swatch.half');
        expect(CSS_SOURCE).toContain('.legend-swatch.empty');
    });

    it('legend colors match the overlay color ramp (red, amber, green)', () => {
        // Full = red (#ff0000), half = amber (#ffaa00), empty = green (#00ff00)
        expect(CSS_SOURCE).toContain('#ff0000');
        expect(CSS_SOURCE).toContain('#ffaa00');
        expect(CSS_SOURCE).toContain('#00ff00');
    });
});

// ---------------------------------------------------------------------------
// Legend element in HTML
// ---------------------------------------------------------------------------
describe('Legend element in HTML', () => {
    it('#dcOverlayLegend div exists in dc.html', () => {
        expect(HTML_SOURCE).toContain('id="dcOverlayLegend"');
    });

    it('legend contains "Free U Capacity" title', () => {
        expect(HTML_SOURCE).toContain('Free U Capacity');
    });

    it('legend has three rows for Full, Half, Empty', () => {
        expect(HTML_SOURCE).toContain('Full');
        expect(HTML_SOURCE).toContain('Half');
        expect(HTML_SOURCE).toContain('Empty');
    });
});
