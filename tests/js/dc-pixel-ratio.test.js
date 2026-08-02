/**
 * tests/js/dc-pixel-ratio.test.js — pixel ratio Step 4.2
 *
 * Verifies:
 * (a) Only ONE formula exists for setting renderer pixel ratio
 * (b) That formula is Math.min(window.devicePixelRatio * S.pixelScale, 2)
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

/**
 * Find all setPixelRatio call sites.
 * Returns array of { line, lineText } objects.
 */
function findPixelRatioCallSites() {
    const results = [];
    const lines = DC_SOURCE.split('\n');
    const pattern = /renderer\.setPixelRatio\(/;

    lines.forEach((line, idx) => {
        if (pattern.test(line)) {
            results.push({
                line: idx + 1,
                lineText: line.trim()
            });
        }
    });

    return results;
}

/**
 * Check if a line contains the canonical pixel ratio formula.
 * Uses regex to handle any whitespace variations.
 */
function hasCanonicalPixelRatioFormula(lineText) {
    // The canonical formula must contain:
    // - renderer.setPixelRatio call
    // - Math.min()
    // - window.devicePixelRatio
    // - S.pixelScale multiplier
    // - capped at 2
    const canonicalPattern = /renderer\.setPixelRatio\s*\(\s*Math\.min\s*\(\s*window\.devicePixelRatio\s*\*\s*S\.pixelScale\s*,\s*2\s*\)\s*\)/;
    return canonicalPattern.test(lineText);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc.js pixel ratio — Step 4.2 (F-10)', () => {

    describe('single canonical formula', () => {

        it('(a) all setPixelRatio calls use the same formula', () => {
            const callSites = findPixelRatioCallSites();
            expect(callSites.length).toBeGreaterThan(0);

            // All call sites should match the canonical pattern
            callSites.forEach(site => {
                expect(hasCanonicalPixelRatioFormula(site.lineText)).toBe(true);
            });
        });

        it('(b) canonical formula is Math.min(window.devicePixelRatio * S.pixelScale, 2)', () => {
            const callSites = findPixelRatioCallSites();
            expect(callSites.length).toBeGreaterThan(0);

            // Every call site should use the canonical formula with S.pixelScale
            callSites.forEach(site => {
                expect(hasCanonicalPixelRatioFormula(site.lineText)).toBe(true);
                // Should NOT have the buggy pattern (devicePixelRatio without S.pixelScale)
                const buggyInline = /devicePixelRatio\s*,\s*2\s*\)/;
                expect(buggyInline.test(site.lineText)).toBe(false);
            });
        });

        it('(c) pixel ratio is NOT set with devicePixelRatio alone (missing S.pixelScale)', () => {
            // The buggy pattern was: Math.min(window.devicePixelRatio, 2)
            // which ignores user quality settings
            const buggyPattern = /renderer\.setPixelRatio\s*\(\s*Math\.min\s*\(\s*window\.devicePixelRatio\s*,\s*2\s*\)\s*\)/g;

            // Count occurrences of the buggy pattern in the source
            const matches = DC_SOURCE.match(buggyPattern) || [];
            expect(matches).toHaveLength(0);
        });

    });

    describe('S.pixelScale is defined as the quality multiplier', () => {

        it('S.pixelScale exists in the settings object', () => {
            // The S object has pixelScale defined
            const pixelScaleDef = /pixelScale:\s*[\d.]+/;
            expect(DC_SOURCE).toMatch(pixelScaleDef);
        });

        it('S.pixelScale default is 1.0 (full quality)', () => {
            // Default pixelScale is 1.0 meaning full device pixel ratio
            const defaultPattern = /pixelScale:\s*1\.0/;
            expect(DC_SOURCE).toMatch(defaultPattern);
        });

    });

});
