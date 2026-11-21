/**
 * winback-reactivate-choice — executes the win-back journey's "Yes, restart my subscription" click.
 *
 * Called from BOTH journey endpoints, because the page decides which one to hit: a code-driven
 * journey with a `steps` array is treated as multi-step and posts to /complete (outcome
 * "completed"), otherwise it posts to /step. The restart runs synchronously through
 * [[subscription-reactivate]] (the same function as the portal's Reactivate button) so the page can
 * show the customer the REAL result.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

export const REACTIVATE_JOURNEY_TYPES = new Set(["reactivate_subscription", "reactivate", "win_back"]);

/**
 * The win-back choice carried by a /complete call, or null when this is not a win-back submit.
 * `reactivate_choice` is unique to this journey; a minted win-back session's frozen
 * config_snapshot carries no journeyType (steps are live-rendered), so the step key is the signal.
 */
export function winbackChoiceFrom(
  journeyType: string | null,
  responses: Record<string, { value?: string } | undefined> | null | undefined,
): string | null {
  const choice = responses?.reactivate_choice?.value;
  if (!choice) return null;
  if (journeyType && !REACTIVATE_JOURNEY_TYPES.has(journeyType)) return null;
  return choice;
}

export type ReactivateChoiceSession = {
  id: string; workspace_id: string; ticket_id: string | null; customer_id: string | null;
  /** The sub the win-back link was minted for. When set, it is the one restarted. */
  subscription_id?: string | null;
};

export async function handleReactivateChoice(
  admin: ReturnType<typeof createAdminClient>,
  session: ReactivateChoiceSession,
  choice: string,
  responses: Record<string, { value: string; label: string }>,
): Promise<{ outcome: string; message: string }> {
  const note = async (body: string) => {
    if (!session.ticket_id) return;
    await admin.from("ticket_messages").insert({
      ticket_id: session.ticket_id, direction: "outbound", visibility: "internal", author_type: "system", body,
    });
  };
  const finish = async (outcome: string, subscriptionId: string | null) => {
    await admin.from("journey_sessions").update({
      status: "completed",
      outcome,
      responses,
      completed_at: new Date().toISOString(),
      // The action already ran here; the outcome processor must not run it a second time.
      outcome_action_taken: true,
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    }).eq("id", session.id);
  };

  const { parseReactivateValue, loadWinbackGifts } = await import("@/lib/reactivate-journey-builder");
  const parsed = parseReactivateValue(choice);
  if (!parsed.restart) {
    await finish("declined", null);
    await note("[Win-back] Customer chose \"Not right now\". No change made.");
    return { outcome: "declined", message: "No problem. Your subscription stays off, and you can restart it anytime." };
  }

  if (!session.customer_id) {
    await note("[Win-back] ⚠ Restart clicked but the session has no customer. Nothing restarted — needs manual follow-up.");
    return { outcome: "error", message: "We couldn't restart it automatically. Our team will reach out shortly to finish it for you." };
  }

  const { resolveTargetSubscription } = await import("@/lib/reactivate-journey-builder");
  const sub = await resolveTargetSubscription(admin, session.workspace_id, session.customer_id, session.subscription_id);
  if (!sub?.shopify_contract_id) {
    await finish("error_no_target_sub", null);
    await note("[Win-back] ⚠ Restart clicked but no cancelled or paused subscription was found. Nothing restarted — needs manual follow-up.");
    return { outcome: "error_no_target_sub", message: "We couldn't find a subscription to restart. Our team will reach out shortly to help." };
  }

  const { reactivateSubscription } = await import("@/lib/subscription-reactivate");
  const r = await reactivateSubscription(session.workspace_id, String(sub.shopify_contract_id));
  if (!r.ok) {
    const needsCard = r.reason === "needs_payment_method";
    const needsAddress = r.reason === "needs_address";
    await finish(needsCard ? "reactivate_needs_payment_method" : needsAddress ? "reactivate_needs_address" : "reactivate_failed", sub.id as string);
    await note(`[Win-back] ⚠ Restart clicked but NOT applied (${r.reason}): ${r.message}. Needs follow-up.`);
    const { logCustomerEvent: logFail } = await import("@/lib/customer-events");
    await logFail({
      workspaceId: session.workspace_id, customerId: session.customer_id,
      eventType: "winback.reactivate_failed", source: "journey",
      summary: `Win-back restart failed: ${r.reason}`,
      properties: { session_id: session.id, subscription_id: sub.id, contract_id: sub.shopify_contract_id, reason: r.reason, error: r.message },
    });
    console.error(`[winback-reactivate] reactivate FAILED contract=${sub.shopify_contract_id} reason=${r.reason}: ${r.message}`);
    return {
      outcome: "reactivate_failed",
      message: needsCard
        ? "Almost there. We need an updated card before we can restart your subscription. Our team will send you a secure link to update it."
        : needsAddress
          ? "Almost there. We need your shipping address before we can restart your subscription. Our team will reach out to confirm it."
          : "We couldn't restart it automatically. Our team will reach out shortly to finish it for you.",
    };
  }

  await finish("reactivated", sub.id as string);
  const when = new Date(r.nextBillingDate).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

  // Free gift on the FIRST order only (one-time $0 line, never recurring). Only a variant on the
  // DB-configured list is honoured — the option value comes from the client.
  let giftLabel: string | null = null;
  let giftError: string | null = null;
  if (parsed.giftVariantId) {
    const gifts = await loadWinbackGifts(admin, session.workspace_id);
    const gift = gifts.find((g) => g.variant_id === parsed.giftVariantId);
    if (!gift) {
      giftError = "gift not on the configured list";
    } else {
      const { resolveShopifyVariantId } = await import("@/lib/product-variants");
      const shopifyVariantId = await resolveShopifyVariantId(session.workspace_id, gift.variant_id);
      if (!shopifyVariantId) {
        giftError = "gift variant has no Shopify id";
      } else {
        const { subscriptionAddFreeProduct } = await import("@/lib/commerce/subscription");
        const g = await subscriptionAddFreeProduct(session.workspace_id, r.contractId, shopifyVariantId, 1);
        if (g.success) giftLabel = gift.label;
        else giftError = g.error || "add free product failed";
      }
    }
  }
  await note(`[Win-back] Customer restarted their subscription (contract ${r.contractId}). Next order: ${when}.`
    + (giftLabel ? ` Free gift added: ${giftLabel}.` : "")
    + (giftError ? ` ⚠ Free gift NOT added (${giftError}) — add it manually.` : ""));
  if (giftError) console.error(`[winback-reactivate] gift FAILED contract=${r.contractId} variant=${parsed.giftVariantId}: ${giftError}`);
  const { logCustomerEvent } = await import("@/lib/customer-events");
  await logCustomerEvent({
    workspaceId: session.workspace_id,
    customerId: session.customer_id,
    eventType: "winback.reactivated",
    source: "journey",
    summary: "Customer restarted their subscription from the win-back journey",
    properties: { session_id: session.id, subscription_id: sub.id, gift_variant_id: parsed.giftVariantId, gift_added: !!giftLabel, gift_error: giftError, shopify_contract_id: r.contractId, next_billing_date: r.nextBillingDate, revived_on_shopcx: r.revivedOnShopcx },
  });
  return {
    outcome: "reactivated",
    message: giftLabel
      ? `You're all set! Your subscription is back on, and your free ${giftLabel} ships with your next order on ${when}.`
      : giftError
        ? `You're all set! Your subscription is back on, and your next order processes on ${when}. We'll add your free gift to it.`
        : `You're all set! Your subscription is back on, and your next order processes on ${when}.`,
  };
}
