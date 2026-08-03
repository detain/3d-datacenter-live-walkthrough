/**
 * tests/js/dc-pointer-lock.test.js — pointer lock with unadjustedMovement (R2.5)
 *
 * The old version was three source greps, and one of them (`catch[^}]*controls\.lock`) matched
 * the DEAD catch block: Element.requestPointerLock(options) returns a Promise and rejects
 * ASYNCHRONOUSLY when the option dictionary is refused or the lock is denied — it does not throw
 * synchronously. So the catch fired only if domElement itself was null, the fallback was
 * unreachable on every real failure path, and the discarded promise produced an unhandled
 * rejection. A grep for "there is a catch containing controls.lock" cannot tell a reachable
 * fallback from an unreachable one.
 *
 * These tests extract the click handler and run it against fakes that reject the way a browser
 * does.
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

/**
 * Slice the instructions-click handler out of init(). It is an anonymous function passed to
 * addEventListener, so it is located by its opening line and walked to a balanced brace.
 */
function sliceClickHandler() {
	const marker = 'instructionsEl.addEventListener("click", function () {';
	const start = SRC.indexOf(marker);
	if (start < 0) throw new Error('the instructions click handler was not found in dc.js — was it renamed?');
	const bodyStart = SRC.indexOf('{', start + marker.length - 1);
	let depth = 0;
	for (let i = bodyStart; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') {
			depth--;
			if (depth === 0) return SRC.slice(bodyStart, i + 1);
		}
	}
	throw new Error('the instructions click handler has unbalanced braces');
}

const HANDLER_BODY = sliceClickHandler();

/**
 * Compile the handler with injected collaborators.
 *
 * @param {object} opts
 *   requestPointerLock  what the canvas method does: 'resolve' | 'reject' | 'throw' | 'undefined' | 'missing'
 *   lockResult          what controls.lock() does: 'promise-resolve' | 'promise-reject' | 'undefined' | 'throw'
 */
function compileHandler({ requestPointerLock = 'resolve', lockResult = 'undefined' } = {}) {
	const calls = { requestPointerLock: 0, lock: 0, warns: [] };

	const domElement = {};
	if (requestPointerLock !== 'missing') {
		domElement.requestPointerLock = (opts) => {
			calls.requestPointerLock++;
			calls.lockOptions = opts;
			if (requestPointerLock === 'throw') throw new TypeError('unknown option dictionary');
			if (requestPointerLock === 'undefined') return undefined;
			if (requestPointerLock === 'reject') return Promise.reject(new Error('The document is not focused'));
			return Promise.resolve();
		};
	}

	const controls = {
		lock: () => {
			calls.lock++;
			if (lockResult === 'throw') throw new Error('lock() blew up');
			if (lockResult === 'promise-reject') return Promise.reject(new Error('denied'));
			if (lockResult === 'promise-resolve') return Promise.resolve();
			return undefined;
		},
	};

	const documentStub = { body: { focus() {} } };
	const consoleStub = { warn: (...a) => calls.warns.push(a.map(String).join(' ')) };

	// eslint-disable-next-line no-new-func
	const fn = new Function('controls', 'renderer', 'document', 'console', 'noteUserInput',
		'return function () ' + HANDLER_BODY + ';')(
		controls, { domElement }, documentStub, consoleStub, () => { calls.noteUserInput = (calls.noteUserInput || 0) + 1; });

	return { fn, calls };
}

/** Let every queued microtask (and the .catch chained inside it) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
describe('dc.js — pointer lock click handler', () => {

	it('asks for unadjustedMovement on the happy path and does not double-lock', async () => {
		// Without the option, 1000 Hz mice produce movementX spikes that read as the camera
		// snapping violently.
		const h = compileHandler({ requestPointerLock: 'resolve' });
		h.fn();
		await flush();
		expect(h.calls.requestPointerLock).toBe(1);
		expect(h.calls.lockOptions).toEqual({ unadjustedMovement: true });
		expect(h.calls.lock).toBe(0);
	});

	it('falls back to controls.lock() when the promise REJECTS', async () => {
		// The reachability test. The browser rejects asynchronously — "The document is not
		// focused" is the common one — and the old try/catch never saw it, so the fallback was
		// dead code on the only path that needed it.
		const h = compileHandler({ requestPointerLock: 'reject' });
		h.fn();
		await flush();
		expect(h.calls.lock).toBe(1);
	});

	it('falls back when the engine returns undefined instead of a promise', async () => {
		// Older engines never took the option dictionary at all.
		const h = compileHandler({ requestPointerLock: 'undefined' });
		h.fn();
		await flush();
		expect(h.calls.lock).toBe(1);
	});

	it('falls back when requestPointerLock throws synchronously', async () => {
		// Some engines throw a TypeError on an unrecognised option dictionary.
		const h = compileHandler({ requestPointerLock: 'throw' });
		h.fn();
		await flush();
		expect(h.calls.lock).toBe(1);
	});

	it('falls back when the canvas has no requestPointerLock at all', async () => {
		const h = compileHandler({ requestPointerLock: 'missing' });
		h.fn();
		await flush();
		expect(h.calls.lock).toBe(1);
	});

	it('logs the reason it fell back', async () => {
		const h = compileHandler({ requestPointerLock: 'reject' });
		h.fn();
		await flush();
		expect(h.calls.warns.join('\n')).toMatch(/falling back/);
	});

	describe('no unhandled rejections', () => {
		// Each case below produced (or could produce) a rejected promise with no handler, which
		// surfaces as an "Unhandled Promise Rejection" in the console on every failed click.

		let unhandled;
		const record = (e) => { unhandled.push(e); };

		beforeEach(() => { unhandled = []; process.on('unhandledRejection', record); });
		afterEach(() => { process.off('unhandledRejection', record); });

		it('when requestPointerLock rejects and lock() succeeds', async () => {
			const h = compileHandler({ requestPointerLock: 'reject', lockResult: 'promise-resolve' });
			h.fn();
			await flush(); await flush();
			expect(unhandled).toHaveLength(0);
		});

		it('when requestPointerLock rejects AND lock() also rejects', async () => {
			// The double-failure path: both promises must be handled, or the second one leaks.
			const h = compileHandler({ requestPointerLock: 'reject', lockResult: 'promise-reject' });
			h.fn();
			await flush(); await flush();
			expect(unhandled).toHaveLength(0);
			expect(h.calls.warns.join('\n')).toMatch(/pointer lock rejected/);
		});

		it('when lock() throws synchronously after a rejection', async () => {
			const h = compileHandler({ requestPointerLock: 'reject', lockResult: 'throw' });
			expect(() => h.fn()).not.toThrow();
			await flush(); await flush();
			expect(unhandled).toHaveLength(0);
			expect(h.calls.warns.join('\n')).toMatch(/pointer lock failed/);
		});

	});

	it('does nothing at all when there are no controls yet', async () => {
		// eslint-disable-next-line no-new-func
		const fn = new Function('controls', 'renderer', 'document', 'console', 'noteUserInput',
			'return function () ' + HANDLER_BODY + ';')(
			null, { domElement: { requestPointerLock: () => { throw new Error('must not be called'); } } },
			{ body: { focus() {} } }, { warn: vi.fn() }, () => {});
		expect(() => fn()).not.toThrow();
	});

});
