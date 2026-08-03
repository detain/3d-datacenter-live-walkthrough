# dc renderer modes — classic WebGL vs the three.js node renderer

The datacenter walkthrough (`public_html/admin/dc.php`, markup `public_html/admin/dc.html`,
scene `public_html/js/dc.js`) can run on either three.js renderer, chosen per URL with
`?renderer=`. The point is comparison: the same scene, the same assets, the same code,
two rendering architectures side by side.

**The default is unchanged.** With no `?renderer=` the page loads `three.module.js` and the
classic `WebGLRenderer`, exactly as it did before this work. Everything below is opt-in.

## Modes

| `?renderer=` | three build loaded | Renderer class | GPU backend |
|---|---|---|---|
| absent / `webgl` / anything unrecognised | `three.module.js` | `WebGLRenderer` | WebGL 2 (classic path) |
| `webgpu` | `three.webgpu.js` | `WebGPURenderer` | WebGPU if `navigator.gpu` yields an adapter, else the renderer's own WebGL 2 backend |
| `webgpu-gl` | `three.webgpu.js` | `WebGPURenderer({forceWebGL:true})` | WebGL 2, forced |

`webgpu-gl` is a **diagnostic tool**, not a production renderer or a fallback tier. It runs the
node-renderer architecture with WebGL 2 forced as the GPU backend, regardless of whether a
WebGPU adapter is available. Its only purpose is to make `webgl` → `webgpu-gl` isolate the cost
of the node-renderer architecture (same GPU API, different three.js internals) and
`webgpu-gl` → `webgpu` isolate the WebGPU API itself (same internals, different GPU API).

## How the mode is picked

There is no bundler here — module resolution is an import map — so the mode has to be decided
before the first module script runs. The first thing in `dc.html`'s `<head>` is a classic
(non-module) script that reads `?renderer=` and `document.write()`s the matching import map at
that exact position, plus a `modulepreload` for the build it chose. It also sets
`window.DC_RENDERER_MODE`.

Constraints worth knowing before editing that block:

- It must stay the **first** script and must never become `async`, `defer`, or injected —
  an import map cannot be added after module resolution has started.
- `three/webgpu` and `three/tsl` are mapped **only** in the webgpu modes. A webgpu-only import
  that sneaks into the default page should fail loudly rather than half-work.
- `dc.php` streams `dc.html` verbatim except for the `#dc-session-globals` block, so both entry
  points — and the Playwright fixture, which loads the raw `dc.html` — get this for free.

`dc.js` keeps its single `import * as THREE from "three"`. Both builds export every symbol the
scene uses; the only structural branch in the whole codebase is at renderer construction
(`dc.js`, `isNode = !!THREE.WebGPURenderer`). The scene's *materials* are all stock — no
`ShaderMaterial`, no `onBeforeCompile` — which is why no shader had to be ported to TSL.

Post-processing is the one place where the two architectures genuinely diverge, because
`EffectComposer` is a WebGL-only addon and the node renderer has no equivalent for it. Ambient
occlusion is therefore implemented twice, and `dc.js` picks by capability rather than by backend
name — see **Ambient occlusion** below. (An earlier version of this document said the scene had
"no `EffectComposer`". That stopped being true at `dc.js`'s `_setupWebglPostFX()`.)

## How fallback works, and what the UI reports

`WebGPURenderer` picks its backend at construction: WebGPU when an adapter request succeeds,
otherwise its WebGL 2 backend. So **the requested mode is a request, not an outcome**.
Everything user-visible reports the backend that was actually obtained:

- `DC.backendName` → `'webgl'` (classic renderer) · `'webgpu'` · `'webgl2-fallback'`
  (webgpu mode that fell back).
- The `#dcRenderer` button label is `<actual backend> ⇄ <other mode>` and its tooltip spells
  out the same thing. Clicking it reloads with the other `?renderer=` value, preserving every
  other query parameter.

The mode lives in the URL, not in storage: it is explicit, shareable, and a plain reload with
no `?renderer=` always lands back on the default renderer.

## What actually differs between the modes

| | `webgl` | `webgpu` / `webgpu-gl` |
|---|---|---|
| perf readout | `Stats` panel (rAF cadence) | three.js **Inspector** (`three/addons/inspector/Inspector.js`), dynamically imported; Performance tab reads real GPU time off timestamp queries |
| settings panel | lil-gui | Inspector `createParameters('Scene settings')` — same controls, same order, via the `public_html/js/dc-gui.js` adapter |
| max anisotropy | `renderer.capabilities.getMaxAnisotropy()` | `renderer.getMaxAnisotropy()`, and only valid after `await renderer.init()` |
| per-frame draw calls | `info.render.calls` | `info.render.drawCalls` (`calls` was redefined as the lifetime `render()` count) — both go through `_drawCalls()` in `dc.js` |
| device loss | `webglcontextlost` / `webglcontextrestored` DOM events, in-place recovery | `renderer.onDeviceLost` callback; there is **no** restored counterpart, so the handler stashes a session backup in `sessionStorage` and reloads. The WebGL 2 backend routes canvas context loss into the same callback |
| init | synchronous | `await renderer.init()` before anything draws — `init()` in `dc.js` is `async` and the module tail is a top-level `await` |
| shadow map type | `PCFSoftShadowMap` deprecated → `PCFShadowMap` (console warning); both paths work, WebGPU just uses the TSL node shadow filter instead | `PCFSoftShadowMap` supported via TSL `ShadowFilterNode` (`PCFSoftShadowFilter` in `_shadowFilterLib`); `shadowMap.type` is read in `NodeManager.js` and `Renderer.js` |

`body.dc-has-inspector` shifts `#dcPlayer` / `#dcPresence` / `#dcWsToggle` clear of the
Inspector's fixed `#profiler-toggle`; the class is only added when the Inspector really
attached, so the default page never sees the rule.

## Ambient occlusion

AO is implemented **twice**, because `EffectComposer` is a WebGL-only addon and the node renderer
has no equivalent for it. The toggle is in the GUI's Display folder on both paths and defaults to
off — it is the most expensive thing in the frame.

| | classic path | node path |
|---|---|---|
| setup | `_setupWebglPostFX()` | `_setupWebgpuPostFX()` |
| chain | `RenderPass` → `GTAOPass` → `OutputPass` in an `EffectComposer` | `pass(scene, camera)` with an MRT of `{output, normal: normalView}`, into `ao(depth, normal, camera)`, composited by a `RenderPipeline` |
| gate | `caps.supportsEffectComposer` | `caps.supportsTSL` |

The gate is a **capability**, not a backend string. Both node backends compile TSL — the WebGL 2
fallback emits GLSL from the same node graph — so `?renderer=webgpu-gl` and a `?renderer=webgpu`
run that fell back both take the node path. `caps.backend` is `'webgpu'`, `'webgl2-fallback'` or
`'webgl'`; it never spells a class name. See `public_html/js/dc-caps.js`.

Three things about the node graph are easy to get wrong and were:

- **The MRT normal attachment is required.** GTAO needs depth *and* normals; taking both off the
  same pass is what makes it one geometry pass rather than two. Without `setMRT`,
  `getTextureNode('normal')` has nothing to return and the effect occludes against garbage.
- **GTAONode's output target is `RedFormat`.** The occlusion factor is in `.r`; `.g` and `.b` are
  zero. Multiplying the scene colour by the whole texel — the obvious thing to write — zeroes green
  and blue and renders the scene dark red. Broadcast the scalar:
  `colorNode.mul(vec4(vec3(aoNode.getTextureNode().r), 1))`.
- **The sampling radius is in world units.** GTAO defaults to `0.25`, which suits a scene where a
  character is ~1.8 units tall. Here a rack is ~19 units and a 1U server ~1, so the default samples
  a sphere smaller than one server and finds nothing. `_AO_RADIUS` / `_AO_THICKNESS` in `dc.js` set
  it for this scene's scale, and both paths use the same values so the two backends are comparable.

`DC.postFX()` reports which implementation built and whether AO is really being applied:

```js
DC.postFX()   // { mode: 'webgl'|'node'|'none', requested, active, suspendedByScaler }
```

`mode: 'none'` means the dynamic import failed and the toggle does nothing. `active` is the same
`aoActive()` predicate the render path and `bench()` use, so those three can never disagree.

Both paths are pixel-verified in CI — `tests/playwright/dc.spec.ts` Group 13 renders the same
frozen camera with AO off and on and asserts the mean luminance falls, on both backends.

## Known performance characteristics

Required by remediation step 7.5. Costs are architectural, not measurements — the only numbers we
have are from a software rasteriser (see *Baseline measurements*), so treat these as what to expect
and what to watch, not as figures to quote.

| Feature | Cost | Notes |
|---|---|---|
| Ambient occlusion | **Highest.** A full screen-resolution pass over depth and normals, plus a denoise | First tier the auto-quality scaler drops. On the node path it also forces the scene through an MRT, so the geometry pass writes two attachments instead of one |
| Shadows | One extra depth pass over every caster, per frame | `applyShadowPolicy(root, 'cable')` keeps cable bundles out of it — a 3 cm bundle casts nothing readable and would cost a shadow-map draw per merged run. See `docs/dc_shadows.md` |
| Shadow map size | Quadratic in the dimension: 2048 is 16× the fill of 512 | Second tier dropped. Changing it reallocates the map, hence the 30 s oscillation lockout |
| Pixel scale | Quadratic in the multiplier | Third tier. `dc-multi.js` already starts at 0.8 |
| LOD bias | Cheap to change, large effect on neighbour buildings | Last tier |
| Neighbour buildings | Two extra shells plus block proxies — the draw-call rise from 108 to 168 in the CI fixture | Not a regression; see *Baseline measurements* |

### The auto-quality scaler

`_autoQualityScale()` averages a 60-frame ring buffer and acts when it crosses `FPS_TARGET` /
`FPS_RECOVERY`, with separate debounces for each direction. Downgrades run in cost order and
upgrades run in reverse, so the cheapest thing to lose goes first and comes back last:

```
ambientOcclusion → shadowMapSize → pixelScale → lodBias
```

Ambient occlusion is the one tier that is a **user opt-in** rather than something the scaler owns,
so `_aoSuspended` records that the scaler — not the user — switched it off. Recovery gives AO back
only to someone who asked for it, and a manual toggle clears the flag so the user's choice wins.

`DC.setAutoQuality(false)` pins every tier where it is. Benchmarks, screenshots and the E2E suite
all need that: without it the scaler rewrites the thing being measured mid-measurement, and on any
machine below `FPS_TARGET` — which includes every headless CI runner — AO is switched off within a
second of being switched on and can never be observed at all.

## Payload cost

Both builds import `three.core.js`, which is the bulk of the library. Comparing only the entry
files ("2.06 MB vs 649 KB") overstates the delta by a lot — the real numbers, from the files we
serve out of `public_html/lib/three/build/`:

| mode | files loaded | raw | gzip (`gzip -9`) |
|---|---|---|---|
| `webgl` | `three.module.js` + `three.core.js` | 2,076,458 B (1.98 MiB) | 409,372 B |
| `webgpu` / `webgpu-gl` | `three.webgpu.js` + `three.core.js` | 3,488,962 B (3.33 MiB) | 682,810 B |
| `webgpu` extra when the Inspector attaches | `+ three.tsl.js` | +33,614 B | +7,209 B |

So webgpu mode costs **+1.41 MB raw / +273 KB gzip**, about +68% / +67% — not the 3× the
file listing suggests. If we ever switch to the minified builds the same comparison is
749,220 B → 1,021,783 B raw (+36%) and 187,185 B → 277,359 B gzipped (+48%).

The dev (unminified) builds are what both modes serve today, so the comparison is like for
like. Production is fronted by LiteSpeed, which compresses; the raw column is what the
uncompressed fixture server (`php -S`) sends, and the in-browser `transferSize` readings below
match it to within response-header overhead (~300 B per file).

## Bench protocol — `DC.bench()`

`DC.bench(seconds = 10)` is a console handle, nothing more. It is **inert unless called**: it is
not wired into `init()` or the render loop, so a normal page load pays nothing for it.

What it does:

1. Walks the camera through the five preset views (`IDLE_VIEWS`: overview, aisle, labels,
   cables, top), `seconds / 5` on each, so every mode is measured over one identical path.
   It jumps to each preset rather than calling `setView()` — a fly-to would spend most of the
   sample window in transit, and `setView()` also unlocks the pointer and repaints the preset
   buttons.
2. Suppresses the idle "show-off" view cycler for the duration, so the demo cannot move the
   camera mid-sample.
3. Every 250 ms, samples the FPS ring buffer the auto-quality scaler already maintains
   (`DC.quality._fps`) and `_drawCalls()`. It also clears the idle-skip gate on each sample —
   a page parked for `_IDLE_FRAME_THRESHOLD` frames has already switched FPS tracking off and
   would otherwise report a frozen number.
4. Restores the camera position and orientation it started with.

```js
// run this once per mode, same machine, same location, nothing else on screen
await DC.bench(30)
```

A real return value, from the headless webgl run below (not a hypothetical — see Findings for
why the numbers are so low):

```json
{ "mode": "webgl", "backend": "webgl", "avgFps": 4, "minFps": 2,
  "drawCalls": 120, "dpr": 0.5, "location": 4, "seconds": 40, "samples": 69,
  "ao": false, "shadows": true, "shadowMapSize": 2048, "pixelScale": 0.8, "triangles": 52340 }
```

Read the fields carefully:

- `mode` is what the URL asked for; `backend` is what was actually obtained. A `webgpu` run
  that reports `webgl2-fallback` is a WebGL measurement wearing a WebGPU label. Note that
  `webgpu-gl` also reports `webgl2-fallback` — the renderer cannot tell "forced" from
  "fell back", so use `mode` to tell those two apart.
- `avgFps` / `minFps` come from a rolling 60-frame average, so `minFps` is the **worst window**
  seen, not the worst single frame — a one-frame hitch is smeared across the window.
- `avgFps` and `minFps` are `null` when the 60-frame window never filled (a slow enough
  renderer, or too short a `seconds`). `samples` tells you how many readings went in.
  When this happens `bench()` logs a console warning.
- `dpr` is the effective pixel ratio. `dc-multi.js` sets a 0.8 quality scale on load, and the
  auto-quality scaler drops it further under load — two runs at different `dpr` are not
  comparable, so check it before comparing FPS.
- `drawCalls` is the worst (highest) per-frame count seen over the run.
- `ao` reports whether ambient occlusion was actually applied — the same `aoActive()` predicate
  the render path uses, so the bench result and the frame can never disagree. (It was hardcoded
  `false` until R3.7, under a comment claiming AO was "not yet implemented", so every run
  reported AO off while the composer was rendering. Two runs that differed in AO looked
  comparable and were not.)
- `shadows` is `true` when shadow rendering is active.
- `shadowMapSize` is the shadow map resolution in pixels (typically 512, 1024, or 2048).
- `pixelScale` is the quality scale multiplier applied to the renderer pixel ratio
  (`S.pixelScale`, distinct from `dpr` which is the effective ratio after auto-quality).
- `triangles` is the per-frame triangle count from `renderer.info.render.triangles`.

## Baseline measurements

The draw-call baseline that Phase 8 of `dc_improve_plan.md` was gated on. It was never
recorded at the time — Step 8.0 required a browser and was skipped, and Steps 8.1, 8.3 and
8.4 all proceeded on estimates. Recorded here 2026-08-03 as part of the remediation
(`dc_remediation_plan.md` step R1.7), once the page could boot again.

### CI-equivalent room — 2026-08-03

Chromium + SwiftShader via Playwright, `bootHermetic()` stubs, `?renderer=webgl`,
`await DC.bench(10)`. Taken **twice** the same day, before and after Tier 2 of the remediation:

| Field | Before Tier 2 | After Tier 2 |
|---|---|---|
| `backend` | `webgl` | `webgl` |
| `drawCalls` | 108 | **168** |
| `triangles` | 62,418 | **66,008** |
| `avgFps` / `minFps` | `null` (`samples: 0`) | `null` (`samples: 0`) |
| `dpr` | 0.8 | 0.8 |
| `pixelScale` | 1 | 1 |
| `shadows` | `false` | **`true`** |
| `ao` | `false` | `false` |

**The increase is the product working, not a regression.** The first reading was taken while
`buildCommunity()` was placing no neighbours at all (`dc_remediation_plan.md` R2.1) and while the
Playwright fixture served one location to both tiers, so the scene contained a single room shell
and nothing else. It now contains two neighbour buildings' shells and block proxies — which is
what the page is supposed to render. The old numbers described a scene the product never intends
to produce, so the CI ceilings were re-derived from the new ones (`250` / `99000`).

`shadows` flipping to `true` is R2.3: the flag was never assigned, so `bench()` reported `false`
while shadows rendered. The reported value now matches `renderer.shadowMap.enabled`.

**Read these caveats before quoting the numbers.**

- **This is the room shell only.** `public_html/images/3d` is gitignored, so every rack and
  server GLB 404s, and `bootHermetic()` stubs the character manifest to 404 as well. There
  are no racks, no servers and no avatars in this measurement. A production room will be far
  heavier. These figures are the right basis for the CI regression ceilings in
  `tests/playwright/dc.spec.ts` and for nothing else.
- **The FPS fields are unusable here.** `samples: 0` means the ring buffer never filled —
  SwiftShader is a software rasteriser and its frame cadence says nothing about a real GPU.
  The CI guard therefore asserts draw calls and triangles only. Do not add an FPS assertion
  until the numbers come from real hardware.
- **`ao: false` here is a setting, not a defect.** Ambient occlusion defaults to off, and these
  runs did not turn it on. It was a hardcoded lie until R3.7; `bench()` now calls the same
  `aoActive()` predicate the renderer does. `shadows` was the same until R2.3.
- **Shadows are enabled here but nothing casts.** With no rack or server models loaded, the only
  meshes present are the room shell, which receives shadows and does not cast. The shadow depth
  pass runs and costs draw calls; the visual result in this fixture is nothing. Shadow *casting*
  cannot be verified in CI at all — it needs the gitignored 3D assets.

### Still not measured

A full room on real hardware, and a neighbour building swapped to full detail. Both need a
GPU and a live datacenter payload. Step 8.0's original intent — measure in an aisle, then
again beside a full-detail neighbour — remains open. `DC.lodState()` now reports neighbours in
the fixture (R2.1), but nothing in CI walks close enough to force one to full detail.

Step 8.3's cable-triangle reduction was performed without the measurement that was supposed to
authorise it. At the 108 draw calls measured before Tier 2, the honest reading of Step 8.0's own
gate ("if draw calls are already under ~100, skip Step 8.3 entirely") is that the reduction was
not justified. It is harmless and has been kept.

## Findings

### Measured headlessly (2026-08-01, SwiftShader — read the caveats)

Chromium via Playwright with `--use-gl=swiftshader --enable-unsafe-webgpu`, the `php -S`
fixture serving `public_html`, `/ajax/datacenter.php` stubbed with a synthetic location, and the
hub WebSocket stubbed dead. **This is CPU rasterisation.** The numbers are real measurements of
a real page, but they say almost nothing about GPU performance — they are here to prove the
harness works end to end and to pin the parts that *are* machine-independent (payload,
draw calls, backend resolution, the Inspector wiring).

Run A — 15 racks × 16 servers, viewport 1280×800, `DC.bench(60)`:

| | `webgl` | `webgpu-gl` | `webgpu` |
|---|---|---|---|
| `DC.backendName` | `webgl` | `webgl2-fallback` | **`webgpu`** (a real WebGPU adapter) |
| three payload transferred | 2,077,058 B | 3,489,562 B | 3,489,562 B (+33,914 B `three.tsl.js`) |
| navigation `load` | 3,106 ms | 4,173 ms | 264 ms † |
| DC ready (goto → `DC.scene`) | 5,604 ms | 4,205 ms | 504 ms † |
| rAF rate | 0.6 fps | 0.6 fps | 36 fps † |
| `avgFps` / `minFps` | `null` / `null` ‡ | `null` / `null` ‡ | 34 / 10 † |
| `drawCalls` | 260 | 261 | 8 † |
| render-loop errors | 0 | 0 | **2,131** † |

Run B — 4 racks × 6 servers, viewport 640×400, `DC.bench(40)` (small enough that the FPS window
actually fills):

| | `webgl` | `webgpu-gl` | `webgpu` |
|---|---|---|---|
| `avgFps` / `minFps` | **4 / 2** (69 samples) | **3 / 2** (41 samples) | 32 / 9 † |
| `drawCalls` | 120 | 121 | 9 † |
| `dpr` | 0.5 | 0.5 | 0.5 |
| render-loop errors | 0 | 0 | **1,378** † |

‡ At 0.6 fps the 60-frame FPS window never filled inside a 60 s run, so `avgFps` came back
`null` — which is the harness reporting honestly rather than averaging four samples. That is the
reason for run B. In run B the reported `avgFps: 4` matches what the on-page Stats panel showed
(`4 FPS (1-6)`), so the sampling path is verified against an independent reading.

† **The `webgpu` column is not a measurement of our scene.** Headless Chromium's software WebGPU
adapter accepts the device but reports tiny buffer limits, and every frame throws:

```
RangeError: Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed,
size (50680) is too large for the implementation when mappedAtCreation == true
    at WebGPUAttributeUtils.createAttribute (three.webgpu.js)
```

50 KB is nowhere near a real WebGPU `maxBufferSize`. So no geometry ever uploads: the scene is
empty (8–9 draw calls is the HUD and sky), which is exactly why that column shows a "fast" 32–34
fps and a sub-second load. Everything in the `webgpu` column is an artefact of the software
adapter. `_guardLoop()` did its job through it: the loop kept running, the page kept responding,
the Inspector panel stayed rendered, and `DC.bench()` still completed and restored the camera
across 2,131 consecutive failing frames.

What *is* trustworthy from these runs:

- `webgl` vs `webgpu-gl` render the same scene to within one draw call (260 vs 261, 120 vs 121),
  so the node renderer is not silently changing what gets submitted.
- `?renderer=webgpu-gl` correctly resolves to a WebGL 2 backend, and `?renderer=webgpu` correctly
  resolves to a WebGPU backend when one is available — the mode switch and backend reporting work.
- The Inspector attaches, docks, and hosts the whole settings panel in both webgpu modes
  (`Scene settings` → Display / Movement / LOD / Player, with the `dc-val` value highlights
  intact); `three.tsl.js` is fetched only in those modes, only after the dynamic import.
- `DC.bench()` restores the camera exactly: reading position + quaternion in the same tick that
  `bench()` resolves gives byte-identical values before and after.

### Not measured

- **Real WebGPU on real hardware.** As above, the headless software adapter cannot upload our
  geometry, so the WebGPU backend has never actually drawn this scene here. No FPS number in this
  document is a verdict on WebGPU; the comparison that matters has to be run on a real machine
  with a real GPU, in the same browser, at the same window size, from the same location, with
  `DC.bench(30)` in each of the three modes.
- **Node-material warm-up.** The node renderer compiles a material per material/light
  combination on first use; the classic renderer has its own GLSL compile stutter, distributed
  differently. Both are first-frame effects that a steady-state FPS average hides. Worth
  watching for on real hardware.
- **Real device loss.** `renderer.onDeviceLost` → `sessionStorage` → reload has not been
  exercised against an actual GPU reset. `chrome://gpucrash` or a DevTools-forced context loss
  is the check.

### Visual pass

The scene has no custom shaders, so nothing needed porting, but the node renderer rebuilds our
standard materials through its node system and small differences are possible. The things worth
eyeballing side by side, at the same location and preset:

- MeshPhysical clearcoat glass walls (`dc.js` builds these around the room shell)
- cable sheen — `vertexColors` + clearcoat on the tube geometry
- `CanvasTexture` rack/server labels: sharpness, sRGB, anisotropic filtering
- fog falloff at the far end of the room, and the sun glow's transparency
- avatar name sprites from `dc-presence.js`

Headlessly, screenshots were taken of `webgl` and `webgpu-gl` from the same camera state and the
same location, and they agree: same room shell, same glass, same fog, same HUD. But SwiftShader
rasterises on the CPU and the software path is not a fair witness for clearcoat and env-map
response, so **treat the headless screenshots as a smoke test, not as the visual pass**. The
`webgpu` screenshot shows an empty scene for the buffer-limit reason above, so there is nothing
to compare there at all.

The screenshots live with the rest of the Playwright output and are deliberately not committed
(`coverage/`, `playwright-report/`, `test-results/` are gitignored build artifacts). The real
visual pass is still owed: same machine, same location, same preset, real GPU, one screenshot
per mode.

## Known quirks

### Two `.parameters` lists in the DOM (webgpu mode) — addon-inherent, not ours

`document.querySelectorAll('.parameters')` returns **two** elements in webgpu mode: our settings
list, and a second, shorter one. This is not a double attach and not a second Inspector.
`Inspector` constructs exactly one `Parameters` tab — but it also constructs a `Settings` tab,
and `tabs/Settings.js` is `class Settings extends Parameters`. `Parameters`' constructor is what
adds `class="parameters"` to its list root, so the Settings tab's own list carries the same
class. Confirmed in the browser: the two elements are
`inspector.parameters.paramList.domElement` (ours — it lives under `#profiler-mini-panel`, and
`createParameters('Scene settings')` writes into it) and
`inspector.settings.paramList.domElement` (the addon's own Force WebGL / Capture Stack Trace /
Extensions controls, under `#settings-content`).

Consequence: never select the panel by `.parameters` alone. `DC.inspector.parameters` is
unambiguous. Nothing is broken and nothing in `dc.js` needed changing.

### `ValueSelect.setValue()` ignores its argument (upstream three.js bug)

`ValueSelect` and `ValueColor` are the only `Value` subclasses that do not override
`setValue()`, and the base implementation is `setValue() { this.dispatchChange(); return this; }`
— it drops the value and re-emits the current one. The Inspector's `listen()` calls exactly
that, so a programmatic write to a select-backed property would leave the `<select>` alone, push
the stale value back onto the object, and fire `onChange` on the way past (a spurious
`switchLocation()` on the location dropdown, a spurious character reload on dc-multi's).
`dc-gui.js` therefore implements its own `listen()` for selects: it writes the element directly
and dispatches nothing. Worth filing upstream so the workaround can eventually go.

### The Inspector adapter reaches into undocumented internals

`dc-gui.js` uses `parameters.paramList`, `group.objects[…].subItem`, and `editor.select`. These
are internals of a new and still-moving addon. **After any `three` upgrade, check the webgpu-mode
settings panel first.** This is also the argument for keeping lil-gui as the webgl-mode backend
rather than standardising everything on the Inspector.

### Pre-existing: `hud()` is not defined in `dc.js`

`loadGlbWithFallback()`'s final error handler calls `hud("Warning: Some 3D models failed to
load…")`, but `hud()` is defined in `dc-multi.js` as a module-local function and is not exported
or attached to `window` — so the warning path throws `ReferenceError: hud is not defined` instead
of showing the warning. Only reachable when every GLB variant 404s. Found while building this
harness; it predates the renderer work and was left alone.

## See also

- `plan_dc.md` — the full port plan, including the exhaustive API-delta table.
- `.claude/rules/websocket.md` — DC page conventions (the renderer modes change nothing about
  the frozen v1 envelope).
- `.claude/rules/js-tests.md` — Vitest is the CI gate; Playwright is advisory.
