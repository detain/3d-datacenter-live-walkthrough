# DataCenter 3D — the isolate render pass

`DC.setIsolate(keepSet)` dims every mesh in the scene except the ones you name, so a traced cable
run or a selected rack reads clearly against everything else. `DC.clearIsolate()` puts it all back.

Mandated by remediation plan steps 9.5 and 9.6; written by R3.10.

## API

```js
DC.setIsolate(new Set([mesh.id, otherMesh.id]));   // dim everything else
DC.setIsolate(null);                                // same as clearing
DC.setIsolate(new Set());                           // same as clearing
DC.clearIsolate();                                  // restore
```

The set holds **`THREE.Object3D.id` values**, not asset ids — these are scene-graph object
identities, which is what `scene.traverse()` hands you.

`setIsolate(null)` used to throw on `keepSet.has()`. No set, or an empty one, is the same request as
clearing, and is now treated as such.

## What "dim" means

Three material properties, per material:

```js
m.opacity     = ISOLATE_DIM;   // 0.3
m.transparent = true;
m.depthWrite  = false;
m.needsUpdate = true;
```

All three are needed, and this is where the feature was broken twice over:

1. **The mechanism is to *set* `transparent`, not to require it.** An earlier version began with
   `if (!m.transparent) continue;` — which skips every opaque material, and every mesh in this scene
   is opaque. The pass ran, touched nothing, and reported success.
2. **`depthWrite: false` is what makes the transparency visible.** A dimmed mesh that still writes
   depth occludes the thing you are trying to isolate, so lowering its opacity changes nothing you
   can see.

`needsUpdate` is required because whether a material blends is compiled into its program.

## Restoring exactly

`_isolateState` is a `Map<THREE.Material, {opacity, transparent, depthWrite}>` — keyed by
**material**, not by mesh. Materials are shared across meshes in this scene, so a mesh-keyed record
saves the same material several times and restores it several times, and any of those restores can
be from a snapshot taken *after* another mesh already dimmed it.

Two rules follow:

- **First touch wins.** `if (!_isolateState.has(m))` guards the save, so the recorded state is the
  pristine one, whatever order the traverse visits shared materials in.
- **Clearing iterates the saved map, not the scene.** A material whose mesh has since been removed —
  a location switch, an LOD swap — still needs restoring, because it may still be on screen through
  another mesh. Walking the scene would leave it permanently at 0.3.

```js
function clearIsolate() {
    if (_isolateState.size === 0) return;
    for (const m of Array.from(_isolateState.keys())) _restoreIsolateMaterial(m);
    _isolateState.clear();
}
```

`_restoreIsolateMaterial(m)` writes all three properties back and deletes the entry, so calling
`setIsolate()` again with a different keep-set restores the newly-kept materials rather than leaving
them dim.

## How cable tracing uses it

`DC.traceCable()` / `DC.traceCableForAsset()` resolve an asset's switchport connections through
`_portsByAsset`, build the set of objects in the run, and hand it to `setIsolate()`. `clearTrace()`
calls `clearIsolate()`.

The reverse index is keyed with `String(portData.asset)` and looked up with `String(assetId)`,
because the endpoint emits port `asset` as a **number** while rack and server ids arrive as JSON
object **keys** and are therefore strings. The mismatch is what hid the Trace Cable button for every
asset (R2.6) — see `docs/dc_data_endpoint.md`.

## Testing

- `tests/js/dc-isolate.test.js` — `setIsolate()` / `clearIsolate()` executed against real material
  objects, including shared materials, removed meshes, repeated calls and the null/empty cases.
- `tests/js/dc-cable-trace.test.js` — the reverse index and the string/number normalisation.
- `tests/playwright/dc.spec.ts` — a browser check that dimming happens and that every material comes
  back to *exactly* its previous opacity, transparency and depth-write, not merely to something
  opaque-looking.

## See also

- `docs/dc_overlays.md` — the other way the scene re-tints itself, and why the two do not collide
- `docs/dc_deep_links.md` — the info panel that triggers both
