/**
 * tests/js/dc-ric-guard.test.js — the requestIdleCallback guard in public_html/js/dc.js
 *
 * The module-level `_ric` constant is initialised before anything else runs, so if the
 * `requestIdleCallback` global is absent (or shadowed to a non-function) the ternary
 * `requestIdleCallback ?` threw a ReferenceError and the entire DC module crashed — window.DC
 * was never assigned and every satellite module timed out waiting for it.
 *
 * The fix uses `typeof requestIdleCallback === 'function'` as a guard, which is safe to
 * evaluate even when the global does not exist.
 *
 * Run: yarn test:js
 */

import { describe, it, expect } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Slice the real source
// ---------------------------------------------------------------------------
function extractMultiLineConst(name) {
    // Match a top-level const that spans multiple lines (the ternary).
    // Starts at column 0 (`const name = `) and closes at the left margin with `};`.
    const m = SRC.match(new RegExp('^const ' + name + ' = [\\s\\S]*?^\\};$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} — update this spec`);
    return m[0];
}

function extractLet(name) {
    // Top-level `let name = ...;` on a single line.
    const m = SRC.match(new RegExp('^let ' + name + ' = .*;$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares let ${name} — update this spec`);
    return m[0];
}

// ---------------------------------------------------------------------------
// The guard: when `requestIdleCallback` is absent the polyfill must be returned,
// not a ReferenceError.
// ---------------------------------------------------------------------------
describe('dc.js — _ric requestIdleCallback guard', () => {
    it('returns the polyfill when requestIdleCallback is NOT defined', () => {
        // Need both _ricChannel (referenced by the polyfill) and _ric
        const _ricChannelSrc = extractLet('_ricChannel');
        const _ricSrc = extractMultiLineConst('_ric');

        const wrapped = `(() => { ${_ricChannelSrc}\n${_ricSrc}; return _ric; })()`;

        // Compile it inside a VM context with no requestIdleCallback global
        const vm = require('node:vm');
        const sandbox = { console, Math, Date, Array, Object, Map, Set, Promise, MessageChannel };
        vm.createContext(sandbox);

        // Deliberately NO requestIdleCallback in the sandbox — it must not throw
        const fn = new vm.Script(wrapped);
        const _ric = fn.runInContext(sandbox);

        // _ric must be a function (the polyfill branch), not a ReferenceError
        expect(typeof _ric).toBe('function');
    });

    it('returns the native when requestIdleCallback IS defined', () => {
        const _ricSrc = extractMultiLineConst('_ric');
        const wrapped = `(() => { ${_ricSrc}; return _ric; })()`;

        const vm = require('node:vm');
        const sandbox = {
            console, Math, Date, Array, Object, Map, Set, Promise,
            requestIdleCallback: (cb) => { cb({ didTimeout: false }); return 42; },
        };
        vm.createContext(sandbox);

        const fn = new vm.Script(wrapped);
        const _ric = fn.runInContext(sandbox);

        expect(typeof _ric).toBe('function');

        // Calling it must hand off to the real requestIdleCallback
        let result;
        _ric(() => { result = 'called'; });
        expect(result).toBe('called');
    });

    it('FAILS with ReferenceError when the guard uses bare requestIdleCallback (non-vacuous)', () => {
        const _ricSrc = extractMultiLineConst('_ric');

        // Inject the BROKEN form: bare `requestIdleCallback` with no `typeof` guard
        const brokenSrc = _ricSrc.replace(
            'typeof requestIdleCallback === \'function\'',
            'requestIdleCallback',
        );
        const brokenWrapped = `(() => { ${brokenSrc}; return _ric; })()`;

        const vm = require('node:vm');
        const sandbox = { console, Math, Date, Array, Object, Map, Set, Promise };
        vm.createContext(sandbox);

        const fn = new vm.Script(brokenWrapped);

        // The broken form must throw when requestIdleCallback is absent.
        // We check the message to confirm it is specifically about requestIdleCallback.
        expect(() => fn.runInContext(sandbox)).toThrow(/requestIdleCallback/);
    });
});
