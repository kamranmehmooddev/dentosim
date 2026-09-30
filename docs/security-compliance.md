# Security, HIPAA and GDPR design

DentoSim processes patient dental models (PHI under HIPAA; personal / health data under
GDPR). This document lists the controls implemented in the code and the operational
requirements for a compliant deployment. It is not legal advice; a compliance review is
required before go-live.

## Data minimisation

* Patients are identified by a lab-chosen **reference** (e.g. `JD-1042`) and an optional
  first name for the greeting — no full names, dates of birth or contact data are required.
* Emails never contain PHI: case numbers and links only.
* Audit metadata stores ids only; IP addresses are stored as salted hashes.

## Encryption

* In transit: HTTPS only (HSTS header set); S3 over TLS.
* At rest: S3 objects written with `ServerSideEncryption: AES256` (use SSE-KMS by
  bucket policy for customer-managed keys); managed Postgres/Redis with storage
  encryption.
* Application-level: TOTP secrets and share tokens are encrypted with AES-256-GCM
  (key derived from `APP_SECRET`); passwords use argon2id (OWASP parameters); session
  tokens, share tokens and auth tokens are stored only as SHA-256 hashes.

## Access control

* Roles: lab admin, lab technician, doctor (assigned cases only), patient (token link,
  optional PIN, no account).
* Postgres row-level security on every tenant table + service-layer checks + tenant-
  prefixed storage keys (see `architecture.md`); proven by `tenancy.test.ts`.
* Short-lived signed storage URLs (`SIGNED_URL_TTL`, default 300 s); the viewer
  refreshes them transparently; original uploads are never exposed to viewers.
* Share links: 256-bit random tokens mapped internally to {tenant, case, revision};
  expiry, revocation, optional 4–8 digit PIN (argon2 hash, rate-limited, 12 h HMAC grant
  cookie). `Referrer-Policy: no-referrer` keeps tokens out of third-party logs.
* Optional TOTP second factor; impersonation by platform staff is time-limited (1 h),
  requires a reason, is audit-logged on both sides, shows a banner and cannot approve.
* CSRF: SameSite=Lax HttpOnly cookies + Origin check on state-changing requests.

## Audit log

Views, package downloads, shares (create/revoke/view/PIN failures), approvals and change
requests, uploads, mapping confirmations, publishing, deletions, retention deletions,
logins, password resets, 2FA changes, impersonation, billing changes. Visible to lab
admins (Settings → Data & retention).

## Retention and deletion

* Per-organisation retention (30–3650 days of inactivity) enforced nightly by the worker:
  database rows (cascade) **and** every stored object are hard-deleted.
* "Delete case" hard-deletes immediately; `hardDeleteOrganization` erases a tenant and
  users without other memberships (GDPR erasure / offboarding).
* Backups: configure point-in-time recovery with a retention window compatible with the
  erasure policy, and document it in the DPA.

## Upload hardening

File-count / per-file / total limits, zip-slip rejection, zip-bomb detection
(compression ratio + declared total), nesting depth, symlinks never followed, every mesh
must parse, pipeline runs in a separate process with memory and time limits, 7-Zip runs
with a timeout. Rate limits (Redis): login, signup, password reset, TOTP, share views,
share PINs, upload starts.

## Logging / monitoring

* Sentry (optional) with `sendDefaultPii: false` and a `beforeSend` scrubber that drops
  request bodies, cookies, headers, query strings, breadcrumbs and user details and
  redacts emails, model file names and tokens (`telemetry.ts`, tested).
* No analytics scripts are included on patient pages.

## Vendors (BAA / DPA)

Run on vendors that sign a BAA (HIPAA) and a DPA with SCCs (GDPR), e.g. AWS (RDS
PostgreSQL, ElastiCache Redis, S3, ECS/EKS), Postmark or Resend (email, no PHI in
content), Stripe (billing, no PHI), Sentry (scrubbed events; enable its data-scrubbing
and IP-address removal as well). Keep EU tenants in an EU region if required.
