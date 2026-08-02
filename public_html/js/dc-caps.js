/**
 * public_html/js/dc-caps.js — Step 7.1 renderer-capability module
 *
 * Exports describeRenderer(renderer) which returns a normalised capability object
 * for the current Three.js renderer. Use these flags instead of ad-hoc renderer.backend
 * or instanceof checks scattered through dc.js.
 *
 * Run: yarn test:js
 */

import * as THREE from 'three';

/**
 * @param {THREE.WebGLRenderer|THREE.WebGPURenderer} renderer
 * @returns {{
 *   isNode: boolean,
 *   backend: string,
 *   shadowTypeSettable: boolean,
 *   supportsTSL: boolean,
 *   supportsCompute: boolean,
 *   supportsOcclusionQuery: boolean,
 *   supportsEffectComposer: boolean
 * }}
 */
export function describeRenderer(renderer) {
	// Detect renderer type via constructor name rather than instanceof, which can fail
	// across module boundaries (e.g., in Node test environments with different THREE instances).
	const ctorName = renderer.constructor?.name || '';

	// isNode: the node/offscreen renderer is the WebGLRenderer subclass that three.webgpu.js ships.
	// It is identified by being a WebGLRenderer AND renderer.info.type === 'offscreen'.
	const isNode = ctorName === 'WebGLRenderer' && renderer.info?.type === 'offscreen';

	// Derive the backend string from the constructor name or backend object.
	let backend;
	if (ctorName === 'WebGPURenderer') {
		backend = 'WebGPURenderer';
	} else if (ctorName === 'WebGLRenderer') {
		// Classic renderer — check the context version via the context itself.
		const ctx = renderer.getContext?.();
		// WebGLRenderingContext is the global in browsers; in Node tests it may not be available,
		// so we fall back to checking the context's constructor name.
		if (ctx && ctx.constructor?.name === 'WebGLRenderingContext') {
			backend = 'WebGL1Renderer';
		} else {
			backend = 'WebGL2Renderer';
		}
	} else {
		backend = 'Unknown';
	}

	// shadowTypeSettable: both WebGLRenderer and WebGPURenderer paths allow shadow map type
	// to be changed freely. The node renderer (WebGPU with WebGL2 backend) also supports it.
	const shadowTypeSettable = !!(renderer.shadowMap);

	// supportsTSL: the Textured Shader Language (TSL) is only available on the WebGPU path.
	const supportsTSL = !!(renderer._tslm); // three.js marks TSL-capable renderers with _tslm

	// supportsCompute: compute shaders are a WebGPU-only feature.
	const supportsCompute = !!(renderer.compute);

	// supportsOcclusionQuery: occlusion queries are supported in WebGL2 via EXT_occlusion_query.
	// The node renderer (WebGPU) always supports them natively.
	const supportsOcclusionQuery = isNode || backend === 'WebGL2Renderer' || backend === 'WebGPURenderer';

	// supportsEffectComposer: EffectComposer works on both WebGL and WebGPU renderers.
	// It requires the renderer to have a proper WebGL/WebGPU context.
	const supportsEffectComposer = ctorName === 'WebGLRenderer' || ctorName === 'WebGPURenderer';

	return {
		isNode,
		backend,
		shadowTypeSettable,
		supportsTSL,
		supportsCompute,
		supportsOcclusionQuery,
		supportsEffectComposer,
	};
}
