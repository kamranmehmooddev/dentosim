import Link from "next/link";
import { AppError, verifyEmail } from "@dentosim/server";

export const metadata = { title: "Verify email" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  let ok = false, message = "This link is incomplete.";
  if (token)
    try {
      await verifyEmail(token);
      ok = true;
    } catch (e) {
      message = e instanceof AppError ? e.message : "Something went wrong.";
    }
  return (
    <div className="space-y-4 text-center">
      <h1 className="text-lg font-semibold">{ok ? "Email confirmed" : "Could not confirm email"}</h1>
      <p className="text-sm text-stone-600">{ok ? "Thanks — your email address is confirmed." : message}</p>
      <Link href="/dashboard" className="inline-block text-sm font-medium text-brand">Continue</Link>
    </div>
  );
}
