/**
 * Portal login server entry — loads workspace branding (logo,
 * primary color, favicon) so the customer sees a branded login
 * page instead of a generic form. Delegates the form itself to
 * the client component below.
 */
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStorefrontIcons } from "@/app/(storefront)/_lib/storefront-metadata";
import LoginClient from "./LoginClient";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("id, name")
    .eq("help_slug", slug)
    .single();
  return {
    title: ws?.name ? `My Account · ${ws.name}` : "My Account",
    icons: ws?.id ? await getStorefrontIcons(ws.id as string) : undefined,
  };
}

export default async function PortalLoginPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const admin = createAdminClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("name, portal_config, storefront_logo_url, storefront_primary_color")
    .eq("help_slug", slug)
    .single();

  const portalConfig = (workspace?.portal_config || {}) as Record<string, unknown>;
  const minisite = (portalConfig.minisite || {}) as Record<string, unknown>;
  const logoUrl =
    (minisite.logo_url as string) ||
    (workspace?.storefront_logo_url as string | null) ||
    "";
  const primaryColor =
    (minisite.primary_color as string) ||
    (workspace?.storefront_primary_color as string | null) ||
    "#18181b";
  const brandName = (workspace?.name as string) || "";

  return (
    <LoginClient logoUrl={logoUrl} primaryColor={primaryColor} brandName={brandName} />
  );
}
