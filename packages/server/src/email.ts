/**
 * Transactional email (Resend / Postmark / console) with tenant branding.
 * Emails never contain PHI: they reference case numbers and link into the app.
 */
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { emailOutbox, type Branding } from "./db/schema.js";

export type EmailTemplate =
  | "verify_email" | "reset_password" | "invite"
  | "case_ready" | "case_needs_mapping" | "case_failed" | "case_sent_to_doctor"
  | "case_approved" | "case_changes_requested" | "case_shared";

export interface EmailMessage {
  to: string;
  template: EmailTemplate;
  orgId?: string | null;
  branding?: Branding & { orgName?: string };
  /** template variables (no PHI) */
  vars: Record<string, string>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const TEMPLATES: Record<EmailTemplate, (v: Record<string, string>) => { subject: string; heading: string; body: string; cta?: string }> = {
  verify_email: (v) => ({ subject: "Confirm your email", heading: "Confirm your email address", body: "Click the button below to confirm your email and finish setting up your account.", cta: v.url }),
  reset_password: (v) => ({ subject: "Reset your password", heading: "Reset your password", body: "Someone (hopefully you) asked to reset your password. This link is valid for one hour.", cta: v.url }),
  invite: (v) => ({ subject: `You're invited to ${v.orgName}`, heading: `Join ${v.orgName}`, body: `${v.inviter} invited you to ${v.orgName} as ${v.role}.`, cta: v.url }),
  case_ready: (v) => ({ subject: `Case #${v.caseNumber} is ready for review`, heading: `Case #${v.caseNumber} is ready`, body: "The treatment simulation finished processing and is ready for review.", cta: v.url }),
  case_needs_mapping: (v) => ({ subject: `Case #${v.caseNumber} needs file mapping`, heading: "We need your help with an export", body: "We could not recognise every file in this export automatically. Please confirm the file mapping — it will be remembered for the next export from the same software.", cta: v.url }),
  case_failed: (v) => ({ subject: `Case #${v.caseNumber} could not be processed`, heading: "Processing failed", body: v.reason ?? "The export could not be processed.", cta: v.url }),
  case_sent_to_doctor: (v) => ({ subject: `Case #${v.caseNumber} awaits your approval`, heading: "A treatment plan awaits your review", body: `Revision ${v.revision} of case #${v.caseNumber} is ready for your approval.`, cta: v.url }),
  case_approved: (v) => ({ subject: `Case #${v.caseNumber} approved`, heading: "Plan approved", body: `${v.doctor} approved revision ${v.revision} of case #${v.caseNumber}.`, cta: v.url }),
  case_changes_requested: (v) => ({ subject: `Changes requested on case #${v.caseNumber}`, heading: "Changes requested", body: `${v.doctor} requested changes to revision ${v.revision} of case #${v.caseNumber}.`, cta: v.url }),
  case_shared: (v) => ({ subject: "Your treatment simulation", heading: "Your treatment simulation is ready", body: `${v.doctor} prepared a 3D simulation of your treatment.${v.pinNote ? " " + v.pinNote : ""}`, cta: v.url }),
};

export function renderEmail(m: EmailMessage): { subject: string; html: string; text: string } {
  const t = TEMPLATES[m.template](m.vars);
  const color = m.branding?.primaryColor ?? "#0f766e";
  const name = m.branding?.orgName ?? "DentoSim";
  const logo = m.branding?.logoUrl ? `<img src="${esc(m.branding.logoUrl)}" alt="${esc(name)}" style="max-height:40px">` : `<strong style="font-size:18px">${esc(name)}</strong>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:${esc(m.branding?.fontFamily ?? "system-ui, sans-serif")}">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td>${logo}</td></tr>
<tr><td style="padding-top:24px"><h1 style="font-size:20px;margin:0 0 12px">${esc(t.heading)}</h1><p style="font-size:15px;line-height:1.5;color:#44403c;margin:0">${esc(t.body)}</p></td></tr>
${t.cta ? `<tr><td style="padding-top:24px"><a href="${esc(t.cta)}" style="display:inline-block;background:${esc(color)};color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">Open</a></td></tr>` : ""}
</table><p style="font-size:12px;color:#78716c">${esc(name)}</p></td></tr></table></body></html>`;
  const text = `${t.heading}\n\n${t.body}${t.cta ? `\n\n${t.cta}` : ""}\n\n— ${name}`;
  return { subject: t.subject, html, text };
}

/** Last messages sent by the console provider (tests and dev tooling). */
export const consoleOutbox: { to: string; subject: string; text: string; template: EmailTemplate; vars: Record<string, string> }[] = [];

export async function sendEmail(m: EmailMessage): Promise<void> {
  const c = config();
  const r = renderEmail(m);
  const from = m.branding?.emailFromName ? `${m.branding.emailFromName} <${c.EMAIL_FROM.replace(/^.*<|>$/g, "")}>` : c.EMAIL_FROM;
  const [row] = await db().insert(emailOutbox).values({ orgId: m.orgId ?? null, to: m.to, template: m.template, subject: r.subject }).returning({ id: emailOutbox.id });
  try {
    let providerId: string | undefined;
    if (c.EMAIL_PROVIDER === "resend") {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${c.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: m.to, subject: r.subject, html: r.html, text: r.text }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`);
      providerId = ((await res.json()) as { id?: string }).id;
    } else if (c.EMAIL_PROVIDER === "postmark") {
      const res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: { "X-Postmark-Server-Token": c.POSTMARK_TOKEN ?? "", "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ From: from, To: m.to, Subject: r.subject, HtmlBody: r.html, TextBody: r.text, MessageStream: "outbound" }),
      });
      if (!res.ok) throw new Error(`Postmark ${res.status}`);
      providerId = ((await res.json()) as { MessageID?: string }).MessageID;
    } else {
      consoleOutbox.push({ to: m.to, subject: r.subject, text: r.text, template: m.template, vars: m.vars });
      if (consoleOutbox.length > 200) consoleOutbox.shift();
      if (c.NODE_ENV === "development") console.log(`[email] to=${m.to} subject="${r.subject}"\n${r.text}\n`);
    }
    await db().update(emailOutbox).set({ status: "sent", sentAt: new Date(), providerId }).where(eq(emailOutbox.id, row.id));
  } catch (e) {
    await db().update(emailOutbox).set({ status: "failed", error: (e as Error).message.slice(0, 500) }).where(eq(emailOutbox.id, row.id));
  }
}
