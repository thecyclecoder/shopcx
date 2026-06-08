import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * subscriptionTax — return the (saved, mutation-fresh) Avalara tax quote for an
 * internal sub so the detail breakdown can show estimated tax. The quote is
 * persisted to subscriptions.avalara_quote_* and auto-refreshes whenever the sub
 * is mutated (ensureFreshSubscriptionTaxQuote re-quotes when avalara_quote_at is
 * older than updated_at). Appstle subs return null (Shopify handles their tax).
 */
export const subscriptionTax: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const idParam = url.searchParams.get("id") || url.searchParams.get("contractId") || "";
  const admin = createAdminClient();
  const sub = await resolveSub(admin, auth.workspaceId, idParam, auth.loggedInCustomerId);
  if (!sub) return jsonErr({ error: "missing_contractId" }, 400);
  if (!sub.is_internal) return jsonOk({ ok: true, route, tax: null });

  try {
    const { ensureFreshSubscriptionTaxQuote } = await import("@/lib/avalara-subscription");
    const quote = await ensureFreshSubscriptionTaxQuote(auth.workspaceId, sub.id);
    return jsonOk({ ok: true, route, tax: quote ? { tax_cents: quote.tax_cents, total_cents: quote.total_cents } : null });
  } catch (err) {
    console.warn(`[portal] subscriptionTax failed for ${sub.id}:`, err);
    return jsonOk({ ok: true, route, tax: null });
  }
};
