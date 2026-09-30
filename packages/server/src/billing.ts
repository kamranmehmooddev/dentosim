/**
 * Billing: usage-based pricing per processed case, one-time private-label setup
 * fee, free trial, Stripe Checkout / Billing meters, duplicate-safe webhooks,
 * plan limits.
 *
 * Pricing (volume tiers per billing month — all cases in the month at one rate):
 *     1–50 cases   $5.00 / case
 *    51–149 cases  $4.00 / case
 *    150+ cases    $3.50 / case
 *    one-time setup / private-label fee  $30
 * Configure the same tiers on the Stripe Price (STRIPE_CASE_PRICE_ID,
 * billing_scheme=tiered, tiers_mode=volume, metered by STRIPE_METER_EVENT_NAME).
 */
import { and, count, eq, gte, isNull, sql } from "drizzle-orm";
import Stripe from "stripe";
import { audit } from "./audit.js";
import type { AuthContext } from "./auth.js";
import { config } from "./config.js";
import { db, withSystem, type Executor } from "./db/client.js";
import { organizations, usageRecords, users, webhookEvents } from "./db/schema.js";
import { AppError, badRequest, forbidden, paymentRequired } from "./errors.js";

export const PRICING_TIERS = [
  { upTo: 50, unitCents: 500 },
  { upTo: 149, unitCents: 400 },
  { upTo: Infinity, unitCents: 350 },
] as const;
export const SETUP_FEE_CENTS = 3000;

/** Volume pricing: the tier reached by the month's total applies to every case. */
export function unitPriceCents(casesInPeriod: number): number {
  return PRICING_TIERS.find((t) => casesInPeriod <= t.upTo)!.unitCents;
}

export function periodChargeCents(casesInPeriod: number): number {
  return casesInPeriod <= 0 ? 0 : casesInPeriod * unitPriceCents(casesInPeriod);
}

let stripeClient: Stripe | undefined;
export function stripe(): Stripe | null {
  const key = config().STRIPE_SECRET_KEY;
  if (!key) return null;
  stripeClient ??= new Stripe(key);
  return stripeClient;
}

export function setStripeForTests(s: Stripe | undefined): void {
  stripeClient = s;
}

export interface BillingStatus {
  status: "trialing" | "active" | "past_due" | "canceled" | "trial_expired" | "trial_exhausted";
  trialEndsAt: Date | null;
  trialCasesUsed: number;
  trialCaseLimit: number;
  casesThisMonth: number;
  estimatedChargeCents: number;
  unitPriceCents: number;
  setupFeePaid: boolean;
  canProcess: boolean;
  reason?: string;
}

function monthStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function billingStatus(orgId: string, exec: Executor = db()): Promise<BillingStatus> {
  const [o] = await exec.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const usage = await withSystem(async (tx) => {
    // trial allowance counts every processed case; the invoice counts billable (subscribed) ones
    const [all] = await tx.select({ n: count() }).from(usageRecords).where(eq(usageRecords.orgId, orgId));
    const [month] = await tx.select({ n: count() }).from(usageRecords).where(and(eq(usageRecords.orgId, orgId), eq(usageRecords.billable, true), gte(usageRecords.createdAt, monthStart())));
    return { all: Number(all.n), month: Number(month.n) };
  });
  const sub = o.subscriptionStatus;
  let status: BillingStatus["status"];
  let canProcess = true, reason: string | undefined;
  if (sub === "active") status = "active";
  else if (sub === "past_due") {
    status = "past_due";
    reason = "Your last payment failed. Please update your payment method.";
  } else if (sub === "canceled") {
    status = "canceled";
    canProcess = false;
    reason = "Your subscription is cancelled. Subscribe to process new cases.";
  } else if (o.trialEndsAt && o.trialEndsAt.getTime() < Date.now()) {
    status = "trial_expired";
    canProcess = false;
    reason = "Your free trial has ended. Subscribe to keep processing cases.";
  } else if (usage.all >= o.trialCaseLimit) {
    status = "trial_exhausted";
    canProcess = false;
    reason = `Your trial includes ${o.trialCaseLimit} cases. Subscribe to process more.`;
  } else status = "trialing";
  return {
    status,
    trialEndsAt: o.trialEndsAt,
    trialCasesUsed: usage.all,
    trialCaseLimit: o.trialCaseLimit,
    casesThisMonth: usage.month,
    estimatedChargeCents: status === "active" || status === "past_due" ? periodChargeCents(usage.month) : 0,
    unitPriceCents: unitPriceCents(Math.max(1, usage.month)),
    setupFeePaid: !!o.setupFeePaidAt,
    canProcess,
    ...(reason ? { reason } : {}),
  };
}

/** Plan limit gate — called before a new case/revision is uploaded. */
export async function assertCanProcess(orgId: string): Promise<void> {
  const s = await billingStatus(orgId);
  if (!s.canProcess) throw paymentRequired(s.reason ?? "Billing required.");
}

/**
 * Meter one processed case (idempotent: one unit per case, however many
 * revisions it gets). Reports to Stripe when the org is subscribed.
 */
export async function recordCaseProcessed(orgId: string, caseId: string): Promise<boolean> {
  const inserted = await withSystem(async (tx) => {
    const [o] = await tx.select({ sub: organizations.subscriptionStatus }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    const billable = o?.sub === "active" || o?.sub === "past_due";
    const rows = await tx.insert(usageRecords).values({ orgId, caseId, billable, kind: "case_processed" }).onConflictDoNothing().returning();
    return rows[0] ? { row: rows[0], billable } : null;
  });
  if (!inserted) return false;
  if (inserted.billable) await reportUsage(orgId, inserted.row.id).catch(() => undefined); // retried by reportPendingUsage
  return true;
}

async function reportUsage(orgId: string, usageId: string): Promise<void> {
  const s = stripe();
  const [o] = await db().select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!s || !o.stripeCustomerId) return;
  await s.billing.meterEvents.create({
    event_name: config().STRIPE_METER_EVENT_NAME,
    identifier: usageId, // Stripe de-duplicates on identifier
    payload: { stripe_customer_id: o.stripeCustomerId, value: "1" },
  });
  await withSystem((tx) => tx.update(usageRecords).set({ reportedAt: new Date() }).where(eq(usageRecords.id, usageId)));
}

/** Retry unreported usage (scheduled by the worker). */
export async function reportPendingUsage(): Promise<number> {
  if (!stripe()) return 0;
  const pending = await withSystem((tx) =>
    tx
      .select({ id: usageRecords.id, orgId: usageRecords.orgId })
      .from(usageRecords)
      .innerJoin(organizations, eq(organizations.id, usageRecords.orgId))
      .where(and(isNull(usageRecords.reportedAt), eq(usageRecords.billable, true), sql`${organizations.subscriptionStatus} in ('active','past_due')`))
      .limit(500),
  );
  for (const p of pending) await reportUsage(p.orgId, p.id).catch(() => undefined);
  return pending.length;
}

export async function createCheckout(ctx: AuthContext): Promise<string> {
  if (ctx.role !== "admin" || !ctx.org) throw forbidden("Only admins can manage billing.");
  const s = stripe();
  const c = config();
  if (!s || !c.STRIPE_CASE_PRICE_ID) throw new AppError(503, "BILLING_DISABLED", "Billing is not configured on this server.");
  const [o] = await db().select().from(organizations).where(eq(organizations.id, ctx.org.id)).limit(1);
  let customer = o.stripeCustomerId;
  if (!customer) {
    const [u] = await db().select().from(users).where(eq(users.id, ctx.user.id)).limit(1);
    customer = (await s.customers.create({ name: o.name, email: u.email, metadata: { orgId: o.id } })).id;
    await db().update(organizations).set({ stripeCustomerId: customer }).where(eq(organizations.id, o.id));
  }
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{ price: c.STRIPE_CASE_PRICE_ID }];
  if (!o.setupFeePaidAt && c.STRIPE_SETUP_FEE_PRICE_ID) lineItems.push({ price: c.STRIPE_SETUP_FEE_PRICE_ID, quantity: 1 });
  const trialEnd = o.trialEndsAt && o.trialEndsAt.getTime() > Date.now() + 48 * 3600_000 ? Math.floor(o.trialEndsAt.getTime() / 1000) : undefined;
  const session = await s.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: lineItems,
    client_reference_id: o.id,
    subscription_data: { metadata: { orgId: o.id }, ...(trialEnd ? { trial_end: trialEnd } : {}) },
    success_url: `${c.APP_URL}/settings/billing?checkout=success`,
    cancel_url: `${c.APP_URL}/settings/billing?checkout=cancelled`,
  });
  await audit({ orgId: o.id, actorType: "user", actorUserId: ctx.user.id, action: "billing.checkout_started" });
  return session.url!;
}

export async function createPortal(ctx: AuthContext): Promise<string> {
  if (ctx.role !== "admin" || !ctx.org) throw forbidden();
  const s = stripe();
  const [o] = await db().select().from(organizations).where(eq(organizations.id, ctx.org.id)).limit(1);
  if (!s || !o.stripeCustomerId) throw badRequest("No billing account yet.");
  return (await s.billingPortal.sessions.create({ customer: o.stripeCustomerId, return_url: `${config().APP_URL}/settings/billing` })).url;
}

/**
 * Stripe webhook handler. Verifies the signature, then records the event id
 * first: a duplicate delivery inserts nothing and is acknowledged without
 * re-processing.
 */
export async function handleStripeWebhook(rawBody: string, signature: string | null): Promise<{ duplicate: boolean; type: string }> {
  const secret = config().STRIPE_WEBHOOK_SECRET;
  const s = stripe() ?? new Stripe("sk_test_unused");
  if (!secret || !signature) throw badRequest("Missing webhook signature");
  let event: Stripe.Event;
  try {
    event = s.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw badRequest("Invalid webhook signature");
  }
  return db().transaction(async (tx) => {
    const inserted = await tx.insert(webhookEvents).values({ id: event.id, provider: "stripe", type: event.type }).onConflictDoNothing().returning();
    if (!inserted.length) return { duplicate: true, type: event.type };
    await applyStripeEvent(event, tx);
    await tx.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, event.id));
    return { duplicate: false, type: event.type };
  });
}

async function applyStripeEvent(event: Stripe.Event, tx: Executor): Promise<void> {
  const orgByCustomer = async (customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) => {
    const id = typeof customer === "string" ? customer : customer?.id;
    if (!id) return undefined;
    return (await tx.select().from(organizations).where(eq(organizations.stripeCustomerId, id)).limit(1))[0];
  };
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const orgId = session.client_reference_id;
      if (!orgId) return;
      await tx
        .update(organizations)
        .set({
          stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
          stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id,
          subscriptionStatus: "active",
          setupFeePaidAt: sql`coalesce(${organizations.setupFeePaidAt}, now())`,
        })
        .where(eq(organizations.id, orgId));
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const o = await orgByCustomer(sub.customer);
      if (!o) return;
      const status = event.type === "customer.subscription.deleted" ? "canceled" : sub.status === "trialing" ? "active" : sub.status === "active" ? "active" : sub.status === "past_due" || sub.status === "unpaid" ? "past_due" : "canceled";
      await tx.update(organizations).set({ subscriptionStatus: status, stripeSubscriptionId: sub.id }).where(eq(organizations.id, o.id));
      await audit({ orgId: o.id, actorType: "system", action: "billing.subscription_updated", metadata: { status } }, tx);
      break;
    }
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      const o = await orgByCustomer(inv.customer as string);
      if (o) await tx.update(organizations).set({ subscriptionStatus: "past_due" }).where(eq(organizations.id, o.id));
      break;
    }
    case "invoice.paid": {
      const inv = event.data.object as Stripe.Invoice;
      const o = await orgByCustomer(inv.customer as string);
      if (o && o.subscriptionStatus === "past_due") await tx.update(organizations).set({ subscriptionStatus: "active" }).where(eq(organizations.id, o.id));
      break;
    }
    default:
      break;
  }
}
