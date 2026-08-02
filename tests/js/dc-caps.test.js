/**
 * tests/js/dc-caps.test.js — Step 7.1 renderer-capability module
 *
 * Verifies:
 * (a) describeRenderer is exported as a named export
 * (b) the returned object has all required fields (isNode, backend, shadowTypeSettable,
 *     supportsTSL, supportsCompute, supportsOcclusionQuery, supportsEffectComposer)
 * (c) isNode is true when renderer.info.type === 'offscreen'
 * (d) isNode is false for a classic WebGLRenderer
 * (e) backend string is correctly derived for WebGL1, WebGL2, and WebGPU renderers
 * (f) shadowTypeSettable, supportsEffectComposer are true for both WebGL and WebGPU
 * (g) supportsTSL and supportsCompute are true only for WebGPURenderer
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { describeRenderer } from '../../public_html/js/dc-caps.js';

const fs = require('node:fs');
const path = require('node:path');

const DC_CAPS_JS = path.resolve(__dirname, '../../public_html/js/dc-caps.js');
const DC_CAPS_SOURCE = fs.readFileSync(DC_CAPS_JS, 'utf8');

// ---------------------------------------------------------------------------
// Mock renderers
// ---------------------------------------------------------------------------

/**
 * Creates a mock WebGLRenderer-like object.
 * @param {object} opts
 * @param {boolean} [opts.isNode=false] - if true, sets info.type = 'offscreen'
 * @param {string} [opts.contextType='webgl2'] - 'webgl1' | 'webgl2'
 * @param {boolean} [opts.hasBackend=false] - if true, adds backend object
 * @param {boolean} [opts.isWebGPUBackend=false] - if true, backend.isWebGPUBackend = true
 */
function mockWebGLRenderer({ isNode = false, contextType = 'webgl2', hasBackend = false, isWebGPUBackend = false } = {}) {
	const ctx = contextType === 'webgl1'
		? /** @type {WebGLRenderingContext} */ ({ constructor: { name: 'WebGLRenderingContext' } })
		: /** @type {WebGL2RenderingContext} */ ({ constructor: { name: 'WebGL2RenderingContext' } });

	const backend = hasBackend
		? { isWebGPUBackend: isWebGPUBackend }
		: undefined;

	return {
		constructor: { name: 'WebGLRenderer' },
		info: { type: isNode ? 'offscreen' : 'resource' },
		getContext: () => ctx,
		shadowMap: {},  // presence of shadowMap means shadowTypeSettable = true
		backend,
	};
}

/**
 * Creates a mock WebGPURenderer-like object.
 * @param {object} opts
 * @param {boolean} [opts.isNode=false] - if true, sets info.type = 'offscreen'
 */
function mockWebGPURenderer({ isNode = false } = {}) {
	return {
		constructor: { name: 'WebGPURenderer' },
		info: { type: isNode ? 'offscreen' : 'resource' },
		shadowMap: {},
		_tslm: true,  // WebGPU renderer has this when TSL is supported
		compute: () => {},  // presence of compute means supportsCompute = true
		getContext: () => ({}),
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc-caps.js — Step 7.1 renderer capability detection', () => {

	describe('module structure', () => {

		it('(a) describeRenderer is exported as a named export', () => {
			expect(typeof describeRenderer).toBe('function');
		});

		it('dc-caps.js source contains the export statement', () => {
			expect(DC_CAPS_SOURCE).toMatch(/export\s+function\s+describeRenderer/);
		});

	});

	describe('returned object shape', () => {

		const mockRenderer = mockWebGLRenderer();
		const caps = describeRenderer(mockRenderer);

		it('(b) returns an object with all required fields', () => {
			expect(caps).toHaveProperty('isNode');
			expect(caps).toHaveProperty('backend');
			expect(caps).toHaveProperty('shadowTypeSettable');
			expect(caps).toHaveProperty('supportsTSL');
			expect(caps).toHaveProperty('supportsCompute');
			expect(caps).toHaveProperty('supportsOcclusionQuery');
			expect(caps).toHaveProperty('supportsEffectComposer');
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

		it('(c) isNode is true when renderer.info.type === "offscreen"', () => {
			const nodeRenderer = mockWebGLRenderer({ isNode: true });
			const caps = describeRenderer(nodeRenderer);
			expect(caps.isNode).toBe(true);
		});

		it('(d) isNode is false for a classic (non-node) WebGLRenderer', () => {
			const classicRenderer = mockWebGLRenderer({ isNode: false });
			const caps = describeRenderer(classicRenderer);
			expect(caps.isNode).toBe(false);
		});

	});

	describe('backend string derivation', () => {

		it('(e) backend is "WebGL1Renderer" when context is WebGLRenderingContext', () => {
			const renderer = mockWebGLRenderer({ contextType: 'webgl1' });
			const caps = describeRenderer(renderer);
			expect(caps.backend).toBe('WebGL1Renderer');
		});

		it('(e) backend is "WebGL2Renderer" when context is WebGL2RenderingContext', () => {
			const renderer = mockWebGLRenderer({ contextType: 'webgl2' });
			const caps = describeRenderer(renderer);
			expect(caps.backend).toBe('WebGL2Renderer');
		});

		it('(e) backend is "WebGPURenderer" for a WebGPU renderer', () => {
			const renderer = mockWebGPURenderer();
			const caps = describeRenderer(renderer);
			expect(caps.backend).toBe('WebGPURenderer');
		});

	});

	describe('shadow type settable', () => {

		it('(f) shadowTypeSettable is true when renderer.shadowMap exists', () => {
			const renderer = mockWebGLRenderer();
			const caps = describeRenderer(renderer);
			expect(caps.shadowTypeSettable).toBe(true);
		});

	});

	describe('TSL and compute support', () => {

		it('(g) supportsTSL is false for classic WebGLRenderer', () => {
			const renderer = mockWebGLRenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsTSL).toBe(false);
		});

		it('(g) supportsTSL is true for WebGPURenderer', () => {
			const renderer = mockWebGPURenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsTSL).toBe(true);
		});

		it('(g) supportsCompute is false for classic WebGLRenderer', () => {
			const renderer = mockWebGLRenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsCompute).toBe(false);
		});

		it('(g) supportsCompute is true for WebGPURenderer', () => {
			const renderer = mockWebGPURenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsCompute).toBe(true);
		});

	});

	describe('effect composer support', () => {

		it('(f) supportsEffectComposer is true for WebGLRenderer', () => {
			const renderer = mockWebGLRenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsEffectComposer).toBe(true);
		});

		it('(f) supportsEffectComposer is true for WebGPURenderer', () => {
			const renderer = mockWebGPURenderer();
			const caps = describeRenderer(renderer);
			expect(caps.supportsEffectComposer).toBe(true);
		});

	});

	describe('occlusion query support', () => {

		it('supportsOcclusionQuery is true for WebGL2Renderer', () => {
			const renderer = mockWebGLRenderer({ contextType: 'webgl2' });
			const caps = describeRenderer(renderer);
			expect(caps.supportsOcclusionQuery).toBe(true);
		});

		it('supportsOcclusionQuery is false for WebGL1Renderer', () => {
			const renderer = mockWebGLRenderer({ contextType: 'webgl1' });
			const caps = describeRenderer(renderer);
			expect(caps.supportsOcclusionQuery).toBe(false);
		});

		it('supportsOcclusionQuery is true for node renderer (offscreen)', () => {
			const renderer = mockWebGLRenderer({ isNode: true });
			const caps = describeRenderer(renderer);
			expect(caps.supportsOcclusionQuery).toBe(true);
		});

	});

});
