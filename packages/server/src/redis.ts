import { Redis } from "ioredis";
import { config } from "./config.js";
import { tooMany } from "./errors.js";

let client: Redis | undefined;

export function redis(): Redis {
  client ??= new Redis(config().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  return client;
}

export async function closeRedis(): Promise<void> {
  await client?.quit().catch(() => undefined);
  client = undefined;
}

export interface RateLimitRule {
  /** e.g. "login", "share-pin" */
  name: string;
  limit: number;
  windowS: number;
}

export const RATE_LIMITS = {
  login: { name: "login", limit: 10, windowS: 15 * 60 },
  signup: { name: "signup", limit: 5, windowS: 60 * 60 },
  passwordReset: { name: "pw-reset", limit: 5, windowS: 60 * 60 },
  totp: { name: "totp", limit: 10, windowS: 15 * 60 },
  shareView: { name: "share-view", limit: 120, windowS: 60 },
  sharePin: { name: "share-pin", limit: 8, windowS: 15 * 60 },
  upload: { name: "upload", limit: 600, windowS: 60 },
} satisfies Record<string, RateLimitRule>;

/**
 * Fixed-window counter in Redis. Throws AppError 429 when exceeded.
 * Returns the remaining allowance.
 */
export async function rateLimit(rule: RateLimitRule, subject: string): Promise<number> {
  const window = Math.floor(Date.now() / 1000 / rule.windowS);
  const key = `rl:${rule.name}:${subject}:${window}`;
  const r = redis();
  const n = await r.incr(key);
  if (n === 1) await r.expire(key, rule.windowS + 5);
  if (n > rule.limit) {
    const retry = rule.windowS - (Math.floor(Date.now() / 1000) % rule.windowS);
    throw tooMany(retry);
  }
  return rule.limit - n;
}

export async function resetRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const window = Math.floor(Date.now() / 1000 / rule.windowS);
  await redis().del(`rl:${rule.name}:${subject}:${window}`);
}
