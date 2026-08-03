/**
 * tests/js/dc-quality-scaler-loop.test.js — the auto-quality control loop, driven for real
 *
 * dc-quality-scaler.test.js asserts on SOURCE TEXT: which constants exist, how the tier gates are
 * spelled, what the toast rules say. None of that can catch a control loop whose decision is
 * unreachable, and one was: FPS_RECOVERY was 65 while the render loop is rAF and therefore
 * vsync-capped, so on a 60 Hz display the measured average could never exceed ~60 and
 * _upgradeQuality() was dead code. The scaler became a one-way ratchet — every dip cost a tier
 * permanently, and a field session came back with 30 seconds of samples showing pixelScale,
 * shadowMapSize and lodBias all pinned at the floor with not one upgrade.
 *
 * So this file drives the real _updateFPS + _autoQualityScale with a synthetic frame clock and
 * spies for the two tier functions, and asserts on the DECISIONS. The tier ladders themselves are
 * covered by dc-quality-scaler.test.js and dc-shadow-gui.test.js.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

function sliceFn(name) {
    const m = SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}
function sliceConst(name) {
    const m = SRC.match(new RegExp('^const ' + name + ' = [^;]+;', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}
function sliceLet(name) {
    const m = SRC.match(new RegExp('^let ' + name + ' = [^;]+;', 'm'));
    if (!m) throw new Error(`dc.js no longer declares let ${name} at top level — update this spec`);
    return m[0];
}

/**
 * Build a sandbox holding the real _updateFPS and _autoQualityScale over the real constants and
 * ring-buffer state, with the two tier functions replaced by counters.
 */
function makeLoop() {
    const calls = { down: 0, up: 0 };
    const src = [
        sliceConst('FPS_WINDOW'),
        // The ring buffer and its cursors are module-scope state both functions share, so they
        // have to be declared inside the sandbox rather than injected as copies.
        'const _fpsHistory = new Array(FPS_WINDOW).fill(0);',
        'let _fpsHead = 0;',
        'let _fpsCount = 0;',
        sliceLet('_lastFrameTime'),
        sliceLet('_qualityDowngradeTime'),
        sliceLet('_lastUpgradeTime'),
        sliceConst('FPS_TARGET'),
        sliceConst('FPS_RECOVERY'),
        sliceConst('DOWNGRADE_COOLDOWN'),
        sliceConst('UPGRADE_COOLDOWN'),
        sliceConst('MAX_PLAUSIBLE_FRAME_MS'),
        'let _autoQualityEnabled = true;',
        sliceFn('_updateFPS'),
        sliceFn('_autoQualityScale'),
        'return { _updateFPS, _autoQualityScale, FPS_TARGET, FPS_RECOVERY, MAX_PLAUSIBLE_FRAME_MS,'
        + ' FPS_WINDOW, DOWNGRADE_COOLDOWN, UPGRADE_COOLDOWN, fps: () => {'
        + '   if (_fpsCount < FPS_WINDOW) return null;'
        + '   let s = 0; for (let i = 0; i < FPS_WINDOW; i++) s += _fpsHistory[(_fpsHead + i) % FPS_WINDOW];'
        + '   return 1000 / (s / FPS_WINDOW); },'
        // What DC.tick does on the paths that skip _updateFPS (tab hidden, idle gate closed).
        + ' dropAnchor: () => { _lastFrameTime = 0; } };',
    ].join('\n');

    // eslint-disable-next-line no-new-func
    const api = new Function('_reduceQuality', '_upgradeQuality', src)(
        () => { calls.down++; },
        () => { calls.up++; }
    );
    return { ...api, calls };
}

/** Run `n` frames of `deltaMs` each through the loop, starting at t = `start`. Returns the end time. */
function runFrames(loop, n, deltaMs, start = 1000) {
    let t = start;
    for (let i = 0; i < n; i++) {
        t += deltaMs;
        loop._updateFPS(t);
        loop._autoQualityScale(t);
    }
    return t;
}

const VSYNC_60 = 1000 / 60;   // 16.667ms — what a healthy scene on a 60 Hz panel actually measures

describe('auto-quality control loop — decisions, not source text', () => {

    it('both thresholds sit below a 60 Hz vsync ceiling, so recovery is physically reachable', () => {
        const loop = makeLoop();
        // The bug in one assertion: a rAF loop cannot report more than the refresh rate, so a
        // recovery gate at or above it can never open no matter how fast the scene renders.
        expect(loop.FPS_RECOVERY).toBeLessThan(60);
        expect(loop.FPS_TARGET).toBeLessThan(loop.FPS_RECOVERY);   // a real hysteresis band
    });

    it('a scene running at a steady vsync 60 UPGRADES rather than sitting there', () => {
        const loop = makeLoop();
        // Fill the window, then keep going long enough to clear UPGRADE_COOLDOWN.
        runFrames(loop, loop.FPS_WINDOW + 300, VSYNC_60);
        expect(loop.fps()).toBeGreaterThan(59);       // it really is rendering at vsync
        expect(loop.calls.up).toBeGreaterThan(0);     // ...and the scaler acts on that
        expect(loop.calls.down).toBe(0);              // with no downgrade at a healthy frame rate
    });

    it('a genuinely struggling scene still downgrades', () => {
        const loop = makeLoop();
        // Start past DOWNGRADE_COOLDOWN. _qualityDowngradeTime initialises to 0 and the guard is
        // `now - _qualityDowngradeTime < DOWNGRADE_COOLDOWN`, so no downgrade can fire until the
        // frame clock passes 10s — an accidental startup grace period that happens to cover the
        // load window. Worth knowing about, but not what this test is measuring.
        runFrames(loop, loop.FPS_WINDOW + 60, 40, 20000);    // 25fps
        expect(loop.calls.down).toBeGreaterThan(0);
        expect(loop.calls.up).toBe(0);
    });

    it('leaves quality alone in the band between the two thresholds', () => {
        const loop = makeLoop();
        // ~50fps: below FPS_RECOVERY, above FPS_TARGET. Neither branch should fire, or the loop
        // would oscillate around its own set point.
        runFrames(loop, loop.FPS_WINDOW + 300, 20);
        expect(loop.fps()).toBeGreaterThan(loop.FPS_TARGET);
        expect(loop.fps()).toBeLessThan(loop.FPS_RECOVERY);
        expect(loop.calls.down).toBe(0);
        expect(loop.calls.up).toBe(0);
    });

    it('a tab-resume gap is discarded instead of being charged as one enormous frame', () => {
        const loop = makeLoop();
        // Steady 60 first, so the window is full of healthy samples and the loop is content.
        let t = runFrames(loop, loop.FPS_WINDOW + 300, VSYNC_60);
        const upsBefore = loop.calls.up;

        // Now the tab goes away for 60 seconds. DC.tick returns before _updateFPS both when the
        // document is hidden and when the idle gate is closed, and _lastFrameTime is written ONLY
        // inside _updateFPS — so the anchor freezes and the first resumed frame measures the whole
        // gap. Unclamped, that single 60000ms sample drags the 60-frame average to about 1fps and
        // forces a downgrade on every single return to the tab.
        t += 60000;
        loop._updateFPS(t);
        loop._autoQualityScale(t);

        expect(loop.calls.down).toBe(0);
        // And the measurement is undisturbed: the gap was dropped, not averaged in.
        expect(loop.fps()).toBeGreaterThan(59);

        // The clamp must not wedge the loop either — normal frames still flow afterwards.
        runFrames(loop, 300, VSYNC_60, t);
        expect(loop.calls.up).toBeGreaterThan(upsBefore);
    });

    it('nulling the anchor on a skipped tick discards the resume frame', () => {
        const loop = makeLoop();
        let t = runFrames(loop, loop.FPS_WINDOW + 300, VSYNC_60);

        // DC.tick nulls _lastFrameTime on both paths that skip _updateFPS — tab hidden and idle
        // gate closed. This is the mechanism that actually fixes the resume poison; the magnitude
        // clamp is only a backstop for pauses that do NOT skip the tick.
        loop.dropAnchor();
        t += 60000;
        loop._updateFPS(t);
        loop._autoQualityScale(t);

        expect(loop.calls.down).toBe(0);
        expect(loop.fps()).toBeGreaterThan(59);   // the gap never entered the window
    });

    it('a slow machine is still scaled — the clamp must not switch the scaler off', () => {
        // The regression this pins: the first version of the magnitude clamp was 250ms, which is
        // BELOW what a struggling renderer produces. Every sample was discarded, so _fpsCount
        // never reached FPS_WINDOW, _autoQualityScale returned at its first line, and automatic
        // quality reduction was disabled on exactly the machines that depend on it. It has to stay
        // above any frame time a live renderer can plausibly hit.
        const loop = makeLoop();
        expect(loop.MAX_PLAUSIBLE_FRAME_MS).toBeGreaterThan(500);

        // ~3fps. Miserable, but real, and every frame of it is evidence.
        runFrames(loop, loop.FPS_WINDOW + 60, 300, 20000);
        expect(loop.fps()).not.toBeNull();          // the window filled at all
        expect(loop.calls.down).toBeGreaterThan(0); // ...and the scaler acted on it
    });
});
