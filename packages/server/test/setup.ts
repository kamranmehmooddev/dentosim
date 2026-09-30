import { sql } from "drizzle-orm";
import { afterAll, beforeAll } from "vitest";
import { closeDb, db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { closeRedis, redis } from "../src/redis.js";
import { closeQueues } from "../src/queue.js";

beforeAll(async () => {
  await runMigrations();
  await db().execute(sql`truncate organizations, users, sessions, auth_tokens, invitations, audit_logs, webhook_events, email_outbox cascade`);
  await redis().flushdb();
});

afterAll(async () => {
  await closeQueues();
  await closeRedis();
  await closeDb();
});
