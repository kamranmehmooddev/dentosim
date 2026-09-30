import { eq } from "drizzle-orm";
import { db, getInvitation, users } from "@dentosim/server";
import { InviteForm } from "@/components/auth/forms";

export const metadata = { title: "Accept invitation" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const found = token ? await getInvitation(token) : null;
  if (!token || !found) return <p className="text-sm text-stone-700">This invitation is invalid or has expired. Ask your administrator for a new one.</p>;
  const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, found.inv.email)).limit(1);
  return <InviteForm token={token} email={found.inv.email} orgName={found.orgName} existing={!!existing} />;
}
