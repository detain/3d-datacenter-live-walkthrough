# DC Asset Pipeline — KTX2 Texture Compression

## Overview

The DataCenter 3D scene uses KTX2-compressed textures for efficient GPU-native texture transfer.
KTX2 is a container format that wraps Basis Universal compressed texture data (UASTC or ETC1S).
The transcoder converts that data into whatever compressed format the GPU actually supports —
ASTC, ETC2, BC/DXT, PVRTC — so the texture stays compressed in GPU memory instead of being
expanded to raw RGBA the way a PNG or JPEG is.

> **This section was rewritten (remediation step R3.10).** The previous version's conversion
> commands were substantially fabricated: they were written as producing `.ktx2` output files when
> the tool is glTF-in/glTF-out, they used flags (`--rdo-g`, `--split-threshold`) that do not exist,
> they inverted which bitstream suits normal maps, they invented a texture format called "JPEG BC",
> and they claimed WebGPU transcodes natively without WASM. Everything below is checked against
> `@gltf-transform/cli` 4.4.2 and against `node_modules/three/examples/jsm/loaders/KTX2Loader.js`.

## Why KTX2?

- **Stays compressed on the GPU.** A PNG or JPEG is fully decompressed in GPU memory; a KTX2
  texture is uploaded in a block-compressed format and stays that way. That is the whole point —
  the download saving is secondary to the VRAM saving.
- **One file, many GPUs.** Basis Universal is a *supercompressed* intermediate. The transcoder
  picks the concrete format at load time from what the device reports, so one asset serves ASTC
  (mobile), ETC2, BC/DXT (desktop) and PVRTC without shipping four files.
- **UASTC** — higher quality, larger. Use it where precision matters: **normal maps**, and any
  colour map where ETC1S banding is visible.
- **ETC1S** — much smaller, lower quality. Use it for colour maps that tolerate it. It is the
  wrong choice for normal maps: ETC1S quantises aggressively, and a quantised normal reads as
  faceted lighting rather than as a slightly blurry texture.

## Conversion pipeline

Use the `@gltf-transform/cli` package. It also needs
[KTX-Software](https://github.com/KhronosGroup/KTX-Software/) on `PATH` — the `uastc` and `etc1s`
commands shell out to `toktx`.

```bash
npm install --save-dev @gltf-transform/cli
```

**Both commands take a glTF/GLB in and write a glTF/GLB out.** They compress the textures *inside*
the model and record `KHR_texture_basisu`; they do not emit loose `.ktx2` files. Writing
`output.ktx2` as the second argument produces a glTF file with a misleading extension.

### UASTC — higher quality, larger

```bash
gltf-transform uastc input.glb output.glb \
  --level 4 \
  --rdo \
  --rdo-lambda 0.5 \
  --zstd 18
```

- `--level 0..4` (default `2`) — encoder speed/quality tradeoff, 43.45 dB at 0 up to 48.24 dB at 4.
- `--rdo` enables RDO post-processing; `--rdo-lambda` (default `1`) scales it. Lower is higher
  quality and larger. The tool's own guidance for **normal maps is `0.25`–`0.75`**.
- `--zstd 1..22` (0 = off) supercompresses the result. Levels above 20 need substantially more
  memory to decompress — 21 wants a 67 MB window — so 18 is a better default than 22.
- `--pattern <glob>` / `--slots <glob>` restrict which textures are touched, which is how you apply
  UASTC to normal maps and ETC1S to everything else in two passes.

### ETC1S — smaller, lower quality

```bash
gltf-transform etc1s input.glb output.glb \
  --quality 200 \
  --compression 2
```

- `--quality 1..255` (default `128`) — higher is better quality and larger. `1` is the *minimum*,
  not a preset.
- `--compression 0..5` (default `1`) — encoding speed vs quality. Try `--quality` first.
- `--rdo` is on by default here; `--rdo-threshold` (default `1.25`, try 1.0–3.0) overrides
  `--quality` when set.

### Two-pass: UASTC for normal maps, ETC1S for the rest

```bash
gltf-transform uastc model.glb pass1.glb --slots "{normalTexture}" --level 4 --rdo --rdo-lambda 0.5
gltf-transform etc1s pass1.glb final.glb --slots "!{normalTexture}" --quality 200
```

### Checking the result

```bash
gltf-transform inspect final.glb
```

The textures table reports the resulting format and size per texture, which is the only reliable
way to confirm the pass did what you expected.

## File placement

KTX2 data lives inside the `.glb` files in `public_html/images/3d/`.

**Note:** `public_html/images/3d/` is **gitignored** — the 3D assets are uploaded to the server
separately and are not committed. This is intentional:

1. They are large binary assets, better suited to a CDN or static file server.
2. They can be regenerated from the source models at any time.
3. CI therefore has none of them. Every rack and server GLB 404s in the Playwright fixture, which
   is why the E2E suite can measure draw calls but cannot verify shadow casting. See
   `docs/dc_shadows.md` and `.claude/rules/js-tests.md`.

## three.js integration

`dc.js` registers `KTX2Loader` on the shared `GLTFLoader` instance at startup:

```javascript
const loaderGltf = new GLTFLoader();
loaderGltf.setMeshoptDecoder(MeshoptDecoder); // EXT_meshopt_compression (mesh geometry)

loaderGltf.ktx2Loader = new KTX2Loader();
loaderGltf.ktx2Loader.setTranscoderPath('/lib/three/examples/jsm/libs/basis/');
loaderGltf.ktx2Loader.detectSupport(renderer);
```

`public_html/lib` is a symlink to the repository's `node_modules/`, which is what makes that
absolute path resolve — the transcoder is served from the installed three.js package rather than
being copied into the tree.

That symlink is created by `package.json`'s `ensure-lib-symlink` script (run from `postinstall`,
and explicitly in CI) and is **not** in git, so it has to exist on every checkout and every deploy.

This path used to read `/node_modules/…`, which resolved only on machines where someone had
hand-made a *second*, undocumented symlink at `public_html/node_modules`. Nothing created it — so
on a clean deploy the transcoder was a 404, and a missing transcoder does not announce itself:
`KTX2Loader` simply fails to decode and every compressed texture silently disappears. CI caught it
once the assertions were resolved against the filesystem instead of matched as text. Everything
else the page loads — three.js, lil-gui, three-mesh-bvh — already went through `/lib/`.

### What `detectSupport(renderer)` actually does

It asks the renderer which **compressed texture formats the device supports** and records them in
`workerConfig`, so the transcoder knows what to transcode *to*. It does not select between a WASM
and a non-WASM path:

| renderer | how support is probed |
|---|---|
| `WebGPURenderer` | `renderer.hasFeature('texture-compression-astc' \| '-etc2' \| '-bc' \| …)` |
| `WebGLRenderer` | `renderer.extensions.has('WEBGL_compressed_texture_astc' \| '_etc' \| '_s3tc' \| 'EXT_texture_compression_bptc' \| …)` |

**The Basis WASM transcoder is used on every path**, WebGPU included:
`KTX2Loader.js` resolves `basis_transcoder.wasm` and `basis_transcoder.js` unconditionally and runs
them in a worker. There is no native GPU transcoding of Basis Universal in any browser API. A
previous version of this document claimed WebGPU needed no WASM; it does.

On the node renderer, `detectSupport()` must be called **after `await renderer.init()`** — the
feature list does not exist until the device has been acquired. `dc.js`'s `init()` is `async` for
this and several related reasons; see `docs/dc_renderer_modes.md`.

## Server configuration

`public_html/images/.htaccess` serves the 3D assets with:

- `AddType image/ktx2 ktx2`
- `<FilesMatch "\.(glb|gltf|ktx2|drc|bin)$">` → `Cache-Control: public, max-age=31536000, immutable`
- `ExpiresByType image/ktx2 "access plus 1 year"`

Long-lived immutable caching is safe because the assets are content-stable once generated: a
regenerated asset is deployed under a new name rather than overwritten.

## See also

- `docs/dc_renderer_modes.md` — renderer capabilities, and why `init()` ordering matters
- `docs/dc_shadows.md` — what the missing CI assets mean for test coverage
