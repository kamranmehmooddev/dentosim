import { Suspense } from "react";
import { LoginForm } from "@/components/auth/forms";

export const metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const sp = await searchParams;
  return (
    <>
      {sp.reset && <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Password changed. Please sign in.</p>}
      <Suspense>
        <LoginForm />
      </Suspense>
    </>
  );
}
