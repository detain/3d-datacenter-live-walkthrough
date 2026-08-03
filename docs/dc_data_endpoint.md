# The DataCenter 3D data endpoint

`public_html/ajax/datacenter.php` is the only server-side data source for the 3D walkthrough
(`public_html/admin/dc.php`, markup `public_html/admin/dc.html`, scene `public_html/js/dc.js`).
It returns rack and asset inventory as JSON.

Mandated by remediation plan steps 3.5–3.8 and 9.1; written by R3.10.

## Access control

The endpoint requires a valid session — `\MyAdmin\App::session()->verify()` — and answers `403`
otherwise. The check runs **before** the gzip output buffer is opened, so a rejected request never
starts one.

The gate is **any logged-in account, not admin-only**. That is an owner decision of 2026-07-31,
recorded in the file itself; tightening it to `App::accounts()->data['ima'] === 'admin'` was
considered and declined. Do not narrow it without asking.

> **Worth revisiting.** Step 9.1 materially widened the payload — MAC address, primary IPv4,
> make/model and `order_id` now ship for roughly 10,111 assets. That is more than the gate was
> agreed against. It is not a defect against the plan, but the decision deserves a fresh look now
> that the data behind it has changed.

`Access-Control-Allow-Origin: *` is also deliberate and also an owner decision. It is largely inert:
a cross-origin caller sends no cookie, so it lands on the 403 above. It stays because dropping it
would break any consumer pulling this through `dc.js`'s `options.domain`.

## The two tiers

The scene needs two different shapes of the same data, and asking for the full shape twice is what
made the first load slow.

| | Query | What comes back | Size |
|---|---|---|---|
| **index** | `?tier=index` | Every location; `name`, `region`, and `racks[id] = {x, y}` — nothing else | ~7 KB |
| **full** | *(default)*, usually with `?location=<id>` | One location, complete: racks, servers, switches, switchports | ~1.5 MB (254 KB gzipped) for all locations |

Additional parameters:

- `?location=<id>` — restrict to one location. The `locations` list itself is always present, because
  the location dropdown needs every name whatever else is filtered.
- `?test=1` — include the synthetic Test location.

### Why two tiers exist

`buildCommunity()` in `dc.js` lays out the *other* datacenters as exterior shells around the one you
are standing in. To place a building it needs only that building's rack grid — where the racks are,
not what is in them. The index tier is exactly that much and no more.

This asymmetry is load-bearing, and it is what a single-location fixture cannot reproduce. The
Playwright suite serves `DATACENTER_INDEX_STUB` (locations 4, 7 and 9) to `?tier=index` and
`DATACENTER_STUB` (location 4 only, full inventory) to everything else, precisely so a neighbour can
be placed without its inventory ever being fetched — the real boot sequence. Collapsing the fixture
back to one payload is how the neighbours-and-LOD regression survived a full E2E run (R2.1).

### Client-side consequence

`dc.js` merges the index response into `locations` first, then merges each full response over it as
you switch locations. A location that has been placed but not entered therefore has `racks` populated
with `{x, y}` entries and **no** `servers` key. Anything asking "have I loaded this location?" must
test for placement, not truthiness:

```js
function locationPlaced(locId) {
    const loc = locations[locId];
    return !!(loc && loc.racks && Object.keys(loc.racks).length > 0);
}
```

## Caching

- `Cache-Control: private, max-age=60`. `private` because the response now sits behind a session
  check and must never be stored in a shared cache where one account's inventory could be served to
  another. The 60-second browser-local window is what makes the per-location fetches cheap.
- An **ETag** over the fully-built body, with `304` on a matching `If-None-Match`. The body is
  assembled in memory before anything is sent, so the hash is exact. Without it, every reload after
  the freshness window re-transferred the whole payload for inventory that changes rarely.
- Output is gzipped in PHP via `ob_gzhandler`, honouring `Accept-Encoding`. Apache and LiteSpeed do
  not reliably deflate FastCGI output, and this blob compresses about 6×.

## Response shape

```jsonc
{
  "locations": {
    "4": {
      "name": "Secaucus", "region": "US East",
      "racks": {
        "101": {
          "x": 3, "y": 7,           // grid position — note x comes from rack_y, see below
          "name": "R1", "type": 1, "u": 42,
          "servers": {
            "110": { "hostname": "web1.example", "start": 20, "size": 1, "type": 1,
                     "status": "active", "primary_ipv4": "…", "mac": "…",
                     "make": "…", "model": "…", "order_id": 12345 }
          },
          "switches": {
            "900": { "name": "sw1", "asset": 0, "start": 20, "size": 1,
                     "totalPorts": 24, "type": 6,
                     "ports": { "7": { "justport": 1, "port": "Gi0/1",
                                       "asset": 110, "datacenter": 4, "rack": 101 } } }
          }
        }
      }
    }
  }
}
```

Two things about this shape bite consumers:

- **`x` and `y` are transposed on purpose.** The endpoint emits `'x' => rack_y` and `'y' => rack_x`.
  The DB's row/column convention and the scene's floor-plan convention are ninety degrees apart.
- **Ids are JSON object keys, so they are strings; `asset` inside a port is a number.** PHP casts
  `(int)` on the port's asset id, and JSON object keys are always strings. Anything joining the two
  must normalise — `buildPortsByAsset()` keys the index with `String(portData.asset)` and looks up
  with `String(assetId)`. The mismatch is what hid the Trace Cable button for every asset (R2.6).

## Known performance issue

The assets query is a full table scan with a filesort:

```sql
... where rack is not null and unit_start != '' and cast(unit_start as decimal) > 0
order by datacenter, rack, cast(unit_start as decimal)
```

`unit_start` is `char(2)`, so `cast(unit_start as decimal)` is not sargable and no index on that
column can be used. `docs/dc_db_index.sql` documents the partial mitigation (deliberately
unapplied) and the real fix: migrating `unit_start`/`unit_end` to `smallint`. That migration touches
every consumer of those columns and is its own piece of work.

## See also

- `docs/dc_renderer_modes.md` — `?renderer=` modes and the bench harness
- `docs/dc_deep_links.md` — the `#asset=` / `#rack=` links the scene reads
- `.claude/rules/js-tests.md` — why the Playwright fixture is shaped the way it is
