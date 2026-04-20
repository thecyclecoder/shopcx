import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";

/**
 * Storefront layout — isolated from dashboard UI.
 *
 * This is a nested layout (the root layout at src/app/layout.tsx still
 * provides <html>/<body>), but everything dashboard-specific is kept out
 * of the rendered tree. Viewport is overridden to allow pinch-zoom (the
 * dashboard disables it), and a local Inter font is layered in via
 * next/font for predictable fallback metrics.
 *
 * Child page.tsx files must remain React Server Components — no
 * "use client" on the page itself. Only leaf interactive components
 * (price toggle, review filter, FAQ accordion, sticky CTA) hydrate.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-storefront",
});

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
  return (
    <div
      className={`${inter.variable} storefront min-h-screen bg-white text-zinc-900 antialiased`}
      style={{ fontFamily: "var(--font-storefront), system-ui, sans-serif" }}
    >
      {children}
    </div>
  );
}
