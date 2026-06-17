import { NextResponse } from "next/server";
import type { RouteHandler } from "@/lib/portal/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateMagicLinkURL } from "@/lib/magic-link";

/**
 * Shopify storefront → in-house portal SSO bridge.
 *
 * Hit via the Shopify App Proxy at `/apps/portal-v2?route=sso` (the proxy can't
 * carry a path tail after /api/portal, so SSO is a query-param route like every
 * other portal handler). Shopify attaches the HMAC-verified
 * `logged_in_customer_id`; the dispatcher's resolveAuth() validates the
 * signature (requireAppProxy) and hands us { loggedInCustomerId, workspaceId }.
 *
 * We mint a signed magic-link token and 302 the customer to the portal already
 * authenticated — no second login. The App Proxy passes our Location header back
 * to the browser, which follows it to portal.superfoodscompany.com/login?token=…
 * (the login page auto-exchanges the token — same path payment-recovery uses).
 *
 * Security: identity comes ONLY from the App-Proxy-verified logged_in_customer_id,
 * never a client-supplied param — so the link can't be forged into account
 * takeover. The token is short-lived and never logged.
 *
 * Fallbacks (always 302 to the bare portal so a stale/logged-out click never
 * errors): no verified customer id, or no internal customers row yet → the
 * customer just signs in normally on the portal.
 */
function safeNext(url: URL): string | undefined {
  const n = url.searchParams.get("next") || "";
  return n.startsWith("/") && !n.startsWith("//") && !n.includes("://") ? n : undefined;
}

/** Bare portal host (login lands here) — mirrors generateMagicLinkURL host resolution. */
async function portalBaseUrl(workspaceId: string): Promise<string> {
  if (workspaceId) {
    const admin = createAdminClient();
    const { data: ws } = await admin
      .from("workspaces")
      .select("help_slug, help_custom_domain, portal_config")
      .eq("id", workspaceId)
      .single();
    const portalDomain = (ws?.portal_config as { minisite?: { custom_domain?: string } } | null)?.minisite?.custom_domain;
    if (portalDomain) return `https://${portalDomain}/`;
    if (ws?.help_custom_domain) return `https://${ws.help_custom_domain}/portal/`;
    if (ws?.help_slug) return `https://${ws.help_slug}.shopcx.ai/portal/`;
  }
  return `${process.env.NEXT_PUBLIC_SITE_URL || "https://shopcx.ai"}/portal/`;
}

export const sso: RouteHandler = async ({ auth, url }) => {
  const next = safeNext(url);

  // Logged-out, or session lost between drawer render and click → bare portal login.
  if (!auth.loggedInCustomerId || !auth.workspaceId) {
    return NextResponse.redirect(await portalBaseUrl(auth.workspaceId), 302);
  }

  const admin = createAdminClient();
  const { data: customer } = await admin
    .from("customers")
    .select("id, email, shopify_customer_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_customer_id", auth.loggedInCustomerId)
    .maybeSingle();

  // No internal customer row for this Shopify id yet → sign in normally.
  if (!customer) {
    return NextResponse.redirect(await portalBaseUrl(auth.workspaceId), 302);
  }

  const magicUrl = await generateMagicLinkURL(
    customer.id,
    customer.shopify_customer_id || auth.loggedInCustomerId,
    customer.email,
    auth.workspaceId,
    next,
  );
  return NextResponse.redirect(magicUrl, 302);
};
