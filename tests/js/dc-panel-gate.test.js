/**
 * tests/js/dc-panel-gate.test.js — the panel-backend gate in public_html/js/dc.js
 *
 * displayGui() is called from loadDatacenter()'s fetch `.then()`, near the TOP of init(); the thing
 * that decides which backend the panel gets — the three.js Inspector in webgpu mode, lil-gui
 * everywhere else — is settled ~300 lines later, at the bottom of init(). The fetch regularly won
 * that race and built lil-gui on top of the Inspector, so `_panelBackendReady` was added: armed in
 * webgpu mode only, awaited by loadDatacenter() before it touches the panel.
 *
 * The defect this spec pins: the gate was armed at the top of init() and resolved only on the way
 * out of it, with nothing in between. Anything that threw in that stretch — `await renderer.init()`,
 * loadFloor(), the Inspector's dynamic import — left the promise unsettled forever. loadDatacenter()'s
 * chain then parked on `return _panelBackendReady` for the life of the page: #dcLoading never lifted,
 * so the user got a permanent "Loading datacenter…" curtain over a dead scene, and the only trace of
 * what happened was the original init error in the console. Measured in chromium against
 * /admin/dc.html?renderer=webgpu with a throw injected after `await renderer.init()`: after 20s the
 * curtain still read "Loading datacenter…", display:flex, with no banner and no panel.
 *
 * _failInit() is the fix — it settles the gate, records the error so the continuation knows a backend
 * was never chosen, and reports the failure through notice() (the same banner the model loaders use)
 * plus the curtain's own text. The gate still does its original job: the settle stays at the bottom of
 * init(), after the Inspector attach, so the double-panel race cannot come back.
 *
 * Tested against the REAL source text rather than a reimplementation: the functions are sliced out of
 * dc.js and run with stubbed fetch / document / console. dc.js cannot be imported here — it is a
 * browser ES module that imports three.js and ends in a top-level `await init()` (see
 * .claude/rules/js-tests.md).
 *
 * Run: yarn test:js
 */

import { describe, it, expect, beforeEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const SRC = fs.readFileSync(DC_JS, 'utf8');

// ---------------------------------------------------------------------------
// Slicing the real source. Anchored on column 0: every top-level declaration in dc.js closes with a
// bare `}` hard against the left margin. Each extractor throws when it finds nothing, so a rename
// fails loudly here instead of quietly testing an empty string.
// ---------------------------------------------------------------------------
function extractFn(name) {
    const m = SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}
function extractLet(name) {
    const m = SRC.match(new RegExp('^let ' + name + ' = .*;$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares let ${name} at top level — update this spec`);
    return m[0];
}
// The one line in init() that arms the gate, lifted verbatim so the test cannot drift from it. Wrapped
// in a function taking THREE, which is how both branches (node renderer / classic renderer) get driven.
function extractArmLine() {
    const m = SRC.match(/^\s*if \(THREE\.WebGPURenderer\) _panelBackendReady = .*;$/m);
    if (!m) throw new Error('init() no longer arms _panelBackendReady on THREE.WebGPURenderer — update this spec');
    return m[0].trim();
}
// The module's bootstrap: `try { await init(); } catch (err) { … }`. `^\}$` (a line that is ONLY a
// closing brace) is the anchor — `} catch (err) {` starts with one too.
function extractBootstrap() {
    const m = SRC.match(/^try \{\n\s*await init\(\);[\s\S]*?^\}$/m);
    if (!m) throw new Error('dc.js no longer wraps the top-level `await init()` in a try — update this spec');
    return m[0];
}

// ---------------------------------------------------------------------------
// A DOM small enough to run notice() and _failInit() against. jsdom is not installed and vitest runs
// in the node environment (.claude/rules/js-tests.md), so this is hand-rolled: only the handful of
// members those two functions actually touch.
// ---------------------------------------------------------------------------
function makeDom() {
    const body = {
        children: [],
        appendChild(el) { el.parentNode = body; body.children.push(el); },
        removeChild(el) {
            const i = body.children.indexOf(el);
            if (i !== -1) body.children.splice(i, 1);
            el.parentNode = null;
        },
    };
    const byId = {
        // the curtain dc.html ships, in the state a page load leaves it in
        dcLoading: { id: 'dcLoading', style: { display: '' }, textContent: 'Loading datacenter…' },
    };
    const document = {
        body,
        createElement() { return { style: { cssText: '' }, textContent: '', id: '', parentNode: null }; },
        getElementById(id) { return Object.prototype.hasOwnProperty.call(byId, id) ? byId[id] : null; },
    };
    return { document, body, byId };
}

// The datacenter payload loadDatacenter() merges. Keyed at location 4 like the Playwright fixture —
// nothing here reads it, but mergeLocations() is stubbed and the shape should still be honest.
const PAYLOAD = { locations: { 4: { name: 'Test DC', region: 'Test', racks: {} } } };

function makeHarness(opts = {}) {
    const dom = makeDom();
    const calls = { displayGui: 0, displayDatacenter: 0, restoreCamera: 0, merged: [] };
    const errors = [];
    const timers = { set: [], cleared: [] };
    let resolveFetch;
    const fetchGate = new Promise((r) => { resolveFetch = r; });
    const response = {
        ok: opts.fetchOk !== false,
        json: () => Promise.resolve(PAYLOAD),
    };
    const prelude = [
        extractLet('_panelBackendReady'),
        extractLet('_panelBackendSettled'),
        extractLet('_initError'),
        extractLet('_noticeEl'),
        extractLet('_noticeTimer'),
        extractFn('notice'),
        extractFn('_failInit'),
        extractFn('loadDatacenter'),
    ].join('\n\n');
    const factory = new Function(
        'fetch', 'dcUrl', 'mergeLocations', '_restoreLocation', 'displayGui', 'displayDatacenter',
        '_restoreCamera', 'document', 'console', 'setTimeout', 'clearTimeout',
        prelude + `
        return {
            loadDatacenter, notice, _failInit,
            // init()'s own arming line, verbatim
            arm: function (THREE) { ${extractArmLine()} },
            settle: () => _panelBackendSettled(),
            gate: () => _panelBackendReady,
            initError: () => _initError,
            noticeEl: () => _noticeEl,
        };`
    );
    const api = factory(
        () => fetchGate.then(() => response),
        (p) => p,
        (data) => calls.merged.push(data),
        () => {},
        () => {
            calls.displayGui++;
            if (opts.displayGuiThrows) throw new Error('displayGui blew up');
        },
        () => { calls.displayDatacenter++; },
        () => { calls.restoreCamera++; },
        dom.document,
        { error: (...a) => errors.push(a.map(String).join(' ')), warn: () => {} },
        (fn, ms) => { timers.set.push(ms); return { fn, ms }; },
        (t) => { timers.cleared.push(t); }
    );
    return { ...api, dom, calls, errors, timers, resolveFetch };
}

// Let every already-queued microtask run. loadDatacenter()'s chain is four `.then()`s deep, so a
// single await is not enough to prove that displayGui() did or did not happen yet.
async function flush(n = 8) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

const NODE_THREE = { WebGPURenderer: function WebGPURenderer() {} };   // the webgpu build exports one
const CLASSIC_THREE = { WebGLRenderer: function WebGLRenderer() {} };  // three.module.js does not

let H;
beforeEach(() => { H = makeHarness(); });

// ---------------------------------------------------------------------------
// Arming: only the node renderer waits on anything
// ---------------------------------------------------------------------------
describe('dc.js — arming the panel-backend gate', () => {
    it('leaves the gate pre-resolved on the classic build, so displayGui() never waits', async () => {
        H.arm(CLASSIC_THREE);
        let settled = false;
        H.gate().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(true);
    });

    it('arms a pending gate on the node build', async () => {
        H.arm(NODE_THREE);
        let settled = false;
        H.gate().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
        H.settle();
        await flush();
        expect(settled).toBe(true);
    });

    it('settles the gate only AFTER the Inspector attach, which is the race it exists for', () => {
        // The ordering is the whole point: displayGui() picking a backend before the Inspector has
        // attached is what produced lil-gui on top of the Inspector.
        const attach = SRC.indexOf("document.body.classList.add('dc-has-inspector')");
        const statsFallback = SRC.indexOf('stats = new Stats();');
        const settle = SRC.indexOf('_panelBackendSettled();   //');
        expect(attach).toBeGreaterThan(-1);
        expect(statsFallback).toBeGreaterThan(-1);
        expect(settle).toBeGreaterThan(attach);
        expect(settle).toBeGreaterThan(statsFallback);
    });
});

// ---------------------------------------------------------------------------
// loadDatacenter()'s continuation
// ---------------------------------------------------------------------------
describe('dc.js — loadDatacenter() waits on the gate', () => {
    it('does not build the panel until the gate settles', async () => {
        H.arm(NODE_THREE);
        H.loadDatacenter();
        H.resolveFetch();
        await flush();
        expect(H.calls.merged.length).toBe(1);      // the payload landed…
        expect(H.calls.displayGui).toBe(0);         // …but the panel is still waiting on the backend
        H.settle();
        await flush();
        expect(H.calls.displayGui).toBe(1);
    });

    it('builds the panel, the room and the camera and lifts the curtain on the happy path', async () => {
        H.arm(NODE_THREE);
        H.loadDatacenter();
        H.resolveFetch();
        H.settle();
        await flush();
        expect(H.calls.displayGui).toBe(1);
        expect(H.calls.displayDatacenter).toBe(1);
        expect(H.calls.restoreCamera).toBe(1);
        expect(H.dom.byId.dcLoading.style.display).toBe('none');
    });

    it('runs straight through on the classic build, where the gate is already resolved', async () => {
        H.arm(CLASSIC_THREE);
        H.loadDatacenter();
        H.resolveFetch();
        await flush();
        expect(H.calls.displayGui).toBe(1);
        expect(H.dom.byId.dcLoading.style.display).toBe('none');
    });

    it('does NOT build a panel for a scene that failed to start', async () => {
        H.arm(NODE_THREE);
        H.loadDatacenter();
        H.resolveFetch();
        await flush();
        H._failInit(new Error('renderer.init() exploded'));
        await flush();
        // A gate that settled because init() DIED is not a backend decision: there is no camera to
        // build controllers against, and displayGui() would only throw a second, more confusing error.
        expect(H.calls.displayGui).toBe(0);
        expect(H.calls.displayDatacenter).toBe(0);
    });

    it('still reports a fetch failure the way it always did', async () => {
        const F = makeHarness({ fetchOk: false });
        F.arm(CLASSIC_THREE);
        F.loadDatacenter();
        F.resolveFetch();
        await flush();
        expect(F.calls.displayGui).toBe(0);
        expect(F.errors.join(' ')).toContain('problem with the fetch operation');
    });
});

// ---------------------------------------------------------------------------
// _failInit()
// ---------------------------------------------------------------------------
describe('dc.js — _failInit()', () => {
    it('settles a gate that init() armed and then threw past (the stranding bug)', async () => {
        H.arm(NODE_THREE);
        let settled = false;
        H.gate().then(() => { settled = true; });
        await flush();
        expect(settled).toBe(false);
        H._failInit(new Error('boom'));
        await flush();
        expect(settled).toBe(true);
    });

    it('records the error so the continuation can tell "stopped" from "chose a backend"', () => {
        const err = new Error('boom');
        H._failInit(err);
        expect(H.initError()).toBe(err);
    });

    it('still records something when handed nothing', () => {
        H._failInit(undefined);
        expect(H.initError()).toBeInstanceOf(Error);
    });

    it('logs the failure', () => {
        H._failInit(new Error('renderer.init() exploded'));
        expect(H.errors.join(' ')).toContain('init failed');
    });

    it('raises the notice banner with the error message', () => {
        H._failInit(new Error('renderer.init() exploded'));
        const el = H.noticeEl();
        expect(el).toBeTruthy();
        expect(el.id).toBe('dcNotice');
        expect(el.textContent).toContain('renderer.init() exploded');
        expect(H.dom.body.children).toContain(el);
    });

    it('leaves that banner up — a fatal error must not auto-dismiss', () => {
        H._failInit(new Error('boom'));
        // notice() only arms its dismissal timer for ms > 0, and _failInit passes 0.
        expect(H.timers.set).toEqual([]);
    });

    it('stops the curtain claiming the datacenter is still loading', () => {
        H._failInit(new Error('boom'));
        expect(H.dom.byId.dcLoading.textContent).not.toContain('Loading datacenter');
        expect(H.dom.byId.dcLoading.textContent).toContain('failed to start');
    });

    it('settles the gate even when the reporting throws', async () => {
        // The settle comes FIRST on purpose. document.body missing (or any other DOM surprise) must
        // not put us back in the permanent-curtain case this function exists to end.
        const F = makeHarness();
        F.dom.document.createElement = () => { throw new Error('DOM unavailable'); };
        F.arm(NODE_THREE);
        let settled = false;
        F.gate().then(() => { settled = true; });
        await flush();
        expect(() => F._failInit(new Error('boom'))).toThrow('DOM unavailable');
        await flush();
        expect(settled).toBe(true);
    });

    it('survives a page with no curtain at all', () => {
        const F = makeHarness();
        delete F.dom.byId.dcLoading;
        expect(() => F._failInit(new Error('boom'))).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// The module bootstrap — where the failure is caught
// ---------------------------------------------------------------------------
describe('dc.js — top-level bootstrap', () => {
    // The real `try { await init(); } catch (err) { … }`, run with init() and _failInit() injected.
    function runBootstrap(init) {
        const seen = [];
        const fn = new Function('init', '_failInit', 'return (async () => {' + extractBootstrap() + '})();');
        return { seen, promise: fn(init, (err) => seen.push(err)) };
    }

    it('routes an init() failure through _failInit()', async () => {
        const err = new Error('renderer.init() exploded');
        const r = runBootstrap(async () => { throw err; });
        await expect(r.promise).rejects.toBe(err);
        expect(r.seen).toEqual([err]);
    });

    it('re-throws the original error untouched, so the page still fails loudly', async () => {
        const err = new Error('loadFloor blew up');
        const r = runBootstrap(async () => { throw err; });
        await r.promise.then(
            () => { throw new Error('bootstrap swallowed the init failure'); },
            (caught) => { expect(caught).toBe(err); }
        );
    });

    it('does nothing on a successful init()', async () => {
        const r = runBootstrap(async () => 'ok');
        await r.promise;
        expect(r.seen).toEqual([]);
    });

    it('keeps the animation loop OUT of the try, so a dead scene never starts one', () => {
        const bootstrap = extractBootstrap();
        expect(bootstrap).not.toContain('setAnimationLoop');
        expect(SRC.indexOf('renderer.setAnimationLoop(_guardLoop(animate));'))
            .toBeGreaterThan(SRC.indexOf(bootstrap));
    });
});

// ---------------------------------------------------------------------------
// End to end within the harness: the exact webgpu sequence that used to strand the page
// ---------------------------------------------------------------------------
describe('dc.js — a webgpu init() that throws mid-way', () => {
    it('explains itself instead of leaving a permanent loading curtain', async () => {
        H.arm(NODE_THREE);            // init() top: gate armed
        H.loadDatacenter();           // init() next line: the fetch goes out
        H.resolveFetch();             // payload lands; the chain parks on the gate
        await flush();
        expect(H.dom.byId.dcLoading.textContent).toContain('Loading datacenter');
        H._failInit(new Error('renderer.init() exploded'));   // init() throws before it can settle
        await flush();
        // The user is told, in the page, twice over — and nothing tried to build a panel.
        expect(H.dom.byId.dcLoading.textContent).toContain('failed to start');
        expect(H.noticeEl().textContent).toContain('renderer.init() exploded');
        expect(H.calls.displayGui).toBe(0);
        expect(H.errors.join(' ')).toContain('init failed');
    });
});
