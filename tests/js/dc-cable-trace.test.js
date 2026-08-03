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
// ---------------------------------------------------------------------------
// traceCable / clearTrace / traceCableForAsset — EXECUTED (R3.11)
//
// These three were nineteen regexes over their own source text: "the function contains the string
// scene.add(_traceOverlay)", "the function contains renderOrder = 1000", and so on. Each one
// restated a line of dc.js and could only ever confirm that nobody had edited it.
//
// What that cannot see is the thing that actually matters here — the overlay's LIFECYCLE. A trace
// allocates a BufferGeometry and a LineBasicMaterial and parents them to the scene; every one of
// those has to be released when the trace is replaced or cleared, or clicking Trace Cable a few
// dozen times leaks GPU memory for the life of the page. "clearTrace() contains .dispose()" says
// nothing about whether it is reached, called once, or called on the right object.
// ---------------------------------------------------------------------------
describe('dc.js — the trace overlay lifecycle, executed', () => {

    /** Minimal three.js stand-ins that record allocation and disposal. */
    function makeTHREE(log) {
        class BufferGeometry {
            constructor() { this.points = null; log.push(['geometry:new']); }
            setFromPoints(pts) { this.points = pts; return this; }
            dispose() { log.push(['geometry:dispose']); this.disposed = true; }
        }
        class LineBasicMaterial {
            constructor(opts) { this.opts = opts; log.push(['material:new', opts]); }
            dispose() { log.push(['material:dispose']); this.disposed = true; }
        }
        class Line {
            constructor(geometry, material) { this.geometry = geometry; this.material = material; }
        }
        class Vector3 {
            constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
        }
        return { BufferGeometry, LineBasicMaterial, Line, Vector3 };
    }

    /** Live sandbox over the real traceCable / clearTrace / traceCableForAsset. */
    function makeTracer(routes = {}, ports = {}) {
        const log = [];
        const scene = {
            children: [],
            add(o) { this.children.push(o); log.push(['scene:add']); },
            remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); log.push(['scene:remove']); },
        };
        const src = [
            'let _traceOverlay = null;',
            'const _cableRoutes = new Map(Object.entries(routes));',
            'const _portsByAsset = new Map(Object.entries(ports));',
            extractFn('traceCable'),
            extractFn('clearTrace'),
            extractFn('traceCableForAsset'),
            'return { traceCable, clearTrace, traceCableForAsset, overlay: () => _traceOverlay };',
        ].join('\n');
        // eslint-disable-next-line no-new-func
        const api = new Function('THREE', 'scene', 'routes', 'ports', src)(
            makeTHREE(log), scene, routes, ports);
        return { ...api, scene, log };
    }

    const ROUTE = [[0, 0, 0], [1, 2, 3], [4, 5, 6]];

    it('draws a line through every route point, in order', () => {
        const t = makeTracer({ '900:7': ROUTE });
        t.traceCable('900:7');
        const line = t.overlay();
        expect(line).toBeTruthy();
        expect(line.geometry.points.map((p) => [p.x, p.y, p.z])).toEqual(ROUTE);
    });

    it('parents the overlay to the scene', () => {
        const t = makeTracer({ '900:7': ROUTE });
        t.traceCable('900:7');
        expect(t.scene.children).toEqual([t.overlay()]);
    });

    it('draws in a colour that stands out, above everything else', () => {
        // A trace you cannot see through the racks is not a trace. renderOrder puts it on top;
        // cyan is the one colour nothing else in this scene uses.
        const t = makeTracer({ '900:7': ROUTE });
        t.traceCable('900:7');
        expect(t.overlay().material.opts.color).toBe(0x00ffff);
        expect(t.overlay().renderOrder).toBe(1000);
    });

    it('refuses to draw a route with fewer than two points', () => {
        // One point is not a line, and setFromPoints would build a degenerate geometry.
        for (const pts of [[], [[0, 0, 0]]]) {
            const t = makeTracer({ '900:7': pts });
            t.traceCable('900:7');
            expect(t.overlay()).toBeNull();
            expect(t.scene.children).toEqual([]);
        }
    });

    it('does nothing for an unknown route key', () => {
        const t = makeTracer({ '900:7': ROUTE });
        t.traceCable('nope');
        expect(t.overlay()).toBeNull();
    });

    it('LEAK: tracing a second cable disposes the first', () => {
        // The one that matters. traceCable() starts with clearTrace() for this reason; without it
        // every click leaks a geometry and a material, and nothing about the page looks wrong.
        const t = makeTracer({ a: ROUTE, b: ROUTE });
        t.traceCable('a');
        const first = t.overlay();
        t.traceCable('b');
        expect(first.geometry.disposed).toBe(true);
        expect(first.material.disposed).toBe(true);
        expect(t.overlay()).not.toBe(first);
        expect(t.scene.children).toEqual([t.overlay()]);   // and only one is left parented
    });

    it('LEAK: fifty traces leave exactly one overlay in the scene', () => {
        const t = makeTracer({ a: ROUTE });
        for (let i = 0; i < 50; i++) t.traceCable('a');
        expect(t.scene.children).toHaveLength(1);
        const news = t.log.filter((e) => e[0] === 'geometry:new').length;
        const disposes = t.log.filter((e) => e[0] === 'geometry:dispose').length;
        expect(news - disposes).toBe(1);
    });

    it('LEAK: a failed trace still clears the previous one', () => {
        // clearTrace() runs before the route lookup, so switching to an asset with no route
        // removes the stale overlay rather than leaving the wrong cable highlighted.
        const t = makeTracer({ a: ROUTE });
        t.traceCable('a');
        t.traceCable('missing');
        expect(t.overlay()).toBeNull();
        expect(t.scene.children).toEqual([]);
    });

    it('clearTrace removes, disposes and forgets', () => {
        const t = makeTracer({ a: ROUTE });
        t.traceCable('a');
        const line = t.overlay();
        t.clearTrace();
        expect(t.scene.children).toEqual([]);
        expect(line.geometry.disposed).toBe(true);
        expect(line.material.disposed).toBe(true);
        expect(t.overlay()).toBeNull();
    });

    it('clearTrace is idempotent and safe with nothing traced', () => {
        const t = makeTracer();
        expect(() => { t.clearTrace(); t.clearTrace(); }).not.toThrow();
        expect(t.log).toEqual([]);
    });

    it('traceCableForAsset traces the asset\'s first connection', () => {
        const t = makeTracer(
            { '900:7': ROUTE },
            { 5150: [{ switchId: '900', portId: '7', port: 'Gi0/1' }] });
        t.traceCableForAsset('5150');
        expect(t.overlay()).toBeTruthy();
        expect(t.overlay().geometry.points).toHaveLength(3);
    });

    it('traceCableForAsset does nothing, and breaks nothing, for an unconnected asset', () => {
        const t = makeTracer({ '900:7': ROUTE }, {});
        expect(() => t.traceCableForAsset('5150')).not.toThrow();
        expect(t.overlay()).toBeNull();
    });

    it('NON-VACUITY: removing the clearTrace() call makes the leak tests fail', () => {
        // Prove the harness can see the leak, rather than passing because disposal never mattered.
        const leaky = extractFn('traceCable').replace(/^\s*clearTrace\(\);\n/m, '');
        expect(leaky).not.toMatch(/clearTrace\(\);/);
        const log = [];
        const scene = { children: [], add(o) { this.children.push(o); }, remove(o) { this.children.splice(this.children.indexOf(o), 1); } };
        // eslint-disable-next-line no-new-func
        const api = new Function('THREE', 'scene', 'routes', [
            'let _traceOverlay = null;',
            'const _cableRoutes = new Map(Object.entries(routes));',
            leaky,
            extractFn('clearTrace'),
            'return { traceCable };',
        ].join('\n'))(makeTHREE(log), scene, { a: ROUTE, b: ROUTE });
        api.traceCable('a');
        api.traceCable('b');
        expect(scene.children).toHaveLength(2);              // the leak, reproduced
        expect(log.filter((e) => e[0] === 'geometry:dispose')).toHaveLength(0);
    });

    it('all three are reachable from the console via window.DC', () => {
        // Structural on purpose: an export list has nothing to execute. The Copy Link and Trace
        // Cable buttons call through window.DC, and so does the E2E suite.
        for (const name of ['traceCable', 'clearTrace', 'traceCableForAsset']) {
            expect(DC_SOURCE).toMatch(new RegExp(`${name}: ${name}`));
        }
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
