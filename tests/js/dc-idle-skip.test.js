/**
 * tests/js/dc-idle-skip.test.js — idle skip, Step 4.3 / F-17 (rewritten by R3.3)
 *
 * The old version required the design Step 4.3 was written to REPLACE: a frame counter
 * (`_tickSkippedFrames`, `_IDLE_FRAME_THRESHOLD = 18000`) reset only from `setLodFocus()`. That
 * counter had one problem the tests could not see. `setLodFocus()` is driven by dc-multi.js; on
 * the plain `dc.html` path nothing calls it, so nothing ever reset the counter. After 18,000
 * frames labels, highlight, blinds and the quality scaler all switched off — whether or not the
 * user was actively walking around — and never came back.
 *
 * "Idle" means "no input for a while", so the gate now measures exactly that, and every input
 * path stamps `noteUserInput()`. These tests run the real `_refreshIdleState()` and
 * `noteUserInput()` against an injected clock rather than matching source text.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_SRC = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_SOURCE = fs.readFileSync(DC_SRC, 'utf8');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function sliceFn(name) {
	const re = new RegExp(`^function ${name}\\(`, 'm');
	const start = DC_SOURCE.search(re);
	if (start < 0) throw new Error(`${name}() not found in dc.js — was it renamed?`);
	let depth = 0, seen = false;
	for (let i = start; i < DC_SOURCE.length; i++) {
		const ch = DC_SOURCE[i];
		if (ch === '{') { depth++; seen = true; } else if (ch === '}') {
			depth--;
			if (seen && depth === 0) return DC_SOURCE.slice(start, i + 1);
		}
	}
	throw new Error(`${name}() has unbalanced braces`);
}

/** Extract an object-literal method body, e.g. `setLodFocus: function (x, z) { … }`. */
function getObjectMethodBody(source, propName) {
	const startRe = new RegExp(`${propName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{`);
	const lines = source.split('\n');
	let startIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (startRe.test(lines[i])) { startIdx = i; break; }
	}
	if (startIdx < 0) return null;
	let depth = 0;
	for (let i = startIdx; i < lines.length; i++) {
		for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
		if (depth === 0 && i > startIdx) return lines.slice(startIdx, i + 1).join('\n');
	}
	return null;
}

/** Live sandbox with a controllable clock. */
function makeIdle({ now = 0 } = {}) {
	const clock = { now };
	const src = [
		DC_SOURCE.match(/^const _IDLE_MS = \d+;/m)[0],
		'let _lastInputAt = 0;',
		'let _skipExpensiveUpdates = false;',
		sliceFn('noteUserInput'),
		sliceFn('_refreshIdleState'),
		'return { noteUserInput, _refreshIdleState, idle: () => _skipExpensiveUpdates,'
		+ ' lastInput: () => _lastInputAt };',
	].join('\n');
	// eslint-disable-next-line no-new-func
	const api = new Function('performance', src)({ now: () => clock.now });
	return { ...api, clock };
}

/** The threshold the module actually uses, read from source so this cannot drift. */
const IDLE_MS = Number(DC_SOURCE.match(/^const _IDLE_MS = (\d+);/m)[1]);

// ---------------------------------------------------------------------------
describe('dc.js — the idle gate measures input recency', () => {

	it('a page just interacted with is not idle', () => {
		const h = makeIdle();
		h.clock.now = 1000;
		h.noteUserInput();
		h._refreshIdleState(h.clock.now);
		expect(h.idle()).toBe(false);
	});

	it('goes idle only after the full threshold has elapsed', () => {
		const h = makeIdle();
		h.clock.now = 1000;
		h.noteUserInput();
		h._refreshIdleState(1000 + IDLE_MS - 1);
		expect(h.idle()).toBe(false);
		h._refreshIdleState(1000 + IDLE_MS + 1);
		expect(h.idle()).toBe(true);
	});

	it('comes back the moment input arrives — this is what the counter could not do', () => {
		// The frame counter only cleared from setLodFocus(), which the dc.html path never calls,
		// so once the scene degraded it stayed degraded for the life of the page.
		const h = makeIdle();
		h.noteUserInput();
		h._refreshIdleState(IDLE_MS * 2);
		expect(h.idle()).toBe(true);
		h.clock.now = IDLE_MS * 2;
		h.noteUserInput();
		expect(h.idle()).toBe(false);
		h._refreshIdleState(h.clock.now);
		expect(h.idle()).toBe(false);
	});

	it('stays active through a long session of continuous input', () => {
		// 30 minutes of activity at one input a minute — far past the old 18,000-frame counter,
		// which would have degraded the scene regardless.
		const h = makeIdle();
		for (let t = 0; t <= 1800000; t += 60000) {
			h.clock.now = t;
			h.noteUserInput();
			h._refreshIdleState(t);
			expect(h.idle(), `t=${t}`).toBe(false);
		}
	});

	it('is recomputed from the clock every frame, so it never latches', () => {
		const h = makeIdle();
		h.noteUserInput();
		h._refreshIdleState(IDLE_MS * 5);
		expect(h.idle()).toBe(true);
		// Same input stamp, earlier query — the gate must follow the clock, not a sticky flag.
		h._refreshIdleState(1);
		expect(h.idle()).toBe(false);
	});

	it('noteUserInput() records when, not just that', () => {
		const h = makeIdle();
		h.clock.now = 4242;
		h.noteUserInput();
		expect(h.lastInput()).toBe(4242);
	});

	it('the threshold is 5 minutes, matching the intent of the old 18000 frames at 60fps', () => {
		expect(IDLE_MS).toBe(300000);
		expect(18000 / 60 * 1000).toBe(IDLE_MS);
	});

});

describe('dc.js — every input path stamps the clock', () => {
	const code = stripComments(DC_SOURCE);

	it('noteUserInput() is actually called — it used to be called from nowhere', () => {
		// It was added by Step 7.6 for bench() and wired into no input handler at all.
		const calls = code.match(/(?<!function\s)noteUserInput\(\)/g) || [];
		expect(calls.length).toBeGreaterThanOrEqual(5);
	});

	it('onKeyDown stamps it', () => {
		expect(stripComments(sliceFn('onKeyDown'))).toMatch(/noteUserInput\(\)/);
	});

	it('onKeyUp stamps it', () => {
		expect(stripComments(sliceFn('onKeyUp'))).toMatch(/noteUserInput\(\)/);
	});

	it('switchLocation stamps it', () => {
		expect(stripComments(sliceFn('switchLocation'))).toMatch(/noteUserInput\(\)/);
	});

	it('the canvas click and pointer-lock handlers stamp it', () => {
		expect(code).toMatch(/domElement\.addEventListener\('click'[\s\S]{0,120}noteUserInput\(\)/);
		expect(code).toMatch(/instructionsEl\.addEventListener\("click"[\s\S]{0,200}noteUserInput\(\)/);
	});

	it('the frame counter is gone', () => {
		// Regression guard: reintroducing a frame counter reintroduces the bug, because the
		// counter's only reset path does not exist on the dc.html page.
		expect(code).not.toMatch(/_tickSkippedFrames/);
		expect(code).not.toMatch(/_IDLE_FRAME_THRESHOLD/);
	});

});

describe('dc.js — tick() and setLodFocus', () => {

	it('tick() refreshes the gate before reading it', () => {
		// Reading a stale flag would delay recovery by a frame at best, and by forever if nothing
		// else recomputed it.
		const code = stripComments(DC_SOURCE);
		expect(code).toMatch(/_refreshIdleState\(now\)[\s\S]{0,200}if\s*\(\s*_skipExpensiveUpdates\s*\)/);
	});

	it('when idle, tick() takes the fast path and still draws', () => {
		// Skipping the render as well as the updates is the failure mode this guards: the scene
		// would freeze on the last drawn frame while everything kept updating invisibly.
		//
		// R3.7 replaced the inline `renderer.render(scene, camera)` in both of tick()'s paths with
		// a shared drawFrame(), because the idle branch knew about the WebGL composer and not the
		// node pipeline — so ambient occlusion switched itself off after five idle minutes on the
		// WebGPU path only. The contract here is unchanged: the fast path still draws.
		const code = stripComments(DC_SOURCE);
		expect(code).toMatch(/if\s*\(\s*_skipExpensiveUpdates\s*\)[\s\S]{0,260}drawFrame\(\)/);
	});

	it('setLodFocus still only reacts to real movement (F-17)', () => {
		// dc-multi.js calls it every frame; treating every call as activity would keep the page
		// permanently "active" and the idle skip would never engage at all.
		const body = stripComments(getObjectMethodBody(DC_SOURCE, 'setLodFocus'));
		expect(body).toMatch(/Math\.abs[\s\S]*lodFocus\.x/);
		expect(body).toMatch(/Math\.abs[\s\S]*lodFocus\.z/);
		expect(body).toMatch(/if\s*\(\s*moved\s*\)[\s\S]*noteUserInput\(\)/);
	});

	it('setLodFocus does not stamp before checking movement', () => {
		const body = stripComments(getObjectMethodBody(DC_SOURCE, 'setLodFocus'));
		const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && l !== '}');
		expect(lines[0]).not.toMatch(/^noteUserInput\(\)/);
	});

	it('setLodFocus still records why the movement check is there', () => {
		expect(getObjectMethodBody(DC_SOURCE, 'setLodFocus')).toMatch(/F-17/);
	});

});
