/**
 * tests/js/dc-bvh.test.js — three-mesh-bvh integration verification
 *
 * Verifies Step 8.1 of the DC Improvement Programme:
 * (a) three-mesh-bvh is listed in package.json dependencies
 * (b) BufferGeometry.prototype is patched with computeBoundsTree/disposeBoundsTree after import
 * (c) raycaster.firstHitOnly = true is set in dc.js
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';
import { computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const PACKAGE_JSON = path.resolve(__dirname, '../../package.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getDcSource() {
    return fs.readFileSync(DC_JS, 'utf8');
}

function getPackageJson() {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
}

// ---------------------------------------------------------------------------
// three-mesh-bvh package presence
// ---------------------------------------------------------------------------
describe('three-mesh-bvh package', () => {

    it('is listed in package.json dependencies', () => {
        const pkg = getPackageJson();
        expect(pkg.dependencies).toHaveProperty('three-mesh-bvh');
    });

    it('is installed and loadable', () => {
        // The module should be importable (verified at top of file via import)
        expect(typeof computeBoundsTree).toBe('function');
        expect(typeof disposeBoundsTree).toBe('function');
    });

});

// ---------------------------------------------------------------------------
// BufferGeometry.prototype patching
// ---------------------------------------------------------------------------
describe('dc.js — BufferGeometry.prototype BVH patching', () => {

    it('imports computeBoundsTree and disposeBoundsTree from three-mesh-bvh', () => {
        const src = getDcSource();
        expect(src).toMatch(/import\s*\{[^}]*computeBoundsTree[^}]*\}\s*from\s*['"]three-mesh-bvh['"]/);
        expect(src).toMatch(/import\s*\{[^}]*disposeBoundsTree[^}]*\}\s*from\s*['"]three-mesh-bvh['"]/);
    });

    it('patches BufferGeometry.prototype.computeBoundsTree', () => {
        const src = getDcSource();
        expect(src).toMatch(/BufferGeometry\.prototype\.computeBoundsTree\s*=\s*computeBoundsTree/);
    });

    it('patches BufferGeometry.prototype.disposeBoundsTree', () => {
        const src = getDcSource();
        expect(src).toMatch(/BufferGeometry\.prototype\.disposeBoundsTree\s*=\s*disposeBoundsTree/);
    });

});

// ---------------------------------------------------------------------------
// computeBoundsTree() called in extractModelMeshes()
// ---------------------------------------------------------------------------
describe('dc.js — extractModelMeshes() calls computeBoundsTree()', () => {

    it('calls geometry.computeBoundsTree() on each mesh geometry', () => {
        const src = getDcSource();
        // extractModelMeshes should call computeBoundsTree on the geometry
        // We look for the pattern within the extractModelMeshes function
        const fnMatch = src.match(/function extractModelMeshes\([\s\S]*?return\s*\{[^}]+\}\s*;\s*\}/);
        expect(fnMatch).toBeTruthy();
        expect(fnMatch[0]).toMatch(/\.computeBoundsTree\s*\(\s*\)/);
    });

});

// ---------------------------------------------------------------------------
// raycaster.firstHitOnly = true
// ---------------------------------------------------------------------------
describe('dc.js — raycaster.firstHitOnly', () => {

    it('sets raycaster.firstHitOnly = true', () => {
        const src = getDcSource();
        expect(src).toMatch(/raycaster\.firstHitOnly\s*=\s*true/);
    });

});

// ---------------------------------------------------------------------------
// Import map entries
// ---------------------------------------------------------------------------
describe('dc.html — import map and modulepreload for three-mesh-bvh', () => {

    const DC_HTML = path.resolve(__dirname, '../../public_html/admin/dc.html');

    it('has three-mesh-bvh in the import map', () => {
        const html = fs.readFileSync(DC_HTML, 'utf8');
        expect(html).toMatch(/['"]three-mesh-bvh['"]:\s*['"]\/node_modules\/three-mesh-bvh\/build\/index\.umd\.cjs['"]/);
    });

    it('has modulepreload for three-mesh-bvh', () => {
        const html = fs.readFileSync(DC_HTML, 'utf8');
        expect(html).toMatch(/<link[^>]+rel=["']modulepreload["'][^>]+href=["'][^"']*three-mesh-bvh[^"']*["']/);
    });

});

// ---------------------------------------------------------------------------
// dc-renderer-mode.js exports THREE_MESH_BVH
// ---------------------------------------------------------------------------
describe('dc-renderer-mode.js — THREE_MESH_BVH export', () => {

    it('exports THREE_MESH_BVH constant', () => {
        const modePath = path.resolve(__dirname, '../../public_html/js/dc-renderer-mode.js');
        const src = fs.readFileSync(modePath, 'utf8');
        expect(src).toMatch(/export\s+const\s+THREE_MESH_BVH\s*=/);
    });

    it('includes three-mesh-bvh in rendererImports()', () => {
        const modePath = path.resolve(__dirname, '../../public_html/js/dc-renderer-mode.js');
        const src = fs.readFileSync(modePath, 'utf8');
        expect(src).toMatch(/['"]three-mesh-bvh['"]:\s*THREE_MESH_BVH/);
    });

});
