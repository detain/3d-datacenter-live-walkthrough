# 3d-datacenter-live-walkthrough
3D walkthrough of various Datacenter locations  with racks,servers,switches populated using three.js

A first-person, multi-user walkthrough of real datacenter floorplans: racks, servers, switches,
structured cabling, room shell and lighting are all built at runtime from a data endpoint, rendered
with three.js on either a WebGL or a WebGPU backend, and shared live between visitors over a
WebSocket presence/chat channel.

## What is in here

| Path | What it is |
| --- | --- |
| `public_html/admin/dc.html` | the page — standalone-playable markup, the three.js import map, and the HUD/GUI containers |
| `public_html/js/dc.js` | the scene: data fetch, instanced rack/server/switch build, cabling, labels, room shell, lighting, picking, quality scaler, isolate/trace/overlay modes |
| `public_html/js/dc-multi.js` | avatars, character/animation loading, third-person and first-person bodies |
| `public_html/js/dc-presence.js` | remote-player presence, name sprites, interpolation |
| `public_html/js/dc-ws.js` | WebSocket hub connection, envelope protocol, reconnect/backoff, debug logging |
| `public_html/js/dc-chat.js` | transparent chat overlay and `/status` |
| `public_html/js/dc-renderer-mode.js` | the `?renderer=webgl\|webgpu\|webgpu-gl` contract |
| `public_html/js/dc-caps.js` | renderer capability probing |
| `public_html/js/dc-gui.js` | lil-gui / three.js Inspector adapter |
| `public_html/css/dc.css`, `dc-shared.css` | page and overlay styles |
| `tests/js/dc-*.test.js` | 53 Vitest suites, plus the three.js stub in `tests/js/__mocks__/three.js` |
| `tests/playwright/dc.spec.ts` | browser E2E, chromium + SwiftShader software WebGL |
| `docs/dc_*.md` | renderer modes, shadows, ambient occlusion, asset pipeline, data endpoint, isolate, overlays, deep links |
| `CHANGELOG-DC.md` | the phase-by-phase engineering log |

## Provenance

This repository's history was **extracted from the InterServer `my` monorepo**
(`github.com/interserver/my`), which is where the walkthrough was actually developed between
2024-02-06 and 2026-08-04. 177 commits touching the 83 walkthrough paths were replayed here in
their original chronological order, each with its original author metadata and a
`Replayed-From: interserver/my@<sha>` trailer pointing back at the monorepo commit it came from.

Deliberately **not** extracted: everything MyAdmin-specific. That means no PHP — including
`public_html/admin/dc.php` (the session-aware wrapper that serves the page in production) and the
`/ajax/datacenter.php` data endpoint the scene fetches from. `dc.html` is the standalone-playable
markup, so the page still runs; the data endpoint is stubbed in the tests and must be supplied by
whatever host serves this scene for real. See `docs/dc_data_endpoint.md` for its contract.

The `package.json`, the CI workflow and this README are **not** replayed history — they are
scaffolding authored for the standalone repo (the monorepo's own `package.json` carried ~200
unrelated MyAdmin dependencies). Dependency versions are pinned to the ones the monorepo suites
actually ran against, so the tests behave identically here.

## Install and run

```bash
npm install                 # also creates the public_html/lib -> node_modules symlink
npm run ensure-lib-symlink  # run standalone if the symlink ever goes missing
```

`public_html/lib` is a symlink to `node_modules/`, and it is load-bearing: `dc.html` imports
three.js, lil-gui, three-mesh-bvh and the Basis/Draco transcoders from `/lib/...`. It is gitignored,
so a fresh clone has no `lib` until `postinstall` (or the script above) creates it.

Three test suites:

```bash
npm run test:js             # vitest run           — the 53 dc-*.test.js unit suites
npm run test:js:coverage    # vitest run --coverage — v8 coverage over public_html/js/**
npm run test:e2e            # playwright test      — chromium + SwiftShader WebGL against dc.html
```

`test:e2e` needs a PHP CLI on `PATH`: `playwright.config.ts` starts `php -S localhost:8080 -t
public_html` as its fixture server (it is only a static file server here — no PHP is executed).
It also downloads a chromium build on first run via `npx playwright install --with-deps chromium`.

WebGPU is opt-in, because headless chromium's software WebGPU adapter is currently broken for this
scene:

```bash
PW_WEBGPU=1 npx playwright test --project=chromium-webgpu
```

## Versioning

Tags are **known-good points in the replayed history**, not releases. The first 47 commits predate
the anchor and are untagged; from the 2026-06-04 scene-revamp landing onward every commit carries a
tag, `v1.0.0` through `v1.9.6`, in strict chronological order. Each minor group is one coherent arc
of work:

| Tag range | Commits | Theme |
| --- | --- | --- |
| `v1.0.0` - `v1.0.2` | 3 | Scene-revamp landing & the quiet gap — characters, posters, denser windows, first-person body; then the drive-by that lands `ws_terminal.js`/`ws_vmstat.js` |
| `v1.1.0` - `v1.1.15` | 16 | WebSocket hub + the performance-audit waves — `dc-ws.js`/`dc-multi.js`/`dc-presence.js` are created, then five full-scene perf audits and the per-file CRIT/MAJOR/MINOR fix pass |
| `v1.2.0` - `v1.2.11` | 12 | First real test suite, WS debugging, multi-tab presence — plus `CHANGELOG-DC.md` and the bot presence system |
| `v1.3.0` - `v1.3.15` | 16 | Chat overlay, the disco-lighting arc (added and reverted inside the group), and multiuser hardening |
| `v1.4.0` - `v1.4.16` | 17 | WebGPU renderer mode, inspector + GUI adapter, loader hardening — the `?renderer=` contract, `DC.bench()`, hermetic e2e |
| `v1.5.0` - `v1.5.20` | 21 | Test-honesty pass (phase 0) + the eight numbered phase-1 bug fixes — real vector maths in the stub, re-implementation tests deleted |
| `v1.6.0` - `v1.6.12` | 13 | Perf phases 2-4: quality scaler, CSS split out of inline `dc.html` styles, two-tier data fetch, leak/ownership fixes |
| `v1.7.0` - `v1.7.13` | 14 | three.js 0.185.1 + lil-gui 0.21.0, shadows (PCFSoftShadowMap), `dc-caps.js`, frustum culling, ambient occlusion on both backends |
| `v1.8.0` - `v1.8.10` | 11 | Asset intelligence: info panel, isolate, cable trace, free-U overlay, deep links, KTX2 + three-mesh-bvh |
| `v1.9.0` - `v1.9.6` | 7 | Changelog truth-up, the two large remediation tiers, WebGPU black-screen fix, quality-scaler perf fix, KTX2/lib-symlink deploy fix |

`v1.10.0` and later are standalone-repo work that never existed in the monorepo.

## License

MIT — see `LICENSE`.
