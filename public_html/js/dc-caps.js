/**
 * dc-caps.js — what the active renderer can actually do.
 *
 * The datacenter scene runs on two renderers (see docs/dc_renderer_modes.md) and, as of the
 * Phase 7 work, deliberately does different things on each. Before that, dc.js branched in
 * exactly one place — renderer construction — and treated the two the same everywhere else.
 * Now that they diverge on purpose, "which renderer is this and what does it support" is asked
 * from several places, and answering it ad-hoc with `!!THREE.WebGPURenderer` sprinkled around is
 * precisely how two code paths quietly stop matching.
 *
 * This module is the single answer. It is pure and has NO import-time side effects — in
 * particular it does not import three.js, so it can be unit tested without a WebGL context and
 * without dragging the whole engine into every Vitest run.
 *
 * Every discriminator below is a property three.js genuinely exposes. An earlier revision keyed
 * off `renderer.info.type === 'offscreen'` and `renderer._tslm`; neither exists anywhere in
 * three.js, so isNode and supportsTSL were permanently false, DC.backendName reported 'webgl' in
 * all three modes, and the entire WebGPU postprocessing branch was unreachable. If you add a
 * discriminator here, grep node_modules/three/src for it first.
 *
 * Run: yarn test:js
 */

/**
 * Describe a constructed renderer.
 *
 * IMPORTANT: the discriminator is the renderer OBJECT, not window.DC_RENDERER_MODE. The mode is a
 * REQUEST; WebGPURenderer silently falls back to its WebGL2 backend wherever navigator.gpu is
 * missing, so the URL can say "webgpu" while the real backend is WebGL2. Everything user-visible
 * must report the backend, never the request.
 *
 * @param {Object} renderer a constructed THREE renderer, or null/undefined
 * @returns {{
 *   isNode: boolean,                 true for WebGPURenderer (either backend)
 *   backend: string,                 'webgl' | 'webgpu' | 'webgl2-fallback' | 'unknown'
 *   shadowTypeSettable: boolean,     shadowMap.type is a classic-renderer concept
 *   supportsTSL: boolean,            TSL node materials + the tsl/display postprocessing nodes
 *   supportsCompute: boolean,        compute shaders (WebGPU only, no WebGL2 emulation)
 *   supportsOcclusionQuery: boolean, occlusion queries (WebGPU only)
 *   supportsEffectComposer: boolean, the classic GLSL EffectComposer chain
 * }}
 */
export function describeRenderer(renderer) {
	if (!renderer) {
		// Callers reach here when init() bails before constructing a renderer, and in tests.
		// Returning an all-false descriptor keeps every `if (caps.x)` site falsy rather than
		// throwing a TypeError from a null dereference deep inside a capability check.
		return {
			isNode: false, backend: 'unknown', shadowTypeSettable: false,
			supportsTSL: false, supportsCompute: false,
			supportsOcclusionQuery: false, supportsEffectComposer: false,
		};
	}

	// A classic WebGLRenderer has no .backend at all. The node renderer (WebGPURenderer, shipped
	// in three.webgpu.js) always has one, and sets isWebGPURenderer on the instance. Check both:
	// isWebGPURenderer is the declared marker, .backend is the structural one the pre-Phase-7
	// code used successfully.
	const isNode = !!(renderer.isWebGPURenderer || renderer.backend);

	// isWebGPUBackend tells the node renderer's two backends apart. It is set on WebGPUBackend and
	// absent on WebGLBackend, so a node renderer that fell back to WebGL2 reports 'webgl2-fallback'.
	const backend = !isNode
		? 'webgl'
		: (renderer.backend && renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2-fallback');
	const realWebGPU = backend === 'webgpu';

	return {
		isNode,
		backend,
		// shadowMap.type is a WebGLRenderer concept; the node renderer manages its own shadow
		// filtering through TSL ShadowNode and does not take PCFSoftShadowMap the same way.
		shadowTypeSettable: !isNode,
		// TSL is a node-renderer capability, not a separate flag. Both node backends compile TSL —
		// the WebGL2 fallback emits GLSL from the same node graph — so this follows isNode, not
		// realWebGPU.
		supportsTSL: isNode,
		// Compute shaders, indirect draw and atomics have no WebGL2 emulation, so they are
		// WebGPU-only by construction — anything built on them is a SECOND implementation to
		// maintain, not a migration.
		supportsCompute: realWebGPU,
		// Occlusion queries are the one genuinely WebGPU-only capability that matters to an indoor
		// scene of rooms. WebGL cannot do them at all; our "one neighbour at full detail" LOD is a
		// hand-rolled approximation of the same idea.
		supportsOcclusionQuery: realWebGPU,
		// The classic GLSL EffectComposer chain (and everything built on it, e.g. N8AO and pmndrs
		// postprocessing) is WebGL-only. It does nothing on the node renderer, which is why the AO
		// toggle must not appear there — the node path uses TSL GTAONode instead.
		supportsEffectComposer: !isNode,
	};
}

/**
 * Human-readable backend name for the UI. Never returns the requested mode.
 * @param {string} backend a value from describeRenderer().backend
 * @returns {string}
 */
export function backendLabel(backend) {
	return ({ webgl: 'WebGL', webgpu: 'WebGPU', 'webgl2-fallback': 'WebGPU (GL)' })[backend] || backend;
}
