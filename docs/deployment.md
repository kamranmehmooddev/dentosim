# Deployment

## Components

| Component | Scale | Notes |
|---|---|---|
| `web` (Next.js) | 2+ replicas behind TLS load balancer | stateless; `docker run dentosim web` |
| `worker` | N replicas × `WORKER_CONCURRENCY` jobs | CPU-bound; ~4 GB RAM per concurrent job for 300 MB exports; `docker run dentosim worker` |
| PostgreSQL 16 | managed (RDS) | app role **not** superuser (RLS); PITR backups |
| Redis 7 | managed (ElastiCache) | BullMQ queues + rate limits; enable persistence |
| S3 bucket | private, SSE-KMS, versioning optional | CORS for PUT/GET from app origins, `ExposeHeaders: ETag` |
| Unity WebGL build | static CDN | versioned folder, `UNITY_BUILD_URL` |

## Steps

1. **Database**
   ```sql
   CREATE ROLE dentosim LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
   CREATE DATABASE dentosim OWNER dentosim;
   \c dentosim
   ALTER SCHEMA public OWNER TO dentosim;
   ```
   Then `docker run --env-file .env dentosim migrate` (applies schema + RLS policies).
2. **Bucket CORS** (S3):
   ```json
   [{ "AllowedOrigins": ["https://app.dentosim.cloud", "https://*.dentosim.cloud"],
      "AllowedMethods": ["GET", "PUT"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
   ```
   Custom tenant domains that host patient pages must be added to `AllowedOrigins`
   (or use `"*"` for GET only — URLs are signed and short-lived).
   Add a lifecycle rule to abort incomplete multipart uploads after 7 days.
3. **Environment**: copy `.env.example`; set `APP_URL`, `APP_BASE_DOMAIN`,
   `APP_SECRET` (48 random bytes), `DATABASE_URL`, `REDIS_URL`, `STORAGE_DRIVER=s3` +
   `S3_*`, email provider, Stripe keys, `SENTRY_DSN`, `UNITY_BUILD_URL`.
4. **DNS / TLS**: `app.<base>` and `*.<base>` → load balancer (wildcard certificate).
   Custom domains: tenants add CNAME → `app.<base>` and the TXT record shown in
   Settings → Domains; issue certificates on demand (e.g. Caddy on-demand TLS / AWS ALB
   with ACM per domain).
5. **Stripe**: create a Billing Meter (`dentosim_case_processed`, sum), a metered Price
   with volume tiers (1–50 $5, 51–149 $4, 150+ $3.50) and a one-time $30 Price; set
   `STRIPE_CASE_PRICE_ID`, `STRIPE_SETUP_FEE_PRICE_ID`; add a webhook to
   `https://app.<base>/api/webhooks/stripe` for `checkout.session.completed`,
   `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`.
6. **Viewer**: build `unity/DentoSimViewer` (see `unity/README.md`), upload to the CDN,
   set `UNITY_BUILD_URL`.
7. **Start** web and workers; `GET /api/health` checks DB + Redis. Workers with
   `WORKER_SELFCHECK=1` refuse to start if any fixture fails.
8. **Create the platform admin**: `docker run dentosim seed` (dev) or set
   `is_platform_admin = true` on your user.

## Local (docker compose)

```bash
cp .env.example .env
docker compose up --build
docker compose run --rm web seed    # optional demo users
open http://localhost:3000
```

Compose uses the local storage driver on a shared volume; use S3 in production.

## Capacity (measured)

On 4 vCPUs, one worker (concurrency 2): 10 concurrent uploads of a 293 MB export
(2.9 GB) completed at ~86 MB/s aggregate and all 10 cases were ready 145 s after the
start; a single 293 MB export processes in ~23 s. Scale workers horizontally for
throughput.
