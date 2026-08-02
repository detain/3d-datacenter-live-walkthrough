/**
 * tests/js/dc-model-guards.test.js — the rack/server MODEL-TYPE guards in public_html/js/dc.js
 *
 * Three defects live here, and all three are the same shape: dc.js trusting a type index that
 * came off the wire.
 *
 *   1. /ajax/datacenter.php's ?test=1 grid emitted server type 22 while serverTypes[] tops out at
 *      index 21. getServerModels() destructured the undefined entry, and the TypeError took the
 *      whole displayDatacenter() call with it — no switches, no community, no key handlers, and
 *      the #dcLoading curtain never lifted.
 *   2. loadRackType()/loadServerType() screened an absent index; getRackModels()/getServerModels()
 *      did not. Both pairs now go through rackModelName()/serverModelName().
 *   3. loadRackType()/loadServerType() resolved ONLY from the GLTFLoader onLoad callback, so a
 *      model that was skipped or that failed every variant never settled and loadBuildingModels()
 *      sat on its 12s Promise.race timeout before a neighbouring building could reach full detail.
 *   4. models.racks/servers are written only on SUCCESS and loadBuildingModels() re-queues every type
 *      still undefined, so a type whose GLB was missing re-issued all three variant requests AND
 *      re-raised the "some 3D models failed to load" banner on every enterFull/exitFull LOD cycle.
 *      _failedGlbs is the negative cache that stops it.
 *   5. A throw inside the onLoad body — gltf.scene undefined on a GLB with no scenes (glTF makes
 *      `scenes` optional), extractModelMeshes() finding nothing usable — was left to escape, and where
 *      it landed depended on the loader. three's GLTFParser.parse() calls onLoad inside a chain ending
 *      in `.catch(onError)`, so in the browser the throw was reported as if the FILE had failed and the
 *      fallback walked on to the next variant of the same broken asset; against a loader that does not
 *      catch (this harness) the loadRackType() promise rejected and nothing settled it. dc.js now
 *      catches it at the source and gives up once.
 *   6. loadBuildingModels() raced Promise.all against a 12s timeout and had NO rejection handler, so a
 *      task that rejected instead of resolving (loaderGltf.load throwing straight out of the promise
 *      executor) rejected the race, the continuation never ran, and enterFull()'s b.loading stayed set
 *      for the life of the page. updateLOD() skips a building with that flag, so that building could
 *      never reach full detail again — permanently worse than the timeout the race exists to provide.
 *   7. Nothing de-duped concurrent requests for the SAME model: two neighbours entering full detail in
 *      the same frame, or getRackModels() at boot racing the loadRackType() a neighbour triggers, each
 *      opened its own set of variant requests, and on the failure path each raised its own banner
 *      (_failedGlbs only closes that window once the first attempt has finished failing).
 *   8. getRackModels()/getServerModels() passed no onGiveUp. The banner and the console.error still
 *      came from inside loadGlbWithFallback(), but nothing said WHICH type went missing — the getter
 *      just never reached displayRacks()/displayServers() for it.
 *
 * These are pure logic, so they are tested against the REAL source text rather than a
 * reimplementation: the functions are sliced out of dc.js and run with stubbed GLTFLoader /
 * notice / models. dc.js cannot be imported here — it is a browser ES module that imports three.js
 * and ends in a top-level `await init()` (see .claude/rules/js-tests.md).
 *
 * Run: yarn test:js
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fs = require('node:fs');
const path = require('node:path');

const DC_JS = path.resolve(__dirname, '../../public_html/js/dc.js');
const DC_PHP = path.resolve(__dirname, '../../public_html/ajax/datacenter.php');
const SRC = fs.readFileSync(DC_JS, 'utf8');
const PHP = fs.readFileSync(DC_PHP, 'utf8');

// ---------------------------------------------------------------------------
// Slicing the real source
//
// Anchored on column 0 rather than brace-counted: getServerModels() carries a commented-out
// `//loaderDae.load(…, function (collada) {` whose unmatched brace defeats naive counting, and a
// comment-stripper would then have to survive the `'https://'` in that same line. Every top-level
// declaration in dc.js closes with `}` / `];` hard against the left margin, so that is the anchor.
// Both extractors throw when they find nothing, so a rename fails loudly instead of quietly
// testing an empty string.
// ---------------------------------------------------------------------------
function extractFn(name) {
    const m = SRC.match(new RegExp('^function ' + name + '\\([\\s\\S]*?^\\}', 'm'));
    if (!m) throw new Error(`dc.js no longer declares function ${name}() at top level — update this spec`);
    return m[0];
}
function extractConst(name) {
    const m = SRC.match(new RegExp('^const ' + name + ' = \\[[\\s\\S]*?\\];$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name}[] at top level — update this spec`);
    return m[0];
}
// One-line top-level const (the _failedGlbs Set). Kept separate from extractConst so a rename of either
// still fails loudly rather than silently testing a harness-local stand-in for the real declaration.
function extractLine(name) {
    const m = SRC.match(new RegExp('^const ' + name + ' = .*;$', 'm'));
    if (!m) throw new Error(`dc.js no longer declares const ${name} at top level — update this spec`);
    return m[0];
}

// The inventory the two getters and loadBuildingModels() read off `locations`. Location 4 is dc.js's
// options.location default (the "current building"); 5 stands in for a neighbour, and uses DIFFERENT
// type indexes so a per-type assertion cannot be satisfied by the wrong building's models.
function defaultLocations() {
    return {
        4: { _full: true, racks: { 1: { type: 1, x: 1, y: 1, name: 'R1', servers: { 10: { type: 1, start: 1 } } } } },
        5: { _full: true, racks: { 2: { type: 2, x: 2, y: 1, name: 'R2', servers: { 20: { type: 2, start: 1 } } } } },
    };
}

// A loader stub shaped like GLTFLoader: url -> 'ok' (calls onLoad) or anything else (calls onError).
// Records every url it was asked for, which is how "the empty placeholder fetches nothing" is proved.
//
// opts.gltf(url)  — the payload handed to onLoad. Default is a scene-bearing gltf; pass `() => ({})` for
//                   the real "parses but has no scenes" shape, where dc.js's own `gltf.scene.traverse`
//                   throws (glTF 2.0 makes `scenes` optional, so GLTFLoader resolves that file happily).
// opts.extract    — stands in for extractModelMeshes(); throw from here for a GLB that has a scene but
//                   nothing usable in it.
// opts.defer      — park each load until flush() is called. The default loader answers inside
//                   loaderGltf.load(), which leaves no window for a second caller to arrive in, so it
//                   can never show a concurrent request being shared (or duplicated).
// opts.throwOnLoad— loaderGltf.load() throws where it is CALLED, i.e. inside loadRackType()'s promise
//                   executor, which REJECTS that task. Real shape: three's FileLoader builds a Request
//                   and calls fetch() inline, so a request the browser refuses to construct comes
//                   straight back out of GLTFLoader.load().
// opts.locations  — inventory override for getRackModels()/getServerModels()/loadBuildingModels().
// opts.buildThrows— buildBuildingFull() throws, i.e. enterFull()'s continuation dies part-way through.
function makeHarness(urlOutcome = () => 'ok', opts = {}) {
    const seen = [];
    const notices = [];
    const warns = [];
    const errors = [];
    const shown = { racks: [], servers: [] };
    const built = [];
    const pending = [];
    // scale.set() is there for getRackModels()/getServerModels(): they pre-scale the model before
    // handing it to extractModelMeshes() (which re-does it), and a scene stub without it makes their
    // onLoad throw — a harness artefact that would read as a real give-up.
    const gltfFor = opts.gltf || ((url) => ({ scene: { traverse() {}, scale: { set() {} }, _url: url } }));
    const loaderGltf = {
        load(url, onLoad, onProgress, onError) {
            seen.push(url);
            if (opts.throwOnLoad) throw new Error('loader threw synchronously for ' + url);
            const answer = () => {
                if (urlOutcome(url) === 'ok') onLoad(gltfFor(url));
                else onError(new Error('404 ' + url));
            };
            if (opts.defer) pending.push(answer); else answer();
        },
    };
    const models = { racks: {}, servers: {} };
    const locations = opts.locations || defaultLocations();
    const options = { location: 4, domain: '' };
    const consoleStub = { warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) };
    const prelude = [
        extractConst('rackTypes'),
        extractConst('serverTypes'),
        extractConst('GLB_VARIANTS'),
        extractLine('_failedGlbs'),
        extractLine('_inflightGlbs'),
        extractFn('glbVariantUrl'),
        extractFn('rackModelName'),
        extractFn('serverModelName'),
        extractFn('loadGlbWithFallback'),
        extractFn('getRackModels'),
        extractFn('getServerModels'),
        extractFn('loadRackType'),
        extractFn('loadServerType'),
        extractFn('loadBuildingModels'),
        extractFn('locationLoaded'),
        extractFn('enterFull'),
    ].join('\n\n');
    const factory = new Function(
        'loaderGltf', 'notice', 'models', 'dcUrl', 'extractModelMeshes', 'console',
        'locations', 'options', 'displayRacks', 'displayServers',
        'buildBuildingFull', 'buildNeighborInterior', 'scene',
        prelude + '\nreturn { rackTypes, serverTypes, GLB_VARIANTS, _failedGlbs, _inflightGlbs, glbVariantUrl,'
        + ' rackModelName, serverModelName, loadGlbWithFallback, getRackModels, getServerModels,'
        + ' loadRackType, loadServerType, loadBuildingModels, locationLoaded, enterFull };'
    );
    const api = factory(
        loaderGltf,
        (t) => notices.push(t),
        models,
        (p) => p,
        opts.extract || ((model, scale) => ({ built: true, scale, url: model._url })),
        consoleStub,
        locations,
        options,
        (t) => shown.racks.push(Number(t)),
        (t) => shown.servers.push(Number(t)),
        (id) => {
            if (opts.buildThrows) throw new Error('buildBuildingFull blew up on ' + id);
            built.push(Number(id));
            return { group: { id: Number(id) }, colliders: [] };
        },
        () => ({ faulty: [], bulbDisco: null }),
        { add() {}, remove() {} }
    );
    // Answer every parked load, including the ones a failing variant queues as it walks the fallback
    // chain. Bounded so a loader that re-queues forever fails the test instead of hanging it.
    const flush = () => {
        for (let guard = 0; pending.length; guard++) {
            if (guard > 10) throw new Error('deferred loads never drained — check the fallback chain');
            for (const answer of pending.splice(0)) answer();
        }
    };
    return { ...api, seen, notices, warns, errors, models, shown, built, locations, options, flush };
}

// A promise that must settle on its own, NOT by waiting out loadBuildingModels' 12s race guard.
// 250ms is ~50x the real settle path and ~1/48th of the timeout, so it cannot be confused for either.
const SETTLE_BUDGET_MS = 250;
async function settlesQuickly(promise) {
    let done = false;
    promise.then(() => { done = true; });
    await new Promise((r) => setTimeout(r, SETTLE_BUDGET_MS));
    return done;
}

let H;
beforeEach(() => { H = makeHarness(); });

// ---------------------------------------------------------------------------
// The type arrays themselves
// ---------------------------------------------------------------------------
describe('dc.js — rackTypes[] / serverTypes[]', () => {
    it('keeps index 0 as the deliberate "no model" placeholder in both arrays', () => {
        expect(H.rackTypes[0]).toBe('');
        expect(H.serverTypes[0]).toEqual(['', 1]);
    });

    it('has no other empty entry (only index 0 means "nothing to load")', () => {
        H.rackTypes.slice(1).forEach((n) => expect(n).toBeTruthy());
        H.serverTypes.slice(1).forEach((e) => { expect(Array.isArray(e)).toBe(true); expect(e[0]).toBeTruthy(); });
    });
});

// ---------------------------------------------------------------------------
// rackModelName() / serverModelName()
// ---------------------------------------------------------------------------
describe('dc.js — rackModelName()', () => {
    it('returns the model name for a real type', () => {
        expect(H.rackModelName(1)).toBe(H.rackTypes[1]);
        expect(H.warns).toEqual([]);
    });

    it('skips index 0 SILENTLY — the placeholder is valid data, not a fault', () => {
        expect(H.rackModelName(0)).toBeNull();
        expect(H.warns).toEqual([]);
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });

    it('warns and skips a type past the end of the array', () => {
        expect(H.rackModelName(H.rackTypes.length)).toBeNull();
        expect(H.warns.join('|')).toMatch(/Unknown rack type/);
        expect(H.notices).toEqual([]);   // not a load failure -> no user-facing banner
    });

    it('warns and skips a type that is not a number at all', () => {
        expect(H.rackModelName(undefined)).toBeNull();
        expect(H.rackModelName('bogus')).toBeNull();
        expect(H.warns).toHaveLength(2);
    });
});

describe('dc.js — serverModelName()', () => {
    it('returns the model name for a real type', () => {
        expect(H.serverModelName(1)).toBe(H.serverTypes[1][0]);
        expect(H.warns).toEqual([]);
    });

    it('skips index 0 SILENTLY', () => {
        expect(H.serverModelName(0)).toBeNull();
        expect(H.warns).toEqual([]);
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });

    it('warns and skips server type 22 — the exact value ?test=1 used to emit', () => {
        expect(H.serverTypes.length).toBe(22);          // so 22 is one past the end
        expect(H.serverModelName(22)).toBeNull();
        expect(H.warns.join('|')).toMatch(/Unknown server type 22/);
        expect(H.notices).toEqual([]);
    });

    it('does not throw where the old destructuring did', () => {
        // `[currentModel, currentUnits] = serverTypes[22]` threw "undefined is not iterable"
        // out of getServerModels()'s forEach and killed the rest of displayDatacenter().
        expect(() => H.serverModelName(22)).not.toThrow();
        expect(() => { const [a] = H.serverTypes[22]; return a; }).toThrow(TypeError);
    });
});

// ---------------------------------------------------------------------------
// loadGlbWithFallback() — the onGiveUp settle path
// ---------------------------------------------------------------------------
describe('dc.js — loadGlbWithFallback()', () => {
    it('calls onLoad on the first variant that resolves and never calls onGiveUp', () => {
        const onLoad = vi.fn(), onGiveUp = vi.fn();
        H.loadGlbWithFallback('/images/3d/racks/', 'Rack', onLoad, onGiveUp);
        expect(onLoad).toHaveBeenCalledTimes(1);
        expect(onGiveUp).not.toHaveBeenCalled();
        expect(H.seen).toEqual(['/images/3d/racks/meshopt/Rack.glb']);
    });

    it('walks every variant before giving up, in GLB_VARIANTS order', () => {
        const h = makeHarness((url) => (url.includes('/webp-simplify/') ? 'ok' : 'fail'));
        const onLoad = vi.fn(), onGiveUp = vi.fn();
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', onLoad, onGiveUp);
        expect(h.seen).toEqual([
            '/images/3d/racks/meshopt/Rack.glb',
            '/images/3d/racks/webp-simplify/Rack.glb',
        ]);
        expect(onLoad).toHaveBeenCalledTimes(1);
        expect(onGiveUp).not.toHaveBeenCalled();
    });

    it('logs, warns the user AND calls onGiveUp when every variant fails', () => {
        const h = makeHarness(() => 'fail');
        const onLoad = vi.fn(), onGiveUp = vi.fn();
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', onLoad, onGiveUp);
        expect(h.seen).toHaveLength(h.GLB_VARIANTS.length);
        expect(onLoad).not.toHaveBeenCalled();
        expect(onGiveUp).toHaveBeenCalledTimes(1);
        // the failure must still be loud — settling the promise may not swallow it
        expect(h.errors.join('|')).toMatch(/All GLB variants failed/);
        expect(h.notices.join('|')).toMatch(/Some 3D models failed to load/);
    });

    it('fetches nothing and calls onGiveUp when handed an empty model name', () => {
        const onLoad = vi.fn(), onGiveUp = vi.fn();
        H.loadGlbWithFallback('/images/3d/racks/', '', onLoad, onGiveUp);
        expect(H.seen).toEqual([]);
        expect(onLoad).not.toHaveBeenCalled();
        expect(onGiveUp).toHaveBeenCalledTimes(1);
        expect(H.notices).toEqual([]);   // a skip is not a failure
    });

    it('still works for a 3-arg caller with no onGiveUp', () => {
        const h = makeHarness(() => 'fail');
        expect(() => h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn())).not.toThrow();
        expect(() => h.loadGlbWithFallback('/images/3d/racks/', '', vi.fn())).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// loadRackType() / loadServerType() — every path settles (defect 3)
// ---------------------------------------------------------------------------
describe('dc.js — loadRackType() settles on every path', () => {
    it('resolves and caches the model on success', async () => {
        await expect(settlesQuickly(H.loadRackType(1))).resolves.toBe(true);
        expect(H.models.racks[1]).toEqual({ built: true, scale: 10, url: '/images/3d/racks/meshopt/' + H.rackTypes[1] + '.glb' });
    });

    it('resolves immediately for an already-cached type without touching the loader', async () => {
        H.models.racks[3] = { built: true };
        await expect(settlesQuickly(H.loadRackType(3))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
    });

    it('resolves for the type 0 placeholder, silently and without a request', async () => {
        await expect(settlesQuickly(H.loadRackType(0))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
        expect(H.warns).toEqual([]);
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });

    it('resolves for a type the array has no entry for', async () => {
        await expect(settlesQuickly(H.loadRackType(H.rackTypes.length + 5))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
        expect(H.warns.join('|')).toMatch(/Unknown rack type/);
    });

    it('resolves when every GLB variant fails — without waiting out the 12s race guard', async () => {
        const h = makeHarness(() => 'fail');
        await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        expect(h.models.racks[1]).toBeUndefined();          // no MODEL cached; the failure is (see below)
        expect(h.errors.join('|')).toMatch(/All GLB variants failed/);
        expect(h.notices.join('|')).toMatch(/Some 3D models failed to load/);
    });
});

describe('dc.js — loadServerType() settles on every path', () => {
    it('resolves and caches the model on success', async () => {
        await expect(settlesQuickly(H.loadServerType(1))).resolves.toBe(true);
        expect(H.models.servers[1]).toBeDefined();
    });

    it('resolves immediately for an already-cached type without touching the loader', async () => {
        H.models.servers[2] = { built: true };
        await expect(settlesQuickly(H.loadServerType(2))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
    });

    it('resolves for the type 0 placeholder, silently and without a request', async () => {
        await expect(settlesQuickly(H.loadServerType(0))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
        expect(H.warns).toEqual([]);
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });

    it('resolves for out-of-range server type 22', async () => {
        await expect(settlesQuickly(H.loadServerType(22))).resolves.toBe(true);
        expect(H.seen).toEqual([]);
        expect(H.warns.join('|')).toMatch(/Unknown server type 22/);
    });

    it('resolves when every GLB variant fails', async () => {
        const h = makeHarness(() => 'fail');
        await expect(settlesQuickly(h.loadServerType(1))).resolves.toBe(true);
        expect(h.models.servers[1]).toBeUndefined();
        expect(h.notices.join('|')).toMatch(/Some 3D models failed to load/);
    });
});

// ---------------------------------------------------------------------------
// _failedGlbs — a definitively failed model is never re-requested and never re-banners (defect 4)
//
// The LOD cycle is what makes this user-visible: enterFull/exitFull calls loadBuildingModels() again
// every time the player walks past a neighbouring building, and that re-queues every type still missing
// from models.*. LOD_CYCLES below stands in for that walk.
// ---------------------------------------------------------------------------
const LOD_CYCLES = 6;

describe('dc.js — _failedGlbs negative cache', () => {
    it('re-requests nothing and re-warns nobody after a type has failed once', async () => {
        const h = makeHarness(() => 'fail');
        await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        const afterFirst = { seen: h.seen.length, notices: h.notices.length };
        expect(afterFirst.seen).toBe(h.GLB_VARIANTS.length);   // all three variants tried, once
        expect(afterFirst.notices).toBe(1);                    // and the user told, once

        for (let i = 0; i < LOD_CYCLES; i++) {
            await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        }
        expect(h.seen.length).toBe(afterFirst.seen);           // unbounded before this cache: 3 per cycle
        expect(h.notices.length).toBe(afterFirst.notices);     // and one banner per cycle
    });

    it('does the same for server types', async () => {
        const h = makeHarness(() => 'fail');
        await expect(settlesQuickly(h.loadServerType(1))).resolves.toBe(true);
        expect(h.notices).toHaveLength(1);
        for (let i = 0; i < LOD_CYCLES; i++) await settlesQuickly(h.loadServerType(1));
        expect(h.seen).toHaveLength(h.GLB_VARIANTS.length);
        expect(h.notices).toHaveLength(1);
    });

    it('still settles every repeat call — the cache must answer, not stall', async () => {
        const h = makeHarness(() => 'fail');
        await settlesQuickly(h.loadRackType(1));
        await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
    });

    it('short-circuits loadGlbWithFallback itself, onGiveUp and all', () => {
        const h = makeHarness(() => 'fail');
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn(), vi.fn());
        const onLoad = vi.fn(), onGiveUp = vi.fn();
        h.seen.length = 0; h.notices.length = 0;
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', onLoad, onGiveUp);
        expect(h.seen).toEqual([]);
        expect(onLoad).not.toHaveBeenCalled();
        expect(onGiveUp).toHaveBeenCalledTimes(1);
        expect(h.notices).toEqual([]);
    });

    it('is keyed per request, so a DIFFERENT broken model still gets its one warning', async () => {
        const h = makeHarness(() => 'fail');
        await settlesQuickly(h.loadRackType(1));
        await settlesQuickly(h.loadRackType(2));
        expect(h.notices).toHaveLength(2);
        expect(h._failedGlbs.size).toBe(2);
        // and neither of them is now retried
        const seenAfter = h.seen.length;
        await settlesQuickly(h.loadRackType(1));
        await settlesQuickly(h.loadRackType(2));
        expect(h.seen).toHaveLength(seenAfter);
    });

    it('keeps racks and servers apart even when both name the same file', () => {
        const h = makeHarness(() => 'fail');
        h.loadGlbWithFallback('/images/3d/racks/', 'Same', vi.fn(), vi.fn());
        h.seen.length = 0;
        h.loadGlbWithFallback('/images/3d/servers/gltf/exported-centered/', 'Same', vi.fn(), vi.fn());
        expect(h.seen).toHaveLength(h.GLB_VARIANTS.length);   // different basePath -> not the cached key
        expect(h._failedGlbs.size).toBe(2);
    });

    it('never caches a HEALTHY model — repeat LOD cycles past a good building are untouched', async () => {
        await settlesQuickly(H.loadRackType(1));
        expect(H._failedGlbs.size).toBe(0);
        const seenAfterFirst = H.seen.length;
        expect(seenAfterFirst).toBe(1);                       // first variant answered
        for (let i = 0; i < LOD_CYCLES; i++) {
            await expect(settlesQuickly(H.loadRackType(1))).resolves.toBe(true);
        }
        expect(H.seen).toHaveLength(seenAfterFirst);          // served from models.racks, as before
        expect(H.models.racks[1]).toBeDefined();
        expect(H.notices).toEqual([]);
        expect(H.errors).toEqual([]);
    });

    it('never caches a SKIP — type 0 stays silent on its own, not because it was remembered', async () => {
        for (let i = 0; i < LOD_CYCLES; i++) {
            await expect(settlesQuickly(H.loadRackType(0))).resolves.toBe(true);
            await expect(settlesQuickly(H.loadServerType(0))).resolves.toBe(true);
        }
        expect(H._failedGlbs.size).toBe(0);   // a placeholder is not a failure
        expect(H.seen).toEqual([]);
        expect(H.warns).toEqual([]);
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });

    it('never caches an out-of-range type either — it never reaches the loader', async () => {
        await settlesQuickly(H.loadRackType(H.rackTypes.length));
        expect(H._failedGlbs.size).toBe(0);
        expect(H.notices).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// A throwing onLoad is caught where it happens (defect 5)
// ---------------------------------------------------------------------------
describe('dc.js — a throw inside the onLoad body', () => {
    // The real shape: glTF 2.0 makes `scenes` optional, so a GLB carrying only an asset block parses
    // clean and GLTFLoader resolves it with gltf.scene === undefined. dc.js then does
    // `const model = gltf.scene; model.traverse(...)` -> TypeError.
    const noScene = { gltf: () => ({}) };
    // And the other one: a scene that yields no meshes, i.e. extractModelMeshes blowing up.
    const badMeshes = { extract: () => { throw new Error('no meshes in model'); } };

    it('settles loadRackType() for a GLB with no scene', async () => {
        const h = makeHarness(() => 'ok', noScene);
        await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        expect(h.models.racks[1]).toBeUndefined();
        expect(h.errors.join('|')).toMatch(/GLB loaded but could not be used/);
        expect(h.notices.join('|')).toMatch(/Some 3D models failed to load/);
    });

    it('settles loadServerType() the same way', async () => {
        const h = makeHarness(() => 'ok', noScene);
        await expect(settlesQuickly(h.loadServerType(1))).resolves.toBe(true);
        expect(h.models.servers[1]).toBeUndefined();
        expect(h.notices).toHaveLength(1);
    });

    it('settles when extractModelMeshes() throws on a model with no usable meshes', async () => {
        const h = makeHarness(() => 'ok', badMeshes);
        await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        await expect(settlesQuickly(h.loadServerType(1))).resolves.toBe(true);
        expect(h.errors.join('|')).toMatch(/no meshes in model/);
    });

    it('does not escape loadGlbWithFallback to the caller', () => {
        const h = makeHarness(() => 'ok', badMeshes);
        expect(() => h.loadGlbWithFallback('/images/3d/racks/', 'Rack', () => { throw new Error('boom'); }))
            .not.toThrow();
    });

    it('gives up on the spot rather than re-fetching the same asset as another variant', () => {
        const h = makeHarness(() => 'ok', noScene);
        const onGiveUp = vi.fn();
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', (g) => g.scene.traverse(), onGiveUp);
        expect(h.seen).toEqual(['/images/3d/racks/meshopt/Rack.glb']);   // one request, not three
        expect(onGiveUp).toHaveBeenCalledTimes(1);
    });

    it('lands in the negative cache like any other definitive failure', async () => {
        const h = makeHarness(() => 'ok', noScene);
        await settlesQuickly(h.loadRackType(1));
        const after = { seen: h.seen.length, notices: h.notices.length };
        for (let i = 0; i < LOD_CYCLES; i++) {
            await expect(settlesQuickly(h.loadRackType(1))).resolves.toBe(true);
        }
        expect(h.seen).toHaveLength(after.seen);
        expect(h.notices).toHaveLength(after.notices);
    });

    it('leaves the healthy path alone — a good GLB still loads and caches identically', async () => {
        await settlesQuickly(H.loadRackType(1));
        expect(H.models.racks[1]).toEqual({
            built: true, scale: 10, url: '/images/3d/racks/meshopt/' + H.rackTypes[1] + '.glb',
        });
        expect(H.errors).toEqual([]);
        expect(H.notices).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// loadBuildingModels() settles on EVERY outcome (defect 6)
//
// This is the one with teeth. enterFull() sets b.loading, hands loadBuildingModels() a continuation
// that clears it, and updateLOD() skips any building whose flag is still set. So a continuation that
// never runs does not make a building slow — it takes it out of the LOD system permanently, for the
// life of the page, which the 12s timeout in the race cannot rescue because a race that has already
// rejected stays rejected.
// ---------------------------------------------------------------------------
const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

// The real enterFull() driven the way updateLOD()/exitFull() drive it. enter() is updateLOD()'s filter
// (`!b.full && !b.loading` and in range); exit() is the two pieces of exitFull() that enterFull() can
// observe — the cancel-token clear and the blocks going back to visible. Everything else exitFull() does
// is scene disposal, which has no bearing on whether the building can ever load again.
function lodDouble(h, id) {
    const b = { id, dx: 0, dz: 0, full: null, loading: false, blocks: { visible: true } };
    let entered = 0;
    return {
        b,
        get entered() { return entered; },
        enter() {
            if (b.full || b.loading) return false;
            entered++;
            h.enterFull(b);
            return true;
        },
        exit() { b.loading = false; b.full = null; if (b.blocks) b.blocks.visible = true; },
    };
}

describe('dc.js — loadBuildingModels() runs its continuation exactly once', () => {
    it('settles when every task resolves', async () => {
        const h = makeHarness();
        let n = 0;
        h.loadBuildingModels(4, () => { n++; });
        await flushMicrotasks();
        expect(n).toBe(1);
        expect(h.models.racks[1]).toBeDefined();
        expect(h.models.servers[1]).toBeDefined();
    });

    it('settles synchronously when there is nothing to load — the healthy re-entry path', () => {
        const h = makeHarness();
        h.models.racks[1] = { built: true };
        h.models.servers[1] = { built: true };
        let n = 0;
        h.loadBuildingModels(4, () => { n++; });
        expect(n).toBe(1);            // no promise, no wait
        expect(h.seen).toEqual([]);
    });

    it('settles when a task REJECTS instead of resolving', async () => {
        const h = makeHarness(() => 'ok', { throwOnLoad: true });
        let n = 0;
        h.loadBuildingModels(4, () => { n++; });
        await flushMicrotasks();
        expect(n).toBe(1);            // before the rejection handler: 0, then 0 forever
        expect(h.errors.join('|')).toMatch(/Model load failed for location 4/);
    });

    it('does not call the continuation a SECOND time when the 12s backstop comes due', async () => {
        vi.useFakeTimers();
        try {
            const h = makeHarness(() => 'ok', { throwOnLoad: true });
            let n = 0;
            h.loadBuildingModels(4, () => { n++; });
            await vi.advanceTimersByTimeAsync(0);
            expect(n).toBe(1);
            await vi.advanceTimersByTimeAsync(30000);
            expect(n).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('still has the 12s backstop for a load that never answers at all', async () => {
        vi.useFakeTimers();
        try {
            const h = makeHarness(() => 'ok', { defer: true });   // parked, and never flushed
            let n = 0;
            h.loadBuildingModels(4, () => { n++; });
            await vi.advanceTimersByTimeAsync(11999);
            expect(n).toBe(0);
            await vi.advanceTimersByTimeAsync(2);
            expect(n).toBe(1);
            h.flush();                                            // the load lands late
            await vi.advanceTimersByTimeAsync(0);
            expect(n).toBe(1);                                    // and must not settle it twice
        } finally {
            vi.useRealTimers();
        }
    });

    it('leaves a building reachable by the LOD after a rejected load', async () => {
        const h = makeHarness(() => 'ok', { throwOnLoad: true });
        const lod = lodDouble(h, 4);
        for (let i = 0; i < LOD_CYCLES; i++) {
            expect(lod.enter()).toBe(true);      // never blocked by a stale loading flag
            await flushMicrotasks();
            expect(lod.b.loading).toBe(false);   // before the fix: true, from the first cycle on
            expect(lod.b.full).not.toBeNull();
            lod.exit();
        }
        expect(lod.entered).toBe(LOD_CYCLES);
        expect(h.built).toHaveLength(LOD_CYCLES);   // one build per enter, no more, no less
    });

    it('leaves the healthy building untouched across the same cycles', async () => {
        const h = makeHarness();
        const lod = lodDouble(h, 4);
        for (let i = 0; i < LOD_CYCLES; i++) {
            expect(lod.enter()).toBe(true);
            await flushMicrotasks();
            expect(lod.b.full).not.toBeNull();
            expect(lod.b.blocks.visible).toBe(false);   // full detail up, placeholder blocks hidden
            lod.exit();
        }
        expect(h.built).toHaveLength(LOD_CYCLES);
        expect(h.seen).toHaveLength(2);          // rack + server model, fetched once and cached
        expect(h.notices).toEqual([]);
        expect(h.errors).toEqual([]);
    });

    it('builds nothing for a building exitFull() cancelled mid-load', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const lod = lodDouble(h, 4);
        lod.enter();
        lod.exit();                              // player walked away mid-load
        h.flush();
        await flushMicrotasks();
        expect(h.built).toEqual([]);             // the continuation ran and correctly built nothing
        expect(lod.b.full).toBeNull();
    });

    it('clears the loading flag even when the build itself throws', () => {
        // Same permanent block from the other end: the continuation RAN but died part-way through.
        // Driven down the no-tasks path so the throw comes straight back out of enterFull() instead of
        // becoming an unhandled rejection inside the promise chain.
        const h = makeHarness(() => 'ok', { buildThrows: true });
        h.models.racks[1] = { built: true };
        h.models.servers[1] = { built: true };
        const lod = lodDouble(h, 4);
        expect(() => lod.enter()).toThrow(/buildBuildingFull blew up/);   // the failure stays loud
        expect(lod.b.loading).toBe(false);                                // and the building stays reachable
        expect(() => lod.enter()).toThrow(/buildBuildingFull blew up/);   // updateLOD() let it back in
        expect(lod.entered).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// One in-flight request per model, shared by every caller (defect 7)
// ---------------------------------------------------------------------------
describe('dc.js — concurrent loads of the same model share one request', () => {
    it('issues one set of variant requests for two loadRackType() calls in the same frame', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const a = h.loadRackType(1), b = h.loadRackType(1);
        expect(h.seen).toHaveLength(1);          // two neighbours, one fetch (was one fetch each)
        h.flush();
        await expect(settlesQuickly(Promise.all([a, b]))).resolves.toBe(true);
        expect(h.models.racks[1]).toBeDefined();
    });

    it('shares that request between getRackModels() at boot and a loadRackType() racing it', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        h.getRackModels();                       // current building, rack type 1
        const p = h.loadRackType(1);             // a neighbour wants the same type before it landed
        expect(h.seen).toHaveLength(1);
        h.flush();
        await expect(settlesQuickly(p)).resolves.toBe(true);
        expect(h.shown.racks).toEqual([1]);      // the getter still drew its racks off the shared gltf
        expect(h.models.racks[1]).toBeDefined();
    });

    it('does the same for servers', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        h.getServerModels();
        const p = h.loadServerType(1);
        expect(h.seen).toHaveLength(1);
        h.flush();
        await expect(settlesQuickly(p)).resolves.toBe(true);
        expect(h.shown.servers).toEqual([1]);
    });

    it('raises ONE banner and one round of requests when two callers share a FAILING model', async () => {
        const h = makeHarness(() => 'fail', { defer: true });
        const a = h.loadRackType(1), b = h.loadRackType(1);
        h.flush();
        await expect(settlesQuickly(Promise.all([a, b]))).resolves.toBe(true);
        expect(h.seen).toHaveLength(h.GLB_VARIANTS.length);   // was 2x GLB_VARIANTS
        expect(h.notices).toHaveLength(1);                    // was 2 — _failedGlbs can't close this window
    });

    it('settles every waiter, not just the one that opened the request', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const settled = [];
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', () => settled.push('a'), () => settled.push('a-gaveup'));
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', () => settled.push('b'), () => settled.push('b-gaveup'));
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', () => settled.push('c'), () => settled.push('c-gaveup'));
        expect(h.seen).toHaveLength(1);
        h.flush();
        expect(settled).toEqual(['a', 'b', 'c']);             // in the order they queued
    });

    it('gives up on every waiter when the shared request fails', () => {
        const h = makeHarness(() => 'fail', { defer: true });
        const gaveUp = [];
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn(), () => gaveUp.push('a'));
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn(), () => gaveUp.push('b'));
        h.flush();
        expect(gaveUp).toEqual(['a', 'b']);
    });

    it('gives up only on the waiter whose onLoad threw', () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const ok = vi.fn(), okGaveUp = vi.fn(), badGaveUp = vi.fn();
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', ok, okGaveUp);
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', () => { throw new Error('boom'); }, badGaveUp);
        h.flush();
        expect(ok).toHaveBeenCalledTimes(1);
        expect(okGaveUp).not.toHaveBeenCalled();   // it got its model; it is already settled
        expect(badGaveUp).toHaveBeenCalledTimes(1);
    });

    it('holds nothing in flight once the shared request is over', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const a = h.loadRackType(1);
        h.flush();
        await settlesQuickly(a);
        expect(h._inflightGlbs.size).toBe(0);
        const b = h.loadRackType(2);               // a different asset must not be blocked by the last one
        expect(h.seen).toHaveLength(2);
        h.flush();
        await expect(settlesQuickly(b)).resolves.toBe(true);
        expect(h._inflightGlbs.size).toBe(0);
    });

    it('holds nothing in flight after a failure either — _failedGlbs answers from then on', async () => {
        const h = makeHarness(() => 'fail', { defer: true });
        const a = h.loadRackType(1);
        h.flush();
        await settlesQuickly(a);
        expect(h._inflightGlbs.size).toBe(0);
        expect(h._failedGlbs.size).toBe(1);
    });

    it('does not park a later caller behind a request that threw synchronously', () => {
        const h = makeHarness(() => 'ok', { throwOnLoad: true });
        expect(() => h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn(), vi.fn())).toThrow();
        expect(h._inflightGlbs.size).toBe(0);
        expect(() => h.loadGlbWithFallback('/images/3d/racks/', 'Rack', vi.fn(), vi.fn())).toThrow();
        expect(h.seen).toHaveLength(2);            // each caller got its own attempt, as before the queue
    });

    it('leaves the single-caller healthy path at exactly one request and one onLoad', async () => {
        const h = makeHarness(() => 'ok', { defer: true });
        const onLoad = vi.fn();
        h.loadGlbWithFallback('/images/3d/racks/', 'Rack', onLoad, vi.fn());
        h.flush();
        expect(h.seen).toEqual(['/images/3d/racks/meshopt/Rack.glb']);
        expect(onLoad).toHaveBeenCalledTimes(1);
        expect(h.notices).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// getRackModels()/getServerModels() report their give-ups (defect 8)
// ---------------------------------------------------------------------------
describe('dc.js — the two getters name the type they gave up on', () => {
    it('names the rack type whose model failed', () => {
        const h = makeHarness(() => 'fail');
        h.getRackModels();
        expect(h.warns.join('|')).toMatch(/Rack type 1 .*has no usable model/);
        expect(h.shown.racks).toEqual([]);         // still not drawn — but no longer without a word
        expect(h.notices).toHaveLength(1);         // the user-facing banner is loadGlbWithFallback's, once
    });

    it('names the server type whose model failed', () => {
        const h = makeHarness(() => 'fail');
        h.getServerModels();
        expect(h.warns.join('|')).toMatch(/Server type 1 .*has no usable model/);
        expect(h.shown.servers).toEqual([]);
    });

    it('reports it for a model already in the negative cache too', async () => {
        const h = makeHarness(() => 'fail');
        await settlesQuickly(h.loadRackType(1));   // fails once, from the neighbour loader
        h.warns.length = 0;
        h.getRackModels();                         // now answered by _failedGlbs, silently
        expect(h.seen).toHaveLength(h.GLB_VARIANTS.length);
        expect(h.warns.join('|')).toMatch(/Rack type 1 .*has no usable model/);
    });

    it('says nothing for the index-0 placeholder — a skip is not a failure', () => {
        const h = makeHarness(() => 'ok', {
            locations: { 4: { _full: true, racks: { 1: { type: 0, x: 1, y: 1, servers: { 10: { type: 0, start: 1 } } } } } },
        });
        h.getRackModels();
        h.getServerModels();
        expect(h.seen).toEqual([]);
        expect(h.warns).toEqual([]);
        expect(h.errors).toEqual([]);
        expect(h.notices).toEqual([]);
    });

    it('says nothing on the healthy path', () => {
        const h = makeHarness();
        h.getRackModels();
        h.getServerModels();
        expect(h.shown.racks).toEqual([1]);
        expect(h.shown.servers).toEqual([1]);
        expect(h.warns).toEqual([]);
        expect(h.errors).toEqual([]);
        expect(h.notices).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Both loader pairs screen types the same way (defect 2)
// ---------------------------------------------------------------------------
describe('dc.js — the two rack/server loaders stay symmetric', () => {
    const body = (name) => extractFn(name);

    it('getRackModels() and loadRackType() both resolve names through rackModelName()', () => {
        expect(body('getRackModels')).toMatch(/rackModelName\(/);
        expect(body('loadRackType')).toMatch(/rackModelName\(/);
    });

    it('getServerModels() and loadServerType() both resolve names through serverModelName()', () => {
        expect(body('getServerModels')).toMatch(/serverModelName\(/);
        expect(body('loadServerType')).toMatch(/serverModelName\(/);
    });

    it('neither getter indexes the type arrays raw any more', () => {
        // `rackTypes[modelIdx]` / `serverTypes[modelIdx]` inside these two is what broke.
        expect(body('getRackModels')).not.toMatch(/rackTypes\s*\[/);
        expect(body('getServerModels')).not.toMatch(/serverTypes\s*\[/);
    });

    it('both async loaders hand loadGlbWithFallback a settle callback', () => {
        expect(body('loadRackType')).toMatch(/\}, res\)/);
        expect(body('loadServerType')).toMatch(/\}, res\)/);
    });
});

// ---------------------------------------------------------------------------
// Cross-language contract: the ?test=1 grid in PHP vs the type arrays in JS
//
// This is the one that actually stops defect 1 coming back. The synthetic grid walks one model per
// row/column, so its two loop bounds ARE indexes into dc.js's arrays — and nothing but this check
// connects the two files.
// ---------------------------------------------------------------------------
describe('ajax/datacenter.php ?test=1 grid stays inside dc.js\'s type arrays', () => {
    const phpInt = (name) => {
        const m = PHP.match(new RegExp('\\$' + name + '\\s*=\\s*(\\d+)\\s*;'));
        if (!m) throw new Error(`datacenter.php no longer defines $${name} — update this spec`);
        return Number(m[1]);
    };

    it('never emits a rack type dc.js has no model for', () => {
        expect(phpInt('maxRackType')).toBeLessThanOrEqual(H.rackTypes.length - 1);
        expect(H.rackModelName(phpInt('maxRackType'))).not.toBeNull();
    });

    it('never emits a server type dc.js has no model for', () => {
        expect(phpInt('maxServerType')).toBeLessThanOrEqual(H.serverTypes.length - 1);
        expect(H.serverModelName(phpInt('maxServerType'))).not.toBeNull();
    });

    it('gates the rack loop and the server emission on those bounds', () => {
        expect(PHP).toMatch(/for\s*\(\s*\$x\s*=\s*1;\s*\$x\s*<=\s*\$maxRackType;/);
        expect(PHP).toMatch(/\$y\s*<=\s*\$maxServerType/);
    });

    it('emits no out-of-range type for any cell of the grid', () => {
        // Re-walk the loops the way the PHP does and check every type it would produce.
        const maxRack = phpInt('maxRackType'), maxServer = phpInt('maxServerType');
        const colBound = Number(PHP.match(/for\s+\(\s*\$y\s*=\s*1;\s*\$y\s*<\s*(\d+);/)[1]);
        for (let x = 1; x <= maxRack; x++) {
            for (let y = 1; y < colBound; y++) {
                expect(H.rackModelName(x)).not.toBeNull();                      // rack type = $x
                if ((x === 1 || y === 1) && y <= maxServer) {
                    expect(H.serverModelName(y)).not.toBeNull();                // server type = $y
                }
            }
        }
        expect(H.warns).toEqual([]);
    });
});
