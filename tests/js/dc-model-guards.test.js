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

// A loader stub shaped like GLTFLoader: url -> 'ok' (calls onLoad) or anything else (calls onError).
// Records every url it was asked for, which is how "the empty placeholder fetches nothing" is proved.
//
// opts.gltf(url)  — the payload handed to onLoad. Default is a scene-bearing gltf; pass `() => ({})` for
//                   the real "parses but has no scenes" shape, where dc.js's own `gltf.scene.traverse`
//                   throws (glTF 2.0 makes `scenes` optional, so GLTFLoader resolves that file happily).
// opts.extract    — stands in for extractModelMeshes(); throw from here for a GLB that has a scene but
//                   nothing usable in it.
function makeHarness(urlOutcome = () => 'ok', opts = {}) {
    const seen = [];
    const notices = [];
    const warns = [];
    const errors = [];
    const gltfFor = opts.gltf || ((url) => ({ scene: { traverse() {}, _url: url } }));
    const loaderGltf = {
        load(url, onLoad, onProgress, onError) {
            seen.push(url);
            if (urlOutcome(url) === 'ok') onLoad(gltfFor(url));
            else onError(new Error('404 ' + url));
        },
    };
    const models = { racks: {}, servers: {} };
    const consoleStub = { warn: (...a) => warns.push(a.join(' ')), error: (...a) => errors.push(a.join(' ')) };
    const prelude = [
        extractConst('rackTypes'),
        extractConst('serverTypes'),
        extractConst('GLB_VARIANTS'),
        extractLine('_failedGlbs'),
        extractFn('glbVariantUrl'),
        extractFn('rackModelName'),
        extractFn('serverModelName'),
        extractFn('loadGlbWithFallback'),
        extractFn('loadRackType'),
        extractFn('loadServerType'),
    ].join('\n\n');
    const factory = new Function(
        'loaderGltf', 'notice', 'models', 'dcUrl', 'extractModelMeshes', 'console',
        prelude + '\nreturn { rackTypes, serverTypes, GLB_VARIANTS, _failedGlbs, glbVariantUrl, rackModelName,'
        + ' serverModelName, loadGlbWithFallback, loadRackType, loadServerType };'
    );
    const api = factory(
        loaderGltf,
        (t) => notices.push(t),
        models,
        (p) => p,
        opts.extract || ((model, scale) => ({ built: true, scale, url: model._url })),
        consoleStub
    );
    return { ...api, seen, notices, warns, errors, models };
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
