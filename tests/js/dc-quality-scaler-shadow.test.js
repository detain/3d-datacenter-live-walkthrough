/**
 * tests/js/dc-quality-scaler-shadow.test.js — quality scaler Step 6.3
 *
 * Verifies:
 * (a) _reduceQuality() calls _applyShadowMapSize before setPixelRatio (shadow halving first)
 * (b) _upgradeQuality() calls _applyShadowMapSize after setPixelRatio/lodBias (shadow doubling last)
 * (c) 30-second lockout between downgrade and upgrade is enforced
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
function extractBlock(fnName, blockName) {
    // Extract a named comment block inside a function, e.g. "Step 1: halve the shadow map size"
    const re = new RegExp(
        `function ${fnName}\\([\\s\\S]*?//\\s*${blockName}[\\s\\S]*?^(?:\\nfunction |\\nconst |\\nlet |\\n$)`,
        'm'
    );
    const m = DC_SOURCE.match(re);
    if (!m) throw new Error(`Could not find "${blockName}" inside ${fnName}()`);
    return m[0];
}

function getFunctionSource(fnName) {
    const re = new RegExp(`function ${fnName}\\([\\s\\S]*?^}`, 'm');
    const m = DC_SOURCE.match(re);
    if (!m) throw new Error(`Could not find function ${fnName}()`);
    return m[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc.js quality scaler — Step 6.3 shadow tier re-enabled', () => {

    describe('(a) _reduceQuality — shadow halving FIRST (before pixelScale)', () => {

        it('Step 1 comment says shadow map halving comes first', () => {
            const block = extractBlock('_reduceQuality', 'Step 1');
            expect(block).toMatch(/shadow map size/i);
        });

        it('calls _applyShadowMapSize before renderer.setPixelRatio', () => {
            // The shadow map step (now Step 1) must call _applyShadowMapSize
            // The pixel scale step (now Step 2) must call renderer.setPixelRatio
            // Since shadow is Step 1 and pixelScale is Step 2, _applyShadowMapSize appears first
            const fn = getFunctionSource('_reduceQuality');
            const shadowIdx = fn.indexOf('_applyShadowMapSize');
            const pixelIdx = fn.indexOf('setPixelRatio');
            expect(shadowIdx).not.toBe(-1);
            expect(pixelIdx).not.toBe(-1);
            expect(shadowIdx).toBeLessThan(pixelIdx);
        });

        it('sets _lastDowngradeAt when shadow map is reduced', () => {
            const block = extractBlock('_reduceQuality', 'Step 1');
            expect(block).toMatch(/_lastDowngradeAt\s*=\s*Date\.now/);
        });
    });

    describe('(b) _upgradeQuality — shadow doubling LAST (after pixelScale and lodBias)', () => {

        it('shadow doubling is the last step in _upgradeQuality', () => {
            // Verify the function ends with the shadow map doubling block
            // by checking that setPixelRatio appears before _applyShadowMapSize
            const fn = getFunctionSource('_upgradeQuality');
            const pixelIdx = fn.indexOf('setPixelRatio');
            const shadowIdx = fn.indexOf('_applyShadowMapSize');
            expect(pixelIdx).not.toBe(-1);
            expect(shadowIdx).not.toBe(-1);
            expect(pixelIdx).toBeLessThan(shadowIdx);
        });

        it('lodBias reduction comes before shadow doubling', () => {
            const fn = getFunctionSource('_upgradeQuality');
            const lodBiasIdx = fn.indexOf("S.lodBias");
            const shadowIdx = fn.indexOf('_applyShadowMapSize');
            expect(lodBiasIdx).not.toBe(-1);
            expect(shadowIdx).not.toBe(-1);
            expect(lodBiasIdx).toBeLessThan(shadowIdx);
        });

        it('shadow block retains S.shadowsEnabled guard', () => {
            const block = extractBlock('_upgradeQuality', 'Reverse Step 2');
            expect(block).toMatch(/if\s*\(\s*S\.shadowsEnabled\s*&&/);
        });
    });

    describe('(c) 30-second UPGRADE_LOCKOUT_MS oscillation guard', () => {

        it('UPGRADE_LOCKOUT_MS is defined as 30000', () => {
            expect(DC_SOURCE).toMatch(/const UPGRADE_LOCKOUT_MS\s*=\s*30000/);
        });

        it('_lastDowngradeAt variable is declared', () => {
            expect(DC_SOURCE).toMatch(/let _lastDowngradeAt\s*=\s*0/);
        });

        it('_upgradeQuality checks lockout before shadow map upgrade', () => {
            const block = extractBlock('_upgradeQuality', 'Reverse Step 2');
            // Must check: Date.now() - _lastDowngradeAt < UPGRADE_LOCKOUT_MS
            expect(block).toMatch(/Date\.now\(\)\s*-\s*_lastDowngradeAt\s*<\s*UPGRADE_LOCKOUT_MS/);
        });

        it('lockout returns early without upgrading (does not call _applyShadowMapSize in lockout branch)', () => {
            const block = extractBlock('_upgradeQuality', 'Reverse Step 2');
            // The lockout branch must return before calling _applyShadowMapSize
            // So _applyShadowMapSize must appear AFTER the lockout check
            const lockoutIdx = block.indexOf('UPGRADE_LOCKOUT_MS');
            const applyIdx = block.indexOf('_applyShadowMapSize');
            expect(lockoutIdx).not.toBe(-1);
            expect(applyIdx).toBeGreaterThan(lockoutIdx);
        });
    });

    describe('S.shadowsEnabled guard retained', () => {

        it('_reduceQuality shadow block still gated on S.shadowsEnabled', () => {
            const block = extractBlock('_reduceQuality', 'Step 1');
            expect(block).toMatch(/if\s*\(\s*S\.shadowsEnabled\s*&&/);
        });

        it('_upgradeQuality shadow block still gated on S.shadowsEnabled', () => {
            const block = extractBlock('_upgradeQuality', 'Reverse Step 2');
            expect(block).toMatch(/if\s*\(\s*S\.shadowsEnabled\s*&&/);
        });
    });
});
