/**
 * Canonical customer-facing portal URLs.
 *
 * Ticket c969f235 (G esposito) is the ground-truth case: she was sent to
 * `account.superfoodscompany.com/profile` — the SHOPIFY account page — to
 * tidy up her saved cards. That page is not ours, we have no write access to
 * the vault behind it, and its "Payment Methods" section does not behave the
 * way our AI described. She looped for two days looking for a delete button
 * that was never going to be there.
 *
 * Shopify is a sunsetting origin (CLAUDE.md § Internal joins use UUIDs), so
 * there is no longer any reason to hand a customer a Shopify-owned URL. Every
 * surface that tells a customer where to manage their account — the portal
 * API payloads, the dunning payload, the orchestrator's knowledge block —
 * resolves through THIS module so the answer cannot drift per call site.
 *
 * Host resolution mirrors `getMagicLinkUrl` in [[magic-link]] exactly, so a
 * link we email and a link we quote in a reply always land on the same host:
 *   1. portal_config.minisite.custom_domain  (e.g. portal.superfoodscompany.com — bare paths)
 *   2. help_custom_domain                    (legacy — paths keep the /portal prefix)
 *   3. {help_slug}.shopcx.ai                 (multi-tenant subdomain)
 *   4. NEXT_PUBLIC_SITE_URL / shopcx.ai      (last-resort fallback)
 */
import { createAdminClient } from "@/lib/supabase/admin";

/** Portal sections a customer can be pointed at. Values are the bare paths the
 *  middleware rewrite understands (see `portal-client.tsx` SECTION_PATHS). */
export const PORTAL_PATHS = {
  home: "/",
  paymentMethods: "/payment-methods",
  subscriptions: "/subscriptions",
  orders: "/orders",
  account: "/account",
} as const;

export type PortalSection = keyof typeof PORTAL_PATHS;

type PortalHost = { base: string; prefixed: boolean };

async function resolvePortalHost(workspaceId: string): Promise<PortalHost> {
  try {
    const admin = createAdminClient();
    const { data: ws } = await admin
      .from("workspaces")
      .select("help_slug, help_custom_domain, portal_config")
      .eq("id", workspaceId)
      .single();

    const portalDomain = (ws?.portal_config as { minisite?: { custom_domain?: string } } | null)
      ?.minisite?.custom_domain;
    if (portalDomain) return { base: `https://${portalDomain}`, prefixed: false };
    if (ws?.help_custom_domain) return { base: `https://${ws.help_custom_domain}`, prefixed: true };
    if (ws?.help_slug) return { base: `https://${ws.help_slug}.shopcx.ai`, prefixed: true };
  } catch {
    /* fall through to the env fallback */
  }
  return { base: process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai", prefixed: true };
}

/**
 * Absolute URL for one portal section. `prefixed` hosts still route through
 * `/portal/...`; the dedicated portal subdomain serves bare paths because the
 * middleware rewrites them internally.
 *
 * Pass `slug` when the host is a prefixed one — the legacy path shape is
 * `/portal/{slug}/{section}`. Callers that only have a workspace id can omit
 * it and get `/portal/{section}`, which the middleware also resolves.
 */
export async function getPortalUrl(
  workspaceId: string,
  section: PortalSection = "home",
  slug?: string | null,
): Promise<string> {
  const { base, prefixed } = await resolvePortalHost(workspaceId);
  const path = PORTAL_PATHS[section];
  if (!prefixed) return path === "/" ? base : `${base}${path}`;
  const slugPart = slug ? `/${slug}` : "";
  return path === "/" ? `${base}/portal${slugPart}` : `${base}/portal${slugPart}${path}`;
}

/**
 * Where a customer manages saved cards. The single answer every surface
 * quotes — portal payloads, dunning, and the orchestrator knowledge block.
 * NEVER a Shopify account URL: we cannot remove or reorder cards in Shopify's
 * vault, so pointing there produces the exact dead end ticket c969f235 hit.
 */
export async function getPaymentMethodsUrl(workspaceId: string, slug?: string | null): Promise<string> {
  return getPortalUrl(workspaceId, "paymentMethods", slug);
}
