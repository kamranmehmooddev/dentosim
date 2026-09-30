/**
 * Environment configuration (validated once). See .env.example at the repo root.
 */
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** public origin of the platform app, e.g. https://app.dentosim.cloud */
  APP_URL: z.string().url().default("http://localhost:3000"),
  /** tenants get <slug>.<APP_BASE_DOMAIN> (e.g. dentosim.cloud) */
  APP_BASE_DOMAIN: z.string().default("localhost"),
  /** 32+ byte secret for signing/encryption (session tokens, share tokens, local storage URLs, TOTP secrets) */
  APP_SECRET: z.string().min(32).default("dev-only-secret-change-me-dev-only-secret-change-me"),
  DATABASE_URL: z.string().default("postgres://dentosim:dentosim@localhost:5432/dentosim"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default(".data/storage"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  /** lifetime of signed storage URLs, seconds */
  SIGNED_URL_TTL: z.coerce.number().default(300),

  EMAIL_PROVIDER: z.enum(["console", "resend", "postmark"]).default("console"),
  EMAIL_FROM: z.string().default("DentoSim <no-reply@dentosim.cloud>"),
  RESEND_API_KEY: z.string().optional(),
  POSTMARK_TOKEN: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Stripe Price with volume tiers (metered via the meter below) */
  STRIPE_CASE_PRICE_ID: z.string().optional(),
  STRIPE_SETUP_FEE_PRICE_ID: z.string().optional(),
  STRIPE_METER_EVENT_NAME: z.string().default("dentosim_case_processed"),
  TRIAL_DAYS: z.coerce.number().default(14),
  TRIAL_CASE_LIMIT: z.coerce.number().default(10),

  SENTRY_DSN: z.string().optional(),
  /** upload limits */
  MAX_UPLOAD_BYTES: z.coerce.number().default(2 * 1024 * 1024 * 1024),
  MAX_UPLOAD_FILES: z.coerce.number().default(5000),
  /** worker sandbox */
  WORKER_CONCURRENCY: z.coerce.number().default(2),
  WORKER_MEMORY_MB: z.coerce.number().default(3072),
  WORKER_TIMEOUT_S: z.coerce.number().default(600),
  /** Unity WebGL build location (served statically); empty → dev viewer only */
  UNITY_BUILD_URL: z.string().optional(),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    cached = parsed.data;
    if (cached.NODE_ENV === "production" && cached.APP_SECRET.startsWith("dev-only")) throw new Error("APP_SECRET must be set in production");
  }
  return cached;
}

/** For tests: override values. */
export function setConfig(overrides: Partial<Config>): void {
  cached = { ...config(), ...overrides };
}
