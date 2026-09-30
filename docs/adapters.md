# Import adapters

DentoSim does not do treatment planning. It accepts the export of **any** aligner
planning software and converts it, through a modular adapter, into the
[Canonical Case](canonical-case.md).

## Contract

```ts
interface ImportAdapter {
  name: string;            // "generic", "template:<id>", "archform", …
  version: string;         // recorded on every case
  vendor: string;
  detect(ctx): { confidence: 0..1, reason }
  import(ctx): { kind: "case", case, mapping } | { kind: "needs-mapping", proposal, reasons, warnings }
}
```

`ctx` (`ImportContext`) gives cached access to every file of the upload and parses
meshes on demand (STL binary/ASCII, OBJ, PLY ascii/binary, 3MF, glTF/GLB — scene
formats keep their node names).

## Detection

1. Every registered adapter's `detect()` runs (vendor adapters, the organisation's
   saved mapping templates, the generic adapter).
2. The highest score **≥ 0.30** wins …
3. … unless the runner-up is **within 0.10** — then the result is ambiguous.
4. No winner or ambiguous → the **mapping screen**, pre-filled by the generic proposal.
   An unknown export never dead-ends.
5. Adapter name, version and **all** scores are recorded on the case
   (`source.detection`), and the admin console lists failed/needs-mapping jobs with
   their scores to prioritise new adapters.

The generic adapter is capped at 0.6 so that any vendor adapter that recognises its
export (vendors should score ≥ 0.8 on their own signatures) always wins.

## Generic adapter (fallback + export styles)

Handles, without vendor knowledge:

| Export style | Example |
|---|---|
| One full model per stage | `Maxillary/Maxillary_Stage_03.stl` |
| Numbered models, no stage list | `A/01.stl … A/20.stl` |
| Scene with stages as nodes | `treatment.glb` with nodes `Upper_Stage_3` (OBJ groups, 3MF objects too) |
| Separate tooth files per stage | `Setup 3/tooth_11.obj`, `Setup 3/gingiva.3mf` |

Inference, each with a recorded reason:

* **Jaw** — words in the file name, then folder names: upper / maxilla / maxillary /
  max / top / U / UJ / oberkiefer …, lower / mandible / mandibular / mand / bottom / L /
  LJ / unterkiefer … ; files next to files of one known jaw inherit it; otherwise
  **geometry**: an upper model covers the palate, a lower model has the tongue space.
  Geometry is trusted only when it separates the sequences cleanly (or the other jaw
  is already named).
* **Stage** — `stage3`, `step 3`, `s03`, `setup 3`, `aligner 3`, `03_of_21`, else the
  numeric field that **varies across files sharing a naming pattern**. A lone number in
  an unpatterned name is not trusted. `initial / malocclusion / pre / start / original`
  → stage 0, `final` → last.
* **Extras** — patient scans (`scan`, `ios`, `intraoral`; `bite`, `occlusion`, `buccal`
  → bite scan), attachment templates, retainers, bases/plinths, and ignorable files
  (thumbnails, reports, logos, OS junk).
* **Conflicts** — two different models for the same jaw + stage → mapping screen;
  byte-identical copies → the duplicate is ignored.

## Manual mapping screen and templates

The mapping screen lists every file (and scene node) with a 3D thumbnail and a
dropdown: upper/lower stage N, scan (upper/lower/bite), retainer, attachment template,
ignore. On confirm:

1. the case is built from the confirmed mapping (`manual-mapping` adapter);
2. the mapping is generalised into a **template** saved for the organisation: every
   digit run becomes `\d+`, the run that carried the stage number becomes a capture
   group, everything else must match literally; when two files differ only by digits,
   their digits stay literal.
3. The next export from the same software matches the template (confidence 0.95 when
   every file matches and every stage rule fires) and imports automatically.

## Vendor adapters — written only from real samples

**Formats are never guessed.** For each vendor we need **2–3 real exports** (with
patient data removed). Each adapter is written from those samples, and the samples
become fixtures in `fixtures/<vendor>-<n>/` with an `expected.json`, so the
self-check runs them identically locally, in CI and in the worker.

| Vendor | Status |
|---|---|
| Archform | awaiting sample exports |
| uLab | awaiting sample exports |
| OnyxCeph | awaiting sample exports |
| Maestro 3D | awaiting sample exports |
| 3Shape (OrthoAnalyzer / Clear Aligner Studio) | awaiting sample exports |
| SureSmile | awaiting sample exports |
| Blue Sky Plan | awaiting sample exports |
| Graphy / Nemo / Dolphin | awaiting sample exports |
| Generic numbered STL folder | ✅ `generic` adapter + 10 synthetic fixtures |

Until a vendor adapter exists, that vendor's exports go through the generic adapter
(most open exports are numbered STL/OBJ/PLY sets) or the mapping screen; once mapped,
the saved template handles the next export automatically.

### Checklist for a new vendor adapter

1. Put the anonymised samples in `fixtures/<vendor>-1/export/` (strip names, dates of
   birth, practice identifiers from file names, folder names, metadata/XML/JSON and
   STL headers).
2. Write `packages/pipeline/src/adapters/vendors/<vendor>.ts` implementing `detect`
   (score ≥ 0.8 only on that vendor's signature files/structure) and `import`.
3. Register it in `VENDOR_ADAPTERS` (`registry.ts`) with a semver version.
4. Add `expected.json` (stage counts, units, segmentation, warnings) and run
   `pnpm selfcheck`.

### Out of scope: proprietary / encrypted formats

Files that can only be read with the vendor's SDK or licence are not supported.
Labs should use the software's open export (STL/OBJ/PLY/3MF/glTF) instead. Examples
we expect to fall in this category — **to be confirmed against real samples**:

* encrypted 3Shape `.dcm` mesh files (3Shape's open exports are STL/PLY/OBJ);
* native project / case databases of any planning software (the files the application
  itself opens, as opposed to its export);
* any archive or mesh that is encrypted or licence-locked.

When such a file is uploaded, the validation step reports it as unreadable and the lab
is asked for the open export.
