import { billingStatus, config, getOrg, PRICING_TIERS, SETUP_FEE_CENTS } from "@dentosim/server";
import { Badge, Card, fmtDate } from "@/components/ui";
import { ActionButton } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Billing" };
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default async function Billing({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const ctx = await requirePageAuth();
  const [s, org] = await Promise.all([billingStatus(ctx.org.id), getOrg(ctx.org.id)]);
  const sp = await searchParams;
  const enabled = !!config().STRIPE_SECRET_KEY;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      {sp.checkout === "success" && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Thanks! Your subscription is being activated.</p>}
      <Card title="Plan" actions={<Badge tone={s.canProcess ? "green" : "amber"}>{s.status.replace("_", " ")}</Badge>}>
        <dl className="grid grid-cols-2 gap-2 text-sm" data-testid="billing-status">
          {s.status === "trialing" || s.status.startsWith("trial") ? (
            <>
              <dt className="text-stone-500">Free trial</dt><dd>{s.trialCasesUsed} / {s.trialCaseLimit} cases · ends {fmtDate(s.trialEndsAt)}</dd>
            </>
          ) : (
            <>
              <dt className="text-stone-500">Cases this month</dt><dd>{s.casesThisMonth}</dd>
              <dt className="text-stone-500">Current rate</dt><dd>{usd(s.unitPriceCents)} per case</dd>
              <dt className="text-stone-500">Estimated this month</dt><dd>{usd(s.estimatedChargeCents)}</dd>
            </>
          )}
          <dt className="text-stone-500">Private-label setup</dt><dd>{s.setupFeePaid ? "paid" : `${usd(SETUP_FEE_CENTS)} one-time, billed with your first invoice`}</dd>
        </dl>
        {s.reason && <p className="mt-3 text-sm text-amber-800">{s.reason}</p>}
        {ctx.role === "admin" && (
          <div className="mt-4 flex gap-2">
            {enabled ? (
              <>
                {org.subscriptionStatus !== "active" && <ActionButton url="/api/billing/checkout" variant="primary">Subscribe</ActionButton>}
                {org.stripeCustomerId && <ActionButton url="/api/billing/portal">Manage payment & invoices</ActionButton>}
              </>
            ) : <p className="text-sm text-stone-500">Online billing is not configured on this server.</p>}
          </div>
        )}
      </Card>
      <Card title="Pricing">
        <p className="mb-3 text-sm text-stone-600">Pay only for processed cases. One charge per case, however many revisions it needs. Your monthly volume sets the rate for every case that month.</p>
        <table className="text-sm"><tbody>
          {PRICING_TIERS.map((t, i) => (
            <tr key={i}><td className="pr-6 text-stone-600">{i === 0 ? `Up to ${t.upTo} cases` : Number.isFinite(t.upTo) ? `${PRICING_TIERS[i - 1].upTo + 1}–${t.upTo} cases` : `${PRICING_TIERS[i - 1].upTo + 1}+ cases`}</td><td className="font-medium tabular">{usd(t.unitCents)} / case</td></tr>
          ))}
          <tr><td className="pr-6 text-stone-600">One-time setup / private label</td><td className="font-medium">{usd(SETUP_FEE_CENTS)}</td></tr>
        </tbody></table>
      </Card>
    </>
  );
}
