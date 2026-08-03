# DataCenter 3D — deep links

How `?location=`, `?rack=` and `?asset=` are read and applied in `public_html/js/dc.js`, and what
the info panel's **Copy Link** button produces.

Mandated by remediation plan steps 9.3 and 9.4; written by R3.10.

## The three parameters

| Parameter | Effect |
|---|---|
| `?location=<id>` | Switch to that location. Takes priority over the other two. |
| `?rack=<rack_id>` | Fly the camera to that rack. |
| `?asset=<asset_id>` | Fly the camera to that server. |

All three are coerced with `Number()` and fall back to `null` when absent or non-numeric, so a
hand-mangled URL cannot get further than being ignored.

```
https://my.example/admin/dc.php?location=4&rack=101
https://my.example/admin/dc.php?location=4&asset=110
```

## When they are read, and when they are applied

Reading and applying are deliberately separate.

`_readDeepLink()` runs early, during boot, and only parses. It wraps `location.search` in a
`try`/`catch`, because it also has to survive being executed in a unit test with no browser globals.

`_applyDeepLinkTarget()` runs **after the room is built** — `displayDatacenter()` has to have run for
there to be anything to fly to, and for `displayRacks()` to have stamped `server.id = serverId` onto
each server object (the endpoint keys servers by id and does not repeat the id inside the value, so
that stamp is what makes the asset lookup below possible).

Priority order, first match wins:

1. **`location`**, if it differs from the current one → set `options.location`, `switchLocation()`,
   return. The new location's own boot re-applies the remaining target.
2. **`rack`** → look up `locations[options.location].racks[String(rack)]` and
   `flyToRackPosition(rack.x, rack.y)`.
3. **`asset`** → scan every rack's `servers` for a matching `id` and `flyToServer(rackKey, serverId)`.

### The rack key has no prefix

`datacenter.php` keys the racks map by `rack_id` directly:

```php
$return['locations'][$dc]['racks'][$db->Record['rack']] = [ … ];
```

An earlier version of the client looked up `'rack_' + id`. That key never existed, so `?rack=<id>`
silently did nothing — on every link the Copy Link button produced. The lookup uses the bare id.

## Copy Link

`_copyDeepLink(assetId, rackKey)` builds the URL for the info panel's **Copy Link** button. It always
sets `location`, then **either** `rack` **or** `asset`:

```js
if (rackKey !== undefined && rackKey !== null && String(rackKey) !== '') {
    params.set('rack', String(rackKey));
} else if (assetId !== undefined && assetId !== null) {
    params.set('asset', String(assetId));
}
```

Two details are load-bearing:

- **An empty string counts as absent.** The server panel passes `''` when it has no rack. Without the
  `!== ''` test, `?rack=` won over the asset id and produced a link resolving to nothing at all.
- **A server links by asset, a rack links by rack.** `showInfo()` calls
  `_wireInfoPanel(panel, { assetId: a.id, rackKey: null, … })` for a server and passes the rack key
  for a rack. It used to read a `rackKey` off the placement object, which carries `assetId` and has
  never carried a `rackKey`, so the value was always `undefined` and every server produced a bare
  `?rack=`.

## Related: session restore

Deep links are not the only thing that repositions the camera on boot. `_restoreLocation()` and
`_restoreCamera()` replay a saved position after a WebGL context loss or a reload. Two rules there
are worth knowing because they interact with deep links:

- `_restoreLocation()` accepts any location that is **placed** — present in the index tier — not one
  that is fully loaded. Requiring full detail silently dropped every restore naming a location other
  than the default. See `docs/dc_data_endpoint.md` for the index/full split.
- `_restoreCamera()` refuses a position captured in a different location, rather than dropping the
  player at another building's coordinates. A refused location restore takes the position with it.

## Testing

`tests/js/dc-deep-link.test.js` executes `_readDeepLink()` and `_applyDeepLinkTarget()` against
injected `location.search` values and stub `locations` maps, including a round trip
(`_copyDeepLink()` → `_readDeepLink()` → the same target) and an XSS suite covering what happens when
the parameters carry markup.

Browser coverage lives in `tests/playwright/dc.spec.ts` Group 12 (info panel actions), which clicks
the real Copy Link button and asserts on the URL it writes.

## See also

- `docs/dc_data_endpoint.md` — where rack and asset ids come from, and their string/number types
- `docs/dc_isolate.md`, `docs/dc_overlays.md` — the other two info-panel-adjacent features
