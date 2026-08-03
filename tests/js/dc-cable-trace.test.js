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

    it('maps assetId to array of connection entries, keyed as a STRING', () => {
        // R2.6: the index used to be keyed by the raw portData.asset, which arrives as a JSON
        // NUMBER (PHP casts it with (int)), while every lookup passes an id that came from
        // Object.keys() and is a STRING. Map.get("123") never matches the key 123, so the Trace
        // Cable button never appeared for any asset in the product. The behavioural proof is in
        // the round-trip test at the bottom of this file; this guards the key type at the source.
        const src = extractFn('buildPortsByAsset');
        expect(src).toMatch(/portData\.asset/);
        expect(src).toMatch(/String\(portData\.asset\)/);
        expect(src).not.toMatch(/_portsByAsset\.set\(portData\.asset[,)]/);
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

    it('looks up connections from _portsByAsset with a normalised key', () => {
        const src = extractFn('traceCableForAsset');
        expect(src).toMatch(/_portsByAsset\.get\(String\(assetId\)\)/);
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

    it('showInfo looks up connections from _portsByAsset with a normalised key', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/_portsByAsset\.get\(String\(a\.id\)\)/);
    });

    it('showInfo creates a trace button for assets with connections', () => {
        const src = extractFn('showInfo');
        expect(src).toMatch(/hasConnections/);
        expect(src).toMatch(/traceBtn.*dc-info-trace/);
    });

    it('the trace button is wired with a listener, not an inline onclick', () => {
        // dc.js loads as type="module", so an inline onclick resolves in GLOBAL scope. The copy
        // button next to this one used a module-scope function that way and threw ReferenceError
        // on every click. Listeners also remove the escaping sink: ids were being interpolated
        // into a JS string inside an HTML attribute.
        const src = extractFn('showInfo');
        expect(src).toMatch(/dc-info-trace/);
        expect(src).not.toMatch(/onclick=/);
        const wire = extractFn('_wireInfoPanel');
        expect(wire).toMatch(/\.dc-info-trace/);
        expect(wire).toMatch(/addEventListener\('click'/);
        expect(wire).toMatch(/traceCableForAsset\(/);
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

// ---------------------------------------------------------------------------
// The port index round-trip — the behavioural half of the key-type fix (R2.6).
//
// Everything above is source text. This runs the real buildPortsByAsset() and
// traceCableForAsset() against a payload shaped like /ajax/datacenter.php's, where
// `ports[<id>].asset` is a NUMBER, and looks it up with the STRING id the info panel actually
// holds (server ids come from Object.keys(rack.servers)). That mismatch is what made the Trace
// Cable button never appear, and no amount of source matching can see it.
// ---------------------------------------------------------------------------
describe('dc.js — the port index round-trips between number and string ids', () => {

    /** Build a live sandbox over the real declarations. */
    function makePortIndex(locations) {
        const traced = [];
        const src = [
            'const _portsByAsset = new Map();',
            extractFn('buildPortsByAsset'),
            extractFn('traceCableForAsset'),
            'return { buildPortsByAsset, traceCableForAsset, get: (k) => _portsByAsset.get(k) };',
        ].join('\n');
        // eslint-disable-next-line no-new-func
        return {
            ...new Function('locations', 'traceCable', src)(locations, (k) => traced.push(k)),
            traced,
        };
    }

    // datacenter.php emits ports[...].asset as (int) — a JSON number — while rack.servers is an
    // object whose KEYS are the same ids as strings.
    const LOCATIONS = {
        4: {
            racks: {
                101: {
                    servers: { 5150: { hostname: 'web1.test' } },
                    switches: {
                        900: { name: 'sw1', ports: { 7: { port: 'Gi0/1', asset: 5150 } } },
                    },
                },
            },
        },
    };

    it('finds an asset looked up with the STRING id the info panel holds', () => {
        const idx = makePortIndex(LOCATIONS);
        idx.buildPortsByAsset(4);
        // '5150', not 5150 — this is exactly what showInfo() passes.
        expect(idx.get('5150')).toBeDefined();
        expect(idx.get('5150')).toHaveLength(1);
    });

    it('also finds it when called with a NUMBER from the console', () => {
        const idx = makePortIndex(LOCATIONS);
        idx.buildPortsByAsset(4);
        idx.traceCableForAsset(5150);
        expect(idx.traced).toEqual(['900:7']);
    });

    it('traces from the string id too', () => {
        const idx = makePortIndex(LOCATIONS);
        idx.buildPortsByAsset(4);
        idx.traceCableForAsset('5150');
        expect(idx.traced).toEqual(['900:7']);
    });

    it('does nothing for an asset with no connections', () => {
        const idx = makePortIndex(LOCATIONS);
        idx.buildPortsByAsset(4);
        idx.traceCableForAsset(9999);
        expect(idx.traced).toEqual([]);
    });

    it('clears the index between locations', () => {
        const idx = makePortIndex(LOCATIONS);
        idx.buildPortsByAsset(4);
        idx.buildPortsByAsset(7);   // no such location
        expect(idx.get('5150')).toBeUndefined();
    });

});
