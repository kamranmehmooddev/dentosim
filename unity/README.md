# DentoSim Unity WebGL viewer (production)

The production 3D viewer. The web app (`apps/web`) loads the WebGL build and drives
it through `packages/viewer-core/src/unity-engine.ts`; all UI chrome (controls,
tooth info, disclaimer, branding) is React, Unity renders the scene only.

## Data flow

1. The page fetches short-lived signed URLs for the immutable package, decodes TSM2
   in JavaScript (`@dentosim/viewer-core`, meshoptimizer) and caches/prefetches stages.
2. `SendMessage("DentoSimBridge", "SetStage", {slot, jaw, key, parts})` announces a stage.
3. C# (`MeshLibrary`) allocates arrays and calls the jslib `DentoSim_CopyPart`, which
   copies positions/normals/indices straight into the Unity heap — no parsing in C#.
   Meshes are cached per `jaw:stage` (70 entries) so playback at 4×/8× only swaps renderers.
4. Taps are ray-picked in C# and emitted back (`DentoSim_Emit`) as `toothTap` events;
   screenshots are rendered off-screen and returned as PNG bytes.

Coordinates: DentoSim frame (right-handed, +X patient left, +Y up, +Z anterior) →
Unity: X negated, winding reversed (see `docs/coordinate-system.md`).

## Messages (JS → Unity)

| Method | Payload |
|---|---|
| `SetStage` | `{ slot: 0|1, jaw, key|null, parts: [{ index, id, kind, fdi, vertexCount, indexCount }] }` |
| `SetScan` | `{ jaw, key|null, parts }` — translucent scan overlay |
| `SetCompare` | `"single" | "side-by-side" | "overlay"` |
| `SetView` | `{ view: front|right|left|upper-occlusal|lower-occlusal|both-occlusal, animate }` |
| `SetJawOpening` | `{ angleRad, point: [x,y,z], axis }` — hinge behind the last lower molars |
| `SetAppearance` | `{ gumColor, showAttachments, highlightToothId }` |
| `SetTheme` | `{ background, gumColor }` — tenant branding |
| `TakeScreenshot` | `""` |

## Build

Requires Unity **2022.3 LTS** with the WebGL module.

```bash
Unity -batchmode -quit -projectPath unity/DentoSimViewer \
  -executeMethod DentoSim.EditorTools.BuildWebGL.Build \
  -buildOutput /path/to/output/viewer-1.0.0
```

Upload the output (`Build/DentoSim.loader.js|data|framework.js|wasm`) to a static
host/CDN (serve `.wasm` as `application/wasm`; enable Brotli/Gzip at the CDN) and set
`UNITY_BUILD_URL=https://cdn…/viewer-1.0.0` for the web app. Version the folder name
so builds are immutable and cacheable.

## Status

This project was written without access to a Unity editor in the build environment,
so it has **not been built with Unity yet**. The runtime scripts were type-checked with
the .NET compiler against stubs of the Unity APIs they use (catches C# errors, not
Unity behaviour). The same `Engine` contract is implemented and
tested end-to-end by the Three.js development viewer (`apps/web/src/components/viewer/ThreeEngine.ts`,
Playwright screenshots of stage 00 and the final stage). Before release, build it
in CI with a Unity licence and run the same Playwright suite with `UNITY_BUILD_URL` set.
