import { ResetForm } from "@/components/auth/forms";

export const metadata = { title: "Choose a new password" };
export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return token ? <ResetForm token={token} /> : <p className="text-sm">This link is incomplete.</p>;
}
