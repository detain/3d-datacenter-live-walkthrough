/**
 * tests/js/dc-isolate.test.js — Step 9.5 isolate render pass (rewritten by R2.6)
 *
 * The old version asserted `if (!m.transparent) continue` MUST be present — the exact line that
 * made the feature a no-op. Every mesh in this scene uses an opaque material, so the pass skipped
 * all of them and nothing was ever dimmed. It also asserted the state Map was keyed by `obj.id`,
 * which corrupts shared materials permanently: materials are shared here (one wallMat for every
 * wall), so object B would record material M's already-dimmed 0.3 as M's "original" and
 * clearIsolate() then pinned it at 0.3 forever.
 *
 * These tests run the real setIsolate()/clearIsolate() against a scene graph of fake meshes and
 * assert the opacity values that come out — including the shared-material case and the
 * isolate-twice case, which are the two that silently corrupt.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

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

/** An opaque MeshStandardMaterial-ish object — the default in this scene. */
function material(opacity = 1) {
	return { opacity, transparent: false, depthWrite: true, needsUpdate: false };
}

let nextId = 1;
function mesh(mat) {
	return { isMesh: true, id: nextId++, material: mat };
}

function makeIsolate(meshes) {
	const scene = { traverse(cb) { for (const m of meshes) cb(m); } };
	const src = [
		'const _isolateState = new Map();',
		DC_SOURCE.match(/^const ISOLATE_DIM = [\d.]+;$/m)[0],
		sliceFn('_restoreIsolateMaterial'),
		sliceFn('setIsolate'),
		sliceFn('clearIsolate'),
		'return { setIsolate, clearIsolate, savedCount: () => _isolateState.size };',
	].join('\n');
	// eslint-disable-next-line no-new-func
	return new Function('scene', src)(scene);
}

/** The dim value the module actually uses, read from source so the test cannot drift from it. */
const DIM = Number(DC_SOURCE.match(/^const ISOLATE_DIM = ([\d.]+);$/m)[1]);

// ---------------------------------------------------------------------------
describe('dc.js — setIsolate()', () => {

	it('dims an OPAQUE mesh — the ones this scene is made of', () => {
		// The whole defect. `if (!m.transparent) continue` skipped every opaque material, which
		// is all of them, so isolate looked implemented and did nothing.
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(b.material.opacity).toBe(DIM);
	});

	it('SETS transparent and clears depthWrite on the dimmed material', () => {
		// Opacity alone does nothing on an opaque material — three.js ignores it unless
		// transparent is true. depthWrite off stops the dimmed mesh occluding what it reveals.
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(b.material.transparent).toBe(true);
		expect(b.material.depthWrite).toBe(false);
		expect(b.material.needsUpdate).toBe(true);
	});

	it('leaves the isolated mesh fully opaque', () => {
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(a.material.opacity).toBe(1);
		expect(a.material.transparent).toBe(false);
	});

	it('handles an array of materials on one mesh', () => {
		const mats = [material(), material()];
		const a = mesh(material()), b = mesh(mats);
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		for (const m of mats) expect(m.opacity).toBe(DIM);
	});

	it('ignores non-mesh nodes and meshes with no material', () => {
		const nodes = [{ isMesh: false, id: 900 }, { isMesh: true, id: 901, material: null }];
		const a = mesh(material());
		const iso = makeIsolate([...nodes, a]);
		expect(() => iso.setIsolate(new Set([a.id]))).not.toThrow();
	});

});

describe('dc.js — shared materials', () => {

	it('records the PRISTINE opacity once, not the already-dimmed value', () => {
		// The corruption: three meshes share one material. Keying saved state by object id let
		// the second mesh record 0.3 as the "original", so restoring put it back to 0.3.
		const shared = material(1);
		const a = mesh(material()), b = mesh(shared), c = mesh(shared), d = mesh(shared);
		const iso = makeIsolate([a, b, c, d]);
		iso.setIsolate(new Set([a.id]));
		expect(shared.opacity).toBe(DIM);
		iso.clearIsolate();
		expect(shared.opacity).toBe(1);
	});

	it('saves one entry per material, not one per mesh', () => {
		const shared = material();
		const a = mesh(material()), b = mesh(shared), c = mesh(shared);
		const iso = makeIsolate([a, b, c]);
		iso.setIsolate(new Set([a.id]));
		expect(iso.savedCount()).toBe(1);
	});

	it('survives isolating twice without corrupting opacity', () => {
		// Isolate A, then isolate B without clearing in between. The second pass must not treat
		// the dimmed value as pristine.
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		iso.setIsolate(new Set([b.id]));
		iso.clearIsolate();
		expect(a.material.opacity).toBe(1);
		expect(b.material.opacity).toBe(1);
	});

	it('un-dims a mesh that moves INTO the keep set', () => {
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(b.material.opacity).toBe(DIM);
		iso.setIsolate(new Set([a.id, b.id]));
		expect(b.material.opacity).toBe(1);
		expect(b.material.transparent).toBe(false);
	});

});

describe('dc.js — clearIsolate()', () => {

	it('restores opacity, transparent AND depthWrite', () => {
		// Restoring opacity alone leaves the material in the transparent render queue with depth
		// writes off — it sorts wrongly against everything behind it, for the rest of the session.
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		iso.clearIsolate();
		expect(b.material.opacity).toBe(1);
		expect(b.material.transparent).toBe(false);
		expect(b.material.depthWrite).toBe(true);
	});

	it('restores a material that was ALREADY transparent to its own values', () => {
		const glass = { opacity: 0.34, transparent: true, depthWrite: false, needsUpdate: false };
		const a = mesh(material()), b = mesh(glass);
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(glass.opacity).toBe(DIM);
		iso.clearIsolate();
		expect(glass.opacity).toBe(0.34);
		expect(glass.transparent).toBe(true);
		expect(glass.depthWrite).toBe(false);
	});

	it('empties the saved state', () => {
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		iso.clearIsolate();
		expect(iso.savedCount()).toBe(0);
	});

	it('is a no-op when nothing is isolated', () => {
		const a = mesh(material());
		const iso = makeIsolate([a]);
		expect(() => iso.clearIsolate()).not.toThrow();
		expect(a.material.opacity).toBe(1);
	});

	it('restores a material whose mesh has since left the scene', () => {
		// A location switch or LOD swap removes the mesh, but the material may still be shared
		// with something on screen. Iterating the scene (as this used to) would miss it.
		const orphan = material();
		const a = mesh(material()), b = mesh(orphan);
		const scene = { _nodes: [a, b], traverse(cb) { for (const m of this._nodes) cb(m); } };
		const src = [
			'const _isolateState = new Map();',
			DC_SOURCE.match(/^const ISOLATE_DIM = [\d.]+;$/m)[0],
			sliceFn('_restoreIsolateMaterial'),
			sliceFn('setIsolate'),
			sliceFn('clearIsolate'),
			'return { setIsolate, clearIsolate };',
		].join('\n');
		// eslint-disable-next-line no-new-func
		const iso = new Function('scene', src)(scene);
		iso.setIsolate(new Set([a.id]));
		expect(orphan.opacity).toBe(DIM);
		scene._nodes = [a];              // b is gone
		iso.clearIsolate();
		expect(orphan.opacity).toBe(1);
	});

});

describe('dc.js — setIsolate() guards', () => {

	it('does not throw on null — it clears instead', () => {
		// DC.setIsolate(null) threw on keepSet.has().
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		expect(() => iso.setIsolate(null)).not.toThrow();
		expect(b.material.opacity).toBe(1);
	});

	it('treats an empty set as "isolate nothing"', () => {
		const a = mesh(material()), b = mesh(material());
		const iso = makeIsolate([a, b]);
		iso.setIsolate(new Set([a.id]));
		iso.setIsolate(new Set());
		expect(b.material.opacity).toBe(1);
		expect(a.material.opacity).toBe(1);
	});

	it('does not throw on a non-Set argument', () => {
		const a = mesh(material());
		const iso = makeIsolate([a]);
		expect(() => iso.setIsolate(['not', 'a', 'set'])).not.toThrow();
		expect(() => iso.setIsolate(42)).not.toThrow();
	});

});

describe('dc.js — integration points', () => {

	it('both functions are on window.DC', () => {
		expect(DC_SOURCE).toMatch(/setIsolate:\s*setIsolate/);
		expect(DC_SOURCE).toMatch(/clearIsolate:\s*clearIsolate/);
	});

	it('Escape clears the isolate', () => {
		expect(DC_SOURCE).toMatch(/case\s+"Escape":/);
		expect(DC_SOURCE).toMatch(/clearIsolate\(\);/);
	});

	it('clearScene() clears the isolate', () => {
		// Saved state keyed by material outlives the meshes; not clearing on a location switch
		// leaks entries for materials that are about to be disposed.
		const body = sliceFn('clearScene');
		expect(body).toMatch(/clearIsolate\(\)/);
	});

	it('the no-op guard is gone', () => {
		// Regression guard: `if (!m.transparent) continue` inside the isolate pass is the exact
		// line that made the feature do nothing, and it read as a sensible optimisation.
		const body = sliceFn('setIsolate') + sliceFn('clearIsolate');
		expect(body).not.toMatch(/if\s*\(!m\.transparent\)\s*continue/);
	});

});
