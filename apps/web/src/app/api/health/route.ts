import { sql } from "drizzle-orm";
import { db, redis } from "@dentosim/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, boolean> = {};
  try { await db().execute(sql`select 1`); checks.db = true; } catch { checks.db = false; }
  try { checks.redis = (await redis().ping()) === "PONG"; } catch { checks.redis = false; }
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks }, { status: ok ? 200 : 503 });
}
