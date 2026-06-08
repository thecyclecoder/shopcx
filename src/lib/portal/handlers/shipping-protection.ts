import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan, resolveSub, findCustomer, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * shippingProtection — toggle shipping protection on an INTERNAL sub. Protection
 * is tracked on the row (shipping_protection_added + _amount_cents) because the
 * renewal scheduler and the pricing engine bill/display from there — NOT as a
 * line item. (Appstle subs keep the line-item add/remove flow in the portal UI;
 * this route is internal-only so the toggle, summary, and billing agree.)
 */
export const shippingProtection: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  const enabled = payload?.enabled === true;

  const admin = createAdminClient();
  const sub = await resolveSub(admin, auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  if (!sub) return jsonErr({ error: "missing_contractId" }, 400);
  if (!sub.is_internal) return jsonErr({ error: "not_internal" }, 400);

  const { data: ws } = await admin
    .from("workspaces")
    .select("shipping_protection_price_cents")
    .eq("id", auth.workspaceId)
    .maybeSingle();
  const amountCents = enabled ? Number(ws?.shipping_protection_price_cents || 0) : 0;

  await admin
    .from("subscriptions")
    .update({
      shipping_protection_added: enabled,
      shipping_protection_amount_cents: amountCents,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sub.id);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: enabled ? "portal.shipping_protection.added" : "portal.shipping_protection.removed",
      summary: `Customer ${enabled ? "added" : "removed"} shipping protection via portal`,
      properties: { subscription_id: sub.id, amount_cents: amountCents },
      createNote: false,
    });
  }

  return jsonOk({ ok: true, route, enabled, patch: { shipping_protection_added: enabled } });
};
