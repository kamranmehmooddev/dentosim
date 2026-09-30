import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  acceptInvitation, beginTotpSetup, completeMfa, confirmTotpSetup, getAuth, inviteMember, login, requestPasswordReset, resetPassword, verifyEmail,
} from "../src/auth.js";
import { decrypt, encrypt, totpCode, verifyTotp, base32Encode, base32Decode } from "../src/crypto.js";
import { db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { consoleOutbox } from "../src/email.js";
import { newOrg } from "./helpers.js";

const lastEmail = (to: string) => [...consoleOutbox].reverse().find((m) => m.to === to)!;
const tokenFrom = (url: string) => new URL(url).searchParams.get("token")!;

describe("auth", () => {
  it("signs up a lab with an admin, trial, and a verification email", async () => {
    const o = await newOrg("Smile Co");
    expect(o.ctx.role).toBe("admin");
    expect(o.ctx.org?.name).toBe("Smile Co");
    const mail = lastEmail(o.email);
    expect(mail.template).toBe("verify_email");
    await verifyEmail(tokenFrom(mail.vars.url));
    expect((await getAuth(o.token))!.user.emailVerified).toBe(true);
    await expect(verifyEmail(tokenFrom(mail.vars.url))).rejects.toThrow(/invalid or has expired/); // single use
  });

  it("stores argon2id hashes, rejects wrong passwords, rate-limits", async () => {
    const o = await newOrg();
    const [u] = await db().select().from(users).where(eq(users.email, o.email));
    expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
    await expect(login(o.email, "wrong password!", "1.1.1.1")).rejects.toThrow(/incorrect/);
    expect((await login(o.email, "correct horse battery", "1.1.1.1")).mfaRequired).toBe(false);
    for (let i = 0; i < 10; i++) await login(o.email, "nope-nope-nope", "9.9.9.9").catch(() => undefined);
    await expect(login(o.email, "correct horse battery", "9.9.9.9")).rejects.toThrow(/Too many/);
  });

  it("resets the password and signs out existing sessions", async () => {
    const o = await newOrg();
    await requestPasswordReset(o.email, "2.2.2.2");
    const mail = lastEmail(o.email);
    expect(mail.template).toBe("reset_password");
    await resetPassword(tokenFrom(mail.vars.url), "a brand new password");
    expect(await getAuth(o.token)).toBeNull();
    await expect(login(o.email, "correct horse battery", "2.2.2.3")).rejects.toThrow();
    expect((await login(o.email, "a brand new password", "2.2.2.3")).token).toBeTruthy();
  });

  it("TOTP: enrolment, MFA-pending sessions, code verification", async () => {
    const o = await newOrg();
    const { secret } = await beginTotpSetup(o.userId);
    await expect(confirmTotpSetup(o.userId, "000000")).rejects.toThrow();
    await confirmTotpSetup(o.userId, totpCode(secret));
    const r = await login(o.email, "correct horse battery", "3.3.3.3");
    expect(r.mfaRequired).toBe(true);
    expect(await getAuth(r.token)).toBeNull(); // unusable until the second factor
    await expect(completeMfa(r.token, "123456")).rejects.toThrow();
    await completeMfa(r.token, totpCode(secret));
    expect((await getAuth(r.token))?.user.totpEnabled).toBe(true);
  });

  it("RFC 6238 test vector and crypto helpers", () => {
    // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890", T=59 → 94287082 (8 digits) → 287082
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, "287082", 59_000 + 30_000)).toBe(true); // ±1 step drift
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    expect(decrypt(encrypt("hello"))).toBe("hello");
  });

  it("invites a doctor who joins with a new account", async () => {
    const o = await newOrg();
    const token = await inviteMember(o.ctx, "New.Doctor@Example.com", "doctor");
    expect(lastEmail("new.doctor@example.com").template).toBe("invite");
    const session = await acceptInvitation(token, { name: "Dr New", password: "doctor password 1" });
    const ctx = await getAuth(session);
    expect(ctx?.role).toBe("doctor");
    expect(ctx?.org?.id).toBe(o.orgId);
    await expect(acceptInvitation(token, { name: "x", password: "doctor password 1" })).rejects.toThrow(/invalid or has expired/);
  });
});
