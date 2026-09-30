import { listClinics, listMembers } from "@dentosim/server";
import { Badge, Card, fmtDate } from "@/components/ui";
import { ActionButton, ClinicForm, InviteForm } from "@/components/app/settings-client";
import { requirePageAuth } from "@/lib/session";

export const metadata = { title: "Members" };
const ROLE = { admin: "Lab admin", technician: "Lab technician", doctor: "Doctor" } as const;

export default async function Members() {
  const ctx = await requirePageAuth();
  const [members, clinics] = await Promise.all([listMembers(ctx.org.id), listClinics(ctx.org.id)]);
  const admin = ctx.role === "admin";
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
      {admin && <Card title="Invite"><InviteForm /></Card>}
      <Card title={`${members.length} member${members.length === 1 ? "" : "s"}`}>
        <ul className="divide-y divide-stone-100">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="font-medium">{m.name}</span>
              <span className="text-stone-500">{m.email}</span>
              <Badge>{ROLE[m.role]}</Badge>
              <span className="flex-1 text-right text-xs text-stone-400">since {fmtDate(m.createdAt)}</span>
              {admin && m.userId !== ctx.user.id && <ActionButton url={`/api/org/members/${m.id}`} method="DELETE" variant="ghost" confirmText={`Remove ${m.name}?`}>Remove</ActionButton>}
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Clinics">
        <ul className="mb-4 list-disc pl-5 text-sm">{clinics.length ? clinics.map((c) => <li key={c.id}>{c.name}</li>) : <li className="list-none text-stone-500">No clinics yet.</li>}</ul>
        {admin && <ClinicForm />}
      </Card>
    </>
  );
}
