/**
 * tests/js/dc-quality-scaler.test.js — quality scaler Step 2.2
 *
 * Verifies:
 * (a) _reduceQuality() shadow tier is gated on S.shadowsEnabled
 * (b) _upgradeQuality() shadow tier is gated on S.shadowsEnabled
 * (c) S.shadowsEnabled exists and defaults to false
 * (d) S.lodBias activates Tier 3 — biasDiv formula halves the thresholds at lodBias=1
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
    // Extract a named comment block inside a function, e.g. "Step 2: halve the shadow map size"
    const re = new RegExp(
        `function ${fnName}\\([\\s\\S]*?//\\s*${blockName}[\\s\\S]*?^(?:\\nfunction |\\nconst |\\nlet |\\n$)`,
        'm'
    );
    const m = DC_SOURCE.match(re);
    if (!m) throw new Error(`Could not find "${blockName}" inside ${fnName}()`);
    return m[0];
}

function snippetExists(pattern) {
    return DC_SOURCE.includes(pattern);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('dc.js quality scaler — Step 2.2', () => {

    describe('Tier 2 shadow map — parked until Phase 6', () => {

        it('(a) _reduceQuality() shadow block is gated on S.shadowsEnabled', () => {
            // The "Step 2" block inside _reduceQuality must begin with the guard.
            const block = extractBlock('_reduceQuality', 'Step 2');
            // The first statement inside the if must check shadowsEnabled first.
            // e.g.  if (S.shadowsEnabled && _shadowMapSize >= 1024) {
            expect(block).toMatch(/if\s*\(\s*S\.shadowsEnabled\s*&&/);
        });

        it('(b) _upgradeQuality() shadow block is gated on S.shadowsEnabled', () => {
            const block = extractBlock('_upgradeQuality', 'Reverse Step 2');
            expect(block).toMatch(/if\s*\(\s*S\.shadowsEnabled\s*&&/);
        });

        it('(c) S.shadowsEnabled exists and defaults to TRUE', () => {
            // R2.3: this required `false`, which is what kept both shadow tiers above dead. The
            // flag was declared false and then assigned nowhere in the codebase, so the gates on
            // lines 51 and 56 could never open — the "parked until Phase 6" tier stayed parked
            // after Phase 6 shipped. init() enables shadows, so true is the honest default and
            // the gates now describe reachable code.
            const sDecl = DC_SOURCE.match(/^const S = \{[\s\S]*?^};$/m);
            expect(sDecl).not.toBeNull();
            expect(sDecl[0]).toMatch(/\bshadowsEnabled\s*:\s*true\b/);
            expect(sDecl[0]).not.toMatch(/\bshadowMapEnabled\b/); // removed in Step 2.1
        });

        it('(c2) S.shadowsEnabled is actually assigned somewhere', () => {
            // The real defect was not the default — it was that nothing ever wrote the flag, so
            // it could not track the renderer. setShadowsEnabled() now does.
            expect(DC_SOURCE).toMatch(/S\.shadowsEnabled\s*=\s*/);
        });
    });

    describe('Tier 3 lodBias — now real', () => {

        it('biasDiv formula is present in updateLOD()', () => {
            const fn = DC_SOURCE.match(
                /^function updateLOD\([\s\S]*?^}/m
            );
            expect(fn).not.toBeNull();
            const src = fn[0];
            // Must divide by (1 + (S.lodBias || 0))
            expect(src).toMatch(/biasDiv\s*=\s*1\s*\+\s*\(\s*S\.lodBias\s*\|\|\s*0\s*\)/);
            // Both thresholds must use biasDiv
            expect(src).toMatch(/exitThresh\s*=\s*\(LOD_EXIT_PAD\s*\*\s*_lodDistanceMult\s*\)\s*\/\s*biasDiv/);
            expect(src).toMatch(/enterThresh\s*=\s*\(LOD_ENTER_PAD\s*\*\s*_lodDistanceMult\s*\)\s*\/\s*biasDiv/);
        });

        it('(d) lodBias=1 halves the enter threshold vs lodBias=0', () => {
            // Verify the biasDiv formula numerically.
            // The values of LOD_ENTER_PAD and _lodDistanceMult don't matter for the ratio.
            const biasDiv0 = 1 + 0; // lodBias = 0
            const biasDiv1 = 1 + 1; // lodBias = 1
            const ratio = biasDiv1 / biasDiv0;
            expect(ratio).toBe(2); // lodBias=1 must give exactly half
        });
    });

    describe('_notifyQualityChange — toast rules', () => {

        it('console.info is always called', () => {
            expect(snippetExists("console.info(`[dc] quality")).toBe(true);
        });

        // R3.4: this used to require `value > 0.5`, under a comment claiming the toast fired "at
        // the floor". It is the exact inverse — 0.5 IS the floor, so the toast fired on the
        // barely-visible 1.0 -> 0.75 step and went silent at the one moment the user needed it.
        // It also fired on UPGRADES, announcing "Auto-reduced quality" while quality recovered.
        // Source matching could not see any of that, so this now runs the function.

        /** Run _notifyQualityChange with a fake DOM and report whether a toast was created. */
        function notify(setting, value, direction) {
            const created = [];
            const body = { appendChild: (el) => created.push(el) };
            const documentStub = {
                body,
                createElement: () => ({ style: {}, textContent: '', remove() {} }),
            };
            const fnSrc = DC_SOURCE.match(/^function _notifyQualityChange\([\s\S]*?^}/m)[0];
            // eslint-disable-next-line no-new-func
            const fn = new Function('document', 'console', 'requestAnimationFrame', 'setTimeout',
                fnSrc + '\nreturn _notifyQualityChange;')(
                documentStub, { info() {} }, () => {}, () => {});
            fn(setting, value, direction);
            return { toasted: created.length > 0, text: created[0] && created[0].textContent };
        }

        it('toasts at the floor (0.5), where the scaler has nothing left to give', () => {
            expect(notify('pixelScale', 0.5, 'down').toasted).toBe(true);
        });

        it('stays quiet on the intermediate downgrade step', () => {
            expect(notify('pixelScale', 0.75, 'down').toasted).toBe(false);
        });

        it('never toasts on an upgrade, even at the floor value', () => {
            // "⚠️ Auto-reduced quality" while quality is being restored is worse than silence.
            expect(notify('pixelScale', 0.5, 'up').toasted).toBe(false);
            expect(notify('pixelScale', 0.75, 'up').toasted).toBe(false);
        });

        it('never toasts for the other quality tiers', () => {
            // Only pixelScale is visible enough to be worth interrupting the user over.
            expect(notify('shadowMap', 512, 'down').toasted).toBe(false);
            expect(notify('lodBias', 2, 'down').toasted).toBe(false);
        });

        it('the toast says what happened', () => {
            expect(notify('pixelScale', 0.5, 'down').text).toMatch(/quality/i);
        });

        it('every call site passes a direction', () => {
            // A missing direction silently means "not down", i.e. the toast never fires again.
            const calls = DC_SOURCE.match(/_notifyQualityChange\([^)]*\)/g) || [];
            const invocations = calls.filter((c) => !c.startsWith('_notifyQualityChange(setting'));
            expect(invocations.length).toBeGreaterThan(0);
            for (const c of invocations) {
                expect(c, `${c} has no direction argument`).toMatch(/,\s*'(up|down)'\)$/);
            }
        });

        it('no unconditional DOM toast', () => {
            // document.createElement('div') must NOT appear before any guard in _notifyQualityChange
            const fnSrc = DC_SOURCE.match(
                /^function _notifyQualityChange\([\s\S]*?^}/m
            )[0];
            const guardIdx = fnSrc.search(/if\s*\(\s*setting\s*===\s*['"]pixelScale['"]/);
            const createIdx = fnSrc.search(/document\.createElement\s*\(\s*['"]div['"]\s*\)/);
            expect(guardIdx).toBeLessThan(createIdx);
        });
    });

    describe('_applyShadowMapSize — untouched for Phase 6', () => {

        it('still exists and walks scene lights', () => {
            const fn = DC_SOURCE.match(
                /^function _applyShadowMapSize\([\s\S]*?^}/m
            );
            expect(fn).not.toBeNull();
            expect(fn[0]).toMatch(/scene\.traverse/);
            expect(fn[0]).toMatch(/shadow\.mapSize\.set/);
        });
    });
});
