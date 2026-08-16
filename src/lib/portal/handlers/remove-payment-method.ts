/**
 * Portal route: remove (revoke) a saved payment method the customer no longer
 * wants on file. Fills the gap identified in ticket 9bc2e674 — the portal
 * previously only LISTED cards and ADDED new ones, so a customer with
 * duplicate/unwanted saved cards had no self-serve removal path and the AI
 * fabricated a "scroll to Payment Methods and remove them" instruction that
 * the portal could not fulfill.
 *
 * Scope + guardrails (deliberate customer-only / PCI stance):
 *   • Customer-only route — same auth+ban gate as the other portal handlers.
 *     There is NO agent-side removal action; support cannot revoke a card on
 *     the customer's behalf. If she can't self-serve here (e.g. no session),
 *     she has to sign in.
 *   • Braintree-vaulted cards only. Shopify-Payments cards live in Shopify's
 *     vault and must be removed from the customer's Shopify account page —
 *     we do not have write access to that store and don't want to fake
 *     removal that the source-of-truth would then re-mirror back. Refuse
 *     with a stable `not_removable_here` code so the caller can show the
 *     right message.
 *   • Block removal of a card currently pinned to an active/paused internal
 *     subscription — losing that card mid-cycle would break the next renewal.
 *     The customer must switch that sub's card first (via setSubscriptionPaymentMethod)
 *     or add a new card and make it default.
 *   • If the card being removed IS the customer's `is_default`, promote the
 *     next most-recently-used active Braintree card to default in the same
 *     transaction, so we don't leave the customer's wallet defaultless.
 *   • Best-effort delete from the Braintree vault (paymentMethod.delete). If
 *     Braintree returns "not found" or fails, we still flip the local row to
 *     status='removed' — the local flag is what the renewal + dunning code
 *     reads, and re-attempting a Braintree delete on a stale token loops
 *     forever. A hard vault failure is logged, not thrown.
 *
 * Output shape:
 *   { ok: true, removed: { id, brand, last4 }, new_default_id: string | null }
 *
 * Error codes:
 *   missing_paymentMethodId · payment_method_not_found · payment_method_not_in_group
 *   not_removable_here (Shopify Payments card — remove via Shopify account)
 *   pinned_to_active_subscription (must reassign that sub's card first)
 */
import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

export const removePaymentMethod: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const paymentMethodId = s(payload?.paymentMethodId);
  if (!paymentMethodId) return jsonErr({ error: "missing_paymentMethodId" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  const { data: pm } = await admin
    .from("customer_payment_methods")
    .select("id, customer_id, provider, status, card_brand, last4, is_default, braintree_payment_method_token, created_at")
    .eq("workspace_id", auth.workspaceId)
    .eq("id", paymentMethodId)
    .maybeSingle();
  if (!pm) return jsonErr({ error: "payment_method_not_found" }, 404);

  // Ownership: the card must belong to someone in the customer's link group.
  const { data: link } = await admin
    .from("customer_links").select("group_id").eq("customer_id", customer.id).maybeSingle();
  let groupIds: string[] = [customer.id];
  if (link?.group_id) {
    const { data: g } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
    if (g?.length) groupIds = g.map((r) => r.customer_id as string);
    if (!groupIds.includes(customer.id)) groupIds.push(customer.id);
  }
  if (!groupIds.includes(pm.customer_id as string)) {
    return jsonErr({ error: "payment_method_not_in_group" }, 403);
  }

  // Shopify-Payments cards are read-only from our side.
  if (pm.provider !== "braintree") {
    return jsonErr({ error: "not_removable_here", provider: pm.provider }, 400);
  }

  // Already removed — idempotent success (the client's optimistic UI might
  // retry after a network hiccup).
  if (pm.status === "removed") {
    return jsonOk({ ok: true, route, removed: { id: pm.id, brand: pm.card_brand, last4: pm.last4 }, new_default_id: null, already_removed: true });
  }

  // Block if the card is currently pinned to an active/paused internal sub —
  // removing it would break that sub's next renewal. The customer must switch
  // that sub's card first.
  const { data: pinnedSubs } = await admin
    .from("subscriptions")
    .select("id, is_internal, status")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", groupIds)
    .eq("payment_method_id", pm.id)
    .in("status", ["active", "paused"]);
  const blocking = (pinnedSubs || []).filter((s) => s.is_internal === true);
  if (blocking.length) {
    return jsonErr({
      error: "pinned_to_active_subscription",
      pinned_subscription_ids: blocking.map((s) => s.id),
    }, 409);
  }

  // If we're removing the default card, pick the next default (most-recently-
  // created active Braintree card belonging to anyone in the link group,
  // excluding this one).
  let newDefaultId: string | null = null;
  if (pm.is_default) {
    const { data: candidates } = await admin
      .from("customer_payment_methods")
      .select("id, created_at")
      .eq("workspace_id", auth.workspaceId)
      .in("customer_id", groupIds)
      .eq("provider", "braintree")
      .eq("status", "active")
      .neq("id", pm.id)
      .order("created_at", { ascending: false })
      .limit(1);
    if (candidates?.[0]) newDefaultId = candidates[0].id as string;
  }

  // Best-effort Braintree vault delete. A missing/invalid token is treated
  // as an already-gone card and does not block the local status flip.
  try {
    if (pm.braintree_payment_method_token) {
      const { getBraintreeGateway } = await import("@/lib/integrations/braintree");
      const gateway = await getBraintreeGateway(auth.workspaceId);
      await gateway.paymentMethod.delete(pm.braintree_payment_method_token as string);
    }
  } catch (e) {
    console.warn(
      `[portal/remove-payment-method] Braintree delete failed for token ${String(pm.braintree_payment_method_token).slice(0, 8)}… — flipping local status anyway:`,
      e instanceof Error ? e.message : e,
    );
  }

  // Local flip: mark removed, drop default flag. Do the promotion in a second
  // update so a failure to promote doesn't strand the row still-default.
  await admin
    .from("customer_payment_methods")
    .update({ status: "removed", is_default: false, updated_at: new Date().toISOString() })
    .eq("id", pm.id);
  if (newDefaultId) {
    await admin
      .from("customer_payment_methods")
      .update({ is_default: true, updated_at: new Date().toISOString() })
      .eq("id", newDefaultId);
  }

  await logPortalAction({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    eventType: "portal.payment_method.removed",
    summary: `Customer removed ${pm.card_brand || "card"} ••${pm.last4 || ""} via portal${newDefaultId ? " (default promoted)" : ""}`,
    properties: {
      payment_method_id: pm.id,
      card_brand: pm.card_brand,
      last4: pm.last4,
      was_default: pm.is_default,
      new_default_id: newDefaultId,
    },
    createNote: false,
  });

  return jsonOk({
    ok: true,
    route,
    removed: { id: pm.id, brand: pm.card_brand, last4: pm.last4 },
    new_default_id: newDefaultId,
  });
};
