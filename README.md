# DentoSim

**Turn any clear-aligner treatment plan into a branded, interactive 3D patient experience.**
Import → Register → Review → Approve → Share.

DentoSim is a multi-tenant, white-label SaaS for clear-aligner companies, dental labs and
orthodontic groups. It does **not** plan treatment: it sits after any planning software as
the presentation, registration, approval and delivery layer.

```
Upload ──► Process ──► Validate ──► Publish ──► View
any export   sandboxed pipeline   immutable package   Unity WebGL viewer (lab, doctor, patient phone)
```

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Canonical Case schema, generic adapter, CLI, self-check | ✅ |
| 2 | Segmentation, bite registration, TSM2 compression, packaging | ✅ |
| 3 | Viewer: engine-agnostic core + controls; Unity WebGL project; Three.js dev viewer | ✅ code · ⚠️ Unity build not produced here (no Unity licence in this environment) |
| 4 | App core: auth, orgs, cases, chunked upload → worker → package → viewer, revisions, mapping screen + templates | ✅ |
| 5 | Vendor adapters | ⏳ waiting for 2–3 real sample exports per vendor (formats are never guessed); the generic adapter + mapping templates handle them meanwhile |
| 6 | Doctor portal, patient links (token, PIN, expiry, revoke, QR), notes, approvals, emails | ✅ |
| 7 | Stripe usage billing (new pricing), trial & plan limits, branding, custom domains | ✅ |
| 8 | Audit log, retention/hard delete, rate limits, PHI-safe telemetry, load test | ✅ |

## Repository layout

```
apps/
  web/          Next.js 16 (App Router) + Tailwind 4: UI + JSON API, Playwright e2e, load test
  worker/       BullMQ processing worker + maintenance schedules
packages/
  canonical/    Canonical Case types + JSON Schema
  pipeline/     pure import/processing library + CLI + self-check + synthetic fixtures
  server/       DB schema/migrations (RLS), tenancy, auth, storage, cases, review, sharing,
                billing, email, audit, admin, processing job
  viewer-core/  browser TSM2 decoder, package client, playback controller, Unity bridge
unity/          DentoSimViewer — production Unity WebGL viewer (C#)
fixtures/       self-check fixtures (expected.json per fixture)
docs/           architecture, coordinate system, Canonical Case, TSM2, adapters,
                security & compliance, deployment
```

## Quick start (development)

Requirements: Node ≥ 22, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env                      # set STORAGE_LOCAL_DIR to a writable folder

# database: the app role must NOT be a superuser (row-level security)
sudo -u postgres psql -c "CREATE ROLE dentosim LOGIN PASSWORD 'dentosim' NOSUPERUSER NOBYPASSRLS"
sudo -u postgres psql -c "CREATE DATABASE dentosim OWNER dentosim"
sudo -u postgres psql -d dentosim -c "ALTER SCHEMA public OWNER TO dentosim"

pnpm build                                # all packages + web
pnpm db:migrate && pnpm db:seed           # demo users, password dentosim-demo-2026
pnpm dev:worker                           # terminal 1
pnpm dev:web                              # terminal 2 → http://localhost:3000
```

Demo accounts: `admin@demo.local`, `tech@demo.local`, `doctor@demo.local`,
`platform@dentosim.local` (platform admin). Or sign up a new lab at `/signup`.

Docker: `docker compose up --build` (see [docs/deployment.md](docs/deployment.md)).

## Tests

```bash
# unit + integration (needs Postgres + Redis; test DB dentosim_test owned by the app role)
pnpm test
# end-to-end against the running stack (web on :3000 with DEV_VIEWER=1, worker running)
pnpm e2e
# 10 concurrent ~300 MB uploads through the API, then processing
pnpm loadtest -- --uploads 10 --stages 20
```

Current results:

| Suite | Result |
|---|---|
| `@dentosim/canonical` | 3 tests ✅ (schema) |
| `@dentosim/pipeline` | 72 tests ✅: loaders (all formats), upload hardening, filename/stage inference, detection scoring & ambiguity, templates, units, orientation, segmentation, registration (sub-0.1 mm, never mirrors), TSM2, packaging, **all 10 fixtures / 13 runs** |
| `@dentosim/viewer-core` | 3 tests ✅: browser decoder, signed-URL refresh, stage clamping, controller, hinge |
| `@dentosim/server` | 24 tests ✅: **tenant isolation (service + RLS)**, auth/TOTP/reset/invites, **share-link expiry/revoke/PIN**, approvals per revision, pricing tiers, trial limits, **Stripe webhooks (signature + duplicates)**, upload→process→package with the sandboxed worker, needs-mapping → template reuse, retention, impersonation, PHI scrubbing |
| Playwright e2e | 7 tests ✅: lab upload → ready (< 3 min) → **viewer screenshots of stage 00 and final** → doctor approves → publish → patient link with PIN **on a phone viewport**; unknown export → mapping screen → template; signup + branding; invalid links |
| Load test | 10 × 293 MB concurrent uploads (2.9 GB): ~86 MB/s aggregate, all ready in 145 s with one worker on 4 vCPUs |
| Pipeline benchmark | 293 MB export → 5.9 MB package in 23 s, 57× smaller, 0.007 mm trimmed-mean error |

## Pipeline CLI

```bash
cd packages/pipeline
pnpm cli <export> <outDir> [--adapter name] [--template t.json]... [--mapping m.json] [--overwrite] [--json]
pnpm cli detect <export>        # detection scores + proposed mapping
pnpm cli inspect <packageDir>   # summary + CRC-check every TSM2 file
pnpm selfcheck                  # every fixture (same code path as the worker)
pnpm bench                      # ~300 MB dense export end to end
```

## Product walkthrough

* **Lab** — dashboard (search, filter by state and source software) → *New case* (patient
  reference, doctor) → drop a .zip / folder / files (chunked, resumable, MB/s, stall
  detection) → live processing progress → viewer + fit statistics + warnings → *Send to
  doctor* → *Publish* → patient links (copy, QR, expiry, PIN, revoke, email).
  Unknown exports land on the **mapping screen** (3D thumbnails, role/arch/stage per file,
  drag to swap); the confirmed mapping becomes an organisation template.
* **Doctor** — `/doctor/cases/{caseId}`: viewer, fit statistics, original scans overlay,
  revision history, notes, **Approve plan / Request changes** for that revision only.
* **Patient** — `https://<tenant domain>/setup/{token}`: logo, “Your Treatment Simulation”,
  greeting, simplified viewer (play, initial/final, side by side, open mouth, bite view),
  “Treatment plan prepared by Dr …”, share, PNG; `?embed=1` for clinic iframes.
* **Viewer** — playback 1×/2×/4×/8×, prev/next/slider, initial/final, side-by-side
  (identical scale), overlay, front/left/right/upper/lower/two-arch occlusal views,
  upper/lower toggles, jaw opening (hinge behind the last molars, up to 20 mm,
  open/close/cycle), gum colour, attachments, tooth tap → FDI + cumulative movement,
  scans overlay, fullscreen, PNG, keyboard (Space, ←/→, Home/End, R, +/−), touch
  (one-finger orbit, two-finger pan/pinch), always-visible disclaimer.
* **Settings** — branding (name, colours, font, logo, favicon, email sender, gum colour,
  patient headline), members & invitations, clinics, custom domains (CNAME + TXT
  verification), billing, import templates, retention + audit log, 2FA.
* **Platform admin** — organisations & usage, failed/needs-mapping jobs with detection
  scores, retry, audit-logged impersonation.

## Pricing (implemented in `packages/server/src/billing.ts`)

Volume tiers per billing month, one unit per processed case (revisions are free):
1–50 cases **$5.00**, 51–149 **$4.00**, 150+ **$3.50** per case; one-time
setup / private-label fee **$30**; free trial (14 days / 10 cases, configurable).
The spec's “80 cases: $4” is interpreted as the 51–149 tier — **please confirm**.

## Configuration

All variables are documented in [.env.example](.env.example). Key ones:
`APP_URL`, `APP_BASE_DOMAIN`, `APP_SECRET`, `DATABASE_URL`, `REDIS_URL`,
`STORAGE_DRIVER` (+ `S3_*`), `EMAIL_PROVIDER` (+ keys), `STRIPE_*`, `SENTRY_DSN`,
`UNITY_BUILD_URL`, `WORKER_CONCURRENCY`, `WORKER_MEMORY_MB`, `WORKER_TIMEOUT_S`.

## Documentation

* [docs/architecture.md](docs/architecture.md) — components, flow, states, tenancy, viewer engines
* [docs/deployment.md](docs/deployment.md) — production deployment, S3 CORS, DNS/TLS, Stripe, capacity
* [docs/security-compliance.md](docs/security-compliance.md) — HIPAA/GDPR controls
* [docs/adapters.md](docs/adapters.md) — adapter contract, detection, generic inference, templates, vendor process, out-of-scope formats
* [docs/canonical-case.md](docs/canonical-case.md), [docs/coordinate-system.md](docs/coordinate-system.md), [docs/tsm2.md](docs/tsm2.md)
* [unity/README.md](unity/README.md) — production viewer bridge and build
* [fixtures/README.md](fixtures/README.md)

## Open items that need the product owner

1. **Vendor adapters (Phase 5)** — send 2–3 anonymised real exports per vendor and the
   priority order; each becomes an adapter + fixture.
2. **Unity build** — build `unity/DentoSimViewer` with a Unity 2022.3 licence (CI job
   included, `vars.BUILD_UNITY=true`), host it, set `UNITY_BUILD_URL`, and re-run the
   Playwright suite against it. Until then only the Three.js development viewer renders
   (enabled in production only with `DEV_VIEWER=1`).
3. **Pricing tier boundaries** (see above) and **branding assets** for the platform itself.
4. **Compliance**: sign BAAs/DPAs with the chosen hosting, email and monitoring vendors.

## Out of scope

Automatic treatment planning, AI tooth segmentation, contact analysis, IPR editing,
recorded jaw motion, proprietary/encrypted formats that need a vendor SDK or licence,
native mobile apps.
