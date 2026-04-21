import type { Metadata, Viewport } from "next";
import { ALL_FONT_VARIABLES } from "./_lib/fonts";

/**
 * Storefront layout — isolated from dashboard UI.
 *
 * Nested under the root layout (src/app/layout.tsx provides <html>/
 * <body>), but nothing dashboard-specific renders here. Viewport is
 * overridden to allow pinch-zoom, and the font is resolved via a
 * curated allowlist (see _lib/fonts.ts) so each workspace can pick
 * from a small set pre-registered with next/font.
 *
 * Child page.tsx files must remain React Server Components — no
 * "use client" on the page itself. Only leaf interactive components
 * (price toggle, review filter, FAQ accordion, sticky CTA) hydrate.
 */

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  userScalable: true,
  themeColor: "#ffffff",
};

export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

export default function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // All pre-registered font variables are attached here. Each page
  // picks which stack to apply via an inline fontFamily on the render
  // wrapper (see render-page.tsx).
  return (
    <div
      className={`${ALL_FONT_VARIABLES} storefront-root min-h-screen bg-white text-zinc-900 antialiased`}
    >
      {children}
    </div>
  );
}
