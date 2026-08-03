/**
 * tests/js/dc-caps.test.js — Step 7.1 renderer-capability module (repaired by R2.4)
 *
 * These tests import the real dc-caps.js and call describeRenderer() with fixtures shaped like
 * the renderers three.js ACTUALLY ships. That distinction is the whole point of this file's
 * rewrite: the previous version's fixtures were reverse-engineered from the implementation, so
 * `info: { type: 'offscreen' }` and `_tslm: true` described properties on no real renderer, and
 * every assertion passed while the module returned isNode:false for a WebGPURenderer in a
 * browser. Fixtures that only exist to satisfy the code under test cannot detect that the code
 * is wrong.
 *
 * The discriminators asserted here were verified against node_modules/three on 2026-08-03:
 *   src/renderers/webgpu/WebGPURenderer.js:95   this.isWebGPURenderer = true
 *   src/renderers/webgpu/WebGPUBackend.js:88    this.isWebGPUBackend = true
 *   src/renderers/common/Renderer.js:113        this.backend = backend
 *   src/renderers/WebGLRenderer.js              has NO .backend at all
 * The contract test at the bottom re-checks those against the installed package, so an upgrade
 * that renames one fails here rather than silently in a browser.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { describeRenderer, backendLabel } from '../../public_html/js/dc-caps.js';

const fs = require('node:fs');
const path = require('node:path');

const DC_CAPS_JS = path.resolve(__dirname, '../../public_html/js/dc-caps.js');
const DC_CAPS_SOURCE = fs.readFileSync(DC_CAPS_JS, 'utf8');
const THREE_SRC = path.resolve(__dirname, '../../node_modules/three/src');

// ---------------------------------------------------------------------------
// Fixtures — modelled on what each real renderer exposes, nothing more.
// ---------------------------------------------------------------------------

/** Classic THREE.WebGLRenderer: an isWebGLRenderer marker, a shadowMap, and NO .backend. */
function classicWebGL() {
	return { isWebGLRenderer: true, shadowMap: { enabled: false, type: 0 } };
}

/** THREE.WebGPURenderer that got a real WebGPU device. */
function nodeWebGPU() {
	return {
		isWebGPURenderer: true,
		backend: { isWebGPUBackend: true },
		shadowMap: { enabled: false },
	};
}

/**
 * THREE.WebGPURenderer that fell back to its WebGL2 backend — what ?renderer=webgpu produces on
 * any machine without navigator.gpu, and what ?renderer=webgpu-gl forces. Renderer.js:791
 * reassigns this.backend on fallback, so isWebGPUBackend is simply absent.
 */
function nodeWebGL2Fallback() {
	return {
		isWebGPURenderer: true,
		backend: { isWebGLBackend: true },
		shadowMap: { enabled: false },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc-caps.js — Step 7.1 renderer capability detection', () => {

	describe('module structure', () => {

		it('exports describeRenderer and backendLabel', () => {
			expect(typeof describeRenderer).toBe('function');
			expect(typeof backendLabel).toBe('function');
		});

		it('has no import-time side effects — the module imports nothing', () => {
			// It used to `import * as THREE from 'three'` without using THREE, which pulled the
			// whole engine into every Vitest run for nothing. The module must stay pure so it can
			// be tested without a WebGL context.
			expect(DC_CAPS_SOURCE).not.toMatch(/^\s*import\s/m);
		});

		it('references no fabricated three.js properties', () => {
			// Guarding a contract that must not silently drift back: both of these were invented,
			// and both silently pinned a capability to false. A source assertion is the right tool
			// here — the point is that neither may reappear as executable code. Comments are
			// stripped first: the file's header deliberately NAMES both properties to explain why
			// they are gone, and that documentation must not trip its own guard.
			const code = DC_CAPS_SOURCE
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/\/\/[^\n]*/g, '');
			expect(code).not.toMatch(/_tslm/);
			expect(code).not.toMatch(/offscreen/);
		});

	});

	describe('returned object shape', () => {

		const caps = describeRenderer(classicWebGL());

		it('returns an object with all required fields', () => {
			for (const key of ['isNode', 'backend', 'shadowTypeSettable', 'supportsTSL',
				'supportsCompute', 'supportsOcclusionQuery', 'supportsEffectComposer']) {
				expect(caps).toHaveProperty(key);
			}
		});

		it('all returned values are booleans except backend (string)', () => {
			expect(typeof caps.isNode).toBe('boolean');
			expect(typeof caps.backend).toBe('string');
			expect(typeof caps.shadowTypeSettable).toBe('boolean');
			expect(typeof caps.supportsTSL).toBe('boolean');
			expect(typeof caps.supportsCompute).toBe('boolean');
			expect(typeof caps.supportsOcclusionQuery).toBe('boolean');
			expect(typeof caps.supportsEffectComposer).toBe('boolean');
		});

	});

	describe('isNode detection', () => {

		it('is false for a classic WebGLRenderer', () => {
			expect(describeRenderer(classicWebGL()).isNode).toBe(false);
		});

		it('is true for a WebGPURenderer on the WebGPU backend', () => {
			expect(describeRenderer(nodeWebGPU()).isNode).toBe(true);
		});

		it('is true for a WebGPURenderer that fell back to WebGL2', () => {
			// The node renderer is still the node renderer after a backend fallback — this is the
			// case ?renderer=webgpu hits on a machine with no navigator.gpu, and calling it
			// "classic WebGL" is what broke DC.backendName and the context-loss wiring.
			expect(describeRenderer(nodeWebGL2Fallback()).isNode).toBe(true);
		});

		it('is true from .backend alone, even without the isWebGPURenderer marker', () => {
			// Structural fallback: the pre-Phase-7 code discriminated on .backend and worked.
			expect(describeRenderer({ backend: { isWebGPUBackend: true } }).isNode).toBe(true);
		});

	});

	describe('backend string — the three values dc-renderer-mode.js specifies', () => {

		it('classic WebGLRenderer  → "webgl"', () => {
			expect(describeRenderer(classicWebGL()).backend).toBe('webgl');
		});

		it('WebGPURenderer + WebGPUBackend → "webgpu"', () => {
			expect(describeRenderer(nodeWebGPU()).backend).toBe('webgpu');
		});

		it('WebGPURenderer + WebGL2 backend → "webgl2-fallback"', () => {
			expect(describeRenderer(nodeWebGL2Fallback()).backend).toBe('webgl2-fallback');
		});

		it('never returns a three.js class name', () => {
			// The broken version returned 'WebGLRenderer' / 'WebGPURenderer' / 'WebGL2Renderer',
			// which no consumer expected: dc.js compared against 'WebGPURenderer' and
			// DC.backendName is documented as one of the three lowercase values.
			for (const r of [classicWebGL(), nodeWebGPU(), nodeWebGL2Fallback()]) {
				expect(['webgl', 'webgpu', 'webgl2-fallback']).toContain(describeRenderer(r).backend);
			}
		});

	});

	describe('capability flags follow the renderer family', () => {

		it('supportsTSL is a node-renderer capability — true on BOTH node backends', () => {
			expect(describeRenderer(classicWebGL()).supportsTSL).toBe(false);
			expect(describeRenderer(nodeWebGPU()).supportsTSL).toBe(true);
			// The WebGL2 fallback compiles the same TSL node graph down to GLSL, so gating the
			// TSL postprocessing path on backend === 'webgpu' would wrongly exclude webgpu-gl.
			expect(describeRenderer(nodeWebGL2Fallback()).supportsTSL).toBe(true);
		});

		it('supportsEffectComposer is WebGL-only — the classic GLSL chain', () => {
			expect(describeRenderer(classicWebGL()).supportsEffectComposer).toBe(true);
			// This is what makes the AO toggle disappear on the node path, where it does nothing.
			expect(describeRenderer(nodeWebGPU()).supportsEffectComposer).toBe(false);
			expect(describeRenderer(nodeWebGL2Fallback()).supportsEffectComposer).toBe(false);
		});

		it('supportsEffectComposer and supportsTSL are never both true', () => {
			// They select the two arms of dc.js's render branch; overlap means both AO paths set
			// up against one renderer.
			for (const r of [classicWebGL(), nodeWebGPU(), nodeWebGL2Fallback()]) {
				const c = describeRenderer(r);
				expect(c.supportsEffectComposer && c.supportsTSL).toBe(false);
			}
		});

		it('shadowTypeSettable is a classic-renderer concept', () => {
			expect(describeRenderer(classicWebGL()).shadowTypeSettable).toBe(true);
			expect(describeRenderer(nodeWebGPU()).shadowTypeSettable).toBe(false);
		});

		it('supportsCompute is real-WebGPU only — WebGL2 has no compute shaders', () => {
			expect(describeRenderer(classicWebGL()).supportsCompute).toBe(false);
			expect(describeRenderer(nodeWebGPU()).supportsCompute).toBe(true);
			expect(describeRenderer(nodeWebGL2Fallback()).supportsCompute).toBe(false);
		});

		it('supportsOcclusionQuery is real-WebGPU only', () => {
			// The old module returned true for plain WebGL2, which cannot do them at all.
			expect(describeRenderer(classicWebGL()).supportsOcclusionQuery).toBe(false);
			expect(describeRenderer(nodeWebGPU()).supportsOcclusionQuery).toBe(true);
			expect(describeRenderer(nodeWebGL2Fallback()).supportsOcclusionQuery).toBe(false);
		});

	});

	describe('describeRenderer(null)', () => {

		it('does not throw', () => {
			expect(() => describeRenderer(null)).not.toThrow();
			expect(() => describeRenderer(undefined)).not.toThrow();
		});

		it('returns an all-false descriptor with backend "unknown"', () => {
			const caps = describeRenderer(null);
			expect(caps.backend).toBe('unknown');
			for (const key of ['isNode', 'shadowTypeSettable', 'supportsTSL', 'supportsCompute',
				'supportsOcclusionQuery', 'supportsEffectComposer']) {
				expect(caps[key]).toBe(false);
			}
		});

	});

	describe('backendLabel()', () => {

		it('maps each backend value to its UI string', () => {
			expect(backendLabel('webgl')).toBe('WebGL');
			expect(backendLabel('webgpu')).toBe('WebGPU');
			expect(backendLabel('webgl2-fallback')).toBe('WebGPU (GL)');
		});

		it('passes an unknown value through rather than rendering undefined', () => {
			expect(backendLabel('unknown')).toBe('unknown');
		});

		it('labels every value describeRenderer can produce', () => {
			for (const r of [classicWebGL(), nodeWebGPU(), nodeWebGL2Fallback(), null]) {
				const label = backendLabel(describeRenderer(r).backend);
				expect(typeof label).toBe('string');
				expect(label.length).toBeGreaterThan(0);
			}
		});

	});

	describe('the discriminators still exist in the installed three.js', () => {
		// If a three.js upgrade renames these, the browser silently reverts to the exact bug R2.4
		// fixed: every flag pinned false and DC.backendName stuck on 'webgl'. Fail here instead.

		it('WebGPURenderer sets isWebGPURenderer', () => {
			const src = fs.readFileSync(path.join(THREE_SRC, 'renderers/webgpu/WebGPURenderer.js'), 'utf8');
			expect(src).toMatch(/this\.isWebGPURenderer\s*=\s*true/);
		});

		it('WebGPUBackend sets isWebGPUBackend', () => {
			const src = fs.readFileSync(path.join(THREE_SRC, 'renderers/webgpu/WebGPUBackend.js'), 'utf8');
			expect(src).toMatch(/this\.isWebGPUBackend\s*=\s*true/);
		});

		it('the common Renderer assigns this.backend', () => {
			const src = fs.readFileSync(path.join(THREE_SRC, 'renderers/common/Renderer.js'), 'utf8');
			expect(src).toMatch(/this\.backend\s*=\s*backend/);
		});

		it('the classic WebGLRenderer still has no .backend', () => {
			const src = fs.readFileSync(path.join(THREE_SRC, 'renderers/WebGLRenderer.js'), 'utf8');
			expect(src).not.toMatch(/this\.backend\s*=/);
		});

	});

});
