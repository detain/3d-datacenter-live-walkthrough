/**
 * tests/js/dc-raycast-instances.test.js — raycastInstances pre-filter verification
 *
 * Verifies that the raycastInstances() pre-filter:
 * (a) reads boundingSphere from the mesh
 * (b) if boundingSphere is null, computes it via geometry.computeBoundingSphere()
 * (c) uses boundingSphere.center (not mesh.position) for the distance check
 *
 * Since we cannot easily instantiate full 3D geometry in a unit test, we use
 * source-text assertions to verify the fix is present in dc.js.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function extractRaycastInstances() {
    const m = DC_SOURCE.match(/^function raycastInstances\([\s\S]*?^\}/m);
    if (!m) throw new Error('dc.js no longer declares raycastInstances() at top level');
    return m[0];
}

// ---------------------------------------------------------------------------
// raycastInstances pre-filter tests
// ---------------------------------------------------------------------------
describe('dc.js — raycastInstances pre-filter', () => {

    it('uses boundingSphere (not mesh.position) in the pre-filter', () => {
        const src = extractRaycastInstances();
        // The pre-filter uses mesh.position in a comment explaining the bug, but not in actual code
        // The actual code (not comment) must use boundingSphere.center
        // Extract just the filter function body
        const filterMatch = src.match(/const nearbyInstanced = objects\.instanced\.filter\(.*?\{([\s\S]*?)\n    \}\)/);
        if (filterMatch) {
            const filterBody = filterMatch[1];
            // No mesh.position usage in actual filter logic (only in comment which is on separate line)
            const codeLines = filterBody.split('\n').filter(line => !line.trim().startsWith('//'));
            const codeWithoutComments = codeLines.join('\n');
            expect(codeWithoutComments).not.toMatch(/mesh\.position/);
        }
        // The pre-filter must use boundingSphere.center for distance check
        expect(src).toMatch(/mesh\.boundingSphere\.center/);
    });

    it('computes boundingSphere from geometry if mesh.boundingSphere is null', () => {
        const src = extractRaycastInstances();
        // Must check if boundingSphere exists
        expect(src).toMatch(/if\s*\(\s*!\s*mesh\.boundingSphere\s*\)/);
        // Must call computeBoundingSphere() on geometry when null
        expect(src).toMatch(/mesh\.geometry\.computeBoundingSphere\(\)/);
    });

    it('uses boundingSphere.center transformed by mesh.matrixWorld', () => {
        const src = extractRaycastInstances();
        // The bounding sphere center must be transformed to world space
        expect(src).toMatch(/mesh\.boundingSphere\.center\.clone\(\)\.applyMatrix4\(mesh\.matrixWorld\)/);
    });

    it('MAX_RAYCAST_DIST is used in the distance check', () => {
        // Verify the constant still exists and is used
        expect(DC_SOURCE).toMatch(/const MAX_RAYCAST_DIST = 50/);
        const src = extractRaycastInstances();
        expect(src).toMatch(/MAX_RAYCAST_DIST/);
    });

    it('_rcTempV, _camFwd, _getCameraForward are removed (unused after fix)', () => {
        // These were the old working variables that are no longer needed
        expect(DC_SOURCE).not.toMatch(/const _rcTempV\s*=/);
        expect(DC_SOURCE).not.toMatch(/const _camFwd\s*=/);
        expect(DC_SOURCE).not.toMatch(/function _getCameraForward/);
    });
});
