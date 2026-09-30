# TSM2 — DentoSim compact mesh format (version 1)

One `.tsm2` file holds **one arch at one stage** (all its parts: gums, each tooth,
attachments, base) or one patient scan. It is designed to be decoded quickly in a
browser / Unity WebGL with the `meshoptimizer` decoder.

## Layout (little-endian)

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 4 | magic `"TSM2"` (ASCII) |
| 4 | 2 | `u16` format version = `1` |
| 6 | 2 | `u16` flags (reserved, `0`) |
| 8 | 4 | `u32` header byte length **H** (UTF-8 JSON, padded with spaces to a multiple of 4) |
| 12 | 4 | `u32` body byte length **B** |
| 16 | 4 | `u32` CRC-32 (IEEE 802.3, as zlib) of the body |
| 20 | H | header JSON |
| 20 + H | B | body |

A reader must reject files whose `20 + H + B` differs from the file size, and should
reject a CRC mismatch.

## Header JSON

```json
{
  "format": "TSM2",
  "version": 1,
  "units": "mm",
  "coordinateSystem": "dentosim-v1",
  "jaw": "upper",
  "stage": 3,
  "content": "stage",
  "bounds": { "min": [-31.2, -0.4, -22.9], "max": [31.0, 16.0, 30.8] },
  "parts": [
    {
      "id": "tooth-11",
      "kind": "tooth",
      "fdi": 11,
      "fdiEstimated": true,
      "vertexCount": 812,
      "triangleCount": 1620,
      "quantization": { "bits": 16, "offset": [x, y, z], "scale": [sx, sy, sz] },
      "vertices": { "encoding": "meshopt-vertex", "stride": 8, "byteOffset": 0, "byteLength": 3120 },
      "indices":  { "encoding": "meshopt-index", "indexSize": 4, "byteOffset": 3120, "byteLength": 2210 }
    }
  ]
}
```

* `kind`: `tooth | gums | attachment | base | arch` (`arch` = unsegmented model or scan).
* `id` is stable across stages for the same tooth/attachment, so the viewer can follow a
  tooth through the plan and show its cumulative movement.
* `procedural: true` marks illustrative gums generated for teeth-only exports.
* `content`: `"stage"` or `"scan"`.

## Body

For each part, in header order: the encoded vertex buffer, then the encoded index
buffer; every buffer starts on a 4-byte boundary (zero padding). Offsets are relative
to the start of the body.

**Vertices** — `vertexCount` × 8 bytes before encoding: `u16 x, u16 y, u16 z, u16 0`.
Decode with `meshopt_decodeVertexBuffer(dst, vertexCount, 8, src)` then

```
position = quantization.offset + q * quantization.scale     (per axis, float32)
```

Quantisation step is ≤ 0.0015 mm for an 80 mm arch.

**Indices** — triangle list of `u32`, decoded with
`meshopt_decodeIndexBuffer(dst, triangleCount * 3, 4, src)`. Winding is
counter-clockwise when seen from outside for closed shells produced by the pipeline;
viewers should render double-sided because exported shells may be open.

**Normals** are not stored; compute smooth vertex normals after decoding.

## Encoder (reference: `packages/pipeline/src/tsm2/tsm2.ts`)

1. Weld coincident vertices (STL stores every corner separately).
2. Simplify with meshoptimizer (`ErrorAbsolute`, default ≤ 0.03 mm, never below 20 % of
   the triangles).
3. Reorder for vertex cache / fetch (`reorderMesh`, strip-optimised for size).
4. Quantise to 16 bits over the part's bounding box and meshopt-encode.
5. Measure the reconstruction error both ways (trimmed mean of point-to-surface
   distances, 75 % kept) — the package records the worst part.

Targets: ≥ 5× smaller than the source binary STL; trimmed-mean error < 0.15 mm.
The 293 MB benchmark (`pnpm --filter @dentosim/pipeline bench`) yields ~57× and
0.007 mm (max 0.07 mm).

## Versioning

New optional header fields may be added within version 1; readers must ignore
unknown fields. Any change to the prelude or body encoding bumps the version.
