/**
 * tests/js/dc-shadow-policy.test.js — Step 6.5 shadow policy verification
 *
 * Verifies the shadow policy in dc.js:
 *   - Sun spheres (sunCore, sunGlow): castShadow = false, receiveShadow = false
 *   - Cables: castShadow = false, receiveShadow = true
 *   - Racks and servers: castShadow = true, receiveShadow = true (already set in loaders)
 *
 * These are source-code pattern checks rather than runtime tests because dc.js is a
 * browser ES module that imports Three.js and ends in a top-level await init().
 * (See .claude/rules/js-tests.md.)
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Helper: find all Mesh creation lines and extract surrounding shadow settings
// ---------------------------------------------------------------------------

/**
 * Extract shadow settings applied immediately after a THREE.Mesh() call.
 * Returns an array of { line, castShadow, receiveShadow } objects.
 */
function extractMeshShadowSettings(meshVarName) {
    // Match: `const meshVarName = new THREE.Mesh(...)` followed by shadow assignments
    // The pattern captures the line number and the two shadow property assignments.
    const results = [];
    const re = new RegExp(
        `^(\\s*)const\\s+${meshVarName}\\s*=\\s*new\\s+THREE\\.Mesh\\([^;]+;[^;]*\\n[^;]*` +
        `(?:[^;\\n]*\\n)?` +
        `(?:\\s*cables\\.castShadow\\s*=\\s*([^;\\n]+);[^;]*\\n)?` +
        `(?:\\s*cables\\.receiveShadow\\s*=\\s*([^;\\n]+);[^;]*\\n)?`,
        'gm'
    );

    // Simpler approach: find the mesh creation line and check the 3 lines that follow
    const meshRe = new RegExp(`^(\\s*const\\s+${meshVarName}\\s*=\\s*new\\s+THREE\\.Mesh\\([^;]+;`, 'gm');
    let match;
    while ((match = meshRe.exec(SRC)) !== null) {
        const startLine = SRC.substring(0, match.index).split('\n').length;
        const afterMesh = SRC.substring(match.index, match.index + 500);
        const lines = afterMesh.split('\n').slice(0, 5);

        let castShadow = null;
        let receiveShadow = null;

        for (const line of lines) {
            const csMatch = line.match(/\.(\w+)\.castShadow\s*=\s*(true|false)/);
            if (csMatch) { castShadow = csMatch[2] === 'true'; }
            const rsMatch = line.match(/\.(\w+)\.receiveShadow\s*=\s*(true|false)/);
            if (rsMatch) { receiveShadow = rsMatch[2] === 'true'; }
        }

        // If not found via dot notation, check direct assignment
        if (castShadow === null) {
            const directCs = lines.join('\n').match(/\.castShadow\s*=\s*(true|false)/);
            if (directCs) castShadow = directCs[1] === 'true';
        }
        if (receiveShadow === null) {
            const directRs = lines.join('\n').match(/\.receiveShadow\s*=\s*(true|false)/);
            if (directRs) receiveShadow = directRs[1] === 'true';
        }

        results.push({ line: startLine, castShadow, receiveShadow });
    }
    return results;
}

// ---------------------------------------------------------------------------
// applyShadowPolicy exists and has the correct default (cast + receive = true)
// ---------------------------------------------------------------------------
describe('applyShadowPolicy helper', () => {
    it('is defined in dc.js', () => {
        expect(SRC).toMatch(/^function applyShadowPolicy\(/m);
    });

    it('sets castShadow and receiveShadow to true for all meshes by default', () => {
        // Extract the function body
        const match = SRC.match(/^function applyShadowPolicy\(root\)\s*\{[\s\S]*?^\}/m);
        expect(match).not.toBeNull();
        const body = match[0];
        // Should traverse and set both to true
        expect(body).toMatch(/castShadow\s*=\s*true/);
        expect(body).toMatch(/receiveShadow\s*=\s*true/);
    });
});

// ---------------------------------------------------------------------------
// Sun spheres — neither cast nor receive shadows
// ---------------------------------------------------------------------------
describe('sun spheres', () => {
    it('sunCore has castShadow = false and receiveShadow = false', () => {
        // Verify sunCore shadow settings exist in the source
        expect(SRC).toMatch(/sunCore\.castShadow\s*=\s*false/);
        expect(SRC).toMatch(/sunCore\.receiveShadow\s*=\s*false/);
        // Verify they appear after the sunCore mesh creation (within 5 lines)
        const meshIdx = SRC.indexOf('sunCore = new THREE.Mesh(');
        const castIdx = SRC.indexOf('sunCore.castShadow = false');
        const receiveIdx = SRC.indexOf('sunCore.receiveShadow = false');
        expect(meshIdx).toBeLessThan(castIdx);
        expect(meshIdx).toBeLessThan(receiveIdx);
        expect(castIdx - meshIdx).toBeLessThan(500); // within a few lines
        expect(receiveIdx - meshIdx).toBeLessThan(500);
    });

    it('sunGlow has castShadow = false and receiveShadow = false', () => {
        expect(SRC).toMatch(/sunGlow\.castShadow\s*=\s*false/);
        expect(SRC).toMatch(/sunGlow\.receiveShadow\s*=\s*false/);
        const meshIdx = SRC.indexOf('sunGlow = new THREE.Mesh(');
        const castIdx = SRC.indexOf('sunGlow.castShadow = false');
        const receiveIdx = SRC.indexOf('sunGlow.receiveShadow = false');
        expect(meshIdx).toBeLessThan(castIdx);
        expect(meshIdx).toBeLessThan(receiveIdx);
        expect(castIdx - meshIdx).toBeLessThan(500);
        expect(receiveIdx - meshIdx).toBeLessThan(500);
    });
});

// ---------------------------------------------------------------------------
// Cables — receive shadows but never cast them
// ---------------------------------------------------------------------------
describe('cables', () => {
    it('each cable mesh has castShadow = false and receiveShadow = true', () => {
        // There are 2 cable mesh creation sites (async path and sync path)
        // Both should have: cables.castShadow = false; cables.receiveShadow = true;
        const re = /const\s+cables\s*=\s*new\s+THREE\.Mesh\([^;]+;[\s\S]{10,300}?(?=\n\s*(?:cables\.visible|_cableCacheOrder|$))/g;
        const matches = SRC.match(re);
        expect(matches).not.toBeNull();
        expect(matches.length).toBe(2);

        for (const block of matches) {
            expect(block).toMatch(/cables\.castShadow\s*=\s*false/);
            expect(block).toMatch(/cables\.receiveShadow\s*=\s*true/);
        }
    });
});

// ---------------------------------------------------------------------------
// Racks and servers — cast and receive shadows (verified via loaders)
// ---------------------------------------------------------------------------
describe('racks and servers', () => {
    it('rack GLTF loader sets castShadow = true and receiveShadow = true', () => {
        // getRackModels() traverse block
        const re = /model\.traverse\(\(n\)\s*=>\s*\{[\s\S]*?n\.castShadow\s*=\s*true[\s\S]*?n\.receiveShadow\s*=\s*true/;
        expect(SRC).toMatch(re);
    });

    it('server GLTF loader sets castShadow = true and receiveShadow = true', () => {
        // getServerModels() traverse block
        const re = /model\.traverse\(\(n\)\s*=>\s*\{[\s\S]*?n\.castShadow\s*=\s*true[\s\S]*?n\.receiveShadow\s*=\s*true/;
        expect(SRC).toMatch(re);
    });

    it('loadRackType sets castShadow = true and receiveShadow = true', () => {
        const re = /loadRackType[\s\S]{0,500}n\.castShadow\s*=\s*true[\s\S]{0,200}n\.receiveShadow\s*=\s*true/;
        expect(SRC).toMatch(re);
    });

    it('loadServerType sets castShadow = true and receiveShadow = true', () => {
        const re = /loadServerType[\s\S]{0,500}n\.castShadow\s*=\s*true[\s\S]{0,200}n\.receiveShadow\s*=\s*true/;
        expect(SRC).toMatch(re);
    });
});
