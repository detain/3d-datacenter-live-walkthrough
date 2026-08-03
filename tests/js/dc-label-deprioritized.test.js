/**
 * tests/js/dc-label-deprioritized.test.js — the `updateLabels()` dePrioritized flag bug
 *
 * Bug: updateLabels() set `dePrioritized = true` for labels beyond MAX_LABELS (200) in the
 * distance-sorted order, but the flag was NEVER cleared when those labels moved back into
 * the nearest 200. In a room with 3137 labels that meant every label died within seconds of
 * walking — once a label fell outside the top 200 it was hidden for the rest of the session,
 * even at point-blank range.
 *
 * The fix (dc.js lines 1445-1452): the loop that assigns the flag now runs over ALL labels
 * and sets `dePrioritized = (i >= MAX_LABELS)` — so a label that was beyond index 200 and
 * is now within it gets dePrioritized = false in the same frame.
 *
 * This is a pure-logic bug, so the test slices the real `updateLabels` out of dc.js and
 * runs it against a minimal Three.js stub — the same pattern as dc-model-guards.test.js.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Slicing the real source (same technique as dc-model-guards.test.js)
// ---------------------------------------------------------------------------
function extractFn(name) {
    const m = SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}
function extractLine(name) {
    // Match up to the first semicolon (const values may have trailing // comments)
    const m = SRC.match(new RegExp('^const ' + name + ' = [^;]+;', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}
// updateLabels() ranks on a countdown held in a module-scope `let`. Slice the real declaration
// rather than injecting a copy, so the sandbox shares one binding with the sliced function — the
// same reason dc-shadow-gui.test.js declares _shadowMapSize inside its sandbox.
function extractLet(name) {
    const m = SRC.match(new RegExp('^let ' + name + ' = [^;]+;', 'm'));
    if (!m) throw new Error(`dc.js no longer declares let ${name} at top level — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// Minimal THREE stub providing only what updateLabels() needs
// ---------------------------------------------------------------------------
class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    distanceToSquared(other) {
        const dx = this.x - other.x, dy = this.y - other.y, dz = this.z - other.z;
        return dx * dx + dy * dy + dz * dz;
    }
    getWorldPosition(target) { target.x = this.x; target.y = this.y; target.z = this.z; }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe('dc.js — updateLabels() dePrioritized flag', () => {
    it('sets dePrioritized=false when a label moves back into the nearest MAX_LABELS', () => {
        // Extract the real updateLabels and MAX_LABELS from dc.js
        const prelude = [
            extractLine('MAX_LABELS'),
            extractLine('LABEL_DISTANCE'),
            extractLine('LABEL_DISTANCE_SQ'),
            // Scratch state added when the per-frame allocation + sort was removed from the hot
            // path. _labelRankCountdown starts at 0, so the first call still ranks — which is what
            // every assertion below depends on.
            extractLine('_labelScratch'),
            extractLine('LABEL_RANK_INTERVAL'),
            extractLine('LABEL_BUILD_BUDGET'),
            extractLet('_labelRankCountdown'),
            extractFn('_byLabelDistance'),
            extractFn('updateLabels'),
        ].join('\n');

        // Build the function factory providing the minimal environment updateLabels needs
        const factory = new Function(
            'Vector3',
            'camera', 'options', 'objects', '_labelCamPos', 'makeLabelTexture',
            prelude + '\nreturn { updateLabels, MAX_LABELS, LABEL_DISTANCE, LABEL_DISTANCE_SQ, LABEL_RANK_INTERVAL };'
        );

        const _labelCamPos = new Vector3();
        const camera = { getWorldPosition: (t) => _labelCamPos.getWorldPosition(t) };
        const objects = { labels: [], rackLabels: [] };
        const options = { showLabels: true };
        const makeLabelTexture = () => null;

        const { updateLabels, MAX_LABELS, LABEL_DISTANCE, LABEL_RANK_INTERVAL } = factory(
            Vector3,
            camera, options, objects, _labelCamPos, makeLabelTexture
        );

        // Sanity check
        expect(MAX_LABELS).toBe(200);

        // Create 250 labels at x = 0, 10, 20, ..., 2490 (y=0, z=0)
        // All start far from the camera (which will be at origin)
        for (let i = 0; i < 250; i++) {
            const sprite = {
                position: new Vector3(i * 10, 0, 0),
                visible: true,
                material: { map: null, needsUpdate: false },
                userData: { dePrioritized: false, drawn: false, text: `Label ${i}` },
            };
            objects.labels.push(sprite);
        }

        // --- Frame 1: camera at origin (0,0,0) ---
        // All labels are at x >= 0, so distances increase with index.
        // Sorted order is labels 0..249 by distance. Label 210 is at index 210 (> MAX_LABELS).
        // With the bug: label 210.userData.dePrioritized = true   (set once, never cleared)
        // With the fix:  label 210.userData.dePrioritized = true   (correct — 210 >= 200)
        _labelCamPos.x = 0; _labelCamPos.y = 0; _labelCamPos.z = 0;
        updateLabels();

        // Verify that the top MAX_LABELS (0-199) have dePrioritized = false
        // and those beyond (200-249) have dePrioritized = true
        for (let i = 0; i < 250; i++) {
            expect(objects.labels[i].userData.dePrioritized).toBe(i >= MAX_LABELS);
        }

        // --- Camera moves right on top of label 210 ---
        // Camera at x=2100 — which is ~0 units from label 210 (at x=2100).
        // Label 210 is now the CLOSEST label. Labels 0-4 are 2100, 2090, 2080, 2070, 2060 units away.
        // Sorted by distance: label 210 (dist 0), labels 209+211 (dist 10), labels 208+212 (dist 20), ...
        // Label 210 is now at sorted INDEX 0 — well within MAX_LABELS.
        // With the bug: label 210.userData.dePrioritized stays true FOREVER (never cleared).
        // With the fix:  it is cleared on the next ranking pass.
        _labelCamPos.x = 2100; _labelCamPos.y = 0; _labelCamPos.z = 0;

        // Ranking is throttled to one pass every LABEL_RANK_INTERVAL frames — the per-frame sort
        // over every label in the scene was ~190k allocations/sec and the dominant source of the
        // GC pauses users felt as periodic stutter. Assert the throttle explicitly, so the
        // interval is a pinned contract rather than an accident: the very next frame must NOT
        // re-rank, and the pass must land within the interval.
        updateLabels();
        expect(objects.labels[210].userData.dePrioritized).toBe(true);   // still stale, by design

        // Drive out the countdown. This must converge — an un-cleared flag is the original bug,
        // and a throttle that never fires would be the same defect wearing a different hat.
        for (let f = 0; f < LABEL_RANK_INTERVAL; f++) updateLabels();

        expect(objects.labels[210].userData.dePrioritized).toBe(false);
        // And the rest of the ranking is still correct after the delayed pass: label 210 is now
        // nearest, so the labels furthest from x=2100 (the low indices) are the de-prioritised ones.
        expect(objects.labels[0].userData.dePrioritized).toBe(true);
    });

    it('clears dePrioritized for ALL labels when total count drops below MAX_LABELS', () => {
        const prelude = [
            extractLine('MAX_LABELS'),
            extractLine('LABEL_DISTANCE'),
            extractLine('LABEL_DISTANCE_SQ'),
            // Scratch state added when the per-frame allocation + sort was removed from the hot
            // path. _labelRankCountdown starts at 0, so the first call still ranks — which is what
            // every assertion below depends on.
            extractLine('_labelScratch'),
            extractLine('LABEL_RANK_INTERVAL'),
            extractLine('LABEL_BUILD_BUDGET'),
            extractLet('_labelRankCountdown'),
            extractFn('_byLabelDistance'),
            extractFn('updateLabels'),
        ].join('\n');

        const factory = new Function(
            'Vector3',
            'camera', 'options', 'objects', '_labelCamPos', 'makeLabelTexture',
            prelude + '\nreturn { updateLabels, MAX_LABELS };'
        );

        const _labelCamPos = new Vector3();
        const camera = { getWorldPosition: (t) => _labelCamPos.getWorldPosition(t) };
        const objects = { labels: [], rackLabels: [] };
        const options = { showLabels: true };
        const makeLabelTexture = () => null;

        const { updateLabels } = factory(
            Vector3,
            camera, options, objects, _labelCamPos, makeLabelTexture
        );

        // Only 50 labels — below MAX_LABELS (200), so the else branch runs
        for (let i = 0; i < 50; i++) {
            objects.labels.push({
                position: new Vector3(i * 10, 0, 0),
                visible: true,
                material: { map: null, needsUpdate: false },
                userData: { dePrioritized: true, drawn: false, text: `L${i}` },
            });
        }

        _labelCamPos.x = 0; _labelCamPos.y = 0; _labelCamPos.z = 0;
        updateLabels();

        // The else branch explicitly clears all dePrioritized flags
        for (let i = 0; i < 50; i++) {
            expect(objects.labels[i].userData.dePrioritized).toBe(false);
        }
    });
});
