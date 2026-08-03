/**
 * tests/js/dc-location-tiers.test.js — the two-tier location merge (R2.1)
 *
 * The original plan called mergeLocations() "the highest-risk step in the phase; test it
 * properly" and it shipped with zero behavioural coverage — dc-panel-gate.test.js:146 injects it
 * as a stub that throws the isFull argument away, which is precisely the argument the whole
 * two-tier design turns on. The regression that followed was invisible to the suite: changing
 * locationLoaded() to test `_full` emptied the neighbourhood, because after boot only
 * options.location is _full and buildCommunity()'s `ids.length >= 2` gate never opened.
 *
 * So these tests run the REAL declarations, sliced out of dc.js and executed against injected
 * module state, and drive them with the payload shapes public_html/ajax/datacenter.php actually
 * emits (verified 2026-08-03 at datacenter.php:138-147 — the index tier keeps racks[id] = {x,y}
 * for every location and strips everything else).
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

/**
 * Slice a top-level `function name(...) { ... }` out of dc.js by brace-depth walk.
 * Throws when the declaration is missing so a rename fails loudly rather than silently
 * testing nothing.
 */
function sliceFunction(name) {
	const re = new RegExp(`^function ${name}\\s*\\(`, 'm');
	const start = DC_SOURCE.search(re);
	if (start < 0) throw new Error(`${name}() not found in dc.js — was it renamed?`);
	let depth = 0, seen = false;
	for (let i = start; i < DC_SOURCE.length; i++) {
		const ch = DC_SOURCE[i];
		if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
			depth--;
			if (seen && depth === 0) return DC_SOURCE.slice(start, i + 1);
		}
	}
	throw new Error(`${name}() has unbalanced braces`);
}

/**
 * Build a live sandbox holding the three real declarations plus the module state they close
 * over. Returns the functions and the state objects so tests can assert on both.
 */
function makeTierSandbox() {
	const src = [sliceFunction('mergeLocations'), sliceFunction('locationLoaded'), sliceFunction('locationPlaced')].join('\n');
	const locations = {};
	const locationNames = {};
	// eslint-disable-next-line no-new-func
	const factory = new Function('locations', 'locationNames',
		src + '\nreturn { mergeLocations, locationLoaded, locationPlaced };');
	return { ...factory(locations, locationNames), locations, locationNames };
}

// --- payloads shaped like the real endpoint ------------------------------------------------

/** ?tier=index — every location, racks stripped to {x, y}. */
const INDEX_PAYLOAD = {
	locations: {
		4: { name: 'SECAUCUS TEB3', region: 'us-east', racks: { 10: { x: 1, y: 1 }, 11: { x: 2, y: 1 } } },
		7: { name: 'DALLAS DFW1', region: 'us-central', racks: { 40: { x: 1, y: 1 }, 41: { x: 2, y: 1 } } },
		9: { name: 'LOS ANGELES LAX1', region: 'us-west', racks: { 70: { x: 1, y: 1 } } },
	},
};

/** ?location=4 — one location, racks carrying full inventory. */
const FULL_PAYLOAD_4 = {
	locations: {
		4: {
			name: 'SECAUCUS TEB3', region: 'us-east',
			racks: {
				10: { x: 1, y: 1, servers: [{ hostname: 'a1', start: 1, size: 2 }], switches: [] },
				11: { x: 2, y: 1, servers: [{ hostname: 'b1', start: 3, size: 1 }], switches: [] },
			},
		},
	},
};

describe('dc.js — two-tier location merge', () => {

	describe('locationPlaced vs locationLoaded answer different questions', () => {

		it('after the index tier, EVERY location is placed', () => {
			// This is the property buildCommunity() needs. locationFootprint() reads only r.x/r.y,
			// which is exactly what the index ships.
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locationPlaced(4)).toBe(true);
			expect(t.locationPlaced(7)).toBe(true);
			expect(t.locationPlaced(9)).toBe(true);
		});

		it('after the index tier, NO location is loaded', () => {
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locationLoaded(4)).toBe(false);
			expect(t.locationLoaded(7)).toBe(false);
			expect(t.locationLoaded(9)).toBe(false);
		});

		it('after the full tier, only the fetched location is loaded — but all stay placed', () => {
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			t.mergeLocations(FULL_PAYLOAD_4, true);
			expect(t.locationLoaded(4)).toBe(true);
			expect(t.locationLoaded(7)).toBe(false);
			expect(t.locationLoaded(9)).toBe(false);
			// The regression in one assertion: three placed locations is what gets
			// buildCommunity() past `ids.length >= 2`. Testing _full here yields one.
			expect([4, 7, 9].filter((id) => t.locationPlaced(id))).toHaveLength(3);
			expect([4, 7, 9].filter((id) => t.locationLoaded(id))).toHaveLength(1);
		});

		it('an unknown location is neither placed nor loaded', () => {
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locationPlaced(999)).toBe(false);
			expect(t.locationLoaded(999)).toBe(false);
		});

		it('a location present in the index but with no racks is not placed', () => {
			// A datacenter with no racked assets yields an empty racks map. locationFootprint()
			// returns null for it, so placing it on the street would put a zero-size lot in the
			// grid.
			const t = makeTierSandbox();
			t.mergeLocations({ locations: { 12: { name: 'EMPTY', racks: {} } } }, false);
			expect(t.locationPlaced(12)).toBe(false);
		});

	});

	describe('the _full downgrade guard', () => {

		it('a later index merge does not clear _full on an already-full location', () => {
			// Step 3.6's guard. A second index fetch (a reconnect, a manual refresh) must not
			// replace the inventory we already hold with an x/y skeleton.
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			t.mergeLocations(FULL_PAYLOAD_4, true);
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locationLoaded(4)).toBe(true);
		});

		it('a later index merge does not discard the full inventory itself', () => {
			// _full staying true while the servers vanished would be worse than the downgrade:
			// buildRoom() reads racks straight off locations[options.location].
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			t.mergeLocations(FULL_PAYLOAD_4, true);
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locations[4].racks[10].servers).toHaveLength(1);
			expect(t.locations[4].racks[10].servers[0].hostname).toBe('a1');
		});

		it('a full merge still upgrades a location the index brought in first', () => {
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locations[4].racks[10].servers).toBeUndefined();
			t.mergeLocations(FULL_PAYLOAD_4, true);
			expect(t.locations[4].racks[10].servers).toHaveLength(1);
		});

	});

	describe('locationNames', () => {

		it('is populated by the index tier for every location, downgrade-guarded or not', () => {
			// The guard `continue`s past the assignment for already-full locations, so the name
			// map has to be written before it. buildLocationButtons() renders from this map — a
			// missed entry is a missing button.
			const t = makeTierSandbox();
			t.mergeLocations(INDEX_PAYLOAD, false);
			t.mergeLocations(FULL_PAYLOAD_4, true);
			t.mergeLocations(INDEX_PAYLOAD, false);
			expect(t.locationNames['SECAUCUS TEB3']).toBe(4);
			expect(t.locationNames['DALLAS DFW1']).toBe(7);
			expect(t.locationNames['LOS ANGELES LAX1']).toBe(9);
		});

	});

	describe('the call sites use the right predicate', () => {
		// Which predicate each caller uses IS the fix; a behavioural test of the predicates alone
		// stays green if buildCommunity() reverts to locationLoaded.

		function bodyOf(name) {
			return sliceFunction(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
		}

		it('buildCommunity() filters on locationPlaced', () => {
			const body = bodyOf('buildCommunity');
			expect(body).toMatch(/locationPlaced\(/);
			expect(body).not.toMatch(/locationLoaded\(/);
		});

		it('_restoreLocation() gates on locationPlaced', () => {
			const body = bodyOf('_restoreLocation');
			expect(body).toMatch(/locationPlaced\(/);
			expect(body).not.toMatch(/locationLoaded\(/);
		});

		it('switchLocation() still gates on locationLoaded — it needs real inventory', () => {
			const body = bodyOf('switchLocation');
			expect(body).toMatch(/locationLoaded\(/);
			expect(body).not.toMatch(/locationPlaced\(/);
		});

		it('loadBuildingModels() still gates on locationLoaded', () => {
			const body = bodyOf('loadBuildingModels');
			expect(body).toMatch(/locationLoaded\(/);
			expect(body).not.toMatch(/locationPlaced\(/);
		});

	});

});
