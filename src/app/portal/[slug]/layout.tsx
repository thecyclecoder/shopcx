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
      {children}
    </div>
  );
}
