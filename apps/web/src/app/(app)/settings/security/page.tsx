import { Card } from "@/components/ui";
import { TotpSetup } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Security" };

export default async function Security() {
  const ctx = await requirePageAuth();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
      <Card title="Two-factor authentication"><TotpSetup enabled={ctx.user.totpEnabled} /></Card>
    </>
  );
}
