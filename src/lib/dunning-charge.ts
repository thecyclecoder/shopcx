/**
 * Charge a subscription during dunning, whichever engine bills it.
 *
 * ⭐ Dunning's charge path is the one place `billing_source` routing cannot be pushed into the
 * commerce SDK. The Appstle flow is `getUpcomingOrders → attemptBilling(ATTEMPT id)`: by the time
 * control reaches a dispatch point the contract id has already been traded for an attempt id, and
 * a Shopify contract has no Appstle attempts at all.
 *
 * Left unrouted, a migrated subscription that declines would look up upcoming orders that do not
 * exist, treat every card as failed, burn `MAX_PAYDAY_RETRIES`, and then hit the cycle-2 ladder —
 * which CANCELS the subscription. A customer with a perfectly good card would be cancelled by a
 * retry loop that never actually charged anything.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveBillingSource } from "@/lib/internal-subscription";
import {
  subscriptionGetUpcomingOrders,
  subscriptionAttemptBilling,
} from "@/lib/commerce/subscription";
import { cycleKeyFromNextBillingDate } from "@/lib/subscription-cycle-charge-claim";
import { errText } from "@/lib/error-text";

export interface DunningChargeResult {
  success: boolean;
  error?: string;
  /** Appstle billing-attempt id, or the Shopify attempt gid. Recorded on the cycle either way. */
  attemptId?: string | null;
  /** True when the outcome is not yet settled (3DS). NOT a failure — must not advance dunning. */
  pending?: boolean;
  /**
   * ⭐ Whether `success` is the FINAL charge outcome or merely "the vendor accepted the request".
   *
   * Appstle: false — acceptance only; the real result arrives later on a webhook, which is why
   * dunning records those attempts as `pending`.
   * ShopCX: true — `awaitBillingAttempt` has already polled to a terminal state, so `success`
   * means the card was actually charged.
   *
   * Conflating the two is how a PAYING customer gets treated as a decline: the shopcx charge
   * succeeds, dunning logs it `pending` and waits for a webhook that can never fire for a contract
   * Appstle no longer holds, the cycle never reaches `recovered`, the payday ladder burns four more
   * retries, and cycle 2 CANCELS them.
   */
  settled?: boolean;
  orderName?: string | null;
  /** The cycle was already BILLED — treat as recovered, never as a fresh charge. */
  alreadyBilled?: boolean;
}

/**
 * Attempt one charge for dunning. `paymentMethodId`, when given, is the card being rotated to —
 * the caller is expected to have switched it onto the contract already.
 */
export async function dunningChargeContract(
  workspaceId: string,
  contractId: string,
  /**
   * ⭐ A STABLE, per-cycle attempt ordinal — the rotation index or `payday_retry_count`.
   *
   * This was derived from a live `payment_failures` COUNT, which is neither stable nor isolated:
   * an Inngest step retry re-reads a higher count, builds a NEW key and issues a second real
   * charge; two concurrent charge sites read the same count, build the SAME key, and Shopify
   * replays the first attempt's decline so a customer's good new card is never actually presented.
   * The caller already holds a per-cycle counter — pass it.
   */
  attemptOrdinal: number,
): Promise<DunningChargeResult> {
  const src = await resolveBillingSource(workspaceId, contractId);

  if (src === "shopcx") {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions").select("next_billing_date")
      .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
    const due = (sub as { next_billing_date: string | null } | null)?.next_billing_date ?? null;

    const { shopifyAttemptBilling, awaitBillingAttempt } =
      await import("@/lib/commerce/shopify-subscription-client");
    try {
      // ⚠️ The idempotency key is deliberately DISTINCT from the renewal worker's
      // `${contract}:${cycleKey}`. Dunning is retrying a cycle the worker already attempted; reusing
      // that key makes Shopify replay the cached FAILED attempt instead of trying the card again,
      // so a rotation to a good card could never succeed. The retry counter makes each try unique.
      const { count } = await admin
        .from("payment_failures").select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId);
      const key = `${contractId}:${cycleKeyFromNextBillingDate(due)}:r${count ?? 0}`;

      const started = await shopifyAttemptBilling(workspaceId, contractId, key,
        due ? { billingCycleSelector: { date: due } } : {});
      if (!started.success || !started.attemptId) {
        return { success: false, error: started.error ?? "attempt not accepted" };
      }
      const outcome = await awaitBillingAttempt(workspaceId, started.attemptId);
      return {
        success: outcome.success,
        settled: !(outcome.pending ?? false),
        pending: outcome.pending ?? false,
        error: outcome.error ?? outcome.errorCode ?? undefined,
        attemptId: started.attemptId,
        orderName: outcome.orderName ?? null,
      };
    } catch (err) {
      return { success: false, error: errText(err) };
    }
  }

  // Appstle / internal: look up the upcoming order, then bill that attempt.
  const ordersRes = await subscriptionGetUpcomingOrders(workspaceId, contractId);
  if (!ordersRes.success || !ordersRes.orders?.length) {
    return { success: false, error: ordersRes.error || "no upcoming orders" };
  }
  const attemptId = ordersRes.orders[0].id;
  const billingRes = await subscriptionAttemptBilling(workspaceId, attemptId);
  // Vendor ACCEPTANCE only — the charge result lands later on the Appstle webhook.
  return { success: billingRes.success, settled: false, error: billingRes.error, attemptId };
}

/** Unskip whatever the engine considers skipped. A no-op where the concept doesn't apply. */
export async function dunningUnskip(
  workspaceId: string,
  contractId: string,
  appstleBillingAttemptId: string | null,
): Promise<void> {
  const src = await resolveBillingSource(workspaceId, contractId);
  if (src === "shopcx") {
    const { shopifyUnskipBillingCycle } = await import("@/lib/commerce/shopify-subscription-client");
    // Best-effort: a contract with nothing skipped simply reports so, which is not an error here.
    await shopifyUnskipBillingCycle(workspaceId, contractId);
    return;
  }
  if (!appstleBillingAttemptId) return;
  const { subscriptionUnskipOrder } = await import("@/lib/commerce/subscription");
  await subscriptionUnskipOrder(workspaceId, appstleBillingAttemptId);
}
