# DentoSim coordinate system (`dentosim-v1`)

Every Canonical Case, every TSM2 file and every package uses one frame:

| Axis | Direction |
|------|-----------|
| **+X** | patient's **left** |
| **+Y** | **superior** (up) — the upper arch is above the lower arch |
| **+Z** | **anterior** — incisors point toward +Z |

* Right-handed (X × Y = Z). Units: **millimetres**.
* **Origin:** centre of the occlusal plane at stage 0 — X/Z at the centroid of the
  teeth, Y halfway between the upper and lower crown-tip levels (single-arch cases:
  at that arch's crown-tip level).
* The occlusal plane is the XZ plane (levelled from the principal axes of the teeth).
* Looking at the patient from the front, the viewer looks along −Z: +X appears on the
  viewer's right, +Y up.

Viewer presets map directly onto this frame: front (camera on +Z), right (camera on −X),
left (camera on +X), upper occlusal (camera on −Y looking up), lower occlusal
(camera on +Y looking down).

## Unity

Unity is left-handed. Import by negating **X** (`unity = (-x, y, z)`) and reversing
triangle winding (the same convention Unity's glTF importers use). The face still
points toward Unity +Z; the front camera sits on +Z looking along −Z, and the
patient's left (Unity −X) then appears on the right of the screen, as when facing a
person. The viewer's `Tsm2Loader` does this conversion.

## How exports are brought into this frame

1. **Units** — arch width (2–98 % extent along the main principal axis) is compared
   with the dental range (≈ 25–120 mm incl. bases); inches, centimetres and metres
   are converted.
2. **Registration** (only when patient scans are present) — each arch is moved rigidly
   onto its scan so the bite comes from the patient, not the export.
3. **Orientation** — for stage 0 of each arch:
   * occlusal normal = smallest principal axis of the teeth (or whole model);
   * anterior = the in-plane direction whose far end is narrow (incisors) and near end wide
     (molars);
   * crown direction = teeth centroid vs gums centroid (segmented) or, when unsegmented,
     the arch end with the smaller footprint (cusp tips vs base/gum rim);
   * upper crowns point −Y, lower crowns +Y; X = Y × Z (rotation only — never a mirror).
4. If the two arches of an export disagree (e.g. both printed base-down side by side),
   each arch is oriented on its own and they are placed in approximate occlusion; the
   case records `interArch: "reconstructed"` and a warning is shown.

The per-jaw 4×4 transforms applied (column-major) are stored in
`normalization.transforms` of the Canonical Case.
