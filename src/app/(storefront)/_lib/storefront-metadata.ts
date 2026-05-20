/**
 * Resolve the workspace's favicon URL for use in funnel-step pages
 * (customize / checkout / thank-you) so customers never see the
 * default ShopCX favicon mid-funnel on a branded domain.
 *
 * Falls back to the workspace logo, then null. Caller's
 * generateMetadata returns icons: undefined when null.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { Metadata } from "next";

export async function getStorefrontIcons(workspaceId: string): Promise<Metadata["icons"] | undefined> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("storefront_favicon_url, storefront_logo_url")
    .eq("id", workspaceId)
    .maybeSingle();
  const url =
    (ws as { storefront_favicon_url?: string | null } | null)?.storefront_favicon_url ||
    (ws as { storefront_logo_url?: string | null } | null)?.storefront_logo_url ||
    null;
  if (!url) return undefined;
  return { icon: url, apple: url };
}
