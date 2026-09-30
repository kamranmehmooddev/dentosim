import { handleStripeWebhook } from "@dentosim/server";
import { route } from "@/lib/api";

/** Stripe webhooks: signature-verified, idempotent on the event id. */
export const POST = route(async ({ req }) => {
  const raw = await req.text();
  return handleStripeWebhook(raw, req.headers.get("stripe-signature"));
}, { public: true });
