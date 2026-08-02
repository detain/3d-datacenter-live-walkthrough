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
