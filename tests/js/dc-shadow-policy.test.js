/**
 * tests/js/dc-shadow-policy.test.js — Step 6.5 shadow policy (rewritten by R2.3)
 *
 * Step 6.5 existed to REPLACE four copy-pasted `traverse(n => { n.castShadow = true; ... })`
 * blocks with one applyShadowPolicy(). The function was written and then never called, and this
 * test file asserted that the copy-pasted blocks must still be present — so it enforced exactly
 * the state the step was meant to remove. It also hardcoded `expect(matches.length).toBe(2)` for
 * cable creation sites when there were three; the third, the cached-reuse branch, had no shadow
 * flags at all, which meant cable shadow behaviour depended on whether the geometry cache hit.
 *
 * This version runs applyShadowPolicy() on real object graphs and asserts the flags it produces,
 * then checks that the call sites exist and the duplicated blocks are gone.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

function sliceFn(name) {
	const re = new RegExp(`^function ${name}\\(`, 'm');
	const start = SRC.search(re);
	if (start < 0) throw new Error(`${name}() not found in dc.js — was it renamed?`);
	let depth = 0, seen = false;
	for (let i = start; i < SRC.length; i++) {
		const ch = SRC[i];
		if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
			depth--;
			if (seen && depth === 0) return SRC.slice(start, i + 1);
		}
	}
	throw new Error(`${name}() has unbalanced braces`);
}

// eslint-disable-next-line no-new-func
const applyShadowPolicy = new Function(sliceFn('applyShadowPolicy') + '\nreturn applyShadowPolicy;')();

/** Minimal Object3D graph with a real traverse(), including self — as three.js does. */
function node(isMesh, children = []) {
	const n = { isMesh, children, castShadow: undefined, receiveShadow: undefined };
	n.traverse = function (cb) { cb(this); for (const c of this.children) c.traverse(cb); };
	return n;
}

function mesh() { return node(true); }
function group(...children) { return node(false, children); }

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

// ---------------------------------------------------------------------------
describe("applyShadowPolicy() — 'model' (the default)", () => {

	it('makes every mesh cast and receive', () => {
		const a = mesh(), b = mesh();
		applyShadowPolicy(group(a, group(b)));
		for (const m of [a, b]) {
			expect(m.castShadow).toBe(true);
			expect(m.receiveShadow).toBe(true);
		}
	});

	it('reaches nested children, not just direct ones', () => {
		const deep = mesh();
		applyShadowPolicy(group(group(group(deep))));
		expect(deep.castShadow).toBe(true);
	});

	it('leaves non-mesh nodes untouched', () => {
		// Setting castShadow on a Group is harmless but meaningless; skipping them keeps the
		// policy about what it claims to be about.
		const g = group(mesh());
		applyShadowPolicy(g);
		expect(g.castShadow).toBeUndefined();
	});

	it('accepts a bare Mesh — Object3D.traverse() visits the node itself', () => {
		// The cable sites pass a single Mesh, not a Group.
		const m = mesh();
		applyShadowPolicy(m);
		expect(m.castShadow).toBe(true);
		expect(m.receiveShadow).toBe(true);
	});

});

describe("applyShadowPolicy() — 'cable'", () => {

	it('receives but never casts', () => {
		// A 3 cm bundle casts nothing readable at this scale and would cost a shadow-map draw per
		// merged run.
		const m = mesh();
		applyShadowPolicy(m, 'cable');
		expect(m.castShadow).toBe(false);
		expect(m.receiveShadow).toBe(true);
	});

	it('overwrites a previously-set cast flag rather than leaving it', () => {
		const m = mesh();
		applyShadowPolicy(m);                  // model policy first
		applyShadowPolicy(m, 'cable');         // then cable
		expect(m.castShadow).toBe(false);
	});

});

describe("applyShadowPolicy() — 'light'", () => {

	it('neither casts nor receives — it IS the light source', () => {
		const m = mesh();
		applyShadowPolicy(m, 'light');
		expect(m.castShadow).toBe(false);
		expect(m.receiveShadow).toBe(false);
	});

});

describe('the call sites', () => {
	const code = stripComments(SRC);

	it('is actually called — it was defined and never used', () => {
		const calls = code.match(/(?<!function\s)applyShadowPolicy\s*\(/g) || [];
		expect(calls.length).toBeGreaterThanOrEqual(7);
	});

	it('the four copy-pasted model traverse blocks are gone', () => {
		// The exact shape Step 6.5 was written to delete, and which this file used to require.
		expect(code).not.toMatch(/traverse\(\(n\)\s*=>\s*\{\s*if\s*\(n\.isMesh\)\s*\{\s*n\.castShadow\s*=\s*true;\s*n\.receiveShadow\s*=\s*true;/);
		expect(code).not.toMatch(/n\.castShadow\s*=\s*true;\s*\n\s*n\.receiveShadow\s*=\s*true;/);
	});

	it('every cable creation site applies the cable policy — all THREE of them', () => {
		// There are three: the async merge path, the sync merge path, and the cached-reuse
		// branch. The third had no shadow flags at all, so whether cables took light and shadow
		// depended on whether the geometry cache happened to hit. The old test hardcoded 2.
		const sites = code.match(/applyShadowPolicy\([^)]*,\s*'cable'\)/g) || [];
		expect(sites).toHaveLength(3);
	});

	it('no cable site sets the flags by hand any more', () => {
		expect(code).not.toMatch(/cables\.castShadow\s*=/);
		expect(code).not.toMatch(/cables\.receiveShadow\s*=/);
	});

	it('the rack and server loaders both use it', () => {
		for (const fn of ['loadRackType', 'loadServerType']) {
			const body = stripComments(sliceFn(fn));
			expect(body, `${fn} does not call applyShadowPolicy`).toMatch(/applyShadowPolicy\(/);
			expect(body, `${fn} still sets shadow flags by hand`).not.toMatch(/n\.castShadow\s*=/);
		}
	});

});
