import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, checkPortalBan, resolveSub, findCustomer, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

/**
 * setSubscriptionPaymentMethod — pin a specific vaulted Braintree card to an
 * INTERNAL sub. The renewal scheduler charges this card (falling back to the
 * customer's default if it's later removed). Appstle subs can't pin a card here
 * (Shopify bills them). The card must be an active Braintree PM owned by someone
 * in the customer's link group.
 */
export const setSubscriptionPaymentMethod: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const admin = createAdminClient();
  const sub = await resolveSub(admin, auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  if (!sub) return jsonErr({ error: "missing_contractId" }, 400);
  if (!sub.is_internal) return jsonErr({ error: "not_internal" }, 400);

  const paymentMethodId = s(payload?.paymentMethodId);
  if (!paymentMethodId) return jsonErr({ error: "missing_paymentMethodId" }, 400);

  // The card must be an active, vaulted Braintree PM.
  const { data: pm } = await admin
    .from("customer_payment_methods")
    .select("id, customer_id, provider, status, card_brand, last4")
    .eq("workspace_id", auth.workspaceId)
    .eq("id", paymentMethodId)
    .maybeSingle();
  if (!pm || pm.provider !== "braintree" || pm.status !== "active") {
    return jsonErr({ error: "invalid_payment_method" }, 400);
  }

  // Ownership: the card must belong to someone in the sub's customer link group.
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", sub.customer_id).maybeSingle();
  let groupIds: string[] = [sub.customer_id];
  if (link?.group_id) {
    const { data: g } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    if (g?.length) groupIds = g.map((r) => r.customer_id as string);
  }
  if (!groupIds.includes(pm.customer_id as string)) {
    return jsonErr({ error: "payment_method_not_in_group" }, 403);
  }

  await admin
    .from("subscriptions")
    .update({ payment_method_id: paymentMethodId, updated_at: new Date().toISOString() })
    .eq("id", sub.id);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.payment_method_changed",
      summary: `Customer set the subscription's card to ${pm.card_brand || "card"} ••${pm.last4 || ""} via portal`,
      properties: { subscription_id: sub.id, payment_method_id: paymentMethodId },
      createNote: false,
    });
  }

  return jsonOk({ ok: true, route, payment_method_id: paymentMethodId, patch: { paymentMethod: { last4: pm.last4, cardBrand: pm.card_brand } } });
};
