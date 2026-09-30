import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="text-sm text-stone-600">This page does not exist or you do not have access to it.</p>
      <Link href="/" className="text-sm font-medium text-brand">Go home</Link>
    </main>
  );
}
