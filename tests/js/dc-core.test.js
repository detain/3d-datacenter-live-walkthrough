/**
 * tests/js/dc-core.test.js — pure-logic helpers sliced from public_html/js/dc.js
 *
 * Tests the 8 standalone utility functions that have no Three.js dependency:
 * convertRackCoordinatesToPosition, convertServerCoordinatesToPosition, eyeHeight,
 * playerRadius, makeRng, escapeHtml, distToRect, glbVariantUrl.
 *
 * Each function is sliced from the real dc.js source at runtime using a
 * column-0-anchored regex (same technique as dc-model-guards.test.js).  The
 * extractor throws if the declaration is renamed or removed, so a rename in
 * dc.js fails loudly instead of silently testing nothing.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Slice extractors — same pattern as dc-model-guards.test.js
// ---------------------------------------------------------------------------
function extractFn(name) {
    const m = DC_SOURCE.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}
function extractLine(name) {
    const m = DC_SOURCE.match(new RegExp('^const ' + name + ' = .*;$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// Compile a sliced function in a minimal safe scope.
// Only plain-JS helpers that work in a Function() constructor are provided.
// ---------------------------------------------------------------------------
function makeFn(name, extraBody = '') {
    const src = extractFn(name);
    // Provide options so eyeHeight/playerRadius can resolve their dependencies.
    // UNITS_PER_INCH is referenced by both eyeHeight() and playerRadius().
    const options = {
        heightInches: 70,
        waistInches: 36,
        scaleX: 8,
        scaleZ: 9,
    };
    const UNITS_PER_INCH = 15 / 70;
    return new Function('options', 'UNITS_PER_INCH', extraBody + src + '\nreturn ' + name + ';')(options, UNITS_PER_INCH);
}

// ---------------------------------------------------------------------------
// Coordinate conversion
// ---------------------------------------------------------------------------
describe('dc.js — coordinate conversion', () => {

    it('convertRackCoordinatesToPosition(1, 1)', () => {
        const fn = makeFn('convertRackCoordinatesToPosition');
        // options.scaleX=8, scaleZ=9, offsetX=-100, offsetZ=-100
        const result = fn(1, 1);
        expect(result).toEqual({ x: -92, z: -91, max_x: -84, max_z: -82 });
    });

    it('convertRackCoordinatesToPosition(0, 0)', () => {
        const fn = makeFn('convertRackCoordinatesToPosition');
        const result = fn(0, 0);
        expect(result).toEqual({ x: -100, z: -100, max_x: -92, max_z: -91 });
    });

    it('convertServerCoordinatesToPosition uses rack position plus offsets', () => {
        // serverX = rackX - 2.4, serverY = 0.5 * start, serverZ = rackZ + 2.6
        // convertServerCoordinatesToPosition calls convertRackCoordinatesToPosition internally
        const convertRack = extractFn('convertRackCoordinatesToPosition');
        const fn = makeFn('convertServerCoordinatesToPosition', convertRack + '\n');
        const result = fn(1, 1, 4); // rack(1,1), 4U server
        expect(result.x).toBeCloseTo(-92 - 2.4);  // rack.x - 2.4
        expect(result.y).toBeCloseTo(2);           // 0.5 * 4
        expect(result.z).toBeCloseTo(-91 + 2.6);  // rack.z + 2.6
    });

    it('UNITS_PER_INCH = 15/70 (source text check)', () => {
        expect(DC_SOURCE).toMatch(/const UNITS_PER_INCH = 15 \/ 70\b/);
    });

    it('RACK_GRID_CELL = 10 (source text check)', () => {
        expect(DC_SOURCE).toMatch(/const RACK_GRID_CELL = 10\b/);
    });
});

// ---------------------------------------------------------------------------
// Player metrics
// ---------------------------------------------------------------------------
describe('dc.js — player metrics', () => {

    it('eyeHeight() equals heightInches times UNITS_PER_INCH', () => {
        const fn = makeFn('eyeHeight');
        // 70 * (15/70) = 15
        expect(fn()).toBeCloseTo(15);
    });

    it('playerRadius() is greater than or equal to 0.2 (minimum enforced)', () => {
        const fn = makeFn('playerRadius');
        // 36" waist: (36 / 2pi) * (15/70) approx 1.22
        const r = fn();
        expect(r).toBeGreaterThanOrEqual(0.2);
        expect(r).toBeCloseTo((36 / (2 * Math.PI)) * (15 / 70), 2);
    });

    it('playerRadius() clamps at minimum 0.2 when waist is tiny', () => {
        // Inject a small waist via options
        const src = extractFn('playerRadius');
        const tinyOpts = { waistInches: 1, heightInches: 70 }; // 1" waist
        const UNITS_PER_INCH = 15 / 70;
        const fn = new Function('options', 'UNITS_PER_INCH', src + '\nreturn playerRadius;')(tinyOpts, UNITS_PER_INCH);
        expect(fn()).toBeCloseTo(0.2);
    });
});

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------
describe('dc.js — makeRng', () => {

    it('same seed produces same sequence', () => {
        const fn = makeFn('makeRng');
        const rng1 = fn(12345);
        const rng2 = fn(12345);
        expect([rng1(), rng1(), rng1()]).toEqual([rng2(), rng2(), rng2()]);
    });

    it('different seeds produce different sequences', () => {
        const fn = makeFn('makeRng');
        const rng1 = fn(111);
        const rng2 = fn(222);
        expect(rng1()).not.toBe(rng2());
    });

    it('values are in the range [0, 1)', () => {
        const fn = makeFn('makeRng');
        const rng = fn(999);
        for (let i = 0; i < 100; i++) {
            const v = rng();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('string seed is hashed to non-zero value', () => {
        const fn = makeFn('makeRng');
        const rng = fn('hello');
        // Hashing 'hello' should produce a non-zero integer
        expect(typeof rng()).toBe('number');
        expect(rng()).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
describe('dc.js — escapeHtml', () => {

    it('escapes HTML special characters', () => {
        const fn = makeFn('escapeHtml');
        expect(fn('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;');
    });

    it('leaves plain text unchanged', () => {
        const fn = makeFn('escapeHtml');
        expect(fn('hello world')).toBe('hello world');
    });

    it('returns String representation of any input', () => {
        const fn = makeFn('escapeHtml');
        expect(fn(123)).toBe('123');
        expect(fn(null)).toBe('null');
        expect(fn(undefined)).toBe('undefined');
    });
});

// ---------------------------------------------------------------------------
// Rectangle distance
// ---------------------------------------------------------------------------
describe('dc.js — distToRect', () => {

    it('returns zero for a point inside the rect', () => {
        const fn = makeFn('distToRect');
        const b = { minX: -50, maxX: -42, minZ: -50, maxZ: -43 };
        expect(fn(-46, -46, b)).toBe(0);
    });

    it('returns distance to nearest edge for point outside', () => {
        const fn = makeFn('distToRect');
        const b = { minX: -50, maxX: -42, minZ: -50, maxZ: -43 };
        // Point (0, 0): dx = max(-50-0, 0, 0-(-42)) = max(-50, 0, 42) = 42
        //               dz = max(-50-0, 0, 0-(-43)) = max(-50, 0, 43) = 43
        //               dist = sqrt(42 squared + 43 squared)
        expect(fn(0, 0, b)).toBeCloseTo(Math.hypot(42, 43));
    });

    it('diagonal corner distance is correct', () => {
        const fn = makeFn('distToRect');
        const b = { minX: 10, maxX: 20, minZ: 10, maxZ: 20 };
        // Point (0, 0): dx = max(10-0, 0, 0-20) = max(10, 0, -20) = 10
        //               dz = max(10-0, 0, 0-20) = 10
        expect(fn(0, 0, b)).toBeCloseTo(Math.hypot(10, 10), 5);
    });
});

// ---------------------------------------------------------------------------
// GLB variant URL builder
// ---------------------------------------------------------------------------
describe('dc.js — glbVariantUrl', () => {

    it('no variant returns base path plus .glb', () => {
        const fn = makeFn('glbVariantUrl');
        expect(fn('/gltf/', 'Rack', '')).toBe('/gltf/Rack.glb');
    });

    it('variant inserts subdir before filename', () => {
        const fn = makeFn('glbVariantUrl');
        expect(fn('/gltf/', 'Rack', 'meshopt')).toBe('/gltf/meshopt/Rack.glb');
    });

    it('nested path is handled correctly', () => {
        const fn = makeFn('glbVariantUrl');
        expect(fn('/gltf/', 'exported/Rack', 'webp-simplify')).toBe('/gltf/exported/webp-simplify/Rack.glb');
    });
});

// ---------------------------------------------------------------------------
// Key constants verified against real source text
// ---------------------------------------------------------------------------
describe('dc.js — constants from source', () => {

    it('MAX_TEXTURE_CACHE = 128', () => {
        expect(DC_SOURCE).toMatch(/const MAX_TEXTURE_CACHE = 128\b/);
    });

    it('ROOM_MARGIN = 28', () => {
        expect(DC_SOURCE).toMatch(/const ROOM_MARGIN = 28\b/);
    });

    it('MAX_LABELS = 200', () => {
        expect(DC_SOURCE).toMatch(/const MAX_LABELS = 200\b/);
    });
});
