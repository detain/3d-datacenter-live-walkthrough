/**
 * tests/js/dc-pixel-ratio.test.js — pixel ratio, Step 4.2 / F-10 (rewritten by R3.2)
 *
 * The old version asserted that every `renderer.setPixelRatio(...)` line matched one canonical
 * formula. Four lines in dc.js did — and the fix Step 4.2 actually called for was to have ONE
 * line, not four identical ones. It also never looked at dc-multi.js, which had a fifth call
 * site with a DIFFERENT formula and its own `pixelScale` variable. Because the two files' `S`
 * objects are distinct, the overlay booted at 0.8, dc.js's S.pixelScale stayed 1.0, and the next
 * window resize restored full resolution. F-10 was unfixed and the test could not see it.
 *
 * The formula difference is not cosmetic:
 *   Math.min(dpr * scale, 2)   clamps the PRODUCT — on a 3x display at scale 0.8 this yields 2.0,
 *                              i.e. the quality reduction is silently discarded
 *   Math.min(dpr, 2) * scale   caps the device ratio, THEN scales — 1.6, the intended result
 *
 * These tests run the real applyPixelRatio() and setPixelScale() against a fake renderer.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_MULTI_JS = path.resolve(__dirname, '../../public_html/js/dc-multi.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');
const DC_MULTI_SOURCE = fs.readFileSync(DC_MULTI_JS, 'utf8');

function sliceFn(source, name) {
	const re = new RegExp(`^function ${name}\\(`, 'm');
	const start = source.search(re);
	if (start < 0) throw new Error(`${name}() not found — was it renamed?`);
	let depth = 0, seen = false;
	for (let i = start; i < source.length; i++) {
		const ch = source[i];
		if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
			depth--;
			if (seen && depth === 0) return source.slice(start, i + 1);
		}
	}
	throw new Error(`${name}() has unbalanced braces`);
}

/**
 * Live sandbox over the real applyPixelRatio + setPixelScale.
 *
 * R3.7 gave applyPixelRatio() a second job: the post-processing targets have to follow the pixel
 * ratio, or the quality scaler can drop to 0.5 while ambient occlusion keeps rendering at full
 * resolution — the one place where it costs the most and helps the least. resizePostFX() is
 * sliced in with it rather than stubbed, so that coupling is exercised here rather than asserted.
 */
function makeHarness({ dpr = 1, pixelScale = 1.0, renderer = true, composer = true, postFX = false } = {}) {
	const applied = [];
	const resized = [];
	const rendererStub = renderer ? { setPixelRatio: (v) => applied.push(v) } : null;
	const S = { pixelScale };
	const _composer = composer ? { setSize: (w, h) => resized.push(['composer', w, h]) } : null;
	const _postProcessing = postFX
		? { post: {}, scenePass: { setSize: (w, h) => resized.push(['scenePass', w, h]) } }
		: null;
	const src = [
		sliceFn(DC_SOURCE, 'applyPixelRatio'),
		sliceFn(DC_SOURCE, 'setPixelScale'),
		sliceFn(DC_SOURCE, 'resizePostFX'),
		'return { applyPixelRatio, setPixelScale, resizePostFX, scale: () => S.pixelScale };',
	].join('\n');
	// eslint-disable-next-line no-new-func
	const api = new Function('renderer', 'S', 'window', '_composer', '_postProcessing', src)(
		rendererStub, S, { devicePixelRatio: dpr, innerWidth: 1280, innerHeight: 720 },
		_composer, _postProcessing);
	return { ...api, applied, resized, S };
}

// ---------------------------------------------------------------------------
describe('dc.js — applyPixelRatio()', () => {

	it('caps the DEVICE ratio at 2 and then applies the scale', () => {
		// The whole formula bug. Clamping the product instead gives 2.0 here — full resolution,
		// no reduction at all, on exactly the high-DPR devices that need one.
		const h = makeHarness({ dpr: 3, pixelScale: 0.8 });
		h.applyPixelRatio();
		expect(h.applied).toEqual([Math.min(3, 2) * 0.8]);   // 1.6
		expect(h.applied[0]).not.toBe(2);
	});

	it('leaves a 1x display alone at full scale', () => {
		const h = makeHarness({ dpr: 1, pixelScale: 1.0 });
		h.applyPixelRatio();
		expect(h.applied).toEqual([1]);
	});

	it('scales a 1x display down', () => {
		const h = makeHarness({ dpr: 1, pixelScale: 0.5 });
		h.applyPixelRatio();
		expect(h.applied).toEqual([0.5]);
	});

	it('caps a 4x display before scaling', () => {
		const h = makeHarness({ dpr: 4, pixelScale: 1.0 });
		h.applyPixelRatio();
		expect(h.applied).toEqual([2]);
	});

	it('the reduction is always visible, at every device ratio', () => {
		// The property the product actually needs: turning quality down must lower the ratio,
		// whatever the display. Under the old formula this failed for every dpr >= 2.5.
		for (const dpr of [1, 1.5, 2, 3, 4]) {
			const full = makeHarness({ dpr, pixelScale: 1.0 });
			const half = makeHarness({ dpr, pixelScale: 0.5 });
			full.applyPixelRatio();
			half.applyPixelRatio();
			expect(half.applied[0], `dpr=${dpr}`).toBeLessThan(full.applied[0]);
		}
	});

	it('does nothing when there is no renderer yet', () => {
		const h = makeHarness({ renderer: false });
		expect(() => h.applyPixelRatio()).not.toThrow();
		expect(h.applied).toEqual([]);
	});

});

describe('dc.js — setPixelScale()', () => {

	it('writes S.pixelScale and applies it in one step', () => {
		const h = makeHarness({ dpr: 2, pixelScale: 1.0 });
		h.setPixelScale(0.75);
		expect(h.scale()).toBe(0.75);
		expect(h.applied).toEqual([1.5]);
	});

	it('clamps to the slider range', () => {
		const h = makeHarness({ dpr: 1 });
		expect(h.setPixelScale(0.1)).toBe(0.5);
		expect(h.setPixelScale(5)).toBe(1.0);
	});

	it('returns the clamped value so callers need not re-implement the clamp', () => {
		// dc-multi.js mirrors the result rather than computing its own.
		const h = makeHarness({ dpr: 1 });
		expect(h.setPixelScale(0.3)).toBe(0.5);
		expect(h.setPixelScale(0.9)).toBeCloseTo(0.9, 10);
	});

	it('ignores junk instead of setting NaN', () => {
		const h = makeHarness({ dpr: 1, pixelScale: 0.8 });
		h.setPixelScale('nonsense');
		expect(h.scale()).toBe(0.8);
		h.setPixelScale(undefined);
		expect(h.scale()).toBe(0.8);
	});

});

describe('there is exactly ONE owner of the pixel ratio', () => {

	it('dc.js calls renderer.setPixelRatio in one place', () => {
		// Step 4.2 asked for one call site and left four identical ones. Four identical formulas
		// is not one owner — it is four places to forget when the formula changes, which is how
		// dc-multi.js came to disagree.
		const calls = DC_SOURCE.match(/renderer\.setPixelRatio\s*\(/g) || [];
		expect(calls).toHaveLength(1);
	});

	it('that one place is inside applyPixelRatio()', () => {
		expect(sliceFn(DC_SOURCE, 'applyPixelRatio')).toMatch(/renderer\.setPixelRatio\s*\(/);
	});

	it('dc-multi.js does not touch the renderer pixel ratio at all', () => {
		expect(DC_MULTI_SOURCE).not.toMatch(/setPixelRatio\s*\(/);
	});

	it('dc-multi.js delegates to DC.setPixelScale', () => {
		const fn = sliceFn(DC_MULTI_SOURCE, 'setPixelScale');
		expect(fn).toMatch(/S\.DC[\s\S]*setPixelScale/);
	});

	it('DC exposes both entry points', () => {
		expect(DC_SOURCE).toMatch(/setPixelScale:\s*setPixelScale/);
		expect(DC_SOURCE).toMatch(/applyPixelRatio:\s*applyPixelRatio/);
	});

	it('the product-clamping formula is gone from both files', () => {
		// Regression guard: `Math.min(dpr * scale, 2)` reads as equivalent and is not.
		for (const [name, src] of [['dc.js', DC_SOURCE], ['dc-multi.js', DC_MULTI_SOURCE]]) {
			const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
			expect(code, name).not.toMatch(/Math\.min\s*\(\s*window\.devicePixelRatio\s*\*/);
		}
	});

});

describe('S.pixelScale', () => {

	it('defaults to 1.0 (full quality)', () => {
		expect(DC_SOURCE).toMatch(/pixelScale:\s*1\.0/);
	});

});

// ---------------------------------------------------------------------------
describe('dc.js — the pixel ratio drags the post-processing targets with it (R3.7)', () => {

	it('applyPixelRatio() resizes the WebGL composer', () => {
		// renderer.setSize()/setPixelRatio() do not reach a render target the composer owns, so
		// without this AO keeps rendering at the resolution it was built at.
		const h = makeHarness({ dpr: 1, pixelScale: 0.5 });
		h.applyPixelRatio();
		expect(h.resized).toEqual([['composer', 1280, 720]]);
	});

	it('applyPixelRatio() resizes the node pipeline\'s scene pass', () => {
		// PostProcessing/RenderPipeline does not forward setSize to the passes it wraps, so the
		// MRT has to be resized directly.
		const h = makeHarness({ composer: false, postFX: true });
		h.applyPixelRatio();
		expect(h.resized).toEqual([['scenePass', 1280, 720]]);
	});

	it('does nothing when neither pipeline was built', () => {
		const h = makeHarness({ composer: false, postFX: false });
		expect(() => h.applyPixelRatio()).not.toThrow();
		expect(h.resized).toEqual([]);
	});

	it('a quality-scaler downgrade resizes the post-processing chain too', () => {
		// The path that made this matter: setPixelScale() -> applyPixelRatio() -> resizePostFX().
		const h = makeHarness({ pixelScale: 1.0 });
		h.setPixelScale(0.5);
		expect(h.applied).toEqual([0.5]);
		expect(h.resized).toEqual([['composer', 1280, 720]]);
	});

	it('a rejected pixel scale does not resize anything', () => {
		const h = makeHarness({ pixelScale: 1.0 });
		h.setPixelScale('not a number');
		expect(h.resized).toEqual([]);
	});

	it('resizePostFX() survives a renderer-less early call', () => {
		// applyPixelRatio() bails on !renderer before reaching it, but resizePostFX() is also
		// called directly from onWindowResize(), which can fire before init() finishes.
		const h = makeHarness({ renderer: false });
		expect(() => h.resizePostFX()).not.toThrow();
	});

});
