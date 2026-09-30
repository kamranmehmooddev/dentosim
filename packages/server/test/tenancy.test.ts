/** Tenant isolation must hold at two layers: the service layer and Postgres RLS. */
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCase, getCaseDetail, listCases, startUpload, deleteCase } from "../src/cases.js";
import { db, withSystem, withTenant } from "../src/db/client.js";
import { cases, patients, revisions } from "../src/db/schema.js";
import { assertTenantKey, storage, tenantKey } from "../src/storage.js";
import { createShareLink } from "../src/share.js";
import { addMember, newOrg } from "./helpers.js";

describe("tenant isolation", () => {
  it("service layer: a tenant cannot read, list, upload to, share or delete another tenant's case", async () => {
    const a = await newOrg("Alpha Lab");
    const b = await newOrg("Beta Lab");
    const caseA = await createCase(a.ctx, { patientReference: "A-1" });
    await createCase(b.ctx, { patientReference: "B-1" });
    expect((await listCases(a.ctx)).map((c) => c.patientRef)).toEqual(["A-1"]);
    expect((await listCases(b.ctx)).map((c) => c.patientRef)).toEqual(["B-1"]);
    await expect(getCaseDetail(b.ctx, caseA.id)).rejects.toThrow(/not found/i);
    await expect(startUpload(b.ctx, caseA.id, [{ path: "x.stl", size: 10 }])).rejects.toThrow(/not found/i);
    await expect(deleteCase(b.ctx, caseA.id)).rejects.toThrow(/not found/i);
    const [rev] = await withSystem((tx) => tx.insert(revisions).values({ orgId: a.orgId, caseId: caseA.id, number: 1, status: "approved" }).returning());
    await expect(createShareLink(b.ctx, { revisionId: rev.id })).rejects.toThrow(/not found/i);
  });

  it("row-level security: without a tenant setting nothing is visible; with one only that tenant's rows", async () => {
    const a = await newOrg();
    const b = await newOrg();
    await createCase(a.ctx, { patientReference: "RLS-A" });
    await createCase(b.ctx, { patientReference: "RLS-B" });
    // plain connection, no app.org_id → RLS hides every tenant row
    expect((await db().select().from(patients)).length).toBe(0);
    // unfiltered query inside tenant A sees only A
    const seen = await withTenant(a.orgId, (tx) => tx.select().from(patients));
    expect(seen.map((p) => p.reference)).toEqual(["RLS-A"]);
    // writing a row for B while scoped to A violates the policy
    const err = await withTenant(a.orgId, (tx) => tx.insert(patients).values({ orgId: b.orgId, reference: "sneaky" })).catch((e) => e);
    expect(String(err.cause?.message ?? err.message)).toMatch(/row-level security/);
    // updates cannot reach B's rows either
    await withTenant(a.orgId, (tx) => tx.update(cases).set({ sourceSoftware: "x" }).where(eq(cases.orgId, b.orgId)));
    const bCases = await withTenant(b.orgId, (tx) => tx.select().from(cases));
    expect(bCases.every((c) => c.sourceSoftware === null)).toBe(true);
    // the app role is not a superuser and cannot bypass RLS
    const [role] = (await db().execute(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`)).rows as { rolsuper: boolean; rolbypassrls: boolean }[];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("doctors only see cases assigned to them", async () => {
    const a = await newOrg();
    const d1 = await addMember(a.orgId, "doctor", "One");
    const d2 = await addMember(a.orgId, "doctor", "Two");
    const c1 = await createCase(a.ctx, { patientReference: "D-1", doctorUserId: d1.user.id });
    await createCase(a.ctx, { patientReference: "D-2", doctorUserId: d2.user.id });
    expect((await listCases(d1.ctx)).map((c) => c.patientRef)).toEqual(["D-1"]);
    await expect(getCaseDetail(d2.ctx, c1.id)).rejects.toThrow(/not found/i);
  });

  it("storage keys are tenant-prefixed and foreign keys are rejected", async () => {
    const a = await newOrg();
    const b = await newOrg();
    const key = tenantKey(a.orgId, "cases", "x", "file.bin");
    expect(() => assertTenantKey(a.orgId, key)).not.toThrow();
    expect(() => assertTenantKey(b.orgId, key)).toThrow();
    expect(() => assertTenantKey(a.orgId, `orgs/${a.orgId}/../${b.orgId}/x`)).toThrow();
    await storage().put(key, new Uint8Array([1, 2, 3]));
    expect(await storage().get(key)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
