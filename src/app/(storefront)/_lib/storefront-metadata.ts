/**
 * Resolve workspace-branded metadata for the funnel-step pages
 * (customize / checkout / thank-you) so customers never see the
 * default ShopCX favicon or "ShopCX" title mid-funnel on a
 * branded domain.
 *
 * Returns null when the workspace can't be resolved — caller's
 * generateMetadata returns `{}` so Next falls back to the root
 * layout metadata.
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

/**
 * Build a full metadata object for a funnel step: title prefixed
 * with the page label ("Customize Your Order", "Secure Checkout",
 * "Thank You"), description sourced from the workspace, plus icons.
 *
 * Page titles read "<label> · <brand>" so the browser tab shows
 * "Secure Checkout · Superfoods Company" instead of the root
 * "ShopCX" fallback.
 */
export async function getStorefrontMetadata(
  workspaceId: string,
  pageLabel: "Customize Your Order" | "Secure Checkout" | "Thank You",
): Promise<Metadata> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("name, storefront_favicon_url, storefront_logo_url")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!ws) return {};
  const brand = (ws.name as string | null) || "Store";
  const title = `${pageLabel} · ${brand}`;
  const description =
    pageLabel === "Secure Checkout"
      ? `Secure checkout for your ${brand} order.`
      : pageLabel === "Thank You"
        ? `Thanks for your ${brand} order.`
        : `Customize your ${brand} order.`;
  const iconUrl =
    (ws as { storefront_favicon_url?: string | null }).storefront_favicon_url ||
    (ws as { storefront_logo_url?: string | null }).storefront_logo_url ||
    null;
  return {
    title,
    description,
    icons: iconUrl ? { icon: iconUrl, apple: iconUrl } : undefined,
    // Stop search engines from indexing the funnel pages — they're
    // per-customer states tied to a cart token.
    robots: { index: false, follow: false },
  };
}
