# DC Asset Pipeline — KTX2 Texture Compression

## Overview

The DataCenter 3D scene uses KTX2-compressed textures for efficient GPU-native texture transfer. KTX2 is a container format that wraps Basis Universal compressed texture data (UASTC or ETC1S), which the GPU can ingest directly without CPU decompression.

## Why KTX2?

- **GPU-native**: The transcoder (Basis Universal) produces data the GPU can upload directly
- **Better quality / smaller size** than alternatives like JPEG BC or DXT
- **UASTC**: Best quality, slightly larger files — suitable for color maps
- **ETC1S**: Smaller files, slightly lower quality — suitable for normal maps

## Conversion Pipeline

Use the `@gltf-transform/cli` package:

```bash
npm install --save-dev @gltf-transform/cli
```

### UASTC (higher quality, larger)

```bash
gltf-transform uastc input.glb output.ktx2 \
  --level 4 \
  --rdo-g 3.5 \
  --zstd 22
```

### ETC1S (smaller, lower quality)

```bash
gltf-transform etc1s input.glb output.ktx2 \
  --quality 1 \
  --split-threshold 0.5
```

### Re-encoding an existing GLB with embedded textures

```bash
# Extract textures first, then compress each one
gltf-transform uastc model_with_textures.glb compressed.glb
```

## File Placement

KTX2 files are placed in `public_html/images/3d/` alongside the `.glb` files.

**Note:** `public_html/images/3d/` is **gitignored** — KTX2 files are uploaded to the server separately and are not committed to the repository. This is intentional because:

1. KTX2 files are large binary assets better suited to a CDN or static file server
2. They can be regenerated from source `.glb` + texture files at any time
3. They are referenced by filename in the GLB, so the hosting arrangement must match the deployment

## Three.js Integration

`dc.js` registers `KTX2Loader` on the shared `GLTFLoader` instance at startup:

```javascript
const loaderGltf = new GLTFLoader();
loaderGltf.setMeshoptDecoder(MeshoptDecoder); // EXT_meshopt_compression (mesh geometry)

loaderGltf.ktx2Loader = new KTX2Loader();
loaderGltf.ktx2Loader.setTranscoderPath('/node_modules/three/examples/jsm/libs/basis/');
loaderGltf.ktx2Loader.detectSupport(renderer); // hardware transcoding support detection
```

The `detectSupport(renderer)` call probes the renderer for hardware support:
- **WebGPU**: Native GPU transcoding (no WASM needed)
- **WebGL2**: Uses the Basis Universal WASM transcoder via `ktx2Loader`
- **WebGL1**: Falls back to a more limited transcoding path

## Server Configuration

The `.htaccess` in `public_html/images/` already serves `.ktx2` files with:

- `Content-Type: image/ktx2`
- `Cache-Control: public, max-age=31536000, immutable` (verified for both Apache and LiteSpeed)
- Long-lived caching — KTX2 files are immutable once generated
