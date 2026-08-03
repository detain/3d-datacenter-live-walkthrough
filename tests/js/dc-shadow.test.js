/**
 * tests/js/dc-shadow.test.js — Phase 6 shadow rendering (rewritten by R2.3)
 *
 * The previous version was `DC_SOURCE.includes('renderer.shadowMap.enabled = true')` and friends.
 * Every assertion passed while shadows were, in practice, invisible: _fitShadowCamera() bailed on
 * its own guard on every single load, so the shadow camera kept three.js's default +/-5
 * orthographic box — a ~10x10 column at the world origin — no matter how large the room was.
 * A string match cannot see that, because the string was there.
 *
 * These tests run the real _fitShadowCamera(), setShadowsEnabled() and setShadowMapSize() against
 * injected module state and assert on the numbers that come out. The central one is simple: the
 * fitted frustum must actually contain the room.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

function sliceFn(name) {
	const re = new RegExp(`^function ${name}\\(`, 'm');
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

/** Pull `const _SUN_OFFSET = {...};` out of source so the test uses the shipped angle. */
function sunOffset() {
	const m = DC_SOURCE.match(/^const _SUN_OFFSET = (\{[^}]*\});$/m);
	if (!m) throw new Error('_SUN_OFFSET not found in dc.js');
	// eslint-disable-next-line no-new-func
	return new Function('return ' + m[1])();
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeSunLight() {
	const vec = () => ({
		x: 0, y: 0, z: 0,
		set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; },
	});
	return {
		castShadow: true,
		position: vec(),
		target: { position: vec(), updateMatrixWorld() { this._updated = (this._updated || 0) + 1; } },
		updateMatrixWorld() { this._updated = (this._updated || 0) + 1; },
		shadow: {
			bias: -0.001,
			normalBias: 0.02,
			map: null,
			mapSize: { x: 0, y: 0, set(w, h) { this.x = w; this.y = h; } },
			camera: {
				left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 500,
				_projUpdates: 0,
				updateProjectionMatrix() { this._projUpdates++; },
			},
		},
	};
}

/** Run _fitShadowCamera() with a given roomBounds and return the resulting shadow camera. */
function fit(roomBounds, light = fakeSunLight()) {
	// eslint-disable-next-line no-new-func
	const fn = new Function('_sunLight', 'roomBounds', '_SUN_OFFSET',
		sliceFn('_fitShadowCamera') + '\nreturn _fitShadowCamera;')(light, roomBounds, sunOffset());
	fn();
	return { cam: light.shadow.camera, light };
}

// A room 200 x 140 sitting a long way from the world origin — which is the normal case, because
// rack coordinates are converted into world space per location.
const FAR_ROOM = { minX: 900, maxX: 1100, minZ: -700, maxZ: -560 };
const ORIGIN_ROOM = { minX: -100, maxX: 100, minZ: -70, maxZ: 70 };

// ---------------------------------------------------------------------------
describe('dc.js — _fitShadowCamera()', () => {

	it('does nothing without a light or without roomBounds', () => {
		const light = fakeSunLight();
		// eslint-disable-next-line no-new-func
		const fn = new Function('_sunLight', 'roomBounds', '_SUN_OFFSET',
			sliceFn('_fitShadowCamera') + '\nreturn _fitShadowCamera;')(light, null, sunOffset());
		expect(() => fn()).not.toThrow();
		expect(light.shadow.camera._projUpdates).toBe(0);
	});

	it('produces a frustum that CONTAINS the room, not one anchored at the origin', () => {
		// The bug in one assertion. three.js's default box is +/-5; the shipped code left it that
		// way because the guard bailed, and even when it did run it wrote WORLD X/Z into
		// light-view-space fields, so a room centred at (1000, -630) fell outside entirely.
		const { cam } = fit(FAR_ROOM);
		const halfDiagonal = 0.5 * Math.hypot(200, 140);
		expect(cam.right).toBeGreaterThanOrEqual(halfDiagonal);
		expect(cam.top).toBeGreaterThanOrEqual(halfDiagonal);
		expect(cam.left).toBe(-cam.right);
		expect(cam.bottom).toBe(-cam.top);
	});

	it('re-anchors the light over the room instead of leaving it at the world origin', () => {
		const off = sunOffset();
		const { light } = fit(FAR_ROOM);
		const cx = (FAR_ROOM.minX + FAR_ROOM.maxX) / 2;
		const cz = (FAR_ROOM.minZ + FAR_ROOM.maxZ) / 2;
		// Target on the room centre, light at the same offset from it — so the sun angle is
		// identical in every building while the frustum still brackets this one.
		expect(light.target.position.x).toBe(cx);
		expect(light.target.position.z).toBe(cz);
		expect(light.position.x).toBe(cx + off.x);
		expect(light.position.y).toBe(off.y);
		expect(light.position.z).toBe(cz + off.z);
	});

	it('updates both world matrices — a stale one aims the shadow camera at the last room', () => {
		const { light } = fit(FAR_ROOM);
		expect(light._updated).toBeGreaterThan(0);
		expect(light.target._updated).toBeGreaterThan(0);
	});

	it('sets a far plane that reaches past the room', () => {
		const off = sunOffset();
		const { cam } = fit(FAR_ROOM);
		const lightDist = Math.hypot(off.x, off.y, off.z);
		expect(cam.near).toBeGreaterThan(0);
		expect(cam.far).toBeGreaterThan(lightDist);
		expect(cam.far).toBeGreaterThan(cam.near);
	});

	it('rebuilds the projection matrix', () => {
		const { cam } = fit(FAR_ROOM);
		expect(cam._projUpdates).toBeGreaterThan(0);
	});

	it('grows the frustum for a larger room', () => {
		const small = fit({ minX: 0, maxX: 40, minZ: 0, maxZ: 40 }).cam.right;
		const large = fit({ minX: 0, maxX: 400, minZ: 0, maxZ: 400 }).cam.right;
		expect(large).toBeGreaterThan(small);
	});

	it('gives the same frustum size for the same room wherever it sits in the world', () => {
		// Size depends on extents, position on the centre — a room moved 1000 units should not
		// change how big the box is.
		const a = fit(ORIGIN_ROOM).cam;
		const b = fit(FAR_ROOM).cam;
		expect(b.right).toBeCloseTo(a.right, 6);
		expect(b.top).toBeCloseTo(a.top, 6);
	});

});

describe('dc.js — the fit is wired to the room build, not to init()', () => {

	it('buildRoom() calls _fitShadowCamera() after assigning roomBounds', () => {
		// Ordering is the entire defect: init()'s call ran before any room existed, so the guard
		// `if (!_sunLight || !roomBounds) return;` fired every time and the frustum was never set.
		// A behavioural test of the function alone cannot see a call site in the wrong place.
		const body = sliceFn('buildRoom');
		const boundsAt = body.indexOf('roomBounds = {');
		const fitAt = body.indexOf('_fitShadowCamera()');
		expect(boundsAt, 'buildRoom() no longer assigns roomBounds').toBeGreaterThan(-1);
		expect(fitAt, 'buildRoom() does not call _fitShadowCamera()').toBeGreaterThan(-1);
		expect(fitAt).toBeGreaterThan(boundsAt);
	});

	it('the room floor receives shadows', () => {
		// Without a receiver, racks can only cast onto other racks — and "racks read as floating",
		// the stated purpose of Phase 6, stays unfixed however well the frustum is fitted.
		const body = sliceFn('buildRoom');
		expect(body).toMatch(/floor\.receiveShadow\s*=\s*true/);
	});

	it('the walls and ceiling receive shadows too', () => {
		const body = sliceFn('buildRoom');
		expect(body).toMatch(/walls\.traverse\([\s\S]{0,120}receiveShadow\s*=\s*true/);
		expect(body).toMatch(/ceiling\.traverse\([\s\S]{0,120}receiveShadow\s*=\s*true/);
	});

});

describe('dc.js — the sun light', () => {

	it('is declared at module scope and casts', () => {
		expect(DC_SOURCE).toMatch(/^let _sunLight\s*=/m);
		expect(DC_SOURCE).toContain('_sunLight.castShadow = true');
	});

	it('has its shadow map size set at creation', () => {
		// It was never set, so three.js allocated at its 512 default while _shadowMapSize,
		// S.shadowMapSize and the GUI all claimed something else.
		expect(DC_SOURCE).toMatch(/_sunLight\.shadow\.mapSize\.set\(_shadowMapSize, _shadowMapSize\)/);
	});

	it('has bias and normalBias set, and its target added to the scene', () => {
		expect(DC_SOURCE).toContain('_sunLight.shadow.bias');
		expect(DC_SOURCE).toContain('_sunLight.shadow.normalBias');
		expect(DC_SOURCE).toContain('scene.add(_sunLight.target)');
	});

	it('asks for a shadow map type each renderer actually supports', () => {
		// PCFSoftShadowMap is deprecated on the classic WebGL path — WebGLShadowMap.js converts it
		// to PCFShadowMap and warns on every page load — but is genuinely supported on the node
		// path. Asking unconditionally bought a console warning and PCFShadowMap anyway.
		expect(DC_SOURCE).toMatch(/renderer\.shadowMap\.type\s*=\s*caps\.isNode\s*\?\s*THREE\.PCFSoftShadowMap\s*:\s*THREE\.PCFShadowMap/);
	});

});
