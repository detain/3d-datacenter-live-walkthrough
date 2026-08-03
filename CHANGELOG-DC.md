# DataCenter 3D Scene — Detailed Changelog

All notable changes to the datacenter 3D walkthrough scene — including `dc.html`, `dc.php`, `dc.js`, `dc-multi.js`, `dc-presence.js`, `dc-ws.js`, `dc.css`, and `dc-shared.css`.

---

## [Unreleased]

### Multi-Tab Presence Support (NEW FEATURE)

Two browser tabs with the same session (same user) can now see each other in DataCenter 3D. Previously, the presence system was keyed by `uid`, so Tab 2's join would overwrite Tab 1's presence entry, and each tab's frontend self-filter used uid-only comparison, causing each tab to ignore the other's broadcasts.

**Solution:** Presence is now tracked per WebSocket connection (`client_id`), not per user (`uid`). Each browser tab gets its own presence entry regardless of shared session.

| Layer | What Changed |
|-------|-------------|
| Backend (`Events.php`) | Presence storage key changed from `dc_presence:$uid` to `dc_presence:client:$clientId`; index changed from `dc_presence_uids` to `dc_presence_clients`; `auth.welcome` now includes `clientId` in response; `handleDcPresenceJoin/Move/Leave/OnClose` all updated to use `client_id` keys; `setupSessionHealthTimer` iterates `dc_presence_clients` index; batch move handler broadcasts to all clients (viewport filtering preserved) |
| Frontend (`dc-ws.js`) | `window.DC_CLIENT_ID` set from `auth.welcome` response; `DC_PRESENCE_MOVE` sends `clientId` in message |
| Frontend (`dc-presence.js`) | `state.clientId` tracked; self-filter uses `clientId === state.clientId`; `state.remote` Map keyed by `clientId` (not uid) |

**Tests:** 18 new PHPUnit tests in `tests/EventsV1DcPresenceMultiTabTest.php`; 20 new Vitest tests in `tests/js/dc-fixes.test.js`

---

### Remediation — Tier 1: the page boots again

An eight-agent audit of `dc_improve_plan.md`'s execution (2026-08-03) found that the plan ran to completion — 54 steps, ~98 commits, 986 green tests — on top of a page that had not rendered a single frame since Phase 8.1 landed. Five fatals were stacked in the boot path, each hiding the next. Full findings and the remaining work: `dc_remediation_plan.md`.

**Before:** `window.DC` undefined, 0 canvases, loading curtain stuck, `yarn test:e2e` 18 failed / 33 passed.
**After:** scene boots, `yarn test:e2e` 1 failed / 50 passed (the one failure is a real Phase 7 defect, tracked as R2.4).

#### R1.1 — Point the import map at the ESM build of three-mesh-bvh

`dc.html` mapped the bare specifier `three-mesh-bvh` to `/node_modules/three-mesh-bvh/build/index.umd.cjs`. Two things were wrong with that: `.cjs` has no MIME mapping in `public_html/.htaccess`, so it was served as `application/node` and strict MIME checking rejected it as a module script before parsing; and it is the CommonJS bundle, which has no ES exports at all. The package's `exports["."].import` is the ESM entry, and the prebuilt ESM bundle sits in the same directory.

| File | Change |
|------|--------|
| `public_html/admin/dc.html` | Import map and modulepreload → `/lib/three-mesh-bvh/build/index.module.js` |
| `public_html/js/dc-renderer-mode.js` | `THREE_MESH_BVH` → same path, with a comment recording why `.cjs` fails |

Also brings the path back onto the `/lib/` convention (the `node_modules` symlink) that `dc-renderer-mode.js:18`'s own comment states and the rest of the page follows.

---

#### R1.2 — Bind `BufferGeometry` and actually wire the BVH raycast

Two defects in four lines. `dc.js` patched a bare `BufferGeometry.prototype`, but there is no such binding in the module — it does `import * as THREE from "three"` — so module evaluation threw `ReferenceError` before `window.DC` was ever created. And `acceleratedRaycast` was never imported: it is the **only** code in three-mesh-bvh that reads `geometry.boundsTree`, so the BVHs built in `extractModelMeshes()` were consulted by nothing and `raycaster.firstHitOnly` was inert. Step 8.1 was pure cost with zero benefit.

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Import `acceleratedRaycast`; `THREE.`-prefix all three prototype patches; add `THREE.Mesh.prototype.raycast = acceleratedRaycast`; replace two Chinese-character comment fragments |

---

#### R1.3 — Assign `caps` before anything reads it

`init()` called `_setupRendererSwitch()` before assigning `caps`, and that function dereferences `caps.isNode`. Every page load in every renderer mode threw `TypeError: Cannot read properties of null (reading 'isNode')`, making everything after that line unreachable — the `caps` assignment itself, KTX2 registration, both AO setups, shadow enablement and the datacenter fetch.

---

#### R1.4 — Make `animate()` call a function that exists

`animate()` ended with a bare `tick()`. There is no module-scope `tick` in `dc.js`; the only one is a property on the `window.DC` object literal. So it threw `ReferenceError` on every frame, `_guardLoop` swallowed it, and `_loopErrorCount` — which resets only on a *successful* frame — stopped logging after 10 frames and failed silently thereafter. On the `dc.html` path, the exact path Step 4.1 existed to protect, the scene painted nothing.

Now `if (window.DC && typeof window.DC.tick === 'function') window.DC.tick();`, which also tolerates `init()` still being in flight.

---

#### R1.5 — Unpin the tests that asserted the broken state

Four tests required defects to remain, so fixing the page turned CI red. Two were rewritten to execute production code instead of pattern-matching it:

| File | Was | Now |
|------|-----|-----|
| `tests/js/dc-bvh.test.js` | Asserted the import map equals `index.umd.cjs`; unanchored regexes that matched broken and fixed code alike | Builds a real `BufferGeometry`, calls `computeBoundsTree()`, asserts `boundsTree` is populated; asserts `acceleratedRaycast` is imported; asserts the mapped URL is not a `.cjs`, exists on disk, has ES exports, and matches what `dc-renderer-mode.js` exports |
| `tests/js/dc-render-loop.test.js` | `expect(lastLine).toMatch(/^tick\(\);?$/)` — required the ReferenceError | Compiles `animate()` with injected dependencies and **runs** it: asserts `DC.tick` is called once per frame, that `_contextLost` and `document.hidden` short-circuit, that a missing `window.DC` is tolerated — plus an explicit non-vacuity test proving the harness throws on the pre-fix bare `tick()` |

Both rewrites were verified by reverting the production fix and watching them go red. `tests/js/dc-bench.test.js` and `tests/js/dc-ao-webgpu.test.js` still assert known-wrong values (`ao: false`, `renderer._tslm`) because the underlying code is not fixed until Tier 3; each now carries a comment naming its remediation step and the assertion that should replace it.

---

#### R1.6 — Make the Playwright smoke test capable of failing

`tests/playwright/dc.spec.ts`'s *"no critical JS errors on page load"* registered only `page.on('pageerror')`. A module script that fails to **load** fires `error` on the `<script>` element and never reaches `window.onerror` — so the test passed on a page with zero canvases and no `window.DC`, for two days. Its own comment claimed *"a broken import map … shows up here as a module error and nowhere else"*, which was exactly backwards.

It now also collects console errors and failed requests, and asserts on the product rather than the absence of a log line: `typeof window.DC === 'object'` and at least one `<canvas>`. Verified non-vacuous — reverting R1.1 produces `Expected: "object" / Received: "undefined"`.

---

#### R1.7 — Record the baseline that Phase 8 was gated on

Step 8.0 required a draw-call baseline before any of Phase 8's optimisations; it was never performed, and Steps 8.1, 8.3 and 8.4 proceeded on estimates. Measured now that the page boots: **108 draw calls, 62,418 triangles** on the CI-equivalent stub room.

The CI ceilings were `drawCalls < 400` / `triangles < 2000000` — the plan's own placeholder values, roughly **32× the real triangle count**, incapable of catching any plausible regression. They are now `165` / `95000`, ~1.5× the measurement, with the observed values and date recorded in the test.

Also corrected in that test: the comment described `DC.bench()` as taking frames and returning `fps`, when it takes **seconds** and returns `avgFps`/`minFps` — so the annotation had been logging `undefined`. And it claimed the thresholds were "conservative headroom around what the stub room (4 racks, 12 servers…) actually produces"; `public_html/images/3d` is gitignored, so CI renders **no** racks or servers at all.

| File | Change |
|------|--------|
| `docs/dc_renderer_modes.md` | New `## Baseline measurements` section with the numbers, the date, and three caveats (room shell only; FPS unusable under SwiftShader; `shadows`/`ao` false are defects not settings) |
| `tests/playwright/dc.spec.ts` | `PERF_BUDGET` derived from the measurement; corrected API and scope comments; result printed, not just annotated |

`avgFps`/`minFps` are deliberately **not** asserted — SwiftShader returns `samples: 0`, so an FPS assertion would be vacuous or flaky. That needs real hardware.

---

### Remediation — Tier 2: restore what regressed

Six defects that shipped as "done" and were not. Each was verified in a real browser after the fix, and each fix was verified non-vacuous by reverting it and watching the new tests go red. Plan: `dc_remediation_plan.md` §R2.

**Suites:** unit 1042 → **1071 passing**; E2E 51 → **64 passing** (two new groups). No test was deleted to make anything pass.

#### R2.4 — Rewrite `dc-caps.js` against three.js properties that exist

The capability module at the centre of Phase 7 detected renderers using two properties that are not in three.js at all: `renderer.info.type === 'offscreen'` (`grep -c offscreen node_modules/three/build/three.module.js` → 0) and `renderer._tslm` (`grep -rn _tslm node_modules/three/src/` → 0 hits). Both were invented, so `caps.isNode` and `caps.supportsTSL` were permanently `false`.

The consequences ran well past those two flags. `DC.backendName` reported `webgl` in **all three** renderer modes — the exact failure Step 7.6 existed to prevent, and a regression, since the pre-Phase-7 line worked. The `#dcRenderer` button label and `bench().backend` were wrong with it. The entire Step 7.4 WebGPU render branch was unreachable. And `if (!caps.isNode)` was always true, so the classic `webglcontextlost` listeners attached on the node renderer too — which the comment three lines above says would "run both recovery paths against one loss".

| Property | Now derived from |
|---|---|
| `isNode` | `renderer.isWebGPURenderer \|\| renderer.backend` — both real, verified at `WebGPURenderer.js:95` and `Renderer.js:113` |
| `backend` | `renderer.backend.isWebGPUBackend` (`WebGPUBackend.js:88`) → `'webgl' \| 'webgpu' \| 'webgl2-fallback'`, never a class name |
| `supportsTSL` | `isNode` — TSL is a node-renderer capability; **both** node backends compile it, so gating on `backend === 'webgpu'` would wrongly exclude `?renderer=webgpu-gl` |
| `supportsEffectComposer` | `!isNode` — was inverted, which is why the AO toggle appeared on the WebGPU path where it does nothing |
| `supportsOcclusionQuery` | `isNode && realWebGPU` — was true for plain WebGL2, which cannot do them at all |

Also: `backendLabel()` is now exported (it was written but not), `describeRenderer(null)` returns a safe all-false descriptor instead of dereferencing `null.constructor`, and the unused `import * as THREE` is gone — the module has no import-time side effects, so it no longer drags the whole engine into every Vitest run. `dc.js` now reads `_backendName = caps.backend` rather than re-deriving the same rule a second way, and its duplicate `_BACKEND_LABELS` table is replaced by the exported `backendLabel()`.

Verified in chromium: `?renderer=webgl` → `webgl`; `?renderer=webgpu` and `?renderer=webgpu-gl` → `webgl2-fallback` (SwiftShader has no WebGPU device, so the fallback is the honest answer). Before this, all three said `webgl`.

`tests/js/dc-caps.test.js` was rebuilt: every fixture had been reverse-engineered from the broken implementation, so `info: { type: 'offscreen' }` and `_tslm: true` described properties on no real renderer and every assertion passed while the module was wrong in a browser. It now uses shapes three.js actually ships, and carries four contract tests that re-check those discriminators against the installed package so a version bump fails here rather than silently in production.

---

#### R2.1 — Give `buildCommunity()` back its neighbours

Step 3.6 changed `locationLoaded()` to test `loc._full`. `buildCommunity()` filters with it and gates the whole neighbour city behind `if (ids.length >= 2)`. After the two-tier boot only `options.location` is `_full`, so `ids.length === 1`, `lodBuildings` stayed empty, and `updateLOD()` returned at its first line for the life of the page. **No neighbour buildings, no block proxies, no doors, no LOD** — a live regression, invisible because no test placed more than one location.

The irony is exact: the index tier exists *"purely so the community layout knows every building's footprint"*, and `locationFootprint()` reads only `r.x`/`r.y` — precisely what the index provides. The one consumer of the index tier was the one call site not updated.

The two questions were conflated, so they are now two predicates:

| Predicate | Question | Used by |
|---|---|---|
| `locationLoaded(id)` | do we hold full asset detail? | `switchLocation()`, `loadBuildingModels()` |
| `locationPlaced(id)` | do we know where its racks sit? | `buildCommunity()`, `_restoreLocation()` |

`_restoreLocation()` was broken the same way: it gates on the predicate and runs *after* the index-only merge, so every device-loss restore naming a non-default location was silently dropped. It only needs the location to exist; `loadDatacenter()` fetches the detail on the next line.

New `tests/js/dc-location-tiers.test.js` (13 tests) is the behavioural coverage the original plan asked for and never got — it called `mergeLocations` *"the highest-risk step in the phase; test it properly"*, and the only existing reference stubbed it in a way that discarded the `isFull` argument the whole design turns on.

**The Playwright fixture was also wrong.** `bootHermetic()` served the same single-location payload to `?tier=index` and `?location=`, so the community layout could not be exercised at all — a fixture that cannot tell a working neighbourhood from an empty one. It is now tier-aware like the real endpoint: three locations in the index, one returned in full.

---

#### R2.2 — Make click-to-inspect actually work

Step 1.4 was meant to replace a distance pre-filter that used `mesh.position` (always `(0,0,0)` on an `InstancedMesh`). It fixed the *source* of the position and kept the camera-forward dot product, which measures distance **along the view axis** — so a mesh 80 units ahead, the one you are staring at, scored 80 and was discarded, while the same mesh behind you scored negative and was kept. With a room-spanning bounding sphere, standing at one end of a long room and looking down it dropped the whole mesh: clicking did nothing and the highlight never appeared. That is F-02's exact symptom, unfixed.

Now a plain distance test with the radius subtracted, so a large mesh whose centre is far but whose surface is at your feet is kept. A mesh with no bounding sphere is **included** rather than excluded — silently disabling picking for a whole model is worse than one extra intersect test. The latent `mesh.geometry.computeBoundingSphere()` bug is fixed too: that populates `geometry.boundingSphere` while the next line reads `mesh.boundingSphere`, which `InstancedMesh` owns separately. And the module-scope scratch vector Step 1.4 deleted is back — the shipped code allocated two `Vector3` per mesh per frame inside a function called every frame from `updateHighlight()`.

`tests/js/dc-raycast-instances.test.js` asserted the broken `mesh.geometry.computeBoundingSphere()` line **must exist**. Replaced with 15 behavioural tests that run the real filter against fakes with real vector maths; 7 of them fail against the old code. The central one: *a mesh within `MAX_RAYCAST_DIST` is kept regardless of which way the camera faces.*

---

#### R2.3 — Make shadows cast onto something

Shadows were enabled, cost GPU time every frame, and were essentially invisible. Five independent defects, and an explicit owner request that shipped non-functional:

1. **The frustum was never fitted.** `_fitShadowCamera()` starts `if (!_sunLight || !roomBounds) return;` and its only call site was in `init()` — but `roomBounds` is not assigned until `buildRoom()`, which runs later from a fetch continuation. It bailed on every load, leaving three.js's default ±5 orthographic box: a ~10×10 column at the world origin. Verbatim the failure the original step warned about. Now called at the end of `buildRoom()`, after `roomBounds` — which also covers location switches, since `clearScene()` nulls it.
2. **The fit was in the wrong space.** It wrote world X/Z into `cam.left/right/top/bottom`, which are **light-view** space. The light also never moved, so a room far from the origin fell outside the box entirely. The light is now re-anchored over each room at a fixed offset and aimed at its centre, and the box is sized by the room's diagonal radius — orientation-independent, so it cannot under-cover.
3. **Nothing received shadows.** Zero `receiveShadow` assignments in `buildRoom()` — floor, walls, ceiling and roof slab all defaulted to `false`. Racks could only cast onto other racks, so *"racks read as floating"*, the stated purpose of Phase 6, was unfixed even with a correct frustum.
4. **`S.shadowsEnabled` was never assigned.** Declared `false`, written nowhere. Both quality-scaler shadow branches gate on it, so Step 6.3 re-enabled nothing, and `DC.bench()` reported `shadows: false` while shadows rendered.
5. **`shadow.mapSize` was never set at creation**, so the real map was three.js's 512 default while `_shadowMapSize` said 2048, `S.shadowMapSize` said 2048 and the GUI said 1024 — four numbers, no two agreeing. All four now start at 2048.

`setShadowsEnabled()` now writes all four pieces of state and re-fits on the way back on, with guards so it cannot throw before `init()`. `setShadowMapSize()` now writes `_shadowMapSize`, `S.shadowMapSize` and `options.shadowQuality` — it wrote none of them, so the auto scaler overwrote the user's choice on its next tick — and accepts a numeric size: `sizeMap[512]` was `undefined`, so `|| 1024` turned the scaler's own downgrade into an **upgrade**.

`applyShadowPolicy()` was defined and never called (`grep -c` → 1). It is now called at all four model sites, the four copy-pasted traverse blocks are gone, and it takes a `kind` so the two cable sites — plus a **third**, the cached-reuse branch, which had no shadow flags at all — share one policy. Cable shadow behaviour previously depended on whether the geometry cache hit.

`renderer.shadowMap.type` is now `caps.isNode ? PCFSoftShadowMap : PCFShadowMap`. `PCFSoftShadowMap` is deprecated on the WebGL path — `WebGLShadowMap.js:99` converts it to `PCFShadowMap` and warns on every page load — while being genuinely supported on the node path. Asking for it unconditionally bought a console warning and `PCFShadowMap` anyway.

Verified in chromium: frustum ±74 (was ±5), far plane 289, map 2048 (was 512), light anchored over the room centre, **73 receivers** (was 0), `bench().shadows` true, no deprecation warning. Casting itself is **not** verifiable in CI — `public_html/images/3d` is gitignored, so there are no rack or server models to cast.

All four shadow test files were source-text regex, and two actively cemented the defects: `dc-shadow-policy.test.js` asserted the un-refactored traverse blocks must still exist, and hardcoded two cable sites when there are three. Rewritten behaviourally — `dc-shadow.test.js` runs the real `_fitShadowCamera()` and asserts the frustum brackets the room; `dc-shadow-gui.test.js` runs both setters and asserts what they write.

---

#### R2.5 — Handle the pointer-lock promise rejection

`Element.requestPointerLock(options)` returns a **Promise** and rejects *asynchronously* when the option dictionary is refused or the lock is denied — it does not throw synchronously. The call was wrapped in `try/catch` alone, so the catch fired only if `domElement` was null, the `controls.lock()` fallback was unreachable on every real failure path (including the common *"The document is not focused"*), and the discarded promise produced an unhandled rejection.

Now the returned value is captured and given a `.catch()` that falls back, `undefined` returns (older engines) go straight to the fallback, and the outer `try/catch` remains for the synchronous `TypeError` some engines throw on an unknown dictionary.

`tests/js/dc-pointer-lock.test.js` was three source greps, one of which matched the *dead* catch block. Replaced with 10 tests that inject a rejecting `requestPointerLock`; 6 fail against the old code, including all three unhandled-rejection cases.

---

#### R2.6 — Wire up Phase 9's five dead UI entry points

Every user-facing deliverable of Phase 9 was unreachable in a browser, each for a different reason. The underlying features worked from the console, which is why they looked done.

| # | Feature | Cause | Fix |
|---|---|---|---|
| 1 | **Copy Link** | `dc.js` loads as `type="module"`, so the inline `onclick="_copyDeepLink(…)"` resolved a module-scope name in **global** scope and threw `ReferenceError` on every click | `_wireInfoPanel()` attaches listeners after the markup is inserted — for all three buttons, including Close |
| 2 | **`?rack=` deep link** | Client looked up `'rack_' + id`; PHP keys racks by the bare id (`datacenter.php:128`) | Bare id at both ends |
| 3 | **Isolate render pass** | `if (!m.transparent) continue;` skipped every **opaque** material — i.e. every mesh in the scene. The mechanism is to *set* `transparent`, not require it | Sets `transparent`/`opacity`/`depthWrite`, saves and restores all three |
| 4 | **Trace Cable** | `_portsByAsset` keyed by PHP's `(int)` (a JSON number), looked up with an id from `Object.keys()` (a string). `Map.get("123")` never matches key `123` | `String()` at both ends |
| 5 | **Admin nav entry** | `add_link()`'s 2nd argument is `$params`, not a URL — it rendered `index.php?/admin/dc.php` | URL passed as `$target`, keeping `$link_names` for the sidebar highlight |

Defect 3 had a second half: saved state was keyed by **object id** while opacity lives on the **material**, and materials are shared in this scene (one `wallMat` for every wall). Object B recorded material M's already-dimmed `0.3` as M's "original", and `clearIsolate()` then pinned it there permanently. State is now keyed by material. `setIsolate(null)` also used to throw; it now clears.

Replacing the inline handlers removed a sink as well as a bug: asset ids were being interpolated into a JS string inside an HTML attribute with no escaping. Listeners close over the values, so nothing is parsed as code. Hanging the functions on `window` would have fixed the `ReferenceError` and left the sink. The `.dc-info-copy` / `.dc-info-trace` buttons also had no CSS at all and rendered as grey UA system buttons on a dark panel.

Verified in chromium: Copy Link writes `?location=4&asset=110` for a server and `?location=4&rack=101` for a rack; Trace Cable appears and draws its overlay; a hostname of `<img src=x onerror=…>` renders as literal text with zero injected elements; isolate dims 160 meshes and restores every one exactly.

New Playwright **Group 11** (community layout, 4 tests) and **Group 12** (info panel actions, 9 tests). Group 12 includes the XSS test the original plan called *"the important one"* and which was never written. Three of Group 11 and two of Group 12 fail against the pre-fix code.

---

### Field fix — periodic stutter, input lag, and quality that never came back

Reported alongside the WebGPU blackout below: periodic hitching even with shadows off, input
lagging behind the mouse at a *healthy* frame rate, and the scene looking worse than it used to.
A console probe on the reporter's own machine produced the measurements that made this tractable —
30 seconds of samples, and every quality tier pinned at its floor with zero recoveries.

**The scaler was a one-way ratchet.** `FPS_RECOVERY` was 65 while the render loop is rAF and
therefore vsync-capped: on a 60 Hz display the measured average can never exceed ~60, so
`_upgradeQuality()` was unreachable code. Every dip cost a tier permanently. That is the whole of
"the quality doesn't seem as good" — not a rendering change, just a control loop that could only
descend. Now 45/57, a real hysteresis band strictly under the ceiling.

Two things fed it. `_lastFrameTime` is written only by `_updateFPS`, which `DC.tick` skips both when
the tab is hidden and when the idle gate is closed — so the anchor froze and the first frame back
measured the *entire* gap. A 60-second background tab reads as ~1 fps and forced a downgrade on
every return to the tab. `DC.tick` now drops the anchor on both paths.

*This one bit twice.* The first fix was a 250 ms magnitude clamp, which looks reasonable and is
badly wrong: a struggling renderer legitimately exceeds it, so every sample was discarded,
`_fpsCount` never filled, and automatic quality reduction switched itself off on precisely the
machines that depend on it. The E2E suite caught it — SwiftShader renders slower than 250 ms/frame
and Group 14's scaler tests stopped firing. The clamp is now a 2000 ms backstop for pauses that do
*not* skip the tick, and `tests/js/dc-quality-scaler-loop.test.js` pins the failure mode.

**The hitching was garbage collection, not a timer.** The probe's hitch spacing was a broad spread
(37 ms–5330 ms, no cluster), which rules a timer out. `updateLabels()` ran every frame and allocated
as it went: a spread copy of both label arrays, one `{sprite, distSq}` object per label, then a full
comparator sort — in a room the code's own comment puts at 3137 labels, roughly 190k allocations a
second. It now ranks on a 10-frame interval into a reused scratch array, and label textures are
budgeted to 4 builds per frame instead of unbounded (each is a 960×96 canvas plus a `needsUpdate`
that recreates the GPU pipeline on the node renderer).

**`MAX_TEXTURE_CACHE` (128) was smaller than `MAX_LABELS` (200).** Past 200 labels every new one
evicted and *disposed* a texture a visible sprite still held, and `userData.drawn` stops it ever
being rebuilt — a permanent dispose/re-upload treadmill. Now a 256-entry cache that drops the map
entry without destroying the texture; `clearScene()` already frees them through the sprites.

**Input lag had two causes, both measured.** The camera-collision cache guard compared `S.camDist`
(the target) against `_lastSafeDist` (the result of the march), which are only equal when nothing
was blocking — so indoors, among rack rows, the cache could never hit and the full ray-march ran
every frame. And `updateHighlight()` re-picked 15×/second whether or not anything moved, with
`raycaster.far` left at `Infinity` and a pre-filter that cannot reject a room-spanning bounding
sphere. The pick now bails when neither the camera pose nor the instanced set has changed.

**Nothing in the scene cast a shadow.** `applyShadowPolicy()` set `castShadow` on the loaded GLTF
roots, but `extractModelMeshes()` keeps only `{geometry, material, matrix}` and the `InstancedMesh`
built from it defaulted to false. Racks and servers *are* the room, so the renderer cleared a
2048² depth target every frame against an empty caster list while every floor, wall and ceiling ran
a PCF lookup that could only return 1.0 — all of the cost, none of the picture. This also corrects
the Tier 3 note in `docs/dc_shadows.md`, which attributed `casters: 0` to CI's gitignored assets;
it was structural and true in production. Fixing it roughly doubles the triangle bill when shadows
are on (a second pass over the same geometry), which is why the Group 10 budget moved — worth
knowing before deciding whether shadows should stay on by default in a production-sized room.

**Cables were stuck at overview detail.** `maxTubular` was `farFromCables ? 24 : 96`, chosen from
`camera.position.y` at *build* time — and `flyTransition()` rebuilds the scene from its `onDone`
with the camera parked at y = 175. So every location switch after the first cached a 24-segment
variant and nothing rebuilt it once the player descended. Only the very first load ever got 96.
The camera's pose when geometry is built says nothing about where it spends the visit, so the
branch and its cache-key component are gone.

Also: `?inspector=0`, and one bug of my own — `raycaster.far = MAX_RAYCAST_DIST` placed above the
`const` that declares it, which is a temporal-dead-zone throw at module scope and stopped the page
booting entirely. Caught by Group 7/8, which exist for exactly that.

**Suites:** unit 1192 → **1199 passing** (53 files, new `dc-quality-scaler-loop.test.js` drives the
control loop with a synthetic clock rather than matching source text); E2E 85 → **85 passing**.

---

### Field fix — the WebGPU scene went black on entering a building

Reported from a live WebGPU session, not from a test: flying above the buildings was fine, clicking
into one turned the whole scene black and it never came back. The console said

```
[dc] quality ↓ shadowMap → 1024.00
Uncaptured WebGPU error: In a draw command, kind: Draw, caused by:
  Texture with 'ShadowDepthTexture' label has been destroyed
```

The interior build costs enough frames to trip the auto-quality scaler, whose second tier halves the
shadow map. `_applyShadowMapSize()` then dropped the map the way `WebGLShadowMap` requires —
`shadow.map.dispose(); shadow.map = null;` — which is the **opposite** of what the node renderer
needs. `ShadowNode` keeps its own reference (`this.shadowMap`) and its compiled TSL graph captured
that render target's depth texture at build time, so nulling the light's copy *orphans* the node's
rather than clearing it: three.js never reallocates, and every draw goes on sampling a destroyed
`GPUTexture`. WebGPU rejects that; WebGL quietly rebinds, which is why only one backend broke.

The branch is on `renderer.isWebGPURenderer`, not on a backend name — `?renderer=webgpu-gl` reports a
WebGL backend while running the node path, so a backend-string test would have missed it.

**What CI can prove, and what it cannot.** The default project resolves `?renderer=webgpu` to the
WebGL2 fallback, which does not enforce destroyed-texture use: mean luminance measured 147.77 before
and after, either way. Asserting on a black frame would have asserted on nothing. What *is*
observable on the fallback is the orphaning, and the orphaning is the defect — so both new test
layers assert that, and pin the two backends to **opposite** outcomes so neither can pass vacuously:

| | after a resize | after a manual `dispose(); map = null` |
|---|---|---|
| WebGL | new target allocated, `2048 → 1024` | recovers — this is the supported mechanism |
| Node | **same object**, resized in place | never recovers |

Both layers were confirmed red against the unfixed code before being kept: the unit test on the node
branch, and Group 15 with `mapped: false, w: null` — the orphan signature exactly.

Also here, from reading the same log: **`?inspector=0`**. In node mode the perf readout is the
three.js Inspector, and `Inspector.js` sets `renderer.backend.trackTimestamp = true` — so every frame
pays timestamp writes in every render pass, two GPU→CPU readbacks, an extra `requestAnimationFrame`,
and a DOM update per open tab. Most of that is main-thread work, whose signature is not a low frame
rate but *input lag at a healthy frame rate*. The flag falls back to `Stats` + lil-gui, both mapped
in every renderer mode.

**Suites:** unit 1191 → **1192 passing**; E2E 79 → **85 passing** (Group 15, both renderers).
Docs: `docs/dc_renderer_modes.md` gains *Resizing the shadow map* and *The Inspector is not free*.

---

### Remediation — Tier 3: finish what was left unfinished

Eleven items that were shipped incomplete, shipped as a stub behind an impossible condition, or documented as done and never written. Plan: `dc_remediation_plan.md` §R3.

**Suites:** unit 1104 → **1191 passing**; E2E 64 → **79 passing** (two new groups). Nine test files were converted from source-text matching to executing the code they name.

#### R3.7 — Ambient occlusion: finished on both backends, not withdrawn

Step 7.4 shipped `_postProcessing = { ao, ready: true }` — the imported TSL function stored in an object — and logged `"WebGPU TSL postprocessing (GTAONode) initialized"`. There was no `PostProcessing`, no `pass()`, no `outputNode`, and the render branch consuming it was byte-identical to the plain `else`. It was also unreachable, because R2.4 had not yet fixed `supportsTSL`. Step 7.3's WebGL half was real but unfinished: the composer was never resized, `GTAOPass` was constructed with the renderer where a width goes, the toggle appeared on the backend that could not use it, and `EffectComposer.js` had no modulepreload.

The plan offered three options and named the worst. This takes the first: **the node path is now a real TSL pipeline**, because the WebGL2 fallback backend compiles the same node graph, which means it is testable in CI under SwiftShader where real WebGPU is absent.

| | classic path | node path |
|---|---|---|
| chain | `RenderPass` → `GTAOPass` → `OutputPass` | `pass()` with an MRT of `{output, normal: normalView}` → `ao(depth, normal, camera)` → `RenderPipeline` |
| gate | `caps.supportsEffectComposer` | `caps.supportsTSL` — both node backends, so `?renderer=webgpu-gl` gets it |

Three things about the node graph took a browser to find, and none of them would have shown up as an error:

- **`setMRT` is not optional.** GTAO needs depth *and* normals off the same pass. Without it `getTextureNode('normal')` has nothing to return and the effect occludes against garbage.
- **GTAONode's output target is `RedFormat`.** The occlusion factor is in `.r`; `.g` and `.b` are zero. `aoNode.getTextureNode().mul(colorNode)` — the obvious thing to write, and what the first working draft did — zeroes green and blue and renders the scene **dark red**. Mean luminance fell by 118 of 255. The fix is the broadcast GTAONode's own doc block shows: `colorNode.mul(vec4(vec3(ao.r), 1))`.
- **The sampling radius is in world units.** GTAO defaults to `0.25`, sized for a scene where a character is ~1.8 units tall. Here a rack is ~19 units, so the default samples a sphere smaller than one 1U server. `_AO_RADIUS` / `_AO_THICKNESS` set it for this scene, and both paths use the same values so the backends stay comparable.

Also fixed: `onWindowResize()` and `applyPixelRatio()` now both call `resizePostFX()`, so the composer target and the TSL scene pass follow the window and the pixel ratio — without which the quality scaler could drop to 0.5 while AO kept rendering at full resolution. `GTAOPass` gets the real width and height instead of `renderer` in the width slot. The GUI toggle is offered on both paths. `EffectComposer.js` — the one module the other three are useless without — was added to the preload list.

**`bench().ao` was hardcoded `false`**, under a comment claiming AO was "not yet implemented" that Step 7.3 had already made untrue. Every benchmark reported AO off while the composer was rendering, in the one field whose entire purpose is making two runs comparable. It now calls `aoActive()`, the same predicate the renderer and `DC.postFX()` use, so the three cannot disagree.

**The scaler had no AO tier.** AO is a full screen-resolution pass over depth and normals with a denoise on top — the most expensive thing in the frame — so a page struggling *because of* AO ground its shadow map and pixel scale to the floor and never touched the actual cost. AO is now the first tier dropped and the last restored. `_aoSuspended` distinguishes "the scaler turned it off" from "the user never wanted it", so recovery only gives AO back to someone who asked for it, and a manual toggle clears the flag. Both GUI backends gained `updateDisplay()` so the checkbox follows.

`DC.setAutoQuality(false)` is new and load-bearing for measurement: the scaler drops AO on its first downgrade, so on any machine below `FPS_TARGET` — every headless CI runner included — AO is switched off within a second of being switched on and cannot be observed at all. `DC.postFX()` reports `{mode, requested, active, suspendedByScaler}`.

Both paths are pixel-verified: Playwright **Group 13** renders the same frozen camera with AO off and on and asserts mean luminance falls, on both backends. **Group 14** covers the scaler tier. Getting that measurement honest took three tries — the first two were measuring the idle-view demo moving the camera, and then the scaler switching AO off mid-capture. Both are documented in the spec, because a green test that compares two AO-off frames is worse than no test.

#### R3.1 — Dispose skeletons and duck-type textures in the dc-multi teardown

`Skeleton.dispose()` releases the bone texture (`Skeleton.js:298`), and nothing in a material walk reaches it. Character switching leaked one per swap. Texture disposal now duck-types on `'minFilter' in value` rather than an allowlist of property names.

#### R3.2 — One owner for the pixel ratio

`dc-multi.js` kept its own copy of the pixel scale in a *different* `S` object from `dc.js`'s, so the two drifted and the next window resize restored full resolution. It now delegates to `DC.setPixelScale()`. The clamp is `[0.5, 1.0]` and a non-finite value is rejected rather than propagating `NaN` into `setPixelRatio()`.

#### R3.3 — The idle gate measures input, not frames

`_tickSkippedFrames` counted to 18,000 and was reset only from `setLodFocus()` — which is driven by `dc-multi.js` and never called on the plain `dc.html` page. After roughly five minutes labels, highlight, blinds and the quality scaler all switched off whether or not anyone was moving, and never came back. "Idle" now means "no input for `_IDLE_MS`", recomputed from the clock every frame, with `noteUserInput()` wired into every input path.

#### R3.4 / R3.5 / R3.6 — Three smaller reversals

The quality-scaler toast fired on the 1.0 → 0.75 step and went silent at the 0.5 floor, under a comment saying it fired "at the floor" — and fired on upgrades too, so recovering announced "Auto-reduced quality". `onKeyDown` dereferenced a null `target` and did not exempt `<select>`. `computeFreeU()` counted every switch's U twice, because a switch is a row in `assets` and already arrives inside `rack.servers`; the switchmanager query emits the same asset again under `rack.switches`. And `applyOverlay()` hand-allocated `instanceColor` as a zero-filled `Float32Array` — RGB (0,0,0) — so any instance not written on a pass rendered **black** rather than untinted. `setColorAt()` allocates it white-filled, which is the correct neutral.

#### R3.8 — The manifest work is inert no longer

The deployed `public_html/images/3d/mixamo/manifest.json` had been regenerated by unfiltered code at **20.4 MB / 75,401 clips** — larger than the 16.4 MB baseline Step 3.3 existed to eliminate. It is now 745 KB / 2,736 clips, max 24 per character.

`public_html/.htaccess`'s cache rule had been commented out wholesale by `d01e841c44` and left that way. The reason it had to go is that **`<LocationMatch>` is not permitted in `.htaccess` context** — Apache answers 500 for every request under the directory when it finds one. `<FilesMatch>` is permitted but matches the basename only, so it would catch any other `manifest.json` too. The rule is re-done with `SetEnvIf Request_URI` + `env=`, which is path-scoped, legal in `.htaccess`, and the same idiom the cross-origin images block below it already uses.

New `tests/js/dc-playable-labels.test.js` is the drift test the step mandated: it parses `PLAYABLE_LABELS` out of `dc-multi.js` (resolving the `...GESTURE_ORDER` spread) and `VIEWER_PLAYABLE_LABELS` out of the Python, and fails in both directions — a downloader label with no viewer binding ships GLBs nothing plays; a viewer label the downloader filters out is a gesture key that silently does nothing. It also pins the two labels the Mixamo DB carries that neither list wants (`look` and `type`, 2 rows each of 114 characters), so adding either becomes a conscious edit.

#### R3.9 — The test stub computed the wrong yaw

`tests/js/__mocks__/three.js` had one transposed matrix element in `Euler.setFromQuaternion`: `m22` was written `1 - (xx + zz)` where three.js's `YXZ` order needs `1 - (xx + yy)`. Measured against the real class: 30° → 26.565°, 45° → 35.264°, 90° → 45°, **180° → 0°**. The comment above it enshrined the wrong answer, claiming a 90° rotation should give π/4. It was latent only because nothing asserted on the result yet.

A second defect in the same function guarded the roll denominator with `m11 === 0 ? 1 : m11`. `atan2` is defined at zero — that is what gives you ±π/2 — so the guard turned the one case it fires on into a wrong answer: `q = (0.5, 0.5, 0.5, 0.5)` has `xx + zz` exactly `1.0` in floating point, and roll came out 45° instead of 90°.

`tests/js/dc-stub-sanity.test.js` is the file Step 0.1 required and never got. It is the one place in the suite that imports the **real** `three` package — a deliberate exception to the project rule, because a stub is the one piece of test infrastructure nothing else can check: every other test trusts it by construction, so a wrong stub makes the suite quieter rather than louder. 32 tests run the real class side by side with the stub across a full yaw sweep, mixed pitch/yaw/roll, and both gimbal poles. `Box3.getSize()` / `getCenter()` / `isEmpty()` were added (production reads bounds through them at `dc.js:3675`), and `AnimationAction.setEffectiveWeight()` records the weight instead of returning `this` — a faded-out action and a full-weight one were previously indistinguishable, and the crossfade in `play()` is entirely a story about weights.

#### R3.10 — The five missing docs, and three wrong ones

None of these existed; no changelog entry flagged the omission:

| File | Mandated by |
|---|---|
| `docs/dc_data_endpoint.md` | Steps 3.5, 3.6, 3.7, 3.8, 9.1 |
| `docs/dc_shadows.md` | Steps 6.1–6.5 |
| `docs/dc_deep_links.md` | Steps 9.3, 9.4 |
| `docs/dc_isolate.md` | Steps 9.5, 9.6 |
| `docs/dc_overlays.md` | Step 9.7 |

`docs/dc_renderer_modes.md` said "ambient occlusion is not yet implemented" and "no `EffectComposer`", both untrue since Step 7.3; it gains an **Ambient occlusion** section and the **Known performance characteristics** section Step 7.5 required.

`docs/dc_asset_pipeline.md`'s conversion section was substantially fabricated and is rewritten against `@gltf-transform/cli` 4.4.2 and the installed `KTX2Loader`. The commands were written as producing `.ktx2` files when the tool is glTF-in/glTF-out; `--rdo-g` and `--split-threshold` are not real options; ETC1S was described as "suitable for normal maps", which is inverted; "JPEG BC" is not a texture format; and the claim that WebGPU transcodes natively without WASM is false — `KTX2Loader` resolves `basis_transcoder.wasm` unconditionally on every path.

#### R3.11 — The test honesty sweep

25 of 49 files (256 of 951 `it()` blocks) never executed production code. The worst were not merely weak — they were **re-implementations of the subject inside the test file**, one of them under a comment presenting it as a technique:

```js
// Test helper: re-implement onWheel logic from source to test in isolation
function makeOnWheel() { return function onWheel(e) { /* four lines copied out of dc-multi.js */ }; }
```

Eleven blocks then exercised that copy. It could not fail for any change to `dc-multi.js`, and the copy was already partial — it stopped at `preventDefault()` and omitted the entire dolly body, so the camera behaviour the file is named after had no coverage at all. `dc-multi.test.js` did the same for `chooseAnimation` (whose copy did not even share the real signature), `lerpAngle`, and `onWheel` twice more, plus eight hand-transcribed constants.

Converted, worst first: `dc-wheel-dolly`, `dc-multi`, `dc-ktx2`, `dc-overlay`, `dc-cable-trace`, plus `dc-ao`, `dc-ao-webgpu`, `dc-idle-skip` and `dc-pixel-ratio` where R3.7 changed what they were pinning. Constants are now read from source at run time and the extractors throw on a rename, so a changed value cannot leave a stale copy behind. Where a source-text assertion is genuinely the right tool — an export list, a markup contract across three files, a "these two call sites must not drift" rule — it is kept and says so in a comment.

**Converting the fakes immediately surfaced two real defects the fakes were hiding:**

- **`lerpAngle` took the long way round.** `((b - a + PI) % (2*PI)) - PI` only normalises when `b - a >= -PI`, because JavaScript's `%` keeps the sign of the dividend. For a target more than half a turn below the current facing the modulo returns a negative value and subtracting π pushes it further out — down to −2π. Both endpoints are the same angle, so nothing looked broken; the avatar just spun the long way, for half of all wrap cases. Fixed in `dc-multi.js`.
- **`dc-overlay.test.js` asserted the presence of a bug in a file that no longer had it.** `expect(fnSrc).toContain('rack.switches')` kept passing after R3.6 removed the double-counting loop, because `rack.switches` still appears — in the comment explaining the removal. A substring match cannot tell code from prose. The replacement is the only form that can detect it: a rack holding one switch must report the same free capacity whether or not `rack.switches` is populated.

`dc-ktx2.test.js` gained the check its regexes structurally could not make: the transcoder path is resolved against the filesystem and the Basis `.js`/`.wasm` files asserted present. A regex derived from a line of code cannot tell you the line is wrong, and a wrong transcoder path is silent until the first KTX2 texture loads — which in CI never happens, because `public_html/images/3d` is gitignored.

---

### Where each `dc_improve_plan.md` step is recorded

Phases 5–9 are written up under their own step headings below. Phases 0, 1 and 4 landed before that convention and are recorded by **finding ID** instead — this table is the bridge.

| Step | Recorded under |
|------|----------------|
| 0.1 Fix the three.js test stub | *Test Infrastructure (2026-08-02)* |
| 0.2 Rewrite the dc-core tests | *Test Infrastructure → `dc-core.test.js` rewrite* |
| 0.3 Delete re-implementation tests | *Test Infrastructure → `dc-fixes.test.js`* |
| 0.4 Bring orphaned ws test files into the suite | *Test Infrastructure* (last paragraph) |
| 1.1 requestIdleCallback crash | *Bug fixes* → `rIC guard` |
| 1.2 Idle-callback polyfill queue | *Bug fixes* → `rIC queue` |
| 1.3 Labels disappearing forever | *Bug fixes* → `Label deprioritization` |
| 1.4 Click-to-inspect / look-highlight | *Bug fixes* → `F-02` |
| 1.5 Cables stuck at low detail | *Bug fixes* → `F-09` |
| 1.6 Number keys doing two things | *Bug fixes* → `F-08` |
| 1.7 Wheel hijacking the page | *Bug fixes* → `F-18` |
| 1.8 Unadjusted pointer-lock movement | *Bug fixes* → `F-39` |
| 2.1 – 2.4 | *Phase 2 — Dead code* |
| 3.1 – 3.8 | *Phase 3 — Boot path and payload* |
| 4.1 Collapse the two render loops | *Bug fixes* → `F-16` |
| 4.2 One owner for pixel ratio | *Bug fixes* → `F-10` |
| 4.3 Idle-skip on real idleness | *Bug fixes* → `F-17` |
| 4.4 Character-switch memory leak | *Bug fixes* → `F-14` |
| 4.5 trySpawn destroying cached door assets | *Bug fixes* → `F-15` |
| 5.1 – 5.2 | *Phase 5 — Dependency upgrades* |
| 6.1 – 6.3 | *Phase 6* (first section) |
| 6.4 – 6.5 | *Phase 6* (second section, further down) |
| 7.1 – 7.6 | *Phase 7* |
| 8.0 | *Phase 8 → Step 8.0* — **not done**, see that entry |
| 8.1 – 8.4 | *Phase 8* |
| 9.1 – 9.7 | *Phase 9* |

---

### Phase 9

#### Step 9.1 — Send the fields we already have

Expanded the assets SELECT in `public_html/ajax/datacenter.php` to include more fields: `status`, `primary_ipv4`, `mac`, `make`, `model`, `order_id`. When building the JSON response, these fields are included but omitted if empty/null. Also added `rack_size` as `u` field to the racks query response.

| File | What Changed |
|------|-------------|
| `public_html/ajax/datacenter.php` | Added 6 columns to assets SELECT; added conditional field inclusion in assets loop; added `rack_size` to racks SELECT and `u` to racks JSON |

---

#### Step 9.2 — Rich in-scene info panel with status, IPv4, MAC, hardware

Rewrote `showInfo()` in `dc.js` to display more asset information when a server is clicked. The info panel now shows: status (with a colored dot: green=active, red=off/canceled, yellow=warning), IPv4 address, MAC address, hardware make/model, position as U-start to U-end, plus asset and order links. A close button (×) dismisses the panel. All values are passed through `escapeHtml()` for XSS safety.

| File | What Changed |
|------|-------------|
| `public_html/js/dc.js` | Rewrote `showInfo()` to display status dot, IPv4, MAC, hardware, position, links; added close button |
| `public_html/css/dc-shared.css` | Added `.dc-info-close`, `.dc-status-dot`, `.status-active/off/warning`, `.dc-info-row`, `.dc-info-links` |

**Tests:** New Vitest test in `tests/js/dc-info-panel.test.js` verifying escapeHtml coverage on all fields, status dot CSS classes, and expanded field presence.

---

#### Step 9.3 — Deep links into the scene

Added support for `?location=`, `?rack=`, and `?asset=` URL parameters to deep-link directly into the 3D scene. `_readDeepLink()` reads and parses URL params early in `init()` (before room build) using `Number()` coercion for safety. `_applyDeepLinkTarget()` is called after `displayDatacenter()` in the load chain and handles: `?location=X` switches to that location if not already there; `?rack=X` flies the camera to that rack; `?asset=X` searches the current location's racks for the asset and flies to it. Added `_copyDeepLink()` and a "Copy Link" button in the info panel (both server and rack cases) that copies the current URL with appropriate `location=`, `rack=`, and `asset=` params to clipboard.

| File | What Changed |
|------|-------------|
| `public_html/js/dc.js` | Added `_readDeepLink()`, `_applyDeepLinkTarget()`, `flyToRackPosition()`, `_copyDeepLink()`; modified `loadDatacenter()` to use deep link location for initial fetch and call `_applyDeepLinkTarget()` at end of promise chain; added copy button to `showInfo()` for both server and rack cases |
| `tests/js/dc-deep-link.test.js` | New Vitest test verifying URL param parsing, Number() coercion, deep link application logic, and copy link button presence |

**Tests:** New Vitest test in `tests/js/dc-deep-link.test.js`

---

#### Step 9.4 — Make the page discoverable

Added "DataCenter 3D" link to the admin navigation menu and "View in 3D" link on the asset detail page. The nav menu now includes a direct link to the 3D datacenter viewer (`/admin/dc.php`). The asset detail page (`asset_form`) includes a "View in 3D" button that deep-links into the 3D scene at the asset's location.

**Changes:**

| File | Change |
|------|--------|
| `include/menu.functions.inc.php` | Added "DataCenter 3D" menu link under Datacenter section, linking to `/admin/dc.php` |
| `include/servers/admin/asset_form.php` | Added "View in 3D" link button linking to `/admin/dc.php?location={datacenter}&asset={assetId}` |

---

#### Step 9.5 — The "isolate" render pass

Added `setIsolate(keepSet)` / `clearIsolate()` functionality for highlighting specific objects by dimming everything else. The isolate mechanism works with a `Set` of object identifiers (mesh `id` values). Calling `setIsolate(keepSet)` dims all transparent meshes NOT in the keepSet to 0.3 opacity while preserving original opacity values. `clearIsolate()` restores all meshes to their original opacity and clears the state. The isolate state is automatically cleared on `clearScene()` and when the Escape key is pressed.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Added `_isolateOriginalOpacities` Map; added `setIsolate(keepSet)` and `clearIsolate()` functions; `onKeyDown` Escape case calls `clearIsolate()`; `clearScene()` calls `clearIsolate()`; both functions exported on `window.DC` |

**Tests:** New Vitest test in `tests/js/dc-isolate.test.js`

---

#### Step 9.6 — Cable tracing

Added cable tracing functionality to visualize individual cable routes in the 3D scene. When a server asset with cable connections is clicked, a "Trace Cable" button appears in the info panel. Clicking it draws a bright cyan (`0x00ffff`) `LineBasicMaterial` overlay along the cable path from switch to asset.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Added `_cableRoutes` Map (stores route points per `switchId:portId`); added `_portsByAsset` Map (reverse index `assetId → [{switchId, portId, port, sw}]`); added `buildPortsByAsset(locId)` to build the reverse index; modified `displaySwitches` to capture route points in `addCable`; added `traceCable(routeKey)` to draw the trace overlay; added `clearTrace()` to remove overlay; added `traceCableForAsset(assetId)` helper; modified `showInfo` to show trace button for connected assets; `displayDatacenter` calls `buildPortsByAsset` before `displaySwitches`; all new functions exported on `window.DC` |

**Tests:** New Vitest test in `tests/js/dc-cable-trace.test.js`

---

#### Step 9.7 — Free-U capacity overlay

Added a capacity overlay system that tints rack InstancedMeshes with a red→amber→green color ramp based on available U slots. When "Free U" overlay is selected from the Display dropdown, each rack is colored by its free capacity: red (0% free/full), amber (50% free), green (100% free/empty).

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Added `options.overlay` ('none'\|'freeU'); added `OVERLAY_SOURCES` registry (`{none: null, freeU: computeFreeU}`); added `computeFreeU()` function returning `Map<rackId, 0..1>`; added `applyOverlay()` to tint rack InstancedMeshes via `setColorAt()`; added `_resetInstanceColors()` helper; GUI dropdown added to Display folder with `onChange` calling `applyOverlay()`; `applyOverlay()` called after each `displayRacks()`/`displayServers()` call and in `flyTransition` callback |
| `public_html/css/dc-shared.css` | Added `#dcOverlayLegend` styles (hidden by default, shown via `.visible` class); `.legend-swatch.full/half/empty` with red/amber/green colors |
| `public_html/admin/dc.html` | Added `#dcOverlayLegend` div with "Free U Capacity" title and three swatch rows |

**Tests:** New Vitest test in `tests/js/dc-overlay.test.js` verifying OVERLAY_SOURCES registry, computeFreeU() return type and value range, GUI dropdown presence, and CSS legend rules.

---

### Phase 8

#### Step 8.0 — Record the draw-call baseline — **NOT DONE**

This step was the gate for the rest of Phase 8: load the page, run `await DC.bench(10)` in an aisle and again beside a full-detail neighbour, and write `drawCalls` / `triangles` / `avgFps` / `minFps` into `docs/dc_renderer_modes.md` under a "Baseline measurements" heading. It requires a real browser and GPU, so it could not be performed from the build box and **no baseline was ever recorded**.

Consequences, recorded here so they are not forgotten:

| Step | Why the missing baseline matters |
|------|----------------------------------|
| 8.3 (cable triangle bill) | The plan made this step **conditional** — "if draw calls are already under ~100, skip Step 8.3 entirely". The work was done without the measurement that was supposed to authorise it. |
| 8.4 (CI regression guard) | The `drawCalls < 400` / `triangles < 2000000` thresholds are estimates, not measurements. They may be far too loose to catch a real regression, or tight enough to fail spuriously. |
| 8.1 (BVH picking) | The speed-up is real but unquantified on this scene. |

**To close this out:** open `/admin/dc.php` in a browser, run the two `DC.bench(10)` calls, record the numbers in `docs/dc_renderer_modes.md`, then re-derive the Step 8.4 thresholds from them.

---

#### Step 8.1 — Accelerate picking with three-mesh-bvh

Added `three-mesh-bvh` BVH acceleration for raycasting in the datacenter 3D scene. This provides significant speedup for complex model picking by using a bounding volume hierarchy instead of naive ray intersection on every triangle.

**Changes:**

| File | Change |
|------|--------|
| `package.json` | Added `three-mesh-bvh: latest` to dependencies |
| `public_html/admin/dc.html` | Added `three-mesh-bvh` to import map; added modulepreload for the UMD bundle |
| `public_html/js/dc-renderer-mode.js` | Exported `THREE_MESH_BVH` constant; added to `rendererImports()` |
| `public_html/js/dc.js` | Imported `computeBoundsTree`/`disposeBoundsTree` from three-mesh-bvh and patched `BufferGeometry.prototype`; called `geometry.computeBoundsTree()` in `extractModelMeshes()` for every loaded mesh; set `raycaster.firstHitOnly = true` |
| `tests/js/dc-bvh.test.js` | New test verifying three-mesh-bvh in package.json, BufferGeometry.prototype patching, raycaster.firstHitOnly, and import map entries |

**Tests:** New Vitest test in `tests/js/dc-bvh.test.js` (11 assertions across 6 test suites)

---

#### Step 8.2 — Register KTX2Loader for compressed texture support

Added `KTX2Loader` registration on the shared `GLTFLoader` instance (`loaderGltf`) to enable GPU-native transcoding of UASTC/ETC1S-compressed textures. The loader is configured with the Basis Universal transcoder path and `detectSupport(renderer)` is called to probe hardware capabilities.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Imported `KTX2Loader`; registered `loaderGltf.ktx2Loader = new KTX2Loader()`; set transcoder path to `/node_modules/three/examples/jsm/libs/basis/`; called `detectSupport(renderer)` |
| `docs/dc_asset_pipeline.md` | New document describing the KTX2 conversion pipeline using `gltf-transform cli uastc/etc1s`, noting that `public_html/images/3d/` is gitignored |

**Tests:** New Vitest test in `tests/js/dc-ktx2.test.js` verifying KTX2Loader registration, detectSupport call, and documentation

---

#### Step 8.3 — Reduce the cable triangle bill

Lowered cable geometry LOD to reduce draw call triangle count without visible quality loss at typical viewing distances.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | `CABLE_RADIAL`: 8 → 5 (fewer tube cross-section sides); `maxTubular`: 40/220 → 24/96 (lower LOD cap); tubular divisor: `len/2.2` → `len/4` (longer segments = fewer triangles) |

**Tests:** New Vitest test in `tests/js/dc-cable-geometry.test.js`

---

#### Step 8.4 — Add a performance regression guard to CI

A Playwright E2E test (`tests/playwright/dc.spec.ts` Group 10) now runs `DC.bench(10)` and asserts `drawCalls < 400` and `triangles < 2000000` to catch render-cost regressions before they reach production. The test runs in CI without `continue-on-error` so any regression **blocks the PR**.

**Changes:**

| File | Change |
|------|--------|
| `tests/playwright/dc.spec.ts` | Added `describe('Performance regression', ...)` with `DC.bench(10)` assertions and performance annotations |
| `.github/workflows/tests.yml` | Added dedicated step for performance regression test (no `continue-on-error`) |

---

### Phase 7

#### Step 7.5 — Clarify webgpu-gl is a diagnostic tool, not a fallback tier

The `?renderer=webgpu-gl` mode was described as a "comparison" tool but its framing implied it was a fallback path. It is not — it is a **diagnostic tool** that forces the node-renderer onto WebGL 2 so the architecture cost can be measured in isolation from the GPU API. It should never be presented to users as a recommended option or a fallback when WebGPU is unavailable.

**Changes:**

| File | Change |
|------|--------|
| `docs/dc_renderer_modes.md` | Updated the `webgpu-gl` description to explicitly state it is a diagnostic tool; the table now notes it is not a fallback tier |
| `public_html/js/dc.js` | Added comment above `_MODE_LABELS` explaining `webgpu-gl` is for debugging only |
| `public_html/js/dc-renderer-mode.js` | Added `IMPORTANT` note in `parseRendererMode()` JSDoc that `webgpu-gl` is a diagnostic tool, not a fallback tier |

---

#### Step 7.6 — Make DC.bench() report comparable numbers on all three backends

`DC.bench()` now returns additional fields (`ao`, `shadows`, `shadowMapSize`, `pixelScale`, `triangles`) that capture renderer state at measurement time, enabling meaningful cross-backend FPS comparisons. The idle reset mechanism now uses `noteUserInput()` (exposed on `window.DC`) instead of a raw frame counter, and a console warning is logged if the FPS ring buffer never fills during a run.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Added `noteUserInput()` to `window.DC` for resetting idle skip; updated `bench()` to call it instead of directly setting `_tickSkippedFrames`; added `ao`, `shadows`, `shadowMapSize`, `pixelScale`, `triangles` to bench return object; added warning when FPS ring buffer never fills |
| `docs/dc_renderer_modes.md` | Updated bench result format documentation with new fields and warning behavior |
| `tests/js/dc-bench.test.js` | New test file verifying bench result fields, idle mechanism pattern, and FPS ring buffer warning |

---

#### Step 7.1 — Create a renderer-capability module

A new `dc-caps.js` module centralises renderer capability detection. Instead of ad-hoc `renderer.backend` or `instanceof` checks scattered through `dc.js`, callers now use the normalised `describeRenderer(renderer)` function which returns a capability object with `isNode`, `backend`, `shadowTypeSettable`, `supportsTSL`, `supportsCompute`, `supportsOcclusionQuery`, and `supportsEffectComposer` booleans.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc-caps.js` | New module exporting `describeRenderer(renderer)` |
| `public_html/js/dc.js` | Imports `describeRenderer`; calls it in `init()` after renderer creation to populate `caps`; replaces `renderer.isWebGLRenderer` context-loss check with `!caps.isNode` |
| `public_html/admin/dc.html` | Added `<link rel="modulepreload" href="/js/dc-caps.js">` |

**Tests:** New Vitest test in `tests/js/dc-caps.test.js`

---

#### Step 7.2 — Restore frustum culling for neighbours and player

Re-enabled frustum culling (`frustumCulled = true`) for neighbour building instanced meshes and the player character. The current building's meshes keep `frustumCulled = false` because their room-spanning bounding spheres make culling ineffective.

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | `buildInstanced()` now sets `frustumCulled = !!sink` — true for neighbour buildings (sink is passed), false for current building (sink is undefined) |
| `public_html/js/dc-multi.js` | Player character model traverse sets `frustumCulled = true` on all meshes |

**Tests:** New Vitest test in `tests/js/dc-frustum-culling.test.js`

---

#### Step 7.3 — Add ambient occlusion on the WebGL path using GTAOPass

The classic WebGL renderer path now supports ambient occlusion via three.js's `GTAOPass` run through an `EffectComposer` chain: `RenderPass → GTAOPass → OutputPass`. The feature is opt-in via a new **Display → ambient occlusion** toggle that only appears when `caps.supportsEffectComposer` is true (i.e., on the WebGL path; the WebGPU path uses TSL `GTAONode` via `_setupWebgpuPostFX()` instead).

**Changes:**

| File | Change |
|------|--------|
| `public_html/admin/dc.html` | Added `<link rel="modulepreload">` for `RenderPass.js`, `GTAOPass.js`, and `OutputPass.js` |
| `public_html/js/dc.js` | Added `_composer` and `_aoPass` module variables; added `ambientOcclusion: false` to the `options` object; added `_setupWebglPostFX()` async function that dynamically imports `EffectComposer`, `RenderPass`, `GTAOPass`, and `OutputPass` and builds the composer chain; `init()` calls `_setupWebglPostFX()` after capability detection when not on the WebGPU path; `DC.tick()` now calls `_composer.render()` instead of `renderer.render()` when `options.ambientOcclusion && _composer`; the existing 3-way render branch comment updated to reflect the Step 7.3 AO path; added GUI toggle in the Display folder, guarded by `caps.supportsEffectComposer` |
| `tests/js/dc-ao.test.js` | New Vitest test verifying GTAOPass availability, `supportsEffectComposer` correctness for WebGLRenderer, `ambientOcclusion` in options, and `_setupWebglPostFX` presence in source (only when GTAOPass is available) |

---

#### Step 7.4 — Add ambient occlusion on the WebGPU path using TSL

Added infrastructure for WebGPU TSL postprocessing with a 3-way render branch in `tick()`:

- `caps.supportsEffectComposer`: use EffectComposer (standard postprocessing path)
- `caps.supportsTSL && _postProcessing`: use WebGPU TSL path with GTAONode ambient occlusion
- `else`: plain `renderer.render(scene, camera)`

**Changes:**

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Added `_postProcessing` module variable (null until TSL pipeline is initialized); added `_setupWebgpuPostFX()` async function that dynamically imports `GTAONode` from `three/addons/tsl/display/GTAONode.js`; `init()` calls `_setupWebgpuPostFX()` when `caps.backend === 'WebGPURenderer'`; `tick()` now has a 3-way branch for render path selection |
| `tests/js/dc-ao-webgpu.test.js` | New Vitest test verifying `_postProcessing` declaration, `_setupWebgpuPostFX()` existence, the 3-way branch pattern, and `caps.supportsTSL` detection |

**Note:** Full GTAONode integration with the TSL `RenderPipeline` is a future enhancement. The current implementation sets up the infrastructure and 3-way branch; actual AO rendering via TSL requires additional `RenderPipeline` setup.

---

### Phase 6

#### Step 6.1 — Enable shadow rendering with PCFSoftShadowMap

Shadow rendering is now enabled in the WebGL renderer for realistic shadows from the sun directional light.

**Changes in `dc.js`:**

| What | How |
|------|-----|
| `_sunLight` variable | Declared at module scope to hold the sun `DirectionalLight` |
| Sun light shadow config | `castShadow = true`, `shadow.bias = -0.001`, `shadow.normalBias = 0.02`, `shadow.camera.near = 1`, `shadow.camera.far = 500` |
| Shadow camera fit | New `_fitShadowCamera()` function fits orthographic shadow camera to `roomBounds` with 20-unit margin |
| `scene.add(_sunLight.target)` | Target object added to scene — without this, the shadow camera has no position and shadows don't work |
| Renderer shadow map | `renderer.shadowMap.enabled = true` and `renderer.shadowMap.type = THREE.PCFSoftShadowMap` |

**Tests:** New Vitest test in `tests/js/dc-shadow.test.js`

---

#### Step 6.2 — Add shadow controls to the settings panel

Shadow rendering can now be toggled and configured via the lil-gui settings panel (Display folder).

**Changes in `dc.js`:**

| What | How |
|------|-----|
| `options.shadows` | New boolean option, default `true` |
| `options.shadowQuality` | New string option, default `'Medium'` — Low=512 / Medium=1024 / High=2048 |
| `setShadowsEnabled(bool)` | New function: sets `renderer.shadowMap.enabled` and marks all scene materials `needsUpdate` |
| `setShadowMapSize(quality)` | New function: disposes old shadow map and recreates at 512/1024/2048 based on quality |
| Display folder controls | Checkbox for `options.shadows` and dropdown for `options.shadowQuality` with Low/Medium/High |
| `window.DC` exposure | `setShadowsEnabled` and `setShadowMapSize` exposed for testing |

**Tests:** New Vitest test in `tests/js/dc-shadow-gui.test.js`

---

#### Step 6.3 — Re-enable the qualityscaler's shadow tier

The quality scaler's shadow map tier (gated off in Phase 2 step 2.2) is re-enabled with an oscillation guard.

**Changes in `dc.js`:**

| What | How |
|------|-----|
| `UPGRADE_LOCKOUT_MS` constant | `30000` — 30-second lockout prevents shadow-map upgrade after a downgrade |
| `_lastDowngradeAt` variable | Tracks timestamp of last quality downgrade |
| `_reduceQuality()` order | Shadow map halving moved to **Step 1** (before pixelScale reduction) |
| `_upgradeQuality()` order | Shadow map doubling moved to **last step** (after pixelScale and lodBias) |
| Lockout guard | `_upgradeQuality()` checks `Date.now() - _lastDowngradeAt < UPGRADE_LOCKOUT_MS` before shadow map upgrade and returns early if still locked out |
| `S.shadowsEnabled` guard | Retained around shadow map steps in both functions |

**Tests:** New Vitest test in `tests/js/dc-quality-scaler-shadow.test.js`

---

### Phase 5 — Dependency upgrades

#### Step 5.1 — Upgrade three.js 0.184.0 → 0.185.1

three.js was moved to r185 (`0.185.1` specifically — `0.185.0` was published six days before the r185 tag and is not the release build). The r185 breaking-change list was audited against this scene beforehand and only one item touched us: `FirstPersonControls` was rewritten and its default `dampingFactor` changed from `0` to `0.1`, which would have introduced camera lag. `controls.dampingFactor = 1` is now set explicitly in `setupControls()` to preserve the instant-response camera feel.

Verified as **not** affecting this scene: the WebGPU premultiplied-alpha rework (we set an opaque `scene.background` and never pass `alpha:true`), the removal of `DRACOLoader.decoderPath` (we call the `setDecoderPath()` method), the removal of `InstancedMesh.previousInstanceMatrix` (zero references), the `Object3D.updateWorldMatrix()` change (zero `matrixAutoUpdate` use in any dc file), and the Inspector `extensions.json` removal (zero references). `PointerLockControls`, `RoomEnvironment`, `stats.module.js`, `MeshoptDecoder`, ColorManagement, tone mapping and `outputColorSpace` were all unchanged in r185.

| File | Change |
|------|--------|
| `package.json` | `three` `0.184.0` → `0.185.1` (the `"three": "^0.109.0"` line inside the non-standard `suggests` block is inert and was deliberately left alone) |
| `yarn.lock` | Regenerated by `yarn install` |
| `public_html/js/dc.js` | `controls.dampingFactor = 1` in `setupControls()`, with a comment recording why |

> Note: this commit also carried the Phase 6 shadow enablement (`renderer.shadowMap.enabled`, the `_sunLight` directional light with `bias`/`normalBias`/shadow-camera setup, and the Step 6.5 caster policy). Those changes are described under Phase 6 below.

---

#### Step 5.2 — Upgrade lil-gui 0.19.2 → 0.21.0

lil-gui was upgraded and the CSS class selectors it renamed were updated at every site that targeted them.

| File | Change |
|------|--------|
| `package.json` | `lil-gui` `0.19.2` → `0.21.0` |
| `yarn.lock` | Regenerated by `yarn install` |
| `public_html/css/dc.css` | `.lil-gui.root` → `.lil-gui.lil-root` |
| `public_html/css/dc-shared.css` | `.lil-gui .controller.number .widget input` → `.lil-gui .lil-controller.lil-number .lil-widget input` |

0.21.0 prefixed its internal class names (`controller` → `lil-controller`, `widget` → `lil-widget`, `root` → `lil-root`, `number` → `lil-number`). Verified no un-prefixed selector survives anywhere in `public_html/css/`, `public_html/js/`, `dc.html` or `tests/`.

---

### Phase 3 — Boot path and payload

The scene's boot cost was dominated by two things: every character downloaded its entire Mixamo animation manifest, and the datacenter endpoint returned a 1.5 MB inventory blob for every location before a single frame drew. Phase 3 attacks both.

#### Step 3.1 — Only fetch animation clips the player can actually trigger

`loadCharacter()` in `dc-multi.js` requested every clip in a character's manifest entry — up to 3346 clips for some characters — when only 25 are reachable. A `PLAYABLE_LABELS` set (the four locomotion states `chooseAnimation()` selects between, plus every gesture bound to a key) now filters the manifest before a single request is issued. A `console.warn` fires if a character has clips but none carry a playable label, so a manifest regression is visible rather than silent.

| File | Change |
|------|--------|
| `public_html/js/dc-multi.js` | Added `PLAYABLE_LABELS` (idle/walk/run/jump + `GESTURE_ORDER`); `loadCharacter()` filters `ch.animations` against it and logs the reduction; exposed internal `S` state for the unit test |
| `tests/js/dc-multi-animation-filter.test.js` | New — 270 lines covering the filter |

---

#### Step 3.2 — Cap animation clip downloads at four concurrent requests

Even after filtering, ~25 clip fetches were fired in a single tick, competing with the rack/server GLB loads and the inventory JSON on a page whose whole problem is boot time. A `loadClipsPooled()` worker pool bounds this to four requests in flight. The pool preserves the existing mid-load character-switch guard (a late clip must not attach to a different character's mixer) and settles on failure so one bad clip cannot stall the queue.

| File | Change |
|------|--------|
| `public_html/js/dc-multi.js` | Added `loadClipsPooled(clips, cacheBuster, myMixer, limit = 4)`; `loadCharacter()` now delegates to it |
| `tests/js/dc-multi-animation-filter.test.js` | +79 lines covering concurrency bounds |

---

#### Step 3.3 — Make the Mixamo manifest small

The downloader now applies the same playable-label filter when it writes the viewer manifest, so the manifest itself no longer lists thousands of unreachable clips. `VIEWER_PLAYABLE_LABELS` in the Python mirrors `PLAYABLE_LABELS` in `dc-multi.js` — the two must be kept in sync.

| File | Change |
|------|--------|
| `scripts/mixamo_downloader/mixamo_downloader.py` | Added `VIEWER_PLAYABLE_LABELS`; filters `ch["animations"]` when emitting the manifest |
| `scripts/mixamo_downloader/README.md` | Documented the filter |

> **The generator was fixed; the deployed artifact was not.** `public_html/images/3d/mixamo/manifest.json` is currently **20.4 MB** (21,399,171 bytes, `generated_at 2026-08-03T07:25:58-04:00`) with 75,401 clips across 114 characters and up to 3,346 clips on a single character. It was regenerated *after* this fix landed, by something running unfiltered code, and is now **larger** than the 16.4 MB baseline the step set out to eliminate. The acceptance criterion — "under 100 KB and no character has more than 25 clips" — is **not met**, and Phase 3's headline win is not realised until the manifest is regenerated with the current downloader.
>
> Also outstanding: the drift test the step mandated (compare `PLAYABLE_LABELS` in `dc-multi.js` against `VIEWER_PLAYABLE_LABELS` in the Python, so the two lists cannot silently diverge) was never written. The DB already carries two labels — `look` and `type` — that appear in neither list.

---

#### Step 3.4 — Let the browser cache the manifest

The site-wide "application/json expires immediately" rule forced a revalidation round-trip for `manifest.json` on every page load, for a file that only changes when the asset downloader runs. Because `dc-multi.js` appends `?m=<generated_at>` to every asset URL it derives from the manifest, a regenerated manifest changes those URLs anyway — so the manifest is safe to cache.

| File | Change |
|------|--------|
| `public_html/.htaccess` | `<LocationMatch "^/images/3d/mixamo/manifest\.json$">` sets `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` and unsets `Expires` |

> **This was subsequently reverted and is currently inert.** The whole block at `public_html/.htaccess:77-82` is **commented out** — undone by commit `d01e841c44` ("fix", 2026-08-03). The manifest is once again governed by `ExpiresByType application/json "access plus 0 seconds"` at `.htaccess:395`, so every page load still pays a revalidation round-trip.
>
> The step's own verification command (`grep -n "mixamo/manifest" public_html/.htaccess`) passes **vacuously**, because it matches the commented-out line. The likely reason for the revert is that `<LocationMatch>` is not legal in `.htaccess` context — it is a server/vhost-config directive. Re-doing this step needs `<FilesMatch>` (or a vhost-level block), not an uncommenting.

---

#### Step 3.5 — Add a tiny index tier to the datacenter endpoint

`/ajax/datacenter.php` gained `?tier=index`, which returns only what the community layout needs — location name, region, and `{x, y}` per rack — and drops racks' servers, switches and switchports entirely.

| Tier | Contents | Size |
|------|----------|------|
| `full` (default) | locations with racks, servers, switches, switchports | 1.5 MB / 254 KB gzipped |
| `index` (`?tier=index`) | location name, region, `{x, y}` per rack | ~7 KB |

| File | Change |
|------|--------|
| `public_html/ajax/datacenter.php` | Added the `$tier` branch; documented both tiers and all query parameters in the file header |

---

#### Step 3.6 — Make the client use the two-tier fetch

Boot was a single fetch of every location in full. It is now: **tier 1** `?tier=index` for the whole map, then **tier 2** `?location=<id>` for the building the player actually stands in. `mergeLocations()` gained an `isFull` argument and a per-location `_full` flag so an index-tier skeleton can never overwrite a location already held in full detail — and `hasFullData()` now tests `_full` rather than inferring completeness from a non-empty racks map.

This step also closes **F-29**: a failed inventory fetch used to only `console.error`. It now raises a `notice()` toast and rewrites the `#dcLoading` overlay text, so the user sees the failure instead of an empty room.

| File | Change |
|------|--------|
| `public_html/js/dc.js` | Two-tier fetch chain in `loadDatacenter()`; `mergeLocations(data, isFull)` with `_full` guard; `hasFullData()` reads `_full`; user-visible fetch-failure path |
| `tests/js/dc-model-guards.test.js` | Harness updated for the two-tier pattern |

---

#### Step 3.7 — Add an ETag to the datacenter endpoint

`Cache-Control: private, max-age=60` meant every reload after a minute re-transferred the whole payload even though rack inventory changes rarely. A `dc_emit_json()` helper now hashes the fully-built body, sends it as an `ETag`, and answers a matching `If-None-Match` with `304` and no body. Both the index-tier and full-tier exits go through it.

| File | Change |
|------|--------|
| `public_html/ajax/datacenter.php` | Added `dc_emit_json(array $payload): void`; both `echo json_encode(...); exit;` sites replaced with `dc_emit_json($return)` |

---

#### Step 3.8 — Document the assets query index migration

The assets query runs as `type: ALL` — a full scan of ~12,500 rows with `Using temporary; Using filesort`, measured at 91 ms. The existing `rack` index cannot serve it because the WHERE clause casts a `char(2)` column (`cast(unit_start as decimal) > 0`), and a cast is not sargable. The migration is **documented, not applied** — a human must run the DDL, and the `my` database is a three-node writable cluster, so replication to all nodes needs confirming.

| File | Change |
|------|--------|
| `docs/dc_db_index.sql` | New — `ALTER TABLE assets ADD INDEX dc_rack_unit (rack, unit_start);` with the EXPLAIN evidence, the apply command, and the cluster caveat |
| `public_html/ajax/datacenter.php` | Comment pointing at the migration file |

**The real fix, deliberately deferred:** `assets.unit_start` and `assets.unit_end` are `char(2)`. Migrating them to `smallint` removes both casts and makes the predicate sargable. That touches every consumer of those columns, so it needs its own scoped work.

---

### Phase 2 — Dead code

#### Step 2.1 — Delete unused module identifiers

Removed module-level identifiers that were written but never read: `VIEW_OPTS` and `_viewProxy` (left over from a GUI 'View' dropdown that replaced the `#dcViews` button bar and was itself later replaced), `racksShown`, `showServers`, and `S.shadowMapEnabled`. The `_viewProxy.view = name` write in `setView()` went with them.

| File | Change |
|------|--------|
| `public_html/js/dc.js` | −5 lines: `VIEW_OPTS`, `_viewProxy`, `racksShown`, `showServers`, `S.shadowMapEnabled` |
| `tests/js/dc-core.test.js` | −4 lines: assertions on the removed identifiers |

---

#### Step 2.2 — Make the auto quality scaler honest

The quality scaler claimed three tiers but only one did anything. Two problems were fixed:

- **The LOD tier was inert.** `S.lodBias` was documented as "LOD bias offset added to `S.lodBias`" — it was never actually consumed by `updateLOD()`. It is now a real tier that makes LOD switch to low detail sooner.
- **The shadow tier acted on shadows that were switched off.** `_reduceQuality()`/`_upgradeQuality()` resized a shadow map for a renderer with `shadowMap.enabled = false`, so the tier burned its budget doing nothing. Both are now gated behind a new `S.shadowsEnabled` flag, which Phase 6 turns on and Step 6.3 re-enables the tier against.

`_notifyQualityChange()` also stopped spamming a DOM toast for every tier change. It now always logs to `console.info` and only raises the toast for `pixelScale` while it is still above its 0.5 floor.

| File | Change |
|------|--------|
| `public_html/js/dc.js` | `S.shadowsEnabled` added and gated into both quality functions; `S.lodBias` made real in `updateLOD()`; `_notifyQualityChange()` rewritten |
| `tests/js/dc-quality-scaler.test.js` | New — 131 lines |

---

#### Step 2.3 — Delete dead CSS selectors from dc.css

`dc.css` carried 49 lines of three.js-example boilerplate styling elements this page has never contained.

| File | Change |
|------|--------|
| `public_html/css/dc.css` | −49 lines, +6 |

---

#### Step 2.4 — De-duplicate the inline CSS in dc.html

101 lines of inline `<style>` in `dc.html` duplicated or competed with the shared stylesheet. They were moved into `dc-shared.css`, leaving markup as the single source of truth for structure and CSS for presentation.

| File | Change |
|------|--------|
| `public_html/admin/dc.html` | −101 lines of inline `<style>` |
| `public_html/css/dc-shared.css` | +41 lines (the deduplicated survivors) |

---

### Bot Presence System (NEW FEATURE)

When a real user joins DataCenter 3D, a simulated bot avatar is spawned that wanders around the datacenter. When the last real user leaves, the bot is cleaned up.

#### Backend Changes (`Events.php`)

| Function | Description |
|----------|-------------|
| `spawnBotForLocation($location)` | Spawns bot when first user joins a location |
| `moveBot($location)` | 500ms timer moves bot toward random target at 1.2 units/sec |
| `cleanupBotForLocation($location)` | Removes bot when last user leaves |

**Bot client_id format:** `bot_$location`

**Feature Flags:**

| Function | Description |
|----------|-------------|
| `FeatureFlags::dcBotPresenceEnabled()` | Returns true by default; controls enable/disable |
| `setDcBotPresence(false)` | Disable at runtime |
| Enabled/disabled via GlobalData key `dc_bot_presence` | Runtime toggle |

**Implementation Details:**

- Uses `hasRealUsersAtLocation()` to skip broadcasting when no audience
- Proper CAS (compare-and-swap) loops for atomic position updates
- Bot movement: single `sqrt()` per move (not double)
- 2 GlobalData writes per move (not 3)
- Early exit when no real users watching
- Single `lcg_value()` call with anti-correlated coordinates for random target selection

**Tests:** 18 new bot tests added

#### Bug Fixes

| ID | File | Issue | Fix |
|----|------|-------|-----|
| Bot join broadcast | `Events.php` | Bot spawned but not visible on frontend because `spawnBotForLocation` wasn't broadcasting the join event | Added `dc.presence.joined` broadcast to `dc_presence` channel after writing bot presence to GlobalData, ensuring frontend's `onJoined` handler receives the event and creates avatar entries |
| Test coverage | `EventsBotPresenceTest.php` | No test verifying broadcast behavior | Added `testSpawnBotBroadcastsJoinedEvent()` test |

**Tests:** 19 new bot tests added

---

### Phase 6

#### WebGPU Shadow Support Investigation (Step 6.4)

Investigated `PCFSoftShadowMap` support on the WebGPU renderer path in three.js 0.184.0.

**Findings:**

| Renderer path | `PCFSoftShadowMap` support | Implementation |
|---------------|---------------------------|----------------|
| `WebGLRenderer` (classic) | Deprecated → converted to `PCFShadowMap` | `WebGLShadowMap.js` issues console warning and sets `this.type = PCFShadowMap` |
| `WebGPURenderer` (node/TSL) | **Fully supported** | `ShadowNode.js` and `ShadowFilterNode.js` include `PCFSoftShadowFilter` in the `_shadowFilterLib` array; `shadowMap.type` is read by `NodeManager.js` and `Renderer.js` |

**Implication:** The existing `renderer.shadowMap.type = THREE.PCFSoftShadowMap` assignment in `dc.js` works correctly on **both** paths. No `isNode` guard is required.

**Files changed:**

- `public_html/js/dc.js` — added comment explaining WebGPU shadow support
- `docs/dc_renderer_modes.md` — added shadow map type row to the comparison table
- `CHANGELOG-DC.md` — this entry

#### Reduce Shadow Cost by Excluding Unnecessary Casters (Step 6.5)

Optimized shadow rendering by excluding unnecessary shadow casters, reducing GPU cost.

**Shadow Policy:**

| Object type | `castShadow` | `receiveShadow` | Reason |
|-------------|--------------|-----------------|--------|
| Sun core & glow | `false` | `false` | Decorative; directional light drives scene illumination |
| Cables | `false` | `true` | Thin geometry; receive shadows from racks/servers |
| Racks & servers | `true` | `true` | Primary scene objects; cast and receive shadows |

**Changes:**

- `public_html/js/dc.js` — added `applyShadowPolicy(root)` helper; set `castShadow = false, receiveShadow = false` on `sunCore` and `sunGlow` after creation; set `castShadow = false, receiveShadow = true` on all cable meshes (2 sites: async and sync paths)
- `tests/js/dc-shadow-policy.test.js` — new test verifying shadow policy via source-code pattern matching

**Tests:** New shadow policy tests in `tests/js/dc-shadow-policy.test.js`

### Comprehensive Audit Fixes (2026-07-29)

A full code audit was performed across all DataCenter 3D frontend modules (`dc.js`, `dc-ws.js`, `dc-presence.js`, `dc-multi.js`) and the backend Events.php handler. All critical, major, minor, and bug-level fixes have been applied and committed.

#### CRITICAL Fixes

| ID | File | Issue | Fix |
|----|------|-------|-----|
| whenReady timeout | `dc-multi.js` | Callback silently failed after timeout expired | Added error logging after `timeoutMs` (default 15000ms) |
| Event listener cleanup | `dc-multi.js` | `removeEventListener` called without matching `options` object for `{passive:false}` listeners | Cleanup now passes the correct options reference |
| Manifest error logging | `dc-multi.js` | Manifest fetch failures logged as generic warnings | Changed to `console.warn` with descriptive message |
| Backoff cap | `dc-ws.js` | Exponential reconnect delay grew without bound | Capped at 45000ms (30000 base × 1.5 max jitter) |
| DCM exposure reduction | `dc-multi.js` | Debug handle `DCM` exposed unnecessary internals | Reduced to safe subset; removed `loadedCharId` from state |
| Null collider guard | `dc.js` | Null entries in `rackColliders` array caused TypeError | Added null checks before accessing collider properties |
| GlobalData moveBatch | `dc.js` | `moveBatch` not populated causing presence staleness | Fixed initialization and population of batch state |
| dc_active_clients population | `dc.js` | Active clients HUD not updating | Fixed `dc_active_clients` state tracking |
| Health timer race fix | `dc-ws.js` | `_keepaliveTimer` could fire after explicit close | Added `closedByUs` guard and proper timer cleanup |

#### MAJOR Fixes

| ID | File | Issue | Fix |
|----|------|-------|-----|
| Viewport throttle | `dc-ws.js` | Viewport updates sent every frame causing server flooding | Added 100ms pre-throttle + 500ms send throttle |
| visibilitychange flush | `dc-ws.js` | Presence batch not flushed when tab became visible | Flush pending batch on `visibilitychange` to `!hidden` |
| rIC polyfill | `dc.js` | `requestIdleCallback` polyfill passed options object as callback argument | Fixed to pass only the callback; options as second arg |
| Cable cache increase | `dc.js` | Cable geometry cache too small (3 entries) causing frequent rebuilds | Increased `MAX_CABLE_CACHE` from 3 to 8 |
| Name cache validation | `dc-presence.js` | Cache hit path could create duplicate LRU entries | Added `indexOf` check before `push` to prevent duplicates |
| LRU dedup | `dc-presence.js` | Duplicate names polluted `_nameSpriteCacheOrder` array | Check existence before adding; remove+re-add on hit |
| Presence move during load | `dc-multi.js` | Presence moves sent before scene ready were ignored | Queued and sent after `sceneReady` fires |
| GUI cleanup | `dc-multi.js` | GUI state could persist incorrectly after mode switch | Proper cleanup and re-initialization on mode changes |

#### BUG Fixes

| ID | File | Issue | Fix |
|----|------|-------|-----|
| Presence state cleanup | `dc-presence.js` | `dc:auth-failure` left stale presence state | Properly reset all presence state on auth failure |
| dc:respawn docs | `dc-multi.js` | Handler expected `detail.x` and `detail.z` without validation | Added guard checking both coordinates are numbers |
| Character picker repopulation | `dc-multi.js` | Character dropdown not refilled after manifest load | Call `populateCharacterPicker()` after manifest loads |
| First-person camera preservation | `dc-multi.js` | Camera direction reset on re-lock | Track `camPlacedValid` to distinguish re-lock vs new placement |

#### FEATURES

| Feature | File | Description |
|---------|------|-------------|
| `showHelp()` | `dc-multi.js` | Debug method showing 4-second overlay with keyboard controls. Access via `window.DCM.showHelp()` |

#### Configuration Options

| Option | Module | Default | Description |
|--------|--------|---------|-------------|
| `window.DC_WS_ALLOWED_HOSTS` | `dc-ws.js` | `['mystage.interserver.net']` | Array of allowed WebSocket hostnames for `?ws_url` override |
| `window.DC_MANIFEST_URL` | `dc-multi.js` | `/images/3d/mixamo/manifest.json` | URL path to the Mixamo character manifest JSON |

#### Debug Interface

The `window.DCM` object provides debug access to dc-multi state:

```javascript
window.DCM.showHelp()           // Show controls overlay (4s)
window.DCM.getPosition()         // { x, z } player position
window.DCM.getState()            // { mode, spawned, charId }
window.DCM.getLatency()          // WebSocket latency in ms
window.DCM.getConnected()        // Boolean connection status
window.DCM.getViewport()         // Current camera viewport data
window.DCM.setMode('first')      // Switch to first-person
window.DCM.setMode('third')      // Switch to third-person
window.DCM.toggleMode()          // Toggle between modes
window.DCM.gesture('Wave')       // Play named gesture animation
window.DCM.reload()              // Hard-reload the page
window.DCM.getWsState()           // { connected, authenticated, clientId, sessionId, latency, lastPing, lastPong, reconnectAttempts, presenceEnabled }
window.DCM.getPresenceEnabled()  // Boolean presence system status
```

### Bug fixes

| ID | File | Issue | Fix |
|----|------|-------|-----|
| rIC guard | `dc.js` | `requestIdleCallback ?` threw a `ReferenceError` in browsers missing the global, crashing the entire DC module before `window.DC` was assigned | Replaced the bare ternary guard with `typeof requestIdleCallback === 'function'` — evaluates safely with no global required |
| rIC queue | `dc.js` | The polyfill stored only one pending callback in `_ricChannel._cb`; a second call before the first drained silently overwrote the first, losing that deferred merge and its building's cables never appeared | Replaced the single slot with a `_ricQueue` array; `port1.onmessage` now drains all queued callbacks in a try/catch so a throwing callback cannot prevent subsequent ones from running |
| Label deprioritization | `dc.js` | `updateLabels()` set `dePrioritized = true` for labels beyond MAX_LABELS (200) in the distance-sorted order but never cleared it when those labels moved back into the nearest 200 — in a room with 3137 labels that meant every label died within seconds of walking, hidden even at point-blank range | Changed the loop to run over all labels and assign `dePrioritized = (i >= MAX_LABELS)` each frame, so the flag is set correctly in both directions |
| F-02 | `dc.js` | `raycastInstances()` pre-filter checked `mesh.position` to estimate distance, but `mesh.position` is always (0,0,0) on InstancedMesh — the actual instance positions are in the instance matrix. The pre-filter was effectively a no-op. | Changed pre-filter to use `mesh.boundingSphere.center` (transformed to world space via `mesh.matrixWorld`) for the distance check; if `boundingSphere` is null, compute it via `mesh.geometry.computeBoundingSphere()`. Removed unused `_rcTempV`, `_camFwd`, and `_getCameraForward`. |
| F-09 | `dc.js` | `displaySwitches()` cache key was missing `maxTubular`, causing different LOD settings (far/close) to share the same cache entry and produce wrong geometry; also had a spurious `!farFromCables` guard on the cache read site that skipped valid cache hits when the player was far from cables | Added `maxTubular` to the `cacheKey` string so each LOD setting has its own cache entry; moved LOD variables (`camY`, `farFromCables`, `maxTubular`) before `cacheKey` so it can reference them; removed the `!farFromCables &&` guard since the key itself now differentiates |
| F-08 | `dc.js` | `onKeyDown` allowed bare digit keys (1-9) to trigger location jumps, causing accidental navigation when typing in any input field (search, chat, etc.) | Added `&& event.altKey` check to require Alt+digit for location jump; added input-field guard at top of `onKeyDown` to return early when event target is `INPUT`, `TEXTAREA`, or `contenteditable`; `onKeyUp` unchanged (no guard, to prevent stuck movement keys) |
| F-18 | `dc-multi.js` | `onWheel` called `event.preventDefault()` unconditionally, breaking scroll on `.lil-gui`, `.parameters`, `.dc-chat-frame`, `#dcSearchResults`, and other non-canvas UI elements | Added condition: only call `preventDefault()` when `event.target === canvas || document.pointerLockElement === canvas` — exempts all other scrollable targets |
| F-39 | `dc.js` | Pointer lock requested via `controls.lock()` without `unadjustedMovement: true`, getting accelerated pointer data | Changed to `renderer.domElement.requestPointerLock({ unadjustedMovement: true })` with try/catch fallback to `controls.lock()` if browser rejects the option dictionary |
| F-16 | `dc.js` | `animate()` and `tick()` were two separate render paths with subtly different update logic (different idle-skip timing, different guards, `animate()` missing `updateDisco`/door/LOD/GUI updates). The scene would behave differently depending on which was the active loop | Made `animate()` delegate to `tick()` for rendering; added missing `document.hidden` guard, `updateDisco()`, `updateNeighborDoors()`, `updateRoomDoors()`, `updateLOD()`, and `updateGuiPos()` to `animate()` so both loops produce identical results |
| F-15 | `dc-multi.js` | `trySpawn()` disposed all materials in `S.door.group` via `traverse`, including the shared cached `_cachedGlassMaterial` (from `makeGlassMaterial()`) and `_cachedLogoTexture` (from `makeLogoTexture()`). When the player returned to a room and `buildDoor()` was called, the reused cached material had already been disposed, causing doors to render incorrectly or not at all | Added guards in the `traverse` callback: `if (m !== _cachedGlassMaterial) m.dispose()` and `if (m.map && m.map !== _cachedLogoTexture) m.map.dispose()` — the cached singletons are now preserved when cleaning up the door group |
| F-17 | `dc.js` | `setLodFocus()` was called every frame from dc-multi.js and unconditionally reset `_tickSkippedFrames = 0` and `_skipExpensiveUpdates = false`, preventing the idle-skip from ever triggering (counter was always reset before reaching the 18000-frame threshold) | Added position-change check (`Math.abs(x - lodFocus.x) > 0.01 || Math.abs(z - lodFocus.z) > 0.01`) so the idle skip counter only resets when the player has actually moved — idle-skip can now trigger after 5 minutes of real inactivity |
| F-14 | `dc-multi.js` | `loadCharacter()` cleared `S.actions` before cleaning up the old mixer, making it impossible to iterate the old actions for proper `uncacheAction()` cleanup. `stopAllAction()` halts running animations but leaves `AnimationClip` data cached in the mixer, causing a memory leak on every character switch | Preserved the old actions reference before clearing `S.actions`; added a `for (const action of Object.values(oldActions))` loop that calls `S.mixer.uncacheAction(clip)` for each cached action so Three.js releases the clip data |
| F-10 | `dc.js` | Three different places set renderer pixel ratio with three different formulas — `_reduceQuality()`/`_upgradeQuality()` used `Math.min(window.devicePixelRatio * S.pixelScale, 2)`, while `onWindowResize()` and `webglcontextrestored` handler used `Math.min(window.devicePixelRatio, 2)` (ignoring the user's quality scale setting) | Consolidated to ONE canonical formula `Math.min(window.devicePixelRatio * S.pixelScale, 2)` everywhere — all four call sites now respect the `S.pixelScale` quality multiplier |

---

### Test Infrastructure (2026-08-02)

The three.js test stub (`tests/js/__mocks__/three.js`) was updated so that stub methods compute correct mathematical values instead of silently returning `this`. Previously, no-op stubs allowed tests to pass even when the code under test produced mathematically wrong results — the assertions never caught the error because the mock never changed.

**What was fixed:**

| Method | Before | After |
|--------|--------|-------|
| `Vector3.addScaledVector(v, s)` | No-op: returned `this` | Adds `v × s` to each component |
| `Vector3.normalize()` | No-op: returned `this` | Divides by vector length |
| `Vector3.lerp(v, alpha)` | No-op: returned `this` | Linear interpolation toward `v` |
| `Euler.setFromQuaternion(q, order)` | No-op: returned `this` | Computes Euler angles from quaternion |
| `Box3.setFromObject(object)` | No-op: always returned unit box (0,0,0)–(1,1,1) | Reads `userData.__testBounds` when provided |
| `DoubleSide` | `undefined` | Exports `2` (real Three.js value) |

**Why it matters:** Camera smooth-follow tests passed because `lerp` never moved the vector — the target was already at its final value so the test assertion passed against the unchanging mock. `setFromQuaternion` returned y=0 for every quaternion, so camera yaw assertions compared against a fake zero. `Box3.setFromObject` always reported 1-unit-tall models, so auto-scale code paths that handle non-unit heights were never exercised. `DoubleSide` was `undefined` under test, so `side: THREE.DoubleSide` was falsy and double-sided rendering was never actually verified.

**Rule added:** `.claude/rules/js-tests.md` now states that stub methods must compute correct values or throw — never silently return `this`.

The orphaned `ws_terminal.test.js` and `ws_vmstat.test.js` (using `node:test`) were renamed to `dc-ws-terminal.test.js` and `dc-ws-vmstat.test.js` and converted to Vitest format, bringing them into the vitest suite.

#### `dc-core.test.js` rewrite

`tests/js/dc-core.test.js` was completely rewritten. The old file re-implemented every function it tested locally — copies of `convertRackCoordinatesToPosition`, `makeRng`, `escapeHtml`, etc. declared afresh inside the test file. That pattern is a maintenance hazard: the copies can silently diverge from the real implementations in `public_html/js/dc.js` and the tests would still pass.

The new file slices each function directly from the real `dc.js` source at runtime using a column-0-anchored regex extractor (the same technique already used by `dc-model-guards.test.js`). The extractor throws if the declaration is renamed or removed, so a rename in `dc.js` fails loudly in CI instead of silently testing nothing. Eight pure-logic helpers are now covered: `convertRackCoordinatesToPosition`, `convertServerCoordinatesToPosition`, `eyeHeight`, `playerRadius`, `makeRng`, `escapeHtml`, `distToRect`, `glbVariantUrl`. The `loadDcJs` loader that produced the redundant copies is deleted.

**Why it matters:** A future refactor that renames `eyeHeight()` to `getEyeHeight()` in `dc.js` without updating the test will now cause the test suite to fail immediately, not after the next release when someone notices the old name still passes.

#### `dc-fixes.test.js` — delete re-implementation tests

`tests/js/dc-fixes.test.js` was trimmed from 726 lines to 63. The old file contained re-implementation copies of every function it tested — local copies of `send`, `on`, `off`, `emit`, and helpers like `throttle` declared afresh inside the test file. Those tests asserted the copy against itself, so they passed even when the real source was completely broken.

The new file keeps only source-text assertion tests (guarding contracts that must not silently drift) and one multi-tab presence test that reads `dc-presence.js` and `dc-ws.js` directly. The "RULE" comment that permitted re-implementation has been replaced with an explicit anti-pattern warning: **never re-implement the logic under test in the test file itself**. The old rule was self-contradictory — it banned re-implementation while the file was full of it.

**What was deleted:** ~660 lines of tests that re-implemented `dc-ws.js` send/receive/presence logic and `dc-presence.js` LRU/name-cache logic locally.

---

### Debugging & Graceful Degradation

#### Console Debug Logs (when `DC_DEBUG` enabled)

The WebSocket module (`dc-ws.js`) and presence module (`dc-presence.js`) emit structured debug logs prefixed with `[dc-ws]` and `[dc-presence]` for troubleshooting connection issues and presence state:

| Log Message | Module | Description |
|-------------|--------|-------------|
| `[dc-ws] Connecting to {url} (attempt {n})` | dc-ws.js | WebSocket connection attempt started |
| `[dc-ws] Connected. Session: {sessionId}` | dc-ws.js | Successful connection established |
| `[dc-ws] Connection closed. Code: {code}, Reason: {reason}` | dc-ws.js | Connection terminated |
| `[dc-ws] >>> {op} {data}` | dc-ws.js | Outgoing message (truncated for display) |
| `[dc-ws] <<< {op} {data}` | dc-ws.js | Incoming message (truncated for display) |
| `[dc-ws] Remote avatar {name} moved to ({x}, {z})` | dc-ws.js | Remote player position update |
| `[dc-ws] {name} joined (client {clientId})` | dc-ws.js | Player joined the session |
| `[dc-ws] {name} left` | dc-ws.js | Player left the session |
| `[dc-ws] Flushing {count} presence updates` | dc-ws.js | Presence batch flushed |
| `[dc-ws] Batch throttled, {count} pending (500ms timeout)` | dc-ws.js | Throttle active, updates queued |
| `[dc-presence] WS not connected, {op} skipped` | dc-presence.js | Graceful degradation active |

#### Graceful Degradation

When the WebSocket connection fails to establish, the presence system degrades gracefully to allow single-player operation to continue without interruption:

- `DC_PRESENCE_ENABLED` is set to `false` upon connection failure
- All presence operations (`dc:presence.move`, `dc:presence.join`, `dc:presence.leave`) become no-ops
- The datacenter 3D scene remains fully functional in single-player mode
- Users can retry connection by reloading the page or via the Debug API

Presence functions check `DC_PRESENCE_ENABLED` before performing any operations, ensuring that no errors are thrown when WebSocket is unavailable.

#### Extended Debug API

The `window.DCM` debug interface has been extended with WebSocket state introspection:

```javascript
window.DCM.getWsState()    // Returns detailed WebSocket state object:
                           // {
                           //   connected: boolean,        // WebSocket connection status
                           //   authenticated: boolean,   // Session authenticated
                           //   clientId: string|null,    // Assigned client ID
                           //   sessionId: string|null,  // Current session ID
                           //   latency: number,          // Last measured latency in ms
                           //   lastPing: number|null,    // Timestamp of last ping sent
                           //   lastPong: number|null,    // Timestamp of last pong received
                           //   reconnectAttempts: number, // Current reconnection attempt count
                           //   presenceEnabled: boolean  // Presence system enabled
                           // }

window.DCM.getPresenceEnabled()  // Returns boolean indicating if presence system is active
```

---

## 2026

### July 2026

##### Commit xxxxxxxx (2026-07-29)
**feat(dc-chat): transparent chat frame overlay with NOC channel integration**

**What was done:** Added a new `dc-chat.js` module providing a floating chat widget in the bottom-left corner of the datacenter 3D scene. The module connects to the NOC chat channel (`chat:noc`) via the existing DC_WS WebSocket connection.

**Features:**
- Semi-transparent dark chat frame (320x420px) in bottom-left viewport corner
- Rolling 20-message buffer with auto-scroll to newest
- Input area revealed on hover, hidden on mouse-leave
- WebSocket integration via existing `DC_WS` global (listens for `dc:auth-success`)
- Auto-joins channel `chat:noc` on successful authentication
- Sends messages via `channel.publish` op
- Handles `channel.message` and `chat.message` incoming events
- Local `/status` command returns synthetic status response (client count, timestamp, channel count)
- System/info/warn/error messages styled distinctly

**New `/status` Command Handler (`Events.php`):**
- New private method `handleStatusCommand($client_id, $re, $channel, $level)` in `Events.php`
- Returns system status info to the requesting client only (not broadcast to the channel)
- Gathers: connected WebSocket client count, current timestamp, and number of active channels from the `channel_meta` registry
- Intercepts `/status` messages before they are persisted or broadcast

**Files Changed:**
| File | Change |
|------|--------|
| `public_html/js/dc-chat.js` | New module — transparent chat frame, bottom-left overlay |
| `public_html/js/dc-chat.js` | `init()` — boot module on DOMContentLoaded |
| `public_html/js/dc-chat.js` | `sendMessage(text)` — publish to chat:noc, intercept `/status` locally |
| `public_html/js/dc-chat.js` | `addMessage(msg)` — insert synthetic message into local buffer |
| `public_html/js/dc-chat.js` | `clearMessages()` — wipe visible log and in-memory buffer |
| `public_html/js/dc-chat.js` | `destroy()` — tear down module and release resources |
| `dc.html` | Added `<script src="/js/dc-chat.js">` for single-player entry point |
| `dc.php` | Added `<script src="/js/dc-chat.js">` for multi-user entry point |
| `/home/sites/datacentered/Applications/Chat/Events.php` | New `handleStatusCommand()` method for `/status` command handling |

**Why it matters:** Provides real-time NOC chat capability directly within the datacenter 3D walkthrough, allowing operations staff to communicate without leaving the visualization. The `/status` command gives quick system health visibility. The transparent overlay design maintains the immersive 3D experience while keeping chat accessible.

---

##### Commit 0a5e571f50 (2026-07-28)
**fix(dc): restore the missing renderer.render() that froze the walkthrough**

**What was done:** The core issue was that `DC.tick()` had lost its `renderer.render(scene, camera)` call during a prior refactor (`07bd751aed` — "full 3D scene re-audit"). That refactor moved `updateGuiPos()` out of the idle-skip branch and inadvertently dropped the draw call from the main rendering path. The only surviving `render()` call was trapped inside `if (_skipExpensiveUpdates)` — an early-return branch that effectively never executes because `dc-multi.js` calls `setLodFocus()` every frame, which clears the `_skipExpensiveUpdates` flag before the idle threshold is ever reached.

The result: `dc-multi.js` delegates its entire frame to `DC.tick()` ("...and the actual render"), so once the third-person overlay took over the animation loop, the canvas stopped repainting entirely. The scene froze on the last frame `animate()` had drawn while everything else kept running invisibly — pointer lock engaged, the overlay cleared, view/location buttons moved the camera, the character swapped, doors built themselves. Nothing was visible. `stats.update()` reported a healthy 60fps because it measures tick rate, not draw rate.

The fix restores `renderer.render(scene, camera)` at the end of `DC.tick()` (`public_html/js/dc.js:3359`), which is the canonical render call for the shared scene. This was also accompanied by numerous secondary fixes discovered while tracking down the freeze.

**Why it matters:** The scene was completely broken for any user who loaded a datacenter, waited for the character model to finish streaming, and then clicked to enter the third-person walkthrough. The freeze happened silently — no error, no crash — so it appeared the click had no effect. This fix restores actual scene rendering in the multi-player walkthrough mode, prevents invisible state mutations, and fixes an FPS reporting illusion.

---

##### Commit a961031035 (2026-07-28)
**udpate**

**What was done:** Added a new shared CSS file `public_html/css/dc-shared.css` containing all the common UI styling for the datacenter 3D scene interface. This file was created to consolidate styles that are shared across both the standalone `dc.html` and the multi-user `dc.php` variants of the datacenter viewer. The 62-line file defines styles for search box, info panels, location buttons, view buttons, player HUD, presence indicators, GUI sliders, and fade effects.

**Why it matters:** Before this commit, UI styles were likely duplicated or scattered across variant-specific stylesheets. Creating a dedicated shared stylesheet provides a single source of truth for datacenter UI appearance, consistent UX across `dc.html` (single-player) and `dc.php` (multi-user), and improved maintainability — one change propagates to both variants.

---

##### Commit bc62faa0c9 (2026-07-28)
**fix(dc-ws.js): CRIT-2, MAJOR-7, MINOR-12/13/14**

**What was done:** Five bugs were fixed in the WebSocket client module (`dc-ws.js`), ranging from a critical security validation issue to several reliability and robustness improvements. CRIT-2 added WebSocket URL protocol validation (`wss://` required) and hostname allowlist checking before accepting overrides. MAJOR-7 fixed cancel pending RAF before early return in send(), preventing duplicate flushes and race conditions. MINOR-12 added console.warn logging for JSON.parse failures for debugging. MINOR-13 changed to `typeof crypto.randomUUID === 'function'` check for browser compatibility. MINOR-14 made destroy() unconditionally flush the pending presence batch before cleanup.

**Why it matters:** The `dc-ws.js` module is the real-time communication backbone of the datacenter 3D scene. These fixes address: security (preventing arbitrary WebSocket server injection via URL parameter), correctness (preventing duplicate/missed presence updates from orphaned RAF callbacks), debuggability (making JSON parse failures visible), compatibility (graceful fallback for `crypto.randomUUID`), and data integrity (ensuring no presence updates are lost during module cleanup).

---

##### Commit c18ead8805 (2026-07-28)
**fix(dc-multi.js): MAJOR-6, MAJOR-9**

**What was done:** Two significant bugs were fixed in the multi-player presence and player spawning module (`dc-multi.js`). MAJOR-6 changed from nullifying `DC_PRESENCE_JOIN` on disconnect to using a `DC_PRESENCE_ENABLED` boolean flag, allowing seamless reconnection without permanent callback destruction. MAJOR-9 added optional `x`, `z`, and `facing` parameters to `trySpawn()` for context-loss state recovery, restoring players to their exact pre-crash position instead of the spawn point when WebGL context is restored.

**Why it matters:** The `dc-multi.js` module manages the 3D player character, their position in the scene, and their presence broadcast to other players. These fixes address reconnection reliability (players can seamlessly rejoin after temporary network drops) and context loss recovery (player is restored to exact pre-crash position after GPU/WebGL context loss, preserving their location relative to other entities).

---

##### Commit 688ff0a24f (2026-07-28)
**fix(dc.html, dc.php): CRIT-1, MAJOR-18, MAJOR-20**

**What was done:** Three separate fixes were applied across `dc.html` and `dc.php`. CRIT-1 removed an XSS-vulnerable inline script from `dc.html` that set `window.DC_*` globals without sanitization — session values could be injected raw. Session globals are now exclusively set in `dc.php` using proper `htmlspecialchars()` for strings and `(int)` for integers. MAJOR-18 added missing presence indicator DOM elements (`#dcPresence`, `#dcPresenceDot`, `#dcPresenceLabel`, `#dcPresenceCount`) to `dc.php`. MAJOR-20 replaced ~55 lines of inline `<style>` in `dc.php` with a link to the shared `dc-shared.css` stylesheet, eliminating CSS duplication between the two entry points.

**Why it matters:** CRIT-1 closes a critical cross-site scripting attack surface — users with special characters in their account_lid could have those injected into `window.DC_USER_NAME` raw and potentially exploited. MAJOR-18 enables the user-count presence indicator for multi-user awareness. MAJOR-20 eliminates CSS duplication, reducing maintenance burden and preventing the two UIs from drifting apart.

---

##### Commit 8dc01a1a06 (2026-07-28)
**fix(dc-presence.js): evict name sprite cache entry on name change**

**What was done:** When a remote user's name changed mid-session (e.g., an admin renamed their session or switched accounts), the existing code correctly updated `remoteEntry.name` but never evicted the old entry from the `_nameSpriteCache`. This caused nameplates to display stale names indefinitely. The fix adds explicit eviction at `dc-presence.js:617–629` that runs before the name field is updated: removes the sprite from the scene, frees GPU memory (disposes canvas texture and material), deletes the cache map entry, and cleans the LRU order list.

**Why it matters:** Remote users' nameplates now always reflect their current display name. Without this fix, any name change mid-session was silently invisible to all other users. Additionally, the old sprite and its GPU resources were previously orphaned — over many renames this would cause a slow GPU memory leak. The eviction properly disposes both before removal.

---

##### Commit 45c1054e7f (2026-07-28)
**fix(dc.js): CRIT-12, MAJOR-2/3/8, MINOR-5/6/7**

**What was done:** This commit addresses 7 bugs in `public_html/js/dc.js` — spanning critical crash fixes, algorithmic performance improvements, and cleanup of resource leaks. CRIT-12 moved `_labelTextureCache` from function-scoped to module scope, fixing a ReferenceError on `clearScene()`. MAJOR-2 replaced O(n) array+includes with O(1) Set for collision deduplication. MAJOR-3 replaced O(n) `Array.shift()` with a fixed-size ring buffer for FPS history. MAJOR-8 fixed the `requestIdleCallback` polyfill — `setTimeout` was incorrectly receiving an options object as the callback argument. MINOR-5 added `detachKeyHandlers()` in `clearScene()` to prevent ghost keyboard events. MINOR-6 gated FPS tracking by `!_skipExpensiveUpdates`. MINOR-7 documented the uncached `makeLostCatTexture()` and `makeCalendarTexture()` as known perf debt.

**Why it matters:** CRIT-12 was a crash preventing scene switching entirely. MAJOR-2 directly affects walking performance by reducing collision detection from O(n²) to O(n). MAJOR-3 meaningfully reduces CPU burn at 60fps. MAJOR-8 fixed idle callbacks that fired immediately instead of after 2s delay, causing cable geometry merges to block the render thread.

---

##### Commit 87b0b33e0e (2026-07-27)
**fix: G1 audit fixes + selected ideas for 3D datacenter browser**

**What was done:** This commit introduces both critical bug fixes from a G1 code audit and selected feature ideas (prefixed G1-N) for the 3D datacenter browser, touching 5 files. Critical fixes include: LRU off-by-one fix in `dc-presence.js` (cache grew beyond limit causing OOM for long sessions), texture disposal on eviction (GPU memory leaked every cache eviction), auto-send `dc.presence.leave` on disconnect (ghost player sprites persisted), `_labelTextureCache` disposal in `clearScene()` (GPU memory leaked on scene switch), idle frame counter fix (idle skip was permanent — expensive ops never resumed), cable geometry cache bounded with LRU eviction (unbounded memory growth), and `setTimeout` fallback for presence RAF when tab hidden (presence froze for backgrounded tabs). G1 ideas include: neighbor cable meshes with `frustumCulled = false`, 'R' key to reset player position, GPU memory HUD via `renderer.info`, `AbortController` for `fetchTemps` cancellation, smooth cable geometry LOD interpolation, and OffscreenCanvas worker for heatmap rendering.

**Why it matters:** This commit addresses multiple critical memory leak and stability issues discovered during a G1 audit while simultaneously implementing feature improvements. Long sessions without these fixes would eventually exhaust GPU memory, disconnected players would appear as ghost sprites, and backgrounded browser tabs would cause presence updates to stall indefinitely.

---

##### Commit c49e05688a (2026-07-27)
**3D datacenter browser JS: IDEA-1/2/4/5/6/7/8 + MAJOR/MINOR/BUG fixes**

**What was done:** A massive multipurpose commit spanning 5 files (~430 lines changed) delivering 8 named feature implementations alongside critical/major/minor/bug fixes. IDEA-1 introduced presence move batching via `_presenceBatch` array and RAF-flushed sends to prevent flooding the server with 60fps movement updates. IDEA-2 added WebGL context loss/restore handlers with full state backup and scene rebuild. IDEA-4 implemented cable LOD (caps tubularSegments at 40 when camera Y > 25 for overview mode). IDEA-5 added number keys 1–9 for instant location switching. IDEA-6 implemented `MAX_LABELS = 200` cap with distance-based prioritization. IDEA-7 added latency tracking via `window.DC_LATENCY` and rolling ping history. IDEA-8 implemented progressive cable loading using `requestIdleCallback` with 2s fallback for scenes with 150+ cable tubes. Critical/major/minor fixes addressed sprite orphaning on LRU eviction, throttle per-client move broadcast, reconnect delay formula, stale ping detection, and viewport tracking.

**Why it matters:** The datacenter 3D scene is a real-time collaborative environment. Without batching, each player's 60fps movement would generate 60 WebSocket frames per second. Context loss recovery ensures graceful survival of GPU driver resets. Cable LOD and label caps prevent GPU overload in complex scenes. Number-key navigation and progressive loading make the interface more responsive.

---

##### Commit fac2630673 (2026-07-27)
**feat(dc): move interpolation + velocity prediction in tickAvatars**

**What was done:** Refactored `tickAvatars()` in `dc-presence.js` to implement time-aware velocity tracking, interpolation, and prediction for remote avatar movement. Previously, remote avatars moved via simple linear interpolation causing visible "rubber-banding" when network updates arrived infrequently. The new system: computes velocity per avatar from position delta per time; uses timestamp-based lerp factor (faster when updates are frequent, slower when sparse); applies velocity extrapolation/_prediction up to 300ms ahead; lerps yaw (facing direction) with proper `[-π, π]` normalization; gracefully falls back to simple lerp when server doesn't send timestamps.

**Why it matters:** In a multi-user 3D scene, network latency causes visible lag between when a user moves and when their avatar appears to move for others. Simple lerp causes avatars to "snap" or "rubber-band" when updates are infrequent. Velocity prediction makes avatars appear to move continuously even between network updates by extrapolating along their current velocity vector. The 300ms prediction window is short enough to be unnoticeable when the next update arrives but long enough to bridge typical network jitter.

---

### June 2026

All Phase 2–8 commits below were part of a major performance and feature revamp on **2026-06-03**, delivering a complete rewrite of the datacenter 3D walkthrough rendering engine.

#### Phase 2-8 Walkthrough Improvements (June 2026)

The following 9 commits represent a coordinated multi-phase effort to transform the datacenter 3D scene from a slow (~9 FPS), resource-leaking prototype into a high-performance (~60 FPS), GPU-efficient, feature-complete visualization:

---

##### Commit 6c6d7eb441 (2026-06-03)
**dc 3d walkthrough phase 8: remove dead code + graceful loading indicator**

**What was done:** This cleanup pass removed orphaned functions and imports from earlier phased rewrites (Phases 4–5), added a visible loading overlay to the admin UI, and eliminated a redundant database handle in the PHP AJAX endpoint. In `dc.js`, three functions (`disposeObject`, `disposeMaterial`, `setLabelsVisible`) were deleted entirely — they date from earlier phases where manual 3D object disposal was needed, but the current architecture uses self-disposing Three.js instances. Two imports were also removed: `SkeletonUtils` and a commented-out `ColladaLoader`. In `datacenter.php`, the unused `$db2` database handle opened with a second `get_module_db('servers')` call was deleted; an earlier N+1 query fix had already consolidated to a single handle. The admin HTML shell gained a `#dcLoading` fixed-position overlay with a "Loading datacenter…" message hidden via JavaScript once `loadDatacenter()` successfully completes its first fetch → display chain.

**Why it matters:** Users now see explicit feedback during the GLB model load phase instead of a blank screen. Removing dead code reduces JavaScript bundle size and eliminates dead code paths that just confuse future developers. The `$db2` removal fixes a resource leak where a second database connection was opened and never closed.

---

##### Commit 4bcd9591f2 (2026-06-03)
**dc 3d cabling + labels + views: group routing, colours, gloss, sag, highlight fit**

**What was done:** This Phase 7 continuation added structured cable routing, cable physics (sag and corner fillets), per-cable color and spread, glossy tube materials, label quality improvements, dynamic highlight box sizing, preset camera views, and click-to-walk interaction.

**Group-Based Inter-Rack Routing:** Racks are grouped into contiguous runs within each row. Cables between racks in the same group take a short local path. Cables between different groups trunk across to the nearest end of each group before traveling along overhead tray — mirroring real-world structured cabling.

**Cable Physics:** `makeRng(seed)` provides deterministic per-cable pseudo-RNG for stable sag. `pushCableSag()` adds 1–4 "hump" waypoints on long runs (>9 world units horizontal) creating realistic cable droop. `cableCurvePoints()` also adds rounded fillets at corners using `FILLET = min(1.6, 45% of shorter adjacent segment)`.

**Visual Quality:** Cables use `MeshPhysicalMaterial` (roughness 0.6, clearcoat 0.6) for slight gloss. Color palette expanded to 10 entries (6 blue, 3 yellow, 1 green). Per-cable spread offset prevents "spaghetti collapse" where all cables in a bundle follow identical waypoints.

**Label Quality:** Canvas supersampled 3× (320×32 → 960×96), font changed to Verdana, fit-to-width scaling prevents long hostnames from clipping.

**Look-Highlight Box Sizing:** `extractModelMeshes()` now returns bounding box data used by `updateHighlight()` to correctly size highlight boxes for 1U patch panels vs. 3U full racks.

**Preset Camera Views:** Five named views (overview, top, aisle, cables, labels) via `viewPreset()` and `setView()` with fly-to animation. HTML `#dcViews` button bar wires to these.

**Click-to-Walk:** Renderer click handler changed from "click always shows info" to "click locks pointer and starts walk; click again shows info."

**Why it matters:** Realistic cable routing makes the visualization credible for real-world datacenter planning. Cable sag and spread give each cable a distinct appearance rather than a flat spaghetti mess. Preset views let non-technical users quickly navigate meaningful perspectives. Click-to-walk makes first-person exploration intuitive.

---

##### Commit 824b0a78c9 (2026-06-03)
**dc 3d cabling: 3d matte tube cables, structured routing, multi-colour**

**What was done:** Replaced flat 2D `LineSegments` (1-pixel coloured lines) with fully 3D rounded tube geometry using `THREE.TubeGeometry` with 6-sided cross-section, rendered with `MeshStandardMaterial` (roughness 0.85, metalness 0.0 = matte plastic look). All individual tube geometries are merged via `BufferGeometryUtils.mergeGeometries()` into a **single merged mesh** — all cables render in **one draw call**. Cable routing was implemented with structured waypoints following real-world structured cabling paths: exit the back of the switch, go to the side cable channel, up to the overhead tray, across to the destination row, down to the destination rack, and into the asset.

**Same-rack optimisation:** Cables connecting a switch to a server in the same rack take a short local path without overhead tray trip.

**Per-cable lane offset:** Within a rack bundle, each cable takes a slightly different lane via `lane = ((portNumber % 12) - 6) * 0.08` so cables fan out and read as a bundle.

**Why it matters:** Real structured cabling doesn't float in mid-air — it exits equipment backs, routes through cable management channels, goes overhead between rows, and drops down at the destination. Merging all cable geometry into one mesh means the GPU handles all ~414,000 cable triangles in a single draw call, sustaining 60fps.

---

##### Commit d672dc4d65 (2026-06-03)
**dc 3d walkthrough phase 3: meshopt compression + immutable model caching**

**What was done:** Introduced geometry-level mesh compression via `EXT_meshopt_compression` extension and aggressive browser-cache headers for all 3D model assets, creating a tiered loader cascade: meshopt (best, requires client-side WASM decode) → webp-simplify (decimated geometry + webp textures) → plain (original full model). A new build script `scripts/optimize-3d-models.sh` runs `@gltf-transform/cli`'s `meshopt` command over every `webp-simplify/*.glb` file, writing compressed variants to a sibling `meshopt/` directory.

HTTP caching was enhanced via `.htaccess`: `Cache-Control: public, max-age=31536000, immutable` with `ETag unset` for `.glb/.gltf/.ktx2/.drc/.bin` files. The `immutable` directive means browsers never revalidate — a second visit costs zero network round-trips.

**Why it matters:** Loc 4's GLB payload went from 2.69 MB (plain) → 0.74 MB (meshopt) = 3.6× total reduction. GPU upload is faster since meshopt compresses geometry in a GPU-friendly way. Repeat visits are essentially instant since all model assets are served from browser cache.

---

##### Commit a0ae180b6c (2026-06-03)
**dc 3d walkthrough phase 2 cheap wins**

**What was done:** High-impact, zero-architecture-change optimizations: (1) wired up pre-existing `webp-simplify/` GLB model variants (already on disk but never used), dropping draw calls 2.8× (12,780 → ~4,600) and triangles from 3.74M → ~1.5M; (2) vendored Three.js and lil-gui locally, eliminating 9 external CDN requests (~2.26 MB); (3) modernized Three.js API (`THREE.Clock` → `THREE.Timer`, `requestAnimationFrame` → `renderer.setAnimationLoop`); (4) fixed a GPU memory leak in `clearScene()` that was growing +871 geometries and +404 textures per scene rebuild; (5) capped pixel ratio at 2 to prevent Retina/HiDPI screens from doing 4× raster work; (6) converted UI toggles (labels, network, first-person) from full `displayDatacenter()` rebuilds (~1.46 s) to instant `.visible` flips.

**Why it matters:** 2.8× FPS improvement (9→25 fps idle), eliminated GPU memory leak (stable across unlimited location switches), zero external CDN dependency, instant UI toggles. These were the quick wins before the deeper architectural changes in Phases 3–8.

---

##### Commit f8bd7b6019 (2026-06-03)
**dc 3d walkthrough phase 4: InstancedMesh renderer + merged network lines**

**What was done:** Replaced per-object `SkeletonUtils.clone()` rendering — where every rack and server was an individual cloned mesh — with **THREE.InstancedMesh per sub-mesh per model type**. For loc 4, 9 model types decompose into ~90 sub-meshes → 90 InstancedMeshes = ~90 draw calls (12× reduction from ~1,110). The 1,704 individual switchport network lines were collapsed into a single `THREE.LineSegments` geometry (1 draw call).

**Why it matters:** GPU renderers are bottlenecked by draw call count. InstancedMesh submits ALL instances of a sub-mesh in a single draw call. The memory leak in `clearScene()` was also fixed — objects were removed but never disposed, causing linear GPU memory growth.

---

##### Commit 42cbf906cc (2026-06-03)
**dc 3d walkthrough phase 5: billboarding sprite labels, lazy + distance-culled**

**What was done:** Replaced per-label `PlaneGeometry` + `Mesh` + `CanvasTexture` pattern (one draw call per label) with **THREE.Sprite** objects that auto-billboard and a lazy-build + per-frame distance-cull system. Labels only construct their canvas texture when within 40 world units of the camera. Draw calls dropped from 12,780 → ~100 (128× reduction).

**Why it matters:** The previous label system created a separate draw call per label mesh, which caused severe GPU contention. Now only ~8 labels within 40 units are rendered at any time, with zero FPS impact during normal navigation.

---

##### Commit 9c26ba8eb5 (2026-06-03)
**dc 3d walkthrough phase 6: per-location data endpoint + gzip + N+1 fix**

**What was done:** (1) Added `?location=<id>` query parameter to `datacenter.php` so only the requested location's data is returned instead of all locations. (2) gzip compression via `ob_gzhandler` reducing wire size ~6× (1.47 MB → ~234 KB). (3) Fixed N+1 switchport query — previously one database round-trip per switch, now a single batched query for all switches. (4) On-demand location loading with in-memory caching so switching back and forth is instant.

**Why it matters:** Location 4's payload went from 1.47 MB (all locations, uncompressed) → 47 KB gzipped (single location). 31× reduction in wire size. Once fetched, location switching is instant (no re-fetch). Database round-trips reduced from O(switches) to O(1).

---

##### Commit 31a3d988e0 (2026-06-03)
**dc 3d walkthrough phase 7: interaction (look-highlight, click-info, search, fly-to, collision)**

**What was done:** Introduced the full user interaction layer: (1) Raycasting system using `THREE.Raycaster` from camera center against all InstancedMesh objects with parallel arrays (`userData.assetIds`, `userData.assetData`) mapping instanceId to actual rack/server objects. (2) Look-highlight: yellow wireframe box positioned over the rack/server at screen center, updating every 4th frame. (3) Click-to-info panel showing hostname and deep-link to admin asset form. (4) Search + fly-to: `searchServers(query)` performs substring match, `flyToServer()` glides camera to target with smoothstep easing. (5) Collision detection wired into `updateControls()` gated by `collisionMovement` toggle.

**Why it matters:** Users can now find and inspect specific servers by typing a hostname and flying directly to it. Look-highlight provides constant spatial awareness. Click-to-info gives immediate asset context. Collision prevents wall-clipping during walkthrough.

---

## 2025

### April 2025

##### Commit c8c67a0a35 (2025-04-16)
**Updated paths for datacenter AJAX handler**

**What was done:** Fixed two broken import paths after the AJAX endpoint was relocated. In `public_html/ajax/datacenter.php`, the `require_once` path for `functions.inc.php` was corrected from `../include/` to `../../include/` (the AJAX file now sits one directory deeper). In `public_html/js/dc.js`, the `fetch()` URL was updated from `/ajax_datacenter.php` to `/ajax/datacenter.php`.

**Why it matters:** These were blocking issues — without the path fixes, the 3D scene would receive 404 errors and never populate rack labels, switch positions, or location data. The datacenter 3D page now successfully loads data on every view.

---

## 2024

### May 2024

##### Commit d9e4bbacd0 (2024-05-21)
**Integrated PointerLockControls and FirstPersonControls for 3D navigation**

**What was done:** Added the ability to switch between two 3D navigation control systems. When `useFirstPerson: false` (default), uses `PointerLockControls` (click to lock mouse, ESC to unlock). When `useFirstPerson: true`, uses `FirstPersonControls` (no pointer lock needed, mouse freely moves camera). A `THREE.Clock()` called `clock` tracks elapsed time for `FirstPersonControls.update(delta)`. The `updateControls()` function was refactored to use `camera.position.y` directly instead of `controlObject.position.y`.

**Why it matters:** PointerLockControls can be disorienting for some users (requires clicking to capture mouse, ESC to release). FirstPersonControls offers a more traditional FPS-style experience without cursor capture. Power users can choose their preferred navigation style based on task.

---

##### Commit f4bab656e3 (2024-05-21)
**Organized options structure and added toggle controls to enable/disable labels and network displays**

**What was done:** Added `showLabels: true` and `showNetwork: true` boolean options. Extracted GUI setup into `displayGui()` and datacenter display into `displayDatacenter()`. Restructured lil-gui into three folders (Display, Sizing, Movement). Added early-return guards in `displayRackText()`, `displayServerText()`, and `displaySwitches()`.

**Why it matters:** Users can now toggle off distracting labels or network lines to get a cleaner view. Separating `displayGui()` and `displayDatacenter()` makes the code more maintainable. The folder organization improves usability for the control panel.

---

##### Commit 4a76f563a3 (2024-05-21)
**Added network cables running from switch ports to servers, with labels displayed on each switch**

**What was done:** Introduced network cable visualization rendering physical cable connections from switch ports to destination servers. Backend (`ajax_datacenter.php`) expanded switch query to include `ports` field and nested `switchports` query. Frontend (`dc.js`) added `displaySwitches()` drawing 3D `THREE.Line` geometry between switch port and server positions using a 4-point polyline routing. Added `displayText()` for canvas-based labels and two coordinate conversion helpers (`convertRackCoordinatesToPosition`, `convertServerCoordinatesToPosition`). Shadow casting enabled on all models.

**Why it matters:** Cable visualization gives administrators a visual map of network connectivity — which server is plugged into which switch port — essential for troubleshooting connectivity issues and planning cable migrations.

---

##### Commit 6baf8a47e3 (2024-05-21)
**Added rack label display to the 3D datacenter view**

**What was done:** Added floating text labels above each rack displaying the human-readable rack name (e.g., "Rack A1"). Backend updated to select `rack_name as name`. Frontend added `rackLabels` key to `objects`, `displayRackText()` function positioning labels at `x - 2.5, 19.5, z + 4.2` (above the ~19-unit-tall rack). Server labels continue to use `x + 3.5, y + 0.25, z + 0.2`.

**Why it matters:** Rack names are more recognizable to datacenter administrators than numeric rack IDs. Labels help users orient themselves when navigating — quickly identifying specific racks without memorizing coordinate positions.

---

##### Commit fbbb69ff0a (2024-05-21)
**Fixed the location change dropdown in the 3D datacenter view**

**What was done:** Fixed `clearScene()` which was using `Object.keys(objects)` with `for...in` that returned string indices rather than property names, and was setting `.length = 0` on plain objects (not arrays) which did nothing. The fix uses `for...in` with `hasOwnProperty()` checks, `scene.remove()` for each object, and reassigns containers to `{}`. Also cleaned up HTML partial template comments and fixed indentation.

**Why it matters:** Without this fix, switching datacenters left stale 3D objects in the scene — ghost racks/servers would persist and overlay with the new location's objects. The location dropdown was effectively broken.

---

##### Commit 2e03c7c0f1 (2024-05-21)
**Fixed location box not updating when location was changed**

**What was done:** Added `.listen()` method to the lil-gui location dropdown controller. The original code bound the controller without listening for external changes, so when `switchLocation()` updated `options.location` programmatically, the GUI dropdown wouldn't reflect the change. Also normalized trailing whitespace.

**Why it matters:** The GUI dropdown would become desynchronized from the actual selected location after a programmatic change. With `.listen()`, the dropdown always reflects the current scene state, whether the change came from user interaction or internal code.

---

##### Commit f340f44bed (2024-05-21)
**Minor bug fix**

**What was done:** Fixed a variable-scoping bug in `getServerModels()` where an outer-scope destructuring assignment was dead code that could cause confusion. The closure inside the IIFE correctly captured `idxServer` — but the outer-scope assignment `modelName, modelUnits = serverTypes[idxServer]` was not actually used by the code. Removed that misleading assignment. Also uncommented a `console.log("Loading Server "+currentModel)` debug line.

**Why it matters:** No runtime behavior change to end users — this was a code correctness and clarity fix. With the debug line uncommented, developers can now trace which models are being lazily loaded at runtime.

---

##### Commit 904d32464c (2024-05-21)
**Adjusted rack label positioning and removed unnecessary whitespace**

**What was done:** Two cleanups: (1) `displayRackText()` X-offset changed from `x - 3` to `x - 2.5`, moving labels 0.5 units closer to the rack's front face for better visual alignment. (2) Removed 17 blank lines from `init()` and `animate()` functions, collapsing consecutive blank lines that separated logical blocks.

**Why it matters:** Labels that were previously offset too far to the left now sit more directly above the rack they describe. Blank line removal reduces vertical scrolling and makes code easier to scan during debugging.

---

### April 2024

##### Commit 662db35f69 (2024-03-19)
**Fine-tuned datacenter view rendering and visual presentation**

**What was done:** Two changes: (1) Threshold for `size >= 14` changed to `size >= 13` in PHP and JS, reclassifying certain rack types. (2) Server population wrapped in `if ($x == 1 || $y == 1)` — servers only generated for racks on the perimeter (x=1 or y=1), creating a border-only "frame" layout with empty interior racks. Server density increased from 10 to 40 per rack.

**Why it matters:** The border-only server population creates a visually cleaner "frame" layout showing racks around the perimeter with servers while interior positions appear as empty shells — better for understanding datacenter layout at a glance.

---

##### Commit 63b9506a9e (2024-03-20)
**Minor tweak to the view**

**What was done:** Removed the "KeyZ" keyboard handler that randomly swapped the displayed server model during development. Also simplified `switch` statement formatting by removing multi-line parentheses. The GUI import was updated to use a direct CDN import instead of commented-out local import.

**Why it matters:** The KeyZ feature was a leftover development testing feature that could accidentally trigger during normal navigation. Removing it cleans up the code and prevents accidental model swaps.

---

##### Commit 8b683dad2b (2024-03-20)
**Moved variables to an options object and added GUI-based tracking via lil-gui; initial work on restoring collision detection**

**What was done:** Major refactoring: (1) GUI import migrated to CDN ESM. (2) Movement state variables (`moveForward`, `moveBackward`, etc.), `collisionMovement`, and `PlayerHeight` moved into `options` object. (3) Added lil-gui "Movement" folder with live-tracked read-only state displays and configurable toggles. (4) `locationNames` converted from array to object for O(1) lookup; `locationName2Id()` removed. (5) `usedRacksSet`/`usedServerSet` moved inside functions as local variables. (6) Raycaster intersection changed to recursive (`true` second param) for nested mesh collision detection.

**Why it matters:** Centralizing configuration into `options` makes state management easier. The lil-gui panel allows developers to monitor movement state and tweak values in real-time. Recursive raycaster checking enables accurate collision detection with complex nested 3D models.

---

##### Commit ea80acd3fb (2024-03-19)
**Fixed title display issue**

**What was done:** Changed page `<title>` from CodePen template `"CodePen - rendering our server room in three.js (servers)"` to `"InterServer DataCenter"`.

**Why it matters:** Ensures users see proper branding in their browser tab instead of a generic CodePen demonstration title.

---

### March 2024

##### Commit 253cbd0be6 (2024-03-19)
**Minor adjustment to Z-axis scaling for improved visual proportionality**

**What was done:** Z-axis spacing reduced from multiplier `10` to `9` in rack and server positioning formulas in `public_html/js/dc.js`. The formula `-100 + (z * 10)` became `-100 + (z * 9)` — a 10% compression of depth spacing.

**Why it matters:** The original Z-spacing (10) made racks appear too spread out along Z-axis relative to X-axis spacing (8). With Z=9, the aspect ratio of rack placement is more balanced and visually proportional, preventing the datacenter from appearing stretched in the depth direction.

---

##### Commit ef749dedf7 (2024-03-19)
**Changing the location now updates the layout**

**What was done:** Three changes: (1) Location dropdown `onChange` now calls `clearScene()`, `getRackModels()`, and `getServerModels()` to rebuild the scene. (2) Skeleton disposal `scene.traverse()` moved OUTSIDE the object iteration loop (was inside, causing redundant traverses). (3) `displayServers()` now tracks server models in `objects` array (was missing, causing memory leaks and stale servers on location switch).

**Why it matters:** Before this fix, the location selector was broken — the dropdown would change but the 3D visualization wouldn't update. Users couldn't visually compare different datacenter locations. The skeleton disposal and server tracking fixes prevent WebGL memory leaks when repeatedly rebuilding scenes.

---

##### Commit d13da4582a (2024-03-19)
**Tweaking the positioning logic a bit and fixing an x/y mixup in the ajax handler**

**What was done:** Fixed X/Y coordinate swap bug in `ajax_datacenter.php` where `rack_x` was assigned to `y` and `rack_y` to `x`. All real rack data was being rendered at incorrect positions — a rack at physical position (10, 20) appeared at (20, 10). Also adjusted 3D positioning multipliers from `(x * 10, z * 20)` to `(x * 8, z * 10)` for tighter, more proportional spacing.

**Why it matters:** The X/Y mixup made the 3D view useless for any actual location planning. The spacing adjustments prevent racks and servers from being too spread out in the scene.

---

##### Commit bcb8a9fb5a (2024-03-19)
**Work on 3d datacenter view getting the various locations rendering in it and a sample location showing other models**

**What was done:** Major refactor from hardcoded `racks` array to dynamic data loading from API endpoint. Added `locationId` selection via GUI dropdown. Implemented rack type variations (13 different rack models via `type` property). Added `serverTypes` mapping servers to 3D models by type index. Added model caching (`models.racks[idx]`, `models.servers[idx]`) to avoid re-loading. Generated "Test" location with 13×22 racks showing sample servers of varying sizes. Removed `generateRandomRacksLayout()` dead code.

**Why it matters:** The 3D view now displays real racks and servers from the database instead of hardcoded sample data. The test location provides a showroom of different server sizes and types for verifying rendering. Model caching avoids redundant network requests.

---

##### Commit a28d438809 (2024-03-18)
**Updates to datacenter 3d view**

**What was done:** Established the API endpoint foundation: (1) Redesigned `ajax_datacenter.php` to always return verbose JSON with consistent nested structure (`locations → racks → servers`). (2) Query actual database tables (`asset_locations`, `asset_racks`, `assets`). (3) Added generated "Test" location (index 0) with 13×27 hardcoded sample racks. (4) Added lil-gui library, `locationNames` array, `options` config object. (5) Parameterized 3D model URLs via `options.domain`. (6) Changed grid helper from 500×500 to 50×50 divisions. (7) Adjusted server X position offset from `-2` to `-2.5` for better rack centering. (8) Commented out several server types to reduce model set needed for testing.

**Why it matters:** Prior version had no real data integration. A single consistent JSON structure makes the frontend easier to develop. The test location provides immediate visual feedback without needing a populated database.

---

##### Commit b997d03e1c (2024-03-13)
**Fixing include filename**

**What was done:** Changed CSS and JavaScript include paths in `public_html/admin/dc.html` from relative (`./style.css`, `./script.js`) to absolute (`/css/dc.css`, `/js/dc.js`). Since the HTML file is at `/admin/dc.html`, relative paths with `./` resolved to `/admin/style.css` (404).

**Why it matters:** Blocking issue — without the JavaScript file loading, the entire Three.js 3D datacenter visualization would not initialize. Users saw a blank page with no 3D scene.

---

##### Commit b79bfeabb2 (2024-03-13)
**Updated dc view getting so much more of it working**

**What was done:** Major architectural refactor: (1) Converted from legacy Collada (`.dae`) to GLTF/GLB format. (2) Added `getRackModels()` and `getServerModels()` with `SkeletonUtils` cloning for efficient reuse. (3) Completely redesigned `racks` array format from flat `[[x,z,[servers]],...]` to complex nested `[[rackTypeIdx, x, z, [[serverTypeIdx, startU], ...]], ...]`. (4) Added 13 rack models and 25 server models (vs. 3 previously). (5) Added random layout generation (`generateRandomRacksLayout`, `generateRandomRackLayout`). (6) Replaced complex procedural floor with simple `GridHelper`. (7) Fixed CDN URL from `mystage.interserver.net` to `my.interserver.net`.

**Why it matters:** GLTF/GLB is the industry standard for WebGL 3D models with better tooling and smaller files. Dynamic layout generation means no hardcoded positions. 25 server models vs. 3 dramatically improves visual diversity. This was a proof-of-concept transitioning to a production-ready visualization.

---

### February 2024

##### Commit ad064fbe54 (2024-03-13)
**Splitting the dc page into html/js/css**

**What was done:** Refactored monolithic `public_html/admin/dc.html` (600+ lines) into three separate files: (1) HTML (`dc.html`) now ~30 lines with just DOM structure, external stylesheet link, and external script tag. (2) CSS (`public_html/css/dc.css` — NEW) with all styles covering body defaults, anchor links, button styling, overlay positioning, lil-gui z-index, mobile responsive breakpoint. (3) JavaScript (`public_html/js/dc.js` — NEW) with all Three.js 3D rendering logic as a 293-line ES6 module.

**Why it matters:** Separation of concerns: HTML for structure, CSS for presentation, JS for behavior — each independently maintainable. Browser caching: CSS and JS can be cached separately; HTML changes don't force re-download. The HTML file went from ~600 lines to ~30 lines.

---

##### Commit 13faeb7119 (2024-03-04)
**Updated datacenter 3d map it now renders all racks and servers but slow.. next will be adding object cloning for speed**

**What was done:** Significant enhancement to render complete datacenter with all racks and servers: (1) Redesigned `racks` array format to embed rack coordinates AND occupied server unit positions. (2) Added `rackTypes` (7 models) and `serverTypes` (3 models). (3) New `loadFilesFromServer()` using ColladaLoader for `.dae` server models. (4) Server scale set to 0.26 (vs. rack at 10) for realistic proportions. (5) Replaced complex procedural floor with simple `GridHelper`. (6) Backend `ajax_datacenter.php` rewritten to return nested structure matching frontend `racks` array format. (7) Added Stats.js panel for FPS monitoring. (8) Added 'Z' key binding to cycle through server models for visual testing.

**Why it matters:** Previously only empty racks were rendered; now servers appear in their actual rack positions giving a realistic view of datacenter capacity. This was explicitly a "slow" baseline establishing the foundation before object cloning optimization — the commit message itself notes "next will be adding object cloning for speed."

---

### February 2024

##### Commit 3d0b9a9031 (2024-02-06)
**Moving files**

**What was done:** Reorganized 3D model asset directory structure by moving server rack GLB model files from `public_html/images/3d/` into a new `public_html/images/3d/racks/` subdirectory. Seven GLB files were physically relocated. Updated `dc.html` GLB loader URL to include `/racks/` subdirectory.

**Why it matters:** Improves maintainability as the project scales. Clearer separation between rack models and other 3D assets. Makes automated build/deployment scripts easier to write.

---

##### Commit 3afb3f73e8 (2024-02-06)
**Updated dc view**

**What was done:** (1) Completely restructured `serverRacks` array into five distinct Z-depth rows (Z=-10, -30, -50, -70, -90) with 8 racks per row (40 total). (2) Removed obsolete .fbx and .obj format files. (3) Added five new GLB models (`5307_824_2`, `7000_562_2`, `7831_800_2`, `SB838072AFB18`, `WZ-IT-426060-69AA-2-011_0`). (4) Normalized indentation throughout `dc.html` to 4-space. (5) Removed commented-out "BOX SECTION" reference.

**Why it matters:** Five-row layout with symmetrical left/right placement better represents a real multi-row datacenter with proper aisle spacing (vs. old two-row clustered layout). GLB-only strategy provides unified, compression-optimized format that loads faster.

---

##### Commit b9ce85f284 (2024-02-06)
**Removing several old pages and image resources and adding a replacement page**

**What was done:** Major cleanup removing three old visualization approaches (Isomer.js 2D-style 3D, legacy Three.js implementation, SketchUp-based models) and replacing with unified modern Three.js viewer. Deleted `dc-isomer.html/js` and `dc-three.html`. Created `dc.html` (392+ lines) with first-person navigation, multiple camera/view modes, real-time multi-user presence via WebSocket, live hostname search, location selector, GUI controls, and character gestures. Deleted old SketchUp, OBJ material, and rack-mount server model files. Added new FBX and GLB formats for two server rack types. Added `.htaccess` in images/3d/ for directory security.

**Why it matters:** Consolidated three separate visualization approaches into one coherent system. Moved from CDN-based older Three.js (v0.110.0) to local ES modules via importmap. Added immersive first-person navigation with character presence and multi-user support.

---

*Total: 57 commits documented*
*Last updated: July 29, 2026*
