import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * priceQuote — preview what a line WOULD cost on an internal sub if the customer
 * added a variant, or swapped one in, at a given quantity. Reuses the pricing
 * engine on a projected (non-persisted) items array, so the modal price matches
 * exactly what will be charged — including the MIX-AND-MATCH quantity break, which
 * depends on the resulting total quantity across the rule (you can't compute it
 * from a single variant client-side).
 *
 * Appstle subs return `internal:false` — the client keeps its own (Appstle-baked)
 * estimate.
 */
export const priceQuote: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const admin = createAdminClient();
  const sub = await resolveSub(admin, auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  if (!sub) return jsonErr({ error: "missing_contractId" }, 400);

  const variantId = String(payload?.variantId || "");
  if (!variantId) return jsonErr({ error: "missing_variantId" }, 400);
  const quantity = Math.max(1, Math.floor(Number(payload?.quantity) || 1));
  const replaceVariantId = payload?.replaceVariantId != null ? String(payload.replaceVariantId) : null;

  if (!sub.is_internal) return jsonOk({ ok: true, route, internal: false });

  // Project the items with the hypothetical change — drop the swapped-out line,
  // then append the previewed variant at the chosen quantity. The engine groups
  // by rule and sums quantities, so the appended line correctly contributes to the
  // mix-and-match total (and the previewed line gets the resulting tier).
  const current = (Array.isArray(sub.items) ? sub.items : []) as Array<Record<string, unknown>>;
  const projected = current.filter((i) => !replaceVariantId || String(i.variant_id) !== replaceVariantId);
  projected.push({ variant_id: variantId, quantity });

  const { resolveSubscriptionPricing } = await import("@/lib/pricing");
  const pricing = await resolveSubscriptionPricing(auth.workspaceId, { items: projected, delivery_price_cents: 0 });
  const line = pricing.lines.find((l) => String(l.variant_id) === variantId);
  if (!line) return jsonOk({ ok: true, route, internal: true, base_cents: null, unit_cents: null });

  return jsonOk({
    ok: true,
    route,
    internal: true,
    base_cents: line.base_cents,
    unit_cents: line.unit_cents,
    break_pct: line.break_pct,
    sns_pct: line.sns_pct,
  });
};
