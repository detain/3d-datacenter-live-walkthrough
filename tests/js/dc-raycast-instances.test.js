/**
 * tests/js/dc-raycast-instances.test.js — raycastInstances() pre-filter (R2.2)
 *
 * This file used to assert that `mesh.geometry.computeBoundingSphere()` MUST appear in dc.js —
 * i.e. it required the bug to stay. It was source-text only, so it could not have noticed that
 * the shipped filter was directional and discarded the mesh you were looking straight at.
 *
 * It now slices the real raycastInstances() out of dc.js and runs it against injected module
 * state, with enough real vector maths that a wrong formula produces a wrong answer rather than
 * an absent one. The property under test is the one F-02 was about: whether a mesh is close
 * enough to pick must not depend on which way the camera is facing.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Minimal real maths — enough that the filter's arithmetic is actually exercised.
// ---------------------------------------------------------------------------

class Vec3 {
	constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
	set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
	copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
	clone() { return new Vec3(this.x, this.y, this.z); }
	sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
	dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
	distanceTo(v) {
		const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}
	/** Real three.js Matrix4 application, column-major elements. */
	applyMatrix4(m) {
		const { x, y, z } = this, e = m.elements;
		const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
		this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
		this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
		this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
		return this;
	}
}

/** Identity Matrix4, optionally translated — enough to prove the world transform is applied. */
function matrix4(tx = 0, ty = 0, tz = 0) {
	return { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1] };
}

/**
 * An InstancedMesh-shaped fake. boundingSphere lives on the MESH (instance space), which is the
 * distinction the old code got wrong — it computed geometry.boundingSphere and then read
 * mesh.boundingSphere, which stayed undefined.
 */
function fakeMesh({ center = [0, 0, 0], radius = 0, world = [0, 0, 0], hasSphere = true } = {}) {
	const mesh = {
		isMesh: true,
		matrixWorld: matrix4(...world),
		geometry: {
			boundingSphere: null,
			computeBoundingSphere() { this.boundingSphere = { center: new Vec3(...center), radius }; mesh._geometryComputeCalls++; },
		},
		boundingSphere: hasSphere ? { center: new Vec3(...center), radius } : null,
		computeBoundingSphere() { this.boundingSphere = { center: new Vec3(...center), radius }; mesh._meshComputeCalls++; },
		userData: { kind: 'server', assetData: {} },
		_meshComputeCalls: 0,
		_geometryComputeCalls: 0,
	};
	return mesh;
}

/**
 * A camera at `pos` looking along `dir`. getWorldDirection() is supplied even though the repaired
 * filter never calls it — so the PRE-FIX source still runs correctly here and produces its wrong
 * answer, rather than throwing. That is what makes the non-vacuity check below meaningful.
 */
function fakeCamera(pos = [0, 0, 0], dir = [0, 0, -1]) {
	return {
		position: new Vec3(...pos),
		getWorldDirection(target) { return (target || new Vec3()).set(...dir); },
	};
}

/** Slice the real declaration and bind it to injected module state. */
function compileRaycastInstances({ meshes, camera, maxDist = 50 }) {
	const m = DC_SOURCE.match(/^function raycastInstances\([\s\S]*?^\}/m);
	if (!m) throw new Error('dc.js no longer declares raycastInstances() at top level');

	const seen = { filtered: null, calls: 0 };
	const raycaster = {
		setFromCamera() {},
		intersectObjects(list) { seen.filtered = list; seen.calls++; return []; },
	};
	const objects = { instanced: meshes };
	const scratch = new Vec3();
	// eslint-disable-next-line no-new-func
	const fn = new Function('objects', 'camera', 'MAX_RAYCAST_DIST', '_rcTempV', 'raycaster', 'THREE',
		m[0] + '\nreturn raycastInstances;')(objects, camera, maxDist, scratch, raycaster, { Vector3: Vec3 });
	return { run: (ndc = { x: 0, y: 0 }) => fn(ndc), seen, scratch };
}

/** Which meshes survived the pre-filter for a given camera. */
function keptFor(meshes, camera, maxDist = 50) {
	const h = compileRaycastInstances({ meshes, camera, maxDist });
	h.run();
	return h.seen.filtered || [];
}

// ---------------------------------------------------------------------------
describe('dc.js — raycastInstances() distance pre-filter', () => {

	describe('the F-02 property: picking must not depend on where the camera looks', () => {

		it('keeps a nearby mesh whichever way the camera faces', () => {
			// The whole bug in one test. The old filter projected onto the view axis, so a mesh
			// dead ahead scored its full distance while the same mesh behind you scored negative
			// and passed. Six directions, one mesh, one answer.
			const at = [0, 0, -40];   // 40 units from origin, well inside MAX_RAYCAST_DIST
            const dirs = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
			for (const dir of dirs) {
				const mesh = fakeMesh({ center: at });
				expect(keptFor([mesh], fakeCamera([0, 0, 0], dir)), `facing ${dir}`).toHaveLength(1);
			}
		});

		it('drops a distant mesh whichever way the camera faces', () => {
			const at = [0, 0, -400];
			for (const dir of [[0, 0, -1], [0, 0, 1], [1, 0, 0]]) {
				const mesh = fakeMesh({ center: at });
				expect(keptFor([mesh], fakeCamera([0, 0, 0], dir)), `facing ${dir}`).toHaveLength(0);
			}
		});

		it('is symmetric: a mesh in front and the same mesh behind get the same verdict', () => {
			const front = fakeMesh({ center: [0, 0, -60] });
			const behind = fakeMesh({ center: [0, 0, 60] });
			const cam = fakeCamera([0, 0, 0], [0, 0, -1]);
			expect(keptFor([front], cam).length).toBe(keptFor([behind], cam).length);
		});

	});

	describe('the sphere radius counts', () => {

		it('keeps a large mesh whose surface is in range even though its centre is not', () => {
			// A rack row spans the room, so its bounding sphere is huge and its centre is far
			// away while its near edge is at your feet. Ignoring the radius — as the old filter
			// did — is what made a whole room of racks unpickable from one end of it.
			const roomSpanning = fakeMesh({ center: [0, 0, -80], radius: 60 });
			expect(keptFor([roomSpanning], fakeCamera())).toHaveLength(1);
		});

		it('still drops a large mesh whose surface is out of range', () => {
			const faraway = fakeMesh({ center: [0, 0, -200], radius: 60 });
			expect(keptFor([faraway], fakeCamera())).toHaveLength(0);
		});

		it('respects the MAX_RAYCAST_DIST boundary exactly', () => {
			const cam = fakeCamera();
			expect(keptFor([fakeMesh({ center: [0, 0, -50] })], cam, 50)).toHaveLength(1);   // on the line
			expect(keptFor([fakeMesh({ center: [0, 0, -50.5] })], cam, 50)).toHaveLength(0); // just past
		});

	});

	describe('the bounding sphere itself', () => {

		it('calls the InstancedMesh computeBoundingSphere(), not the geometry one', () => {
			// InstancedMesh has its own boundingSphere in instance space. Computing
			// geometry.boundingSphere leaves mesh.boundingSphere undefined, and the next line
			// dereferences it — a latent TypeError that only stays latent because dc.js happens
			// to call inst.computeBoundingSphere() at creation.
			const mesh = fakeMesh({ center: [0, 0, -10], hasSphere: false });
			keptFor([mesh], fakeCamera());
			expect(mesh._meshComputeCalls).toBe(1);
			expect(mesh._geometryComputeCalls).toBe(0);
		});

		it('INCLUDES a mesh that has no bounding sphere at all', () => {
			// Excluding it would silently disable picking for that whole model; one extra
			// intersect test is the cheaper failure.
			const mesh = fakeMesh({ hasSphere: false });
			mesh.computeBoundingSphere = () => {};   // refuses to produce one
			expect(keptFor([mesh], fakeCamera())).toHaveLength(1);
		});

		it('transforms the sphere centre into world space', () => {
			// Centre at the origin in instance space, but the mesh is parked 400 units away.
			// Skipping matrixWorld would score it as 0 and keep it.
			const mesh = fakeMesh({ center: [0, 0, 0], world: [0, 0, -400] });
			expect(keptFor([mesh], fakeCamera())).toHaveLength(0);
			const near = fakeMesh({ center: [0, 0, 0], world: [0, 0, -10] });
			expect(keptFor([near], fakeCamera())).toHaveLength(1);
		});

	});

	describe('filtering behaviour as a whole', () => {

		it('passes only the near meshes to the raycaster', () => {
			const near1 = fakeMesh({ center: [0, 0, -10] });
			const far = fakeMesh({ center: [0, 0, -300] });
			const near2 = fakeMesh({ center: [20, 0, 0] });
			const kept = keptFor([near1, far, near2], fakeCamera());
			expect(kept).toHaveLength(2);
			expect(kept).toContain(near1);
			expect(kept).toContain(near2);
			expect(kept).not.toContain(far);
		});

		it('skips non-mesh entries', () => {
			const notAMesh = { isMesh: false, boundingSphere: { center: new Vec3(), radius: 0 }, matrixWorld: matrix4() };
			expect(keptFor([notAMesh], fakeCamera())).toHaveLength(0);
		});

		it('returns null without touching the raycaster when nothing is in range', () => {
			const h = compileRaycastInstances({ meshes: [fakeMesh({ center: [0, 0, -900] })], camera: fakeCamera() });
			expect(h.run()).toBeNull();
			expect(h.seen.calls).toBe(0);
		});

		it('returns null for an empty instanced list', () => {
			const h = compileRaycastInstances({ meshes: [], camera: fakeCamera() });
			expect(h.run()).toBeNull();
			expect(h.seen.calls).toBe(0);
		});

	});

	describe('no per-frame allocation', () => {

		it('reuses the module-scope scratch vector instead of allocating', () => {
			// updateHighlight() calls this every frame. The shipped version allocated two Vector3
			// per mesh per frame (bs.center.clone() and new THREE.Vector3()).
			const h = compileRaycastInstances({ meshes: [fakeMesh({ center: [1, 2, -3] })], camera: fakeCamera() });
			h.run();
			// The injected scratch was written to — proof the filter used it rather than a fresh one.
			expect({ x: h.scratch.x, y: h.scratch.y, z: h.scratch.z }).toEqual({ x: 1, y: 2, z: -3 });
		});

		it('the filter body allocates nothing', () => {
			// Guarding a contract that must not silently drift: a `new` or `.clone()` reappearing
			// inside this filter is a per-frame allocation, which no behavioural assertion above
			// can see.
			const src = DC_SOURCE.match(/^function raycastInstances\([\s\S]*?^\}/m)[0];
			const filter = src.match(/objects\.instanced\.filter\([\s\S]*?\n {4}\}\);/);
			expect(filter, 'the instanced pre-filter is no longer recognisable').not.toBeNull();
			const code = filter[0].replace(/\/\/[^\n]*/g, '');
			expect(code).not.toMatch(/\bnew\s+THREE\./);
			expect(code).not.toMatch(/\.clone\(\)/);
			// And no directional term — this is the F-02 regression guard.
			expect(code).not.toMatch(/getWorldDirection/);
			expect(code).not.toMatch(/\.dot\(/);
		});

	});

});
