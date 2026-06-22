/**
 * Portal mini-site layout.
 *
 * Replaces the old purple-header layout with a storefront-style
 * shell: white background, brand color used only for accents (CTAs,
 * sidebar active state), no global header (the portal client owns
 * its own header so it can sit beside the sidebar on desktop).
 *
 * Provides the workspace's branding as CSS custom properties so any
 * subtree can reference them: --portal-primary, --portal-logo-url.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import ClientErrorReporter from "@/components/ClientErrorReporter";

/**
 * Portal metadata — inherits the storefront favicon (so a branded domain never
 * shows the ShopCX icon) and uses an account-area title/description instead of the
 * generic ShopCX root metadata. noindex: the portal is a logged-in account surface.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, portal_config, storefront_favicon_url, storefront_logo_url")
    .eq("help_slug", slug)
    .maybeSingle();
  if (!ws) return {};

  const brand = (ws.name as string | null) || "Account";
  const minisite = ((ws.portal_config as Record<string, unknown> | null)?.minisite || {}) as Record<string, unknown>;
  const iconUrl =
    (minisite.favicon_url as string | null) ||
    (minisite.logo_url as string | null) ||
    (ws.storefront_favicon_url as string | null) ||
    (ws.storefront_logo_url as string | null) ||
    null;

  return {
    title: `My Account · ${brand}`,
    description: `Manage your ${brand} subscriptions, orders, payment methods, and rewards.`,
    icons: iconUrl ? { icon: iconUrl, apple: iconUrl } : undefined,
    robots: { index: false, follow: false },
  };
}

export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const admin = createAdminClient();

  // Branding follows the portal config first, then falls back to
  // storefront branding so the experience is consistent if portal
  // settings weren't customized.
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, portal_config, storefront_logo_url, storefront_primary_color")
    .eq("help_slug", slug)
    .single();

  if (!workspace) return notFound();

  const portalConfig = (workspace.portal_config || {}) as Record<string, unknown>;
  const minisite = (portalConfig.minisite || {}) as Record<string, unknown>;
  const logoUrl =
    (minisite.logo_url as string) ||
    (workspace.storefront_logo_url as string | null) ||
    "";
  const primaryColor =
    (minisite.primary_color as string) ||
    (workspace.storefront_primary_color as string | null) ||
    "#18181b";

  return (
    <div
      style={{
        // CSS custom props read by client components
        ["--portal-primary" as string]: primaryColor,
        ["--portal-logo-url" as string]: logoUrl ? `url(${JSON.stringify(logoUrl)})` : "none",
        minHeight: "100vh",
        backgroundColor: "#f8fafc",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        color: "#18181b",
      } as React.CSSProperties}
    >
      {/* Capture client-side JS errors in the in-house portal → /api/client-errors (surface 'portal'). */}
      <ClientErrorReporter>{children}</ClientErrorReporter>
    </div>
  );
}
