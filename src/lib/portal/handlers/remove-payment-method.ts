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
 *   • Write order is local-first: flip the row to status='removed' + drop
 *     is_default, promote a replacement default, THEN best-effort delete
 *     from the Braintree vault. Both local writes are error-checked and
 *     return 500 on failure — the vault delete is best-effort so a
 *     Braintree outage after a successful local flip leaves an orphaned
 *     vault entry (harmless) rather than a live local row pointing at a
 *     dead token, which the next renewal would try to charge.
 *
 * Output shape:
 *   { ok: true, removed: { id, brand, last4 }, new_default_id: string | null }
 *
 * Error codes:
 *   missing_paymentMethodId · payment_method_not_found · payment_method_not_in_group
 *   not_removable_here (Shopify Payments card — remove via Shopify account)
 *   pinned_to_active_subscription (must reassign that sub's card first)
 *   last_card_for_active_subscription (removing the only card leaves an
 *     active/paused internal sub with no vault to fall back on — the
 *     renewal charge path in internal-subscription-renewals.ts falls
 *     back to the link group's is_default active card when the sub
 *     itself pins nothing, so the pinned guard alone misses this case)
 */
import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

/**
 * Pure decision: refuse to remove a card when it is the last active
 * Braintree card in the customer's link group AND at least one internal
 * subscription in that group is still active/paused. Extracted from the
 * handler so a test can pin the rule without mocking Supabase, matching
 * the shape `pickChargeableVaultedPm` uses in
 * `src/lib/action-executor.vaulted-pm-guard.test.ts`.
 */
export function shouldBlockLastCardRemoval(args: {
  replacementCardId: string | null;
  activeInternalSubCount: number;
}): boolean {
  return args.replacementCardId === null && args.activeInternalSubCount > 0;
}

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

  // Look up the promotion candidate up front. The same query serves two
  // purposes: (a) it's the promotion target if the removed card is
  // currently default, and (b) it tells us whether the customer still
  // has any active Braintree card in the link group after this removal
  // — which the last-card guard below needs.
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
  const replacementCardId: string | null = (candidates?.[0]?.id as string | undefined) ?? null;

  // Count active/paused internal subscriptions in the link group. The
  // renewal charge path (internal-subscription-renewals.ts:694-722) reads
  // sub.payment_method_id first and, when null, FALLS BACK to the link
  // group's is_default active card; if neither resolves it returns
  // { skip: true, reason: "no_payment_method" } and the renewal silently
  // does not charge. So the pinned-subscription guard above only covers
  // subscriptions that explicitly pin this card — removing the ONLY
  // active card in the group would still silently break every sub that
  // relies on the default-card fallback.
  const { data: activeInternalSubs } = await admin
    .from("subscriptions")
    .select("id, is_internal, status")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", groupIds)
    .in("status", ["active", "paused"]);
  const blockingInternalSubs = (activeInternalSubs || []).filter((row) => row.is_internal === true);

  if (shouldBlockLastCardRemoval({
    replacementCardId,
    activeInternalSubCount: blockingInternalSubs.length,
  })) {
    return jsonErr({
      error: "last_card_for_active_subscription",
      subscription_ids: blockingInternalSubs.map((row) => row.id),
    }, 409);
  }

  const newDefaultId: string | null = pm.is_default ? replacementCardId : null;

  // Write order matters. The previous order (Braintree delete → local
  // flip → promotion, none of them error-checked) could leave the vault
  // entry destroyed but the local row still reading status='active' +
  // is_default=true, and the next renewal would pick it and charge a
  // token that no longer exists. Invert: flip the local row FIRST so a
  // vault outage never corrupts local state, and CHECK both writes so a
  // silent update failure doesn't strand the row.
  const nowIso = new Date().toISOString();

  const flip = await admin
    .from("customer_payment_methods")
    .update({ status: "removed", is_default: false, updated_at: nowIso })
    .eq("id", pm.id);
  if (flip.error) {
    return jsonErr({ error: "local_flip_failed" }, 500);
  }

  if (newDefaultId) {
    const promote = await admin
      .from("customer_payment_methods")
      .update({ is_default: true, updated_at: nowIso })
      .eq("id", newDefaultId);
    if (promote.error) {
      return jsonErr({ error: "default_promotion_failed" }, 500);
    }
  }

  // Best-effort Braintree vault delete. By the time this runs the local
  // row is already flipped, so a vault-side failure leaves an orphaned
  // vault entry (harmless — nothing will charge it) rather than a live
  // local row pointing at a dead token.
  try {
    if (pm.braintree_payment_method_token) {
      const { getBraintreeGateway } = await import("@/lib/integrations/braintree");
      const gateway = await getBraintreeGateway(auth.workspaceId);
      await gateway.paymentMethod.delete(pm.braintree_payment_method_token as string);
    }
  } catch (e) {
    console.warn(
      `[portal/remove-payment-method] Braintree delete failed for token ${String(pm.braintree_payment_method_token).slice(0, 8)}… — local row already flipped to removed:`,
      e instanceof Error ? e.message : e,
    );
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
