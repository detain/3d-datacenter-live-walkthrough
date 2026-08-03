# DataCenter 3D — shadows

How the sun, its shadow camera and the shadow-quality controls work in `public_html/js/dc.js`.

Mandated by remediation plan steps 6.1–6.5; written by R3.10.

## The light

One `DirectionalLight` (`_sunLight`) is the only shadow caster in the scene. It hangs at a fixed
offset from whatever room it is lighting:

```js
const _SUN_OFFSET = { x: 60, y: 120, z: 40 };
```

That is an *offset*, not a position. `_fitShadowCamera()` places the light at
`(roomCentre.x + 60, 120, roomCentre.z + 40)` and points it at the room centre, so every building
gets the same lighting angle regardless of where it sits in world space.

## Fitting the shadow camera

This is the part that is easy to get wrong, and was.

A directional light's shadow camera is **orthographic and looks down the light's own axis**. Its
`left`/`right`/`top`/`bottom` are therefore in **light-view space**, not world space. Writing world
X and Z extents into them only lines up when the light happens to look straight down −Z. Ours looks
down from `(60, 120, 40)`, so a world-space box landed skewed and off-centre — and because the light
itself never moved, a room whose centre was far from the world origin fell outside the frustum
entirely and cast no shadows at all.

`_fitShadowCamera()` does three things instead:

1. **Moves the light** to `roomCentre + _SUN_OFFSET` and aims `_sunLight.target` at the room centre.
2. **Sizes the box by the room's diagonal radius**, not its width and depth:
   ```js
   const radius = 0.5 * Math.hypot(w, d) + margin;   // margin = 20
   ```
   The diagonal covers the footprint from *any* view orientation, so the box cannot under-cover no
   matter which way the light ends up facing. A width/depth box can, whenever the light is not axis
   aligned.
3. **Sets `near`/`far` along the light axis**: `far = |_SUN_OFFSET| + 2 * radius`. The light sits a
   full offset away from the room centre, so a far plane that only clears the box stops the far half
   of the room casting.

It bails when there is no `roomBounds` yet — during `init()` the room does not exist. It is called
again at the end of `buildRoom()`, which is where `roomBounds` first becomes real, and from
`setShadowsEnabled(true)`.

## Cast / receive policy

`applyShadowPolicy(root, kind)` walks a subtree and sets `castShadow` / `receiveShadow` per mesh.
Three kinds:

| kind | casts | receives | why |
|---|---|---|---|
| `'model'` *(default)* | yes | yes | racks, servers, neighbour buildings |
| `'cable'` | no | yes | a 3 cm bundle casts nothing readable at this scale, and would cost a shadow-map draw per merged run |
| `'light'` | no | no | the sun sphere **is** the light source — a self-shadowing emitter is wrong twice over |

Everything that loads geometry routes through this rather than setting the two flags inline, so the
policy is stated once.

## Enabling and disabling

`setShadowsEnabled(bool)` writes **all four** pieces of state that track shadows:

```js
S.shadowsEnabled = on;              // the state object bench() and dc-multi.js read
options.shadows = on;               // what the GUI checkbox is bound to
renderer.shadowMap.enabled = on;    // what actually renders
if (_sunLight) _sunLight.castShadow = on;
```

An earlier version wrote only `renderer.shadowMap.enabled`. The other three drifted away from what
was really rendering, and `_sunLight` kept casting into a disabled map — paying the full depth pass
for output nobody sampled.

Turning shadows back **on** re-fits the camera. A location switch nulls `roomBounds` and rebuilds the
room; without the re-fit, shadows would come back fitted to the previous building.

Every material is then marked `needsUpdate`, because whether a material samples the shadow map is
compiled into its program.

## Map resolution

```js
const _SHADOW_SIZES  = { Low: 512, Medium: 1024, High: 2048 };
const _SHADOW_LABELS = { 512: 'Low', 1024: 'Medium', 2048: 'High' };
```

`setShadowMapSize(quality)` accepts **either** a label or a raw pixel count, and writes
`_shadowMapSize`, `S.shadowMapSize` and `options.shadowQuality` together. Both halves of that matter:

- The auto-quality scaler reads and writes `_shadowMapSize` directly. A `setShadowMapSize()` that
  did not write it had its result overwritten on the scaler's next tick.
- The scaler's downgrade path passes a **number** (`512`), not a label. A label-only lookup returned
  `undefined`, fell through a `|| 1024` default, and silently *upgraded* the map it was trying to
  shrink.

`_applyShadowMapSize()` then walks the scene and updates every directional and spot light:

```js
obj.shadow.mapSize.set(_shadowMapSize, _shadowMapSize);
if (obj.shadow.map) { obj.shadow.map.dispose(); obj.shadow.map = null; }
```

`mapSize` is written whether or not a map has been allocated. Requiring `obj.shadow.map` meant a
size chosen before the first shadow render was silently discarded, and three.js then allocated at
whatever `mapSize` still held. An already-allocated map is fixed-size, so it has to be dropped for
the new size to take.

## Shadow map type, per backend

```js
renderer.shadowMap.type = caps.isNode ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
```

`PCFSoftShadowMap` is genuinely supported on the node/WebGPU path — `ShadowNode`'s filter library
carries `PCFSoftShadowFilter`. It is **deprecated on the classic WebGL path**:
`WebGLShadowMap.js:99` converts it to `PCFShadowMap` and warns on every load. Asking for it there
bought a console warning and `PCFShadowMap` anyway, so each path asks for what it can actually get.
See `docs/dc_renderer_modes.md` for how `caps` is derived.

## Auto-quality interaction

Shadow map size is the **second** tier the auto-quality scaler drops (after ambient occlusion) and
the second-to-last it restores. Downgrades halve it to a floor of 512; upgrades double it to a
ceiling of 2048, but only after a 30-second lockout since the last downgrade
(`UPGRADE_LOCKOUT_MS`) — without that, a scene sitting near the FPS target oscillates the map every
cooldown, and reallocating a shadow map is not cheap.

`DC.setAutoQuality(false)` pins every tier where it is, for benchmarking or screenshots.

## Testing, and one honest gap

- `tests/js/dc-shadow.test.js` — `_fitShadowCamera()` executed against injected room bounds
- `tests/js/dc-shadow-policy.test.js` — `applyShadowPolicy()` over real object trees
- `tests/js/dc-shadow-gui.test.js` — `setShadowsEnabled()` / `setShadowMapSize()` state writes
- `tests/js/dc-quality-scaler-shadow.test.js` — the scaler's shadow tier

**What is not covered:** shadow *casting* is not verified end to end in CI. `public_html/images/3d`
is gitignored, so the server and rack GLBs 404 in the Playwright fixture and the scene contains zero
shadow casters (`casters: 0`). Everything above — camera fit, policy, sizes, state — is asserted; that
the resulting depth pass produces the right pixels is not, and cannot be until the fixture carries
geometry. Stated here rather than papered over.

## See also

- `docs/dc_renderer_modes.md` — backend capabilities and the bench harness
- `.claude/rules/js-tests.md` — the fixture's constraints
