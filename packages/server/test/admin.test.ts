import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { adminOrgs, adminProblemJobs, enforceRetention, impersonate } from "../src/admin.js";
import { getAuth } from "../src/auth.js";
import { createCase } from "../src/cases.js";
import { db, withSystem } from "../src/db/client.js";
import { auditLogs, cases, jobs, organizations, revisions, users } from "../src/db/schema.js";
import { decide } from "../src/review.js";
import { storage } from "../src/storage.js";
import { scrubEvent, scrubText } from "../src/telemetry.js";
import { addMember, newOrg } from "./helpers.js";

describe("platform admin", () => {
  it("only platform admins see the console; impersonation is audit-logged and cannot approve", async () => {
    const o = await newOrg("Tenant X");
    const staff = await newOrg("Staff");
    await expect(adminOrgs(o.ctx)).rejects.toThrow(/Platform administrators only/);
    await db().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, staff.userId));
    const admin = (await getAuth(staff.token))!;
    expect((await adminOrgs(admin)).some((x) => x.name === "Tenant X")).toBe(true);
    await expect(impersonate(admin, o.orgId, "")).rejects.toThrow(/reason/);
    const token = await impersonate(admin, o.orgId, "ticket #42");
    const imp = (await getAuth(token))!;
    expect(imp.impersonatorUserId).toBe(staff.userId);
    expect(imp.org?.id).toBe(o.orgId);
    const log = await db().select().from(auditLogs).where(eq(auditLogs.action, "admin.impersonation_started"));
    expect(log.some((l) => l.orgId === o.orgId && l.impersonatorUserId === staff.userId)).toBe(true);
    // an impersonated session cannot approve on the doctor's behalf
    const doc = await addMember(o.orgId, "doctor");
    const c = await createCase(o.ctx, { patientReference: "IMP-1", doctorUserId: doc.user.id });
    const [rev] = await withSystem((tx) => tx.insert(revisions).values({ orgId: o.orgId, caseId: c.id, number: 1, status: "doctor_review" }).returning());
    await expect(decide(imp as never, rev.id, "approved")).rejects.toThrow(/impersonating/);
    // impersonated sessions cannot open the admin console
    await expect(adminOrgs(imp)).rejects.toThrow();
    // failed jobs are listed with detection scores
    await withSystem((tx) => tx.insert(jobs).values({ orgId: o.orgId, revisionId: rev.id, status: "failed", errorCode: "MESH_PARSE", error: "x", detection: [{ adapter: "generic", version: "1.0.0", confidence: 0.2 }] }));
    const problems = await adminProblemJobs(admin);
    expect(problems.find((p) => p.revisionId === rev.id)?.detection).toEqual([{ adapter: "generic", version: "1.0.0", confidence: 0.2 }]);
  });
});

describe("retention", () => {
  it("hard-deletes cases (rows + storage) after the organisation's retention period", async () => {
    const o = await newOrg();
    await db().update(organizations).set({ retentionDays: 30 }).where(eq(organizations.id, o.orgId));
    const old = await createCase(o.ctx, { patientReference: "OLD" });
    const fresh = await createCase(o.ctx, { patientReference: "NEW" });
    await withSystem((tx) => tx.update(cases).set({ lastActivityAt: new Date(Date.now() - 40 * 86400_000) }).where(eq(cases.id, old.id)));
    const key = `orgs/${o.orgId}/cases/${old.id}/revisions/r/package/metadata.json`;
    await storage().put(key, new Uint8Array([1]));
    const other = await newOrg(); // no retention configured → untouched
    const keep = await createCase(other.ctx, { patientReference: "KEEP" });
    await withSystem((tx) => tx.update(cases).set({ lastActivityAt: new Date(Date.now() - 400 * 86400_000) }).where(eq(cases.id, keep.id)));
    expect(await enforceRetention()).toBe(1);
    const left = await withSystem((tx) => tx.select({ id: cases.id }).from(cases));
    expect(left.map((c) => c.id)).toContain(fresh.id);
    expect(left.map((c) => c.id)).toContain(keep.id);
    expect(left.map((c) => c.id)).not.toContain(old.id);
    await expect(storage().get(key)).rejects.toThrow();
  });
});

describe("telemetry PHI scrubbing", () => {
  it("removes emails, file names, tokens, request data and user details", () => {
    expect(scrubText('failed for jane@clinic.com "Maria_Lopez_upper.stl" token abcdefghijklmnopqrstuvwxyz0123456789')).toBe("failed for [email] [file] token [token]");
    const e = scrubEvent({ type: undefined, message: "x jane@x.com", request: { url: "https://a/setup/SECRET123?pin=1", data: "{}", cookies: {}, headers: { a: "b" } }, user: { id: "u1", email: "a@b.c" }, breadcrumbs: [] } as never);
    expect(e.request).toEqual({ url: "https://a/setup/[token]", headers: {} });
    expect(e.user).toEqual({ id: "u1" });
    expect(e.message).toBe("x [email]");
  });
});
