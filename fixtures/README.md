# Fixtures

Every sub-folder with an `expected.json` is run by the self-check
(`pnpm selfcheck`, the vitest suite, and the worker at start-up) through exactly
the same `processExport()` used in production.

```
fixtures/<name>/
├── expected.json     runs + expectations (committed)
├── export/ | export.zip   the upload (synthetic ones are generated, not committed)
└── mapping.json      optional: a confirmed manual mapping used by a run
```

## Synthetic fixtures (`"synthetic": true`)

Generated deterministically by `packages/pipeline/src/fixtures/catalog.ts`
(`pnpm fixtures`, or automatically by the self-check). They exercise export
**styles** — numbered folders, inches + print tilt, scans with a wrong bite, unlabeled
sequences, GLB scenes, per-tooth files, print layouts with fused molars, fused
single-shell arches, and unknown naming that must reach the mapping screen — using a
synthetic dentition. They deliberately do not imitate any vendor's format.

## Vendor fixtures

Real exports only (2–3 per vendor), with **all patient data removed** — file and
folder names, STL headers, XML/JSON/CSV metadata, embedded images. Commit the export
(or `export.zip`) and an `expected.json`; never set `"synthetic"`.

## expected.json

```json
{
  "input": "export",
  "runs": [
    { "name": "auto", "expect": { "status": "ready", "adapter": "generic", "arches": { "upper": 9, "lower": 7 } } },
    { "name": "manual", "mapping": "mapping.json", "expect": { "status": "ready" } },
    { "name": "template", "templateFromMapping": "mapping.json", "expect": { "status": "ready", "adapterPrefix": "template:" } }
  ]
}
```

Available expectation keys: `status`, `adapter`, `adapterPrefix`, `arches`,
`sourceUnits`, `interArch`, `segmentation`, `registration`, `compression`,
`warnings`, `noWarnings`, `anatomy`, `bite`, `fdiCount`, `minMovements`,
`minReasons` (see `packages/pipeline/src/selfcheck.ts`).
