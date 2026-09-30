import type { CSSProperties } from "react";
import type { Branding } from "@dentosim/server";

/** CSS variables for a tenant's brand (validated hex colours only). */
export function brandStyle(b: Branding | undefined | null): CSSProperties {
  const hex = (v?: string) => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
  const s: Record<string, string> = {};
  if (hex(b?.primaryColor)) s["--brand"] = b!.primaryColor!;
  if (hex(b?.secondaryColor)) s["--brand-2"] = b!.secondaryColor!;
  if (b?.fontFamily && /^[\w\s,'"-]+$/.test(b.fontFamily)) s["--brand-font"] = b.fontFamily;
  return s as CSSProperties;
}
