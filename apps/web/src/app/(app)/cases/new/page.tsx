import { redirect } from "next/navigation";
import { listClinics, listDoctors } from "@dentosim/server";
import { Card } from "@/components/ui";
import { NewCaseForm } from "@/components/app/NewCaseForm";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "New case" };

export default async function NewCase() {
  const ctx = await requirePageAuth();
  if (ctx.role === "doctor") redirect("/doctor");
  const [doctors, clinics] = await Promise.all([listDoctors(ctx.org.id), listClinics(ctx.org.id)]);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New case</h1>
      <Card>
        <NewCaseForm doctors={doctors.map((d) => ({ id: d.userId, name: d.name }))} clinics={clinics.map((c) => ({ id: c.id, name: c.name }))} />
      </Card>
    </div>
  );
}
