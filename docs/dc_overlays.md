# DataCenter 3D — capacity overlays

The **capacity overlay** tints rack instances by how full they are: red for full, amber for half,
green for empty. Selected from the GUI's Display folder, or driven from the console.

Mandated by remediation plan step 9.7; written by R3.10.

## API

```js
DC.options.overlay = 'freeU';   // 'none' | 'freeU'
DC.applyOverlay();              // re-tint
DC.computeFreeU();              // Map<rackId, freeRatio 0..1> — the data behind it
```

The GUI dropdown calls `applyOverlay()` on change. Step 9.7 also called for exposing it on
`window.DC` and that was missed, so until R3.6 the only way to refresh the tint was to toggle the
dropdown by hand — there was no way to drive it from a test or the console at all.

## How the tint is applied

Per-instance colour on the rack `InstancedMesh`es, via `setColorAt()`. The racks' own materials are
untouched, which is what lets the overlay and the isolate pass (`docs/dc_isolate.md`) coexist — one
writes `instanceColor`, the other writes material opacity.

### Do not hand-roll `instanceColor`

```js
inst.setColorAt(i, new THREE.Color(r, g, b));
```

An earlier version pre-allocated the attribute itself:

```js
inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
```

A `Float32Array` is **zero-filled**, and RGB `(0, 0, 0)` is black. Any instance the loop did not
write on a given pass rendered black rather than untinted. three.js's own `setColorAt()` allocates
the attribute white-filled on first use — the correct neutral — so letting it do the allocation
removes the failure mode rather than working around it.

`_resetInstanceColors()` sets every instance back to white when the overlay is switched to `'none'`.

## The colour ramp

`freeU` is a ratio in `0..1`, interpolated in two straight segments:

| freeU | colour |
|---|---|
| `0.0` | red `(1, 0, 0)` — full |
| `0.5` | amber `(1, 0.67, 0)` — half |
| `1.0` | green `(0, 1, 0)` — empty |

A rack with no entry in the map gets `0.5`, so an unknown rack reads as "no information" amber
rather than as a full rack.

## `computeFreeU()`

```js
freeU = max(0, rack.u - occupiedU) / rack.u        // rack.u defaults to 42
```

`occupiedU` sums `server.size` over `rack.servers` — **and deliberately does not add
`rack.switches`.**

A switch is a row in `assets`. It already appears in `rack.servers`, because the assets query in
`datacenter.php` picks it up like any other asset. The switchmanager query then joins the *same*
asset row and emits it a second time under `rack.switches`, with its own `start` and `size`, so the
switchport topology has something to hang off. Adding both charged every switch's U twice: it
inflated `occupiedU` and understated free capacity, and the overlay showed racks as fuller than they
are. See `docs/dc_data_endpoint.md` for the two queries.

## The legend

`#dcOverlayLegend` is shown when an overlay is selected **and** there are instanced meshes to tint:

```js
const showLegend = options.overlay !== 'none' && objects.instanced.length > 0;
```

The second half matters on a fresh boot — selecting an overlay before the room finishes building
would otherwise show a legend for a scene with nothing tinted.

## Adding an overlay

Add a source function to `OVERLAY_SOURCES` returning a `Map<rackId, number 0..1>`, and add the key
to the GUI dropdown's options object. `applyOverlay()` bails safely if the source is missing or
returns something that is not a `Map`, so a half-finished overlay degrades to no tint rather than to
a broken scene.

## Testing

- `tests/js/dc-overlay.test.js` — `applyOverlay()` executed against stub instanced meshes, covering
  the ramp, the unknown-rack default, the legend toggle and the reset-to-white path.
- The double-count regression has its own case in the `computeFreeU()` suite: a rack holding one
  switch must report the same free capacity whether or not `rack.switches` is populated.

## See also

- `docs/dc_data_endpoint.md` — where `rack.u`, `servers` and `switches` come from
- `docs/dc_isolate.md` — the other re-tinting pass, and why they do not collide
