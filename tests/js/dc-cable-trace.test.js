/**
 * tests/js/dc-cable-trace.test.js — Step 9.6 Cable Tracing
 *
 * Tests that dc.js correctly implements cable tracing functionality:
 * - _cableRoutes Map exists for storing cable route points
 * - _portsByAsset Map exists for reverse index of asset connections
 * - traceCable(routeKey) function exists and draws a LineBasicMaterial overlay
 * - clearTrace() function exists and removes the overlay
 * - Trace button is added to info panel for assets with cable connections
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// _cableRoutes Map existence
// ---------------------------------------------------------------------------
describe('dc.js — _cableRoutes Map', () => {

    it('is declared as a Map at module scope', () => {
        expect(DC_SOURCE).toMatch(/^const _cableRoutes = new Map\(\);$/m);
    });
});

// ---------------------------------------------------------------------------
// _portsByAsset Map existence
// ---------------------------------------------------------------------------
describe('dc.js — _portsByAsset Map', () => {

    it('is declared as a Map at module scope', () => {
        expect(DC_SOURCE).toMatch(/^const _portsByAsset = new Map\(\);$/m);
    });
});

// ---------------------------------------------------------------------------
// buildPortsByAsset function
// ---------------------------------------------------------------------------
describe('dc.js — buildPortsByAsset function', () => {

    it('is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function buildPortsByAsset\(/m);
    });

    it('clears _portsByAsset before building', () => {
        const src = extractFn('buildPortsByAsset');
        expect(src).toMatch(/_portsByAsset\.clear\(\)/);
    });

    it('iterates over racks and switches to build reverse index', () => {
        const src = extractFn('buildPortsByAsset');
        expect(src).toMatch(/rack\.switches/);
        expect(src).toMatch(/switchData\.ports/);
    });

    it('stores entries with switchId, portId, port, and sw properties', () => {
        const src = extractFn('buildPortsByAsset');
        expect(src).toMatch(/switchId/);
        expect(src).toMatch(/portId/);
        expect(src).toMatch(/port.*portData\.port/);
    });

    it('maps assetId to array of connection entries', () => {
        const src = extractFn('buildPortsByAsset');
        expect(src).toMatch(/portData\.asset/);
        expect(src).toMatch(/_portsByAsset\.set\(portData\.asset/);
    });
});

// ---------------------------------------------------------------------------
// traceCable function
// ---------------------------------------------------------------------------
describe('dc.js — traceCable function', () => {

    it('is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function traceCable\(/m);
    });

    it('calls clearTrace first to remove existing overlay', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/clearTrace\(\)/);
    });

    it('looks up route points from _cableRoutes', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/_cableRoutes\.get\(routeKey\)/);
    });

    it('creates a THREE.BufferGeometry from route points', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/THREE\.BufferGeometry/);
        expect(src).toMatch(/setFromPoints/);
    });

    it('creates a LineBasicMaterial with bright color (0x00ffff cyan)', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/LineBasicMaterial/);
        expect(src).toMatch(/color.*0x00ffff/);
    });

    it('creates a THREE.Line and adds it to the scene', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/new THREE\.Line\(/);
        expect(src).toMatch(/scene\.add\(_traceOverlay\)/);
    });

    it('sets renderOrder to 1000 for overlay priority', () => {
        const src = extractFn('traceCable');
        expect(src).toMatch(/_traceOverlay\.renderOrder = 1000/);
    });

    it('is exposed on window.DC', () => {
        expect(DC_SOURCE).toMatch(/traceCable: traceCable/);
    });
});

// ---------------------------------------------------------------------------
// clearTrace function
// ---------------------------------------------------------------------------
describe('dc.js — clearTrace function', () => {

    it('is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function clearTrace\(/m);
    });

    it('early returns if no overlay exists', () => {
        const src = extractFn('clearTrace');
        expect(src).toMatch(/if \(!_traceOverlay\) return/);
    });

    it('removes overlay from scene', () => {
        const src = extractFn('clearTrace');
        expect(src).toMatch(/scene\.remove\(_traceOverlay\)/);
    });

    it('disposes geometry and material', () => {
        const src = extractFn('clearTrace');
        expect(src).toMatch(/_traceOverlay\.geometry\.dispose\(\)/);
        expect(src).toMatch(/_traceOverlay\.material\.dispose\(\)/);
    });

    it('sets _traceOverlay to null after disposal', () => {
        const src = extractFn('clearTrace');
        expect(src).toMatch(/_traceOverlay = null/);
    });

    it('is exposed on window.DC', () => {
        expect(DC_SOURCE).toMatch(/clearTrace: clearTrace/);
    });
});

// ---------------------------------------------------------------------------
// traceCableForAsset function
// ---------------------------------------------------------------------------
describe('dc.js — traceCableForAsset function', () => {

    it('is declared at top level', () => {
        expect(DC_SOURCE).toMatch(/^function traceCableForAsset\(/m);
    });

    it('looks up connections from _portsByAsset', () => {
        const src = extractFn('traceCableForAsset');
        expect(src).toMatch(/_portsByAsset\.get\(assetId\)/);
    });

    it('early returns if no connections found', () => {
        const src = extractFn('traceCableForAsset');
        expect(src).toMatch(/if \(!connections.*return/);
    });

    it('constructs routeKey from switchId and portId', () => {
        const src = extractFn('traceCableForAsset');
        expect(src).toMatch(/conn\.switchId.*conn\.portId/);
    });

    it('calls traceCable with the routeKey', () => {
        const src = extractFn('traceCableForAsset');
        expect(src).toMatch(/traceCable\(routeKey\)/);
    });

    it('is exposed on window.DC', () => {
        expect(DC_SOURCE).toMatch(/traceCableForAsset: traceCableForAsset/);
    });
});

// ---------------------------------------------------------------------------
// showInfo trace button integration
// ---------------------------------------------------------------------------
describe('dc.js — showInfo trace button', () => {

    it('showInfo looks up connections from _portsByAsset', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/_portsByAsset\.get\(a\.id\)/);
    });

    it('showInfo creates a trace button for assets with connections', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/hasConnections/);
        expect(src).toMatch(/traceBtn.*dc-info-trace/);
    });

    it('trace button calls DC.traceCableForAsset with asset id', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/DC\.traceCableForAsset\(/);
        expect(src).toMatch(/a\.id/);
    });
});

// ---------------------------------------------------------------------------
// displayDatacenter calls buildPortsByAsset
// ---------------------------------------------------------------------------
describe('dc.js — displayDatacenter integration', () => {

    it('displayDatacenter calls buildPortsByAsset before displaySwitches', () => {
        const src = extractFn('displayDatacenter');
        expect(src).toMatch(/buildPortsByAsset\(options\.location\)/);
        // Verify order: buildPortsByAsset comes before displaySwitches
        const buildIdx = src.indexOf('buildPortsByAsset');
        const displayIdx = src.indexOf('displaySwitches');
        expect(buildIdx).toBeLessThan(displayIdx);
    });
});

// ---------------------------------------------------------------------------
// displaySwitches captures cable routes
// ---------------------------------------------------------------------------
describe('dc.js — displaySwitches captures cable routes', () => {

    it('addCable accepts routeKey parameter', () => {
        // The addCable function is internal to displaySwitches, check it's called with routeKey
        expect(DC_SOURCE).toMatch(/addCable\([^)]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^)]+switchId.*portId/);
    });

    it('addCable stores route points in _cableRoutes', () => {
        // Find the addCable function body
        const addCableMatch = DC_SOURCE.match(/const addCable = \([^)]+\) => \{[\s\S]*?_cableRoutes\.set\(/);
        expect(addCableMatch).not.toBeNull();
    });

    it('stores route only if not already stored (idempotent)', () => {
        const src = extractFn('displaySwitches');
        expect(src).toMatch(/if \(routeKey && !_cableRoutes\.has\(routeKey\)\)/);
    });
});
