import type { Metadata, Viewport } from "next";
import { currentTenant } from "@/lib/session";
import { brandStyle } from "@/lib/branding";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentTenant();
  return {
    title: { default: t?.name ?? "DentoSim", template: `%s · ${t?.name ?? "DentoSim"}` },
    description: "Interactive 3D clear-aligner treatment simulations",
    icons: t?.branding.faviconUrl ? [{ url: t.branding.faviconUrl }] : undefined,
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#fafaf9" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const t = await currentTenant();
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased" style={brandStyle(t?.branding)}>
        {children}
      </body>
    </html>
  );
}
