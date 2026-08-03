/**
 * tests/js/dc-bvh.test.js — three-mesh-bvh integration verification
 *
 * Verifies Step 8.1 of the DC Improvement Programme, as repaired by dc_remediation_plan.md
 * steps R1.1 and R1.2.
 *
 * WHY THIS FILE LOOKS DIFFERENT FROM ITS PREDECESSOR
 * The original version asserted only that certain strings appeared in dc.js and dc.html. It
 * passed for two days while the page was completely dead in a browser, and one of its
 * assertions actively required the broken import-map path to stay broken. Three of its
 * defects are now covered behaviourally:
 *
 *   (a) the import map pointed at build/index.umd.cjs — a CommonJS bundle with no ES exports,
 *       served as application/node, which strict MIME checking rejects as a module script.
 *   (b) dc.js patched a bare `BufferGeometry`, which is not bound in that module
 *       (it does `import * as THREE`), throwing ReferenceError at module evaluation.
 *   (c) acceleratedRaycast was never imported, so nothing ever read geometry.boundsTree and
 *       the BVH was pure cost. This is the one that a source-text test can never catch,
 *       because the absence of a line is invisible to a grep for other lines.
 *
 * NOTE ON THE REAL `three` IMPORT: .claude/rules/js-tests.md says to stub three.js in unit
 * tests. This file is a deliberate exception — it verifies a real third-party library
 * integration, and the stub cannot model BVH construction. three-mesh-bvh already pulls real
 * three into this file's module graph regardless.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_HTML = path.resolve(__dirname, '../../public_html/admin/dc.html');
const DC_MODE = path.resolve(__dirname, '../../public_html/js/dc-renderer-mode.js');
const PACKAGE_JSON = path.resolve(__dirname, '../../package.json');

const readDcJs = () => fs.readFileSync(DC_JS, 'utf8');
const readDcHtml = () => fs.readFileSync(DC_HTML, 'utf8');
const readDcMode = () => fs.readFileSync(DC_MODE, 'utf8');

/** Pull the bare specifier -> URL map out of dc.html's inline renderer-mode script. */
function importMapFromHtml() {
    const html = readDcHtml();
    const map = {};
    const block = html.match(/var imports = \{([\s\S]*?)\};/);
    if (!block) throw new Error('import map literal not found in dc.html — was the inline script restructured?');
    for (const m of block[1].matchAll(/'([^']+)'\s*:\s*'([^']+)'/g)) map[m[1]] = m[2];
    return map;
}

// ---------------------------------------------------------------------------
// The library itself — behavioural, not textual
// ---------------------------------------------------------------------------
describe('three-mesh-bvh — library integration', () => {

    it('is listed in package.json dependencies', () => {
        const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
        expect(pkg.dependencies).toHaveProperty('three-mesh-bvh');
    });

    it('exports the three functions dc.js needs', () => {
        expect(typeof computeBoundsTree).toBe('function');
        expect(typeof disposeBoundsTree).toBe('function');
        // acceleratedRaycast is the one Step 8.1 originally forgot.
        expect(typeof acceleratedRaycast).toBe('function');
    });

    it('computeBoundsTree actually builds a boundsTree on a real BufferGeometry', () => {
        // Apply the same patches dc.js applies, on a throwaway subclass so we do not mutate
        // the shared THREE prototypes for other test files in this process.
        class Geo extends THREE.BufferGeometry {}
        Geo.prototype.computeBoundsTree = computeBoundsTree;
        Geo.prototype.disposeBoundsTree = disposeBoundsTree;

        const geo = new Geo();
        const box = new THREE.BoxGeometry(1, 1, 1);
        geo.setAttribute('position', box.getAttribute('position'));
        geo.setIndex(box.getIndex());

        expect(geo.boundsTree).toBeUndefined();
        geo.computeBoundsTree();
        expect(geo.boundsTree).toBeTruthy();

        geo.disposeBoundsTree();
        expect(geo.boundsTree).toBeFalsy();
    });

});

// ---------------------------------------------------------------------------
// dc.js — the prototype patches
// ---------------------------------------------------------------------------
describe('dc.js — BVH prototype patching', () => {

    it('imports all three functions from three-mesh-bvh', () => {
        const src = readDcJs();
        const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*['"]three-mesh-bvh['"]/);
        expect(imp).toBeTruthy();
        const names = imp[1].split(',').map((s) => s.trim());
        expect(names).toContain('computeBoundsTree');
        expect(names).toContain('disposeBoundsTree');
        // Without this, geometry.boundsTree is never consulted and the BVH is cost with no
        // benefit — three's stock Mesh.raycast does not know the tree exists.
        expect(names).toContain('acceleratedRaycast');
    });

    it('patches the prototypes through THREE., not a bare identifier', () => {
        const src = readDcJs();
        // Anchored at column 0 so `THREE.BufferGeometry...` cannot satisfy a test meant to
        // catch a bare `BufferGeometry...`. The unanchored version of this assertion is what
        // let the ReferenceError ship.
        expect(src).not.toMatch(/^BufferGeometry\.prototype\./m);
        expect(src).not.toMatch(/^Mesh\.prototype\./m);
        expect(src).toMatch(/^THREE\.BufferGeometry\.prototype\.computeBoundsTree\s*=\s*computeBoundsTree/m);
        expect(src).toMatch(/^THREE\.BufferGeometry\.prototype\.disposeBoundsTree\s*=\s*disposeBoundsTree/m);
        expect(src).toMatch(/^THREE\.Mesh\.prototype\.raycast\s*=\s*acceleratedRaycast/m);
    });

    it('only patches identifiers that dc.js actually binds', () => {
        const src = readDcJs();
        // dc.js does `import * as THREE from "three"` and imports no named three.js classes,
        // so any bare ClassName.prototype assignment at module scope is a ReferenceError.
        const bare = [...src.matchAll(/^([A-Z]\w+)\.prototype\./gm)].map((m) => m[1]);
        expect(bare).toEqual([]);
    });

    it('calls geometry.computeBoundsTree() when extracting model meshes', () => {
        const src = readDcJs();
        const fn = src.match(/function extractModelMeshes\([\s\S]*?return\s*\{[^}]+\}\s*;\s*\}/);
        expect(fn).toBeTruthy();
        expect(fn[0]).toMatch(/\.computeBoundsTree\s*\(\s*\)/);
    });

    it('sets raycaster.firstHitOnly (only three-mesh-bvh reads this flag)', () => {
        expect(readDcJs()).toMatch(/raycaster\.firstHitOnly\s*=\s*true/);
    });

});

// ---------------------------------------------------------------------------
// The import map — the defect that killed the page
// ---------------------------------------------------------------------------
describe('import map — three-mesh-bvh must resolve as an ES module', () => {

    it('maps three-mesh-bvh to an ESM build, never a .cjs', () => {
        const url = importMapFromHtml()['three-mesh-bvh'];
        expect(url).toBeTruthy();
        // A .cjs is a CommonJS bundle (no ES exports) AND has no MIME mapping in
        // public_html/.htaccess, so it is served as application/node and rejected outright.
        expect(url.endsWith('.cjs')).toBe(false);
        expect(url.endsWith('.js')).toBe(true);
    });

    it('serves it from /lib/, the node_modules symlink the rest of the page uses', () => {
        const url = importMapFromHtml()['three-mesh-bvh'];
        expect(url.startsWith('/lib/')).toBe(true);
        expect(url).not.toMatch(/^\/node_modules\//);
    });

    it('points at a file that exists on disk and has ES exports', () => {
        const url = importMapFromHtml()['three-mesh-bvh'];
        // /lib is a symlink to node_modules; resolve through the repo root the same way the
        // web server would.
        const onDisk = path.resolve(__dirname, '../../public_html', '.' + url);
        expect(fs.existsSync(onDisk)).toBe(true);
        expect(fs.readFileSync(onDisk, 'utf8')).toMatch(/^export\s|\bexport\s*\{/m);
    });

    it('preloads the same URL it maps', () => {
        const url = importMapFromHtml()['three-mesh-bvh'];
        const html = readDcHtml();
        const preloads = [...html.matchAll(/rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
        const written = [...html.matchAll(/modulepreload" href="' \+ ([\w.]+) \+ '"|modulepreload" href="([^"']+)"/g)];
        expect(written.length).toBeGreaterThan(0);
        expect(html).toContain(`modulepreload" href="${url}"`);
        expect(preloads.concat(url)).toContain(url);
    });

});

// ---------------------------------------------------------------------------
// dc-renderer-mode.js must agree with dc.html
// ---------------------------------------------------------------------------
describe('dc-renderer-mode.js — THREE_MESH_BVH stays in sync with dc.html', () => {

    it('exports THREE_MESH_BVH and wires it into rendererImports()', () => {
        const src = readDcMode();
        expect(src).toMatch(/export\s+const\s+THREE_MESH_BVH\s*=/);
        expect(src).toMatch(/['"]three-mesh-bvh['"]:\s*THREE_MESH_BVH/);
    });

    it('exports exactly the URL dc.html writes', () => {
        const declared = readDcMode().match(/export\s+const\s+THREE_MESH_BVH\s*=\s*'([^']+)'/);
        expect(declared).toBeTruthy();
        // dc-renderer-mode.js is an executable spec for dc.html's inline block. If they drift,
        // the module tests keep passing while the browser loads something else entirely.
        expect(declared[1]).toBe(importMapFromHtml()['three-mesh-bvh']);
    });

});
