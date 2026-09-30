# Architecture

```
 Browser (lab, doctor, patient)                          Object storage (S3, SSE)
 ┌──────────────────────────────┐   pre-signed parts   ┌───────────────────────────┐
 │ Next.js pages + React chrome │ ───────────────────► │ orgs/<org>/cases/<case>/  │
 │ Uploader (chunked, resumable)│                      │   revisions/<rev>/upload/ │
 │ Viewer: Unity WebGL (prod) / │ ◄─── signed GETs ─── │   revisions/<rev>/package/│
 │         Three.js (dev only)  │   (package only)     └────────────▲──────────────┘
 └──────────────┬───────────────┘                                   │
                │ JSON API (cookie session, CSRF origin check)      │ download upload /
 ┌──────────────▼───────────────┐   BullMQ (Redis)   ┌──────────────┴──────────────┐
 │ apps/web  (Next.js 16)        │ ─────────────────► │ apps/worker                  │
 │  route handlers → @dentosim/  │                    │  runProcessingJob            │
 │  server services              │                    │   └─ child process (heap +   │
 └──────────────┬───────────────┘                    │      time limit): pipeline   │
                │ withTenant / withSystem              └──────────────┬──────────────┘
         ┌──────▼──────────────────────────────────────────────────────▼──┐
         │ PostgreSQL (row-level security on every tenant table)           │
         └──────────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Role |
|---|---|
| `packages/canonical` | Canonical Case types + JSON Schema + validator |
| `packages/pipeline` | pure import/processing library: intake hardening, loaders, adapters, normalisation, segmentation, registration, TSM2, packaging, CLI, self-check, synthetic fixtures |
| `packages/server` | server core shared by web and worker: schema/migrations (RLS), tenancy, auth, storage, uploads, cases/revisions state machine, review, sharing, billing, email, audit, admin, retention, telemetry, processing job (`@dentosim/server/processing`) |
| `packages/viewer-core` | browser: TSM2 decoder, package client (signed-URL refresh, LRU cache, prefetch), playback controller, jaw hinge, Unity JS bridge |
| `apps/web` | Next.js App Router + Tailwind: all UI and the JSON API |
| `apps/worker` | BullMQ consumer, maintenance schedules, start-up self-check |
| `unity/DentoSimViewer` | production WebGL viewer (C#), driven by `viewer-core`'s `UnityEngine` |

## Flow

**Upload → Process → Validate → Publish → View.** The viewer consumes only the
immutable package; the original upload is never sent to a viewer.

1. `POST /api/cases/:id/uploads` creates revision N (status `uploading`) and one S3
   multipart upload per file; the browser PUTs 8 MB parts to pre-signed URLs (4 in
   parallel), reports each part (resume after reload), then completes.
2. Completion supersedes older unapproved revisions, sets the case to `processing` and
   enqueues a job (job id = row id → idempotent enqueue).
3. The worker downloads the files and runs `processExport` in a child process with
   `--max-old-space-size` and a wall-clock timeout. Outcomes:
   * `ready` → package stored under `…/package/`, summary (stages, fit, warnings,
     detection) saved, usage metered (one unit per case), lab notified;
   * `needs-mapping` → proposal + 3D thumbnails saved; the mapping screen confirms it,
     saves an org template and re-queues;
   * `failed` → human-readable reason; `INTERNAL` errors retried once.
4. Lab sends revision N to the doctor → doctor approves or requests changes (bound to
   that revision, with timestamp + approver) → lab publishes → share links.
5. Patient opens `/setup/<token>` (optional PIN) → signed package URLs → viewer.

## Case states

```
UPLOADED → PROCESSING → READY_FOR_REVIEW → DOCTOR_REVIEW → APPROVED → PUBLISHED → PATIENT_VIEWED
                 │ ↑                           │
                 │ └── NEEDS_MAPPING           └→ CHANGES_REQUESTED → (new revision) → PROCESSING
                 └→ FAILED (retry)
```

Revision statuses add `uploading` and `superseded`.

## Tenancy

* Tenant detection by hostname: `<slug>.<APP_BASE_DOMAIN>` or a verified custom domain
  (TXT `_dentosim.<host>`), used for branding of login/patient pages and share-link URLs.
* Every tenant row has `org_id`; tenant tables have Postgres RLS `FORCE`d with a policy on
  the transaction setting `app.org_id` (`withTenant`) or `app.bypass_rls` (`withSystem`,
  only for worker, share resolution, admin, retention, webhooks). Without a setting no
  tenant row is visible. The app role is not a superuser.
* Services additionally filter by `org_id` and role (doctors see assigned cases only).
* Storage keys are `orgs/<orgId>/…`; signed URLs are issued only after `assertTenantKey`.
* Tests: `packages/server/test/tenancy.test.ts`.

## Viewer engines

The React chrome talks to an `Engine` (`viewer-core/src/controls.ts`). `UnityEngine`
forwards commands to Unity via `SendMessage` and serves decoded meshes to C# through
the jslib (`unity/README.md`). `ThreeEngine` implements the same contract for
development, debugging and CI screenshots; it is only offered in production when
`DEV_VIEWER=1`.
