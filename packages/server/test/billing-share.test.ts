import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { billingStatus, handleStripeWebhook, periodChargeCents, recordCaseProcessed, unitPriceCents, assertCanProcess } from "../src/billing.js";
import { createCase, publishRevision } from "../src/cases.js";
import { db, withSystem } from "../src/db/client.js";
import { cases, organizations, revisions, shareLinks } from "../src/db/schema.js";
import { checkPinGrant, createShareLink, listShareLinks, recordShareView, resolveShare, revokeShareLink, ShareUnavailable, verifySharePin } from "../src/share.js";
import { decide } from "../src/review.js";
import { addMember, newOrg } from "./helpers.js";

describe("pricing", () => {
  it("applies volume tiers: ≤50 $5, 51–149 $4, 150+ $3.50", () => {
    expect(unitPriceCents(1)).toBe(500);
    expect(unitPriceCents(50)).toBe(500);
    expect(unitPriceCents(51)).toBe(400);
    expect(unitPriceCents(80)).toBe(400);
    expect(unitPriceCents(150)).toBe(350);
    expect(periodChargeCents(80)).toBe(32_000);
    expect(periodChargeCents(200)).toBe(70_000);
    expect(periodChargeCents(0)).toBe(0);
  });
});

describe("plan limits", () => {
  it("trial allows up to the case limit, then requires a subscription; one unit per case", async () => {
    const o = await newOrg();
    await db().update(organizations).set({ subscriptionStatus: "trialing", trialCaseLimit: 2 }).where(eq(organizations.id, o.orgId));
    const c1 = await createCase(o.ctx, { patientReference: "T1" });
    const c2 = await createCase(o.ctx, { patientReference: "T2" });
    expect(await recordCaseProcessed(o.orgId, c1.id)).toBe(true);
    expect(await recordCaseProcessed(o.orgId, c1.id)).toBe(false); // a second revision is not billed again
    await assertCanProcess(o.orgId);
    await recordCaseProcessed(o.orgId, c2.id);
    const s = await billingStatus(o.orgId);
    expect(s.status).toBe("trial_exhausted");
    await expect(assertCanProcess(o.orgId)).rejects.toThrow(/trial includes 2 cases/);
    await db().update(organizations).set({ trialEndsAt: new Date(Date.now() - 1000), trialCaseLimit: 100 }).where(eq(organizations.id, o.orgId));
    await expect(assertCanProcess(o.orgId)).rejects.toThrow(/trial has ended/);
  });
});

describe("Stripe webhooks", () => {
  const stripe = new Stripe("sk_test_dummy");
  const sign = (payload: string) => stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_test_secret" });

  it("rejects bad signatures and processes each event exactly once", async () => {
    const o = await newOrg();
    await db().update(organizations).set({ subscriptionStatus: "trialing", stripeCustomerId: "cus_123" }).where(eq(organizations.id, o.orgId));
    const event = { id: `evt_${Date.now()}`, object: "event", type: "checkout.session.completed", data: { object: { id: "cs_1", object: "checkout.session", client_reference_id: o.orgId, customer: "cus_123", subscription: "sub_1" } } };
    const payload = JSON.stringify(event);
    await expect(handleStripeWebhook(payload, "t=1,v1=bad")).rejects.toThrow(/signature/);
    expect(await handleStripeWebhook(payload, sign(payload))).toEqual({ duplicate: false, type: "checkout.session.completed" });
    const [org] = await db().select().from(organizations).where(eq(organizations.id, o.orgId));
    expect(org.subscriptionStatus).toBe("active");
    expect(org.setupFeePaidAt).not.toBeNull();
    // duplicate delivery → acknowledged, not re-applied
    await db().update(organizations).set({ subscriptionStatus: "canceled" }).where(eq(organizations.id, o.orgId));
    expect(await handleStripeWebhook(payload, sign(payload))).toEqual({ duplicate: true, type: "checkout.session.completed" });
    expect((await db().select().from(organizations).where(eq(organizations.id, o.orgId)))[0].subscriptionStatus).toBe("canceled");
    // subscription lifecycle
    const del = JSON.stringify({ id: `evt_del_${Date.now()}`, object: "event", type: "customer.subscription.updated", data: { object: { id: "sub_1", object: "subscription", customer: "cus_123", status: "past_due" } } });
    await handleStripeWebhook(del, sign(del));
    expect((await db().select().from(organizations).where(eq(organizations.id, o.orgId)))[0].subscriptionStatus).toBe("past_due");
  });
});

async function approvedRevision() {
  const o = await newOrg();
  const doc = await addMember(o.orgId, "doctor", "Smith");
  const c = await createCase(o.ctx, { patientReference: "S-1", patientDisplayName: "Maria Lopez", doctorUserId: doc.user.id });
  const [rev] = await withSystem((tx) => tx.insert(revisions).values({ orgId: o.orgId, caseId: c.id, number: 1, status: "doctor_review", packagePrefix: `orgs/${o.orgId}/x` }).returning());
  await decide(doc.ctx, rev.id, "approved");
  return { o, doc, c, rev };
}

describe("approvals", () => {
  it("are revision-specific, record the approver, and only the doctor decides", async () => {
    const o = await newOrg();
    const doc = await addMember(o.orgId, "doctor");
    const tech = await addMember(o.orgId, "technician");
    const c = await createCase(o.ctx, { patientReference: "AP-1", doctorUserId: doc.user.id });
    const [r1] = await withSystem((tx) => tx.insert(revisions).values({ orgId: o.orgId, caseId: c.id, number: 1, status: "doctor_review" }).returning());
    await expect(decide(tech.ctx, r1.id, "approved")).rejects.toThrow(/Only the doctor/);
    await expect(decide(doc.ctx, r1.id, "changes_requested")).rejects.toThrow(/describe the changes/);
    await decide(doc.ctx, r1.id, "changes_requested", "Please add attachments on 13");
    expect((await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id))))[0].status).toBe("changes_requested");
    await expect(decide(doc.ctx, r1.id, "approved")).rejects.toThrow(/not awaiting review/);
    const [r2] = await withSystem((tx) => tx.insert(revisions).values({ orgId: o.orgId, caseId: c.id, number: 2, status: "doctor_review" }).returning());
    await decide(doc.ctx, r2.id, "approved");
    const [row] = await withSystem((tx) => tx.select().from(revisions).where(eq(revisions.id, r2.id)));
    expect(row.status).toBe("approved");
    expect(row.approvedBy).toBe(doc.user.id);
    expect(row.approvedAt).toBeInstanceOf(Date);
    await publishRevision(o.ctx, r2.id);
    expect((await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id))))[0].status).toBe("published");
  });
});

describe("share links", () => {
  it("resolve only for valid tokens; ids never appear in the URL", async () => {
    const { o, rev, c } = await approvedRevision();
    const link = await createShareLink(o.ctx, { revisionId: rev.id });
    const token = link.url.split("/setup/")[1];
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(link.url).not.toContain(rev.id);
    expect(link.url).not.toContain(c.id);
    const s = await resolveShare(token);
    expect(s.revisionId).toBe(rev.id);
    expect(s.patientName).toBe("Maria");
    expect(s.doctorName).toBe("Dr Smith");
    await expect(resolveShare("x".repeat(43))).rejects.toBeInstanceOf(ShareUnavailable);
    expect((await listShareLinks(o.ctx, c.id))[0].url).toBe(link.url); // staff can copy again
  });

  it("expire, can be revoked, and require the PIN when set", async () => {
    const { o, rev, c } = await approvedRevision();
    const expiring = await createShareLink(o.ctx, { revisionId: rev.id, expiresAt: new Date(Date.now() + 60_000) });
    const tExp = expiring.url.split("/setup/")[1];
    await resolveShare(tExp);
    await withSystem((tx) => tx.update(shareLinks).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(shareLinks.id, expiring.id)));
    await expect(resolveShare(tExp)).rejects.toMatchObject({ reason: "expired", status: 410 });
    await expect(createShareLink(o.ctx, { revisionId: rev.id, expiresAt: new Date(Date.now() - 1000) })).rejects.toThrow(/future/);

    const pinned = await createShareLink(o.ctx, { revisionId: rev.id, pin: "4821" });
    const tPin = pinned.url.split("/setup/")[1];
    expect((await resolveShare(tPin)).pinRequired).toBe(true);
    await expect(verifySharePin(tPin, "0000", "5.5.5.5")).rejects.toThrow(/not correct/);
    const grant = await verifySharePin(tPin, "4821", "5.5.5.5");
    expect(checkPinGrant(pinned.id, grant)).toBe(true);
    expect(checkPinGrant(expiring.id, grant)).toBe(false);

    await revokeShareLink(o.ctx, pinned.id);
    await expect(resolveShare(tPin)).rejects.toMatchObject({ reason: "revoked" });

    const open = await createShareLink(o.ctx, { revisionId: rev.id });
    await publishRevision(o.ctx, rev.id);
    await recordShareView(await resolveShare(open.url.split("/setup/")[1]));
    expect((await withSystem((tx) => tx.select().from(cases).where(eq(cases.id, c.id))))[0].status).toBe("patient_viewed");
  });

  it("cannot be created before approval", async () => {
    const o = await newOrg();
    const c = await createCase(o.ctx, { patientReference: "N-1" });
    const [rev] = await withSystem((tx) => tx.insert(revisions).values({ orgId: o.orgId, caseId: c.id, number: 1, status: "ready_for_review" }).returning());
    await expect(createShareLink(o.ctx, { revisionId: rev.id })).rejects.toThrow(/once the plan is approved/);
  });
});
