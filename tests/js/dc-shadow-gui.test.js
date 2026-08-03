/**
 * tests/js/dc-shadow-gui.test.js — Step 6.2 shadow GUI controls (rewritten by R2.3)
 *
 * The old version checked that certain strings appeared in dc.js. All of them did, and none of
 * the controls worked as advertised: setShadowsEnabled() wrote only renderer.shadowMap.enabled,
 * leaving S.shadowsEnabled, options.shadows and _sunLight.castShadow to drift; setShadowMapSize()
 * wrote NONE of the three variables that track the size, so the auto quality scaler overwrote the
 * user's choice on its next tick; and its `sizeMap[quality] || 1024` silently UPGRADED a numeric
 * 512 request — the scaler's own downgrade path — because sizeMap[512] is undefined.
 *
 * These run both setters against injected state and assert what they actually write.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi } from 'vitest';

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

function sliceConst(name) {
	const m = DC_SOURCE.match(new RegExp(`^const ${name} = \\{[^}]*\\};$`, 'm'));
	if (!m) throw new Error(`${name} not found in dc.js`);
	return m[0];
}

// --- harnesses ------------------------------------------------------------------------------

function makeLight() {
	return {
		castShadow: false,
		isDirectionalLight: true,
		shadow: {
			map: { disposed: 0, dispose() { this.disposed++; } },
			mapSize: { x: 0, y: 0, set(w, h) { this.x = w; this.y = h; } },
			camera: { _projUpdates: 0, updateProjectionMatrix() { this._projUpdates++; } },
		},
	};
}

function makeScene(light, meshes = []) {
	const nodes = [light, ...meshes];
	return { traverse(cb) { for (const n of nodes) cb(n); } };
}

function setShadowsHarness({ light = makeLight(), meshes = [] } = {}) {
	const S = { shadowsEnabled: false, shadowMapSize: 2048 };
	const options = { shadows: false, shadowQuality: 'High' };
	const renderer = { shadowMap: { enabled: false, type: 0 } };
	const scene = makeScene(light, meshes);
	const fitCalls = { n: 0 };
	// eslint-disable-next-line no-new-func
	const fn = new Function('renderer', 'scene', 'S', 'options', '_sunLight', '_fitShadowCamera',
		sliceFn('setShadowsEnabled') + '\nreturn setShadowsEnabled;')(
		renderer, scene, S, options, light, () => { fitCalls.n++; });
	return { fn, S, options, renderer, light, fitCalls };
}

// `nodePath` picks which renderer the sandbox is standing in for. It matters because the two
// reallocate a resized shadow map through OPPOSITE mechanisms, and _applyShadowMapSize branches on
// it: WebGLShadowMap allocates only `if (shadow.map === null)`, so there the map must be dropped,
// while ShadowNode.renderShadow() calls shadowMap.setSize() itself every pass and keeps its own
// reference to that render target — so dropping it there orphans the node's copy rather than
// clearing it, and the compiled graph goes on sampling a destroyed GPUTexture forever.
function setSizeHarness({ light = makeLight(), nodePath = false } = {}) {
	const S = { shadowMapSize: 2048 };
	const options = { shadowQuality: 'High' };
	const state = { _shadowMapSize: 2048 };
	const scene = makeScene(light);
	// Only the one flag _applyShadowMapSize reads. isWebGPURenderer — not a backend name — is what
	// the production code tests, because ?renderer=webgpu-gl reports a WebGL backend while still
	// running the node path.
	const renderer = { isWebGPURenderer: nodePath };
	// _shadowMapSize is a module-scope `let` that both functions read/write, so the two have to
	// share one binding — declare it inside the sandbox rather than injecting a copy.
	const src = [
		'let _shadowMapSize = 2048;',
		sliceConst('_SHADOW_SIZES'),
		sliceConst('_SHADOW_LABELS'),
		sliceFn('_applyShadowMapSize'),
		sliceFn('setShadowMapSize'),
		// A function, not a getter: the caller below must not spread this object, or the getter
		// would be evaluated once at spread time and frozen at its initial value.
		'return { setShadowMapSize, getSize: () => _shadowMapSize };',
	].join('\n');
	// eslint-disable-next-line no-new-func
	const api = new Function('scene', 'S', 'options', 'renderer', src)(scene, S, options, renderer);
	return { setShadowMapSize: api.setShadowMapSize, getSize: api.getSize, S, options, light, state, renderer };
}

// ---------------------------------------------------------------------------
describe('setShadowsEnabled()', () => {

	it('writes all four pieces of shadow state, not just the renderer flag', () => {
		// They used to disagree: S.shadowsEnabled stayed at its declared value forever, so
		// DC.bench() reported shadows:false while shadows rendered, and both quality-scaler
		// shadow branches — which open on `S.shadowsEnabled &&` — were dead code.
		const h = setShadowsHarness();
		h.fn(true);
		expect(h.renderer.shadowMap.enabled).toBe(true);
		expect(h.S.shadowsEnabled).toBe(true);
		expect(h.options.shadows).toBe(true);
		expect(h.light.castShadow).toBe(true);
	});

	it('turns all four off together', () => {
		const h = setShadowsHarness();
		h.fn(true);
		h.fn(false);
		expect(h.renderer.shadowMap.enabled).toBe(false);
		expect(h.S.shadowsEnabled).toBe(false);
		expect(h.options.shadows).toBe(false);
		// The light must stop casting too, or the depth pass is still paid for an unused map.
		expect(h.light.castShadow).toBe(false);
	});

	it('coerces truthiness to a real boolean', () => {
		const h = setShadowsHarness();
		h.fn(1);
		expect(h.S.shadowsEnabled).toBe(true);
		h.fn(undefined);
		expect(h.S.shadowsEnabled).toBe(false);
	});

	it('re-fits the shadow camera when switching back on', () => {
		// The room may have been rebuilt while shadows were off — clearScene() nulls roomBounds —
		// leaving the frustum fitted to the previous building.
		const h = setShadowsHarness();
		h.fn(true);
		expect(h.fitCalls.n).toBe(1);
	});

	it('does not re-fit when switching off', () => {
		const h = setShadowsHarness();
		h.fn(false);
		expect(h.fitCalls.n).toBe(0);
	});

	it('marks materials for update', () => {
		const m = { isMesh: true, material: { needsUpdate: false } };
		const h = setShadowsHarness({ meshes: [m] });
		h.fn(true);
		expect(m.material.needsUpdate).toBe(true);
	});

	it('handles an array of materials', () => {
		const m = { isMesh: true, material: [{ needsUpdate: false }, { needsUpdate: false }] };
		const h = setShadowsHarness({ meshes: [m] });
		h.fn(true);
		for (const mat of m.material) expect(mat.needsUpdate).toBe(true);
	});

	it('returns quietly when called before init() has a renderer', () => {
		// The GUI can exist before init() finishes on a slow load; this used to throw.
		// eslint-disable-next-line no-new-func
		const fn = new Function('renderer', 'scene', 'S', 'options', '_sunLight', '_fitShadowCamera',
			sliceFn('setShadowsEnabled') + '\nreturn setShadowsEnabled;')(
			null, null, {}, {}, null, vi.fn());
		expect(() => fn(true)).not.toThrow();
	});

});

describe('setShadowMapSize()', () => {

	it('maps the GUI labels to sizes', () => {
		for (const [label, size] of [['Low', 512], ['Medium', 1024], ['High', 2048]]) {
			const h = setSizeHarness();
			h.setShadowMapSize(label);
			expect(h.getSize(), label).toBe(size);
			expect(h.light.shadow.mapSize.x, label).toBe(size);
		}
	});

	it('accepts a raw pixel count — including 512', () => {
		// `sizeMap[512]` is undefined, so the old `|| 1024` turned the quality scaler's own
		// downgrade to 512 into an UPGRADE to 1024. The scaler calls this with a number.
		const h = setSizeHarness();
		h.setShadowMapSize(512);
		expect(h.getSize()).toBe(512);
		expect(h.light.shadow.mapSize.x).toBe(512);
	});

	it('writes every variable that tracks the size', () => {
		// It wrote none of them, so the auto scaler — which reads _shadowMapSize — overwrote the
		// user's choice on its next tick.
		const h = setSizeHarness();
		h.setShadowMapSize('Low');
		expect(h.getSize()).toBe(512);
		expect(h.S.shadowMapSize).toBe(512);
		expect(h.options.shadowQuality).toBe('Low');
	});

	it('leaves shadowQuality alone for a size with no label', () => {
		const h = setSizeHarness();
		h.setShadowMapSize(1536);
		expect(h.getSize()).toBe(1536);
		expect(h.options.shadowQuality).toBe('High');   // untouched, not undefined
	});

	it('ignores junk instead of setting a broken size', () => {
		const h = setSizeHarness();
		h.setShadowMapSize('Enormous');
		expect(h.getSize()).toBe(2048);
		h.setShadowMapSize(0);
		expect(h.getSize()).toBe(2048);
		h.setShadowMapSize(-1);
		expect(h.getSize()).toBe(2048);
	});

	it('drops the allocated map on the WebGL path so the new size can take effect', () => {
		// A WebGLRenderTarget is fixed-size and WebGLShadowMap reallocates only when it finds
		// shadow.map === null, so on that path changing mapSize alone does nothing.
		const h = setSizeHarness({ nodePath: false });
		const map = h.light.shadow.map;
		h.setShadowMapSize('Low');
		expect(map.disposed).toBe(1);
		expect(h.light.shadow.map).toBeNull();
	});

	it('leaves the map alone on the node path, where dropping it is what broke WebGPU', () => {
		// Reported from a real WebGPU session: entering a building tripped the quality scaler's
		// shadow tier and the whole scene went black with
		//   "In a draw command ... Texture with 'ShadowDepthTexture' label has been destroyed".
		// ShadowNode keeps its own reference to this render target and its compiled TSL graph
		// captured the depth texture, so disposing here destroys a GPUTexture the graph still
		// samples, and nulling orphans the node's copy instead of clearing it — three.js never
		// reallocates, so the scene never recovers. Writing mapSize is enough on that path:
		// ShadowNode.renderShadow() calls shadowMap.setSize() on every shadow pass.
		const h = setSizeHarness({ nodePath: true });
		const map = h.light.shadow.map;
		h.setShadowMapSize('Low');
		expect(map.disposed).toBe(0);              // never destroyed under the node's feet
		expect(h.light.shadow.map).toBe(map);      // and still owned by the light
		// The size still has to be recorded, or the resize three.js performs would be a no-op.
		expect(h.light.shadow.mapSize.x).toBe(512);
		expect(h.light.shadow.mapSize.y).toBe(512);
		expect(h.getSize()).toBe(512);
	});

	it('sets mapSize even when no map has been allocated yet', () => {
		// _applyShadowMapSize() used to require obj.shadow.map, so a size chosen before the first
		// shadow render was silently discarded.
		const light = makeLight();
		light.shadow.map = null;
		const h = setSizeHarness({ light });
		h.setShadowMapSize('Medium');
		expect(light.shadow.mapSize.x).toBe(1024);
		expect(light.shadow.mapSize.y).toBe(1024);
	});

});

describe('the GUI wiring and DC surface', () => {

	it('the options defaults agree with each other', () => {
		// options.shadowQuality said 'Medium' (1024) while _shadowMapSize and S.shadowMapSize both
		// said 2048 and the real map was three.js's 512 default: four numbers, no two agreeing.
		expect(DC_SOURCE).toMatch(/^\s*shadows: true,/m);
		expect(DC_SOURCE).toMatch(/^\s*shadowQuality: 'High',/m);
		expect(DC_SOURCE).toMatch(/^let _shadowMapSize = 2048;/m);
		expect(DC_SOURCE).toMatch(/shadowMapSize: 2048,/);
		expect(DC_SOURCE).toMatch(/^\s*shadowsEnabled: true,/m);
	});

	it('the Display folder wires both controls to the setters', () => {
		expect(DC_SOURCE).toContain("displayFolder.add(options, 'shadows')");
		expect(DC_SOURCE).toContain("'shadowQuality', ['Low', 'Medium', 'High']");
		expect(DC_SOURCE).toContain('setShadowsEnabled(v)');
		expect(DC_SOURCE).toContain('setShadowMapSize(v)');
	});

	it('both setters are on window.DC', () => {
		expect(DC_SOURCE).toContain('setShadowsEnabled: setShadowsEnabled');
		expect(DC_SOURCE).toContain('setShadowMapSize: setShadowMapSize');
	});

});
