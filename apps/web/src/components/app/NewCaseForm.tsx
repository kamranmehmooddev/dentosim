"use client";

import { useState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { api } from "@/lib/client";
import { Uploader } from "./Uploader";

export function NewCaseForm({ doctors, clinics }: { doctors: { id: string; name: string }[]; clinics: { id: string; name: string }[] }) {
  const [caseId, setCaseId] = useState<string | null>(null);
  const [caseNumber, setCaseNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (caseId)
    return (
      <div className="space-y-4">
        <p className="text-sm text-stone-700">Case <strong>#{caseNumber}</strong> created. Upload the treatment-plan export:</p>
        <Uploader caseId={caseId} />
      </div>
    );

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
        setBusy(true);
        setError(null);
        try {
          const r = await api<{ id: string; caseNumber: number }>("/api/cases", {
            body: { patientReference: d.patientReference, patientDisplayName: d.patientDisplayName || undefined, doctorUserId: d.doctorUserId || null, clinicId: d.clinicId || null },
          });
          setCaseId(r.id);
          setCaseNumber(r.caseNumber);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Patient reference" hint="An identifier from your system (e.g. JD-1042). Avoid full names and dates of birth.">
        <Input name="patientReference" required maxLength={64} autoFocus />
      </Field>
      <Field label="Patient first name (optional)" hint="Shown only as a greeting on the patient page.">
        <Input name="patientDisplayName" maxLength={40} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Doctor">
          <Select name="doctorUserId" defaultValue="">
            <option value="">— assign later —</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        {clinics.length > 0 && (
          <Field label="Clinic">
            <Select name="clinicId" defaultValue="">
              <option value="">—</option>
              {clinics.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <Button disabled={busy}>Create case</Button>
    </form>
  );
}
