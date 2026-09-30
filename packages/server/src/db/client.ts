import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
/** a transaction handle (same query API as Db) */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

let pool: pg.Pool | undefined;
let database: Db | undefined;

export function db(): Db {
  if (!database) {
    pool = new pg.Pool({ connectionString: config().DATABASE_URL, max: 10 });
    database = drizzle(pool, { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

/**
 * Run `fn` inside a transaction scoped to one tenant. Row-level security only
 * exposes rows of `orgId`; inserts for another org are rejected by the policy.
 */
export async function withTenant<T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error("withTenant: invalid org id");
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Cross-tenant access for trusted system paths only: the worker, share-link
 * resolution, platform admin console, retention jobs, billing webhooks.
 */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export { schema };
