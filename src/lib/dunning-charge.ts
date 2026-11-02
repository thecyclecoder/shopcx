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
import { resolveBillingSource, resolveLiveContractId } from "@/lib/internal-subscription";
import {
  subscriptionGetUpcomingOrders,
  subscriptionAttemptBilling,
} from "@/lib/commerce/subscription";
import { cycleKeyFromNextBillingDate } from "@/lib/subscription-cycle-charge-claim";
import { errText } from "@/lib/error-text";

export interface DunningChargeResult {
  success: boolean;
  error?: string;
  /**
   * Which engine actually ran the charge.
   *
   * ⭐ Callers LOG this. Before it existed, dunning hardcoded every retry outcome as
   * "Appstle rejected billing attempt" / `error_code: "appstle_rejected"` regardless of engine —
   * so a ShopCX card decline was recorded as an Appstle rejection against a Shopify contract id.
   * Measured 2026-09-21 on contract 36065968301: three rows reading "Appstle rejected" for charges
   * that never touched Appstle. Nothing was mis-billed, but the ledger accuses the wrong system,
   * which is the worst kind of wrong on a double-billing question.
   */
  engine?: "appstle" | "internal" | "shopcx";
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
 * Pure: the Shopify idempotency key for one dunning charge on a ShopCX contract.
 *
 * `cardKey` (the card's `dedupeKey`) is REQUIRED wherever one ordinal covers several cards. A
 * payday pass tries every card under the same `payday_retry_count`, so without it card B reused
 * card A's key and Shopify replayed A's cached decline: only the first card was ever presented,
 * and the ladder cancelled customers whose second card was good. Card rotation gives each card its
 * own ordinal, so it may omit it.
 */
export function shopcxDunningIdempotencyKey(
  contractId: string,
  due: string | null,
  attemptOrdinal: number,
  cardKey?: string | null,
): string {
  const base = `${contractId}:${cycleKeyFromNextBillingDate(due)}:r${attemptOrdinal}`;
  return cardKey ? `${base}:${cardKey}` : base;
}

/**
 * Pure: must a dunning charge refuse because the cycle was already settled somewhere else?
 *
 * Dunning holds `next_billing_date` in the past (or today) ON PURPOSE so the declined cycle stays
 * targetable. A date beyond today means another path already charged and advanced it — a portal or
 * agent Order Now, or a settled pending attempt. If the first unbilled cycle is then a FUTURE one
 * (`inWindow` false), billing it is the NEXT order, early — a second charge the customer never
 * asked for. Compared on the UTC day, the grain the renewal cron selects on, so a sub due later
 * today still retries. A resumed sub whose date was set forward still retries while Shopify's open
 * cycle is unbilled.
 */
export function shouldRefuseEarlyDunningCharge(
  due: string | null,
  inWindow: boolean,
  now: Date = new Date(),
): boolean {
  if (inWindow || !due) return false;
  const d = new Date(due);
  if (!Number.isFinite(d.getTime())) return false;
  return d.toISOString().slice(0, 10) > now.toISOString().slice(0, 10);
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
  /**
   * The card being presented (`PaymentMethod.dedupeKey`). Pass it whenever the same ordinal covers
   * more than one card (the payday pass) — see `shopcxDunningIdempotencyKey`.
   */
  cardKey?: string | null,
): Promise<DunningChargeResult> {
  // Exhausted dunning cycles can still carry a sub's pre-migration id (only OPEN cycles are
  // re-pointed) — resolve it to the live migrated row before routing and charging.
  contractId = await resolveLiveContractId(workspaceId, contractId);
  const src = await resolveBillingSource(workspaceId, contractId);
  const engine = src as DunningChargeResult["engine"];

  if (src === "shopcx") {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions").select("next_billing_date")
      .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
    const due = (sub as { next_billing_date: string | null } | null)?.next_billing_date ?? null;

    const { shopifyAttemptBilling, awaitBillingAttempt, resolveChargeableCycle } =
      await import("@/lib/commerce/shopify-subscription-client");
    try {
      // ⚠️ The idempotency key is deliberately DISTINCT from the renewal worker's
      // `${contract}:${cycleKey}`. Dunning is retrying a cycle the worker already attempted; reusing
      // that key makes Shopify replay the cached FAILED attempt instead of trying the card again,
      // so a rotation to a good card could never succeed. The attempt ordinal makes each try unique.
      //
      // ⭐ It MUST be the caller's `attemptOrdinal`, never a live COUNT of `payment_failures`.
      // This read the count until 2026-09-15 — the exact bug the parameter was added to fix, with
      // the parameter accepted and then ignored:
      //   · an Inngest step retry re-reads a HIGHER count, builds a NEW key, and issues a SECOND
      //     REAL CHARGE against the same cycle;
      //   · two concurrent charge sites read the SAME count, build the SAME key, and Shopify
      //     replays the first decline — so a customer's freshly-rotated good card is never
      //     actually presented and recovery silently cannot succeed.
      // The caller already holds a stable per-cycle counter (rotation index / payday_retry_count).
      const key = shopcxDunningIdempotencyKey(contractId, due, attemptOrdinal, cardKey);

      // ⭐ Address the cycle BY INDEX with an in-window origin time, exactly as the renewal worker
      // and Order Now do. By-date addressing failed whenever `due` landed in an already-BILLED
      // cycle or Shopify rejected the origin time ("Origin time needs to be within the selected
      // billing cycle"): every rotation and payday attempt came back attempt-less, the cycle
      // exhausted, and cycle 2 cancelled a customer who could have paid.
      const cycle = await resolveChargeableCycle(workspaceId, contractId, new Date());
      if (!cycle.success || cycle.index == null || !cycle.originTime) {
        return { success: false, engine, error: cycle.error ?? "no chargeable cycle" };
      }
      // ⚠️ By index, the first unbilled cycle is always billable — including the NEXT one, early.
      // That is only right while the declined cycle is still owed. When OUR date has moved past
      // today AND the only unbilled cycle is a future one, someone already paid this cycle (an
      // Order Now, a settled pending attempt) and a charge here would be a second one. Not a
      // decline: no attempt id, so dunning records nothing and burns no card.
      if (shouldRefuseEarlyDunningCharge(due, cycle.inWindow ?? false)) {
        return { success: false, engine, error: `cycle already settled: next billing date ${due} is past today and only a future cycle is unbilled` };
      }
      const started = await shopifyAttemptBilling(workspaceId, contractId, key,
        { billingCycleSelector: { index: cycle.index }, originTime: cycle.originTime });
      if (!started.success || !started.attemptId) {
        return { success: false, engine, error: started.error ?? "attempt not accepted" };
      }
      const outcome = await awaitBillingAttempt(workspaceId, started.attemptId);
      return {
        success: outcome.success,
        engine,
        settled: !(outcome.pending ?? false),
        pending: outcome.pending ?? false,
        error: outcome.error ?? outcome.errorCode ?? undefined,
        attemptId: started.attemptId,
        orderName: outcome.orderName ?? null,
      };
    } catch (err) {
      return { success: false, engine, error: errText(err) };
    }
  }

  // Appstle / internal: look up the upcoming order, then bill that attempt.
  const ordersRes = await subscriptionGetUpcomingOrders(workspaceId, contractId);
  if (!ordersRes.success || !ordersRes.orders?.length) {
    return { success: false, engine, error: ordersRes.error || "no upcoming orders" };
  }
  const attemptId = ordersRes.orders[0].id;
  const billingRes = await subscriptionAttemptBilling(workspaceId, attemptId);
  // Vendor ACCEPTANCE only — the charge result lands later on the Appstle webhook.
  return { success: billingRes.success, engine, settled: false, error: billingRes.error, attemptId };
}

/** What a dunning cycle's last recorded attempt says about whether to present a card again. */
export type PriorAttemptOutcome = "succeeded" | "unresolved" | "clear";

/**
 * Pure: classify the cycle's last recorded attempt.
 *
 *  - `succeeded` — it settled as a charge after we stopped waiting (a slow success). The cycle is
 *    paid; charging any card now is a SECOND charge.
 *  - `unresolved` — still pending (3DS), or we could not read it. Present no card this pass.
 *  - `clear` — no Shopify attempt on record, or it settled as a decline. Retry as normal.
 */
export function classifyPriorAttempt(
  read: { success: boolean; pending?: boolean; terminal?: boolean } | null,
): PriorAttemptOutcome {
  if (!read) return "clear";
  if (read.success) return "succeeded";
  if (read.terminal) return "clear";
  return "unresolved";
}

/**
 * Read the outcome of a ShopCX cycle's last recorded attempt before presenting another card.
 *
 * Card rotation and the payday pass both stop on an unresolved attempt and record its id on the
 * cycle. Nothing else settles it (`dunning/billing-success` comes only from Appstle), so the next
 * payday pass must look before it charges. Only a Shopify attempt gid is read; an Appstle attempt
 * id (or none) is `clear`.
 */
export async function priorShopcxAttemptOutcome(
  workspaceId: string,
  attemptId: string | null | undefined,
): Promise<PriorAttemptOutcome> {
  if (!attemptId || !String(attemptId).startsWith("gid://shopify/SubscriptionBillingAttempt/")) return "clear";
  try {
    const { getBillingAttempt } = await import("@/lib/commerce/shopify-subscription-client");
    return classifyPriorAttempt(await getBillingAttempt(workspaceId, String(attemptId)));
  } catch {
    return "unresolved";
  }
}

/** Unskip whatever the engine considers skipped. A no-op where the concept doesn't apply. */
export async function dunningUnskip(
  workspaceId: string,
  contractId: string,
  appstleBillingAttemptId: string | null,
): Promise<void> {
  contractId = await resolveLiveContractId(workspaceId, contractId);
  const src = await resolveBillingSource(workspaceId, contractId);
  if (src === "shopcx") {
    const { shopifyUnskipBillingCycle } = await import("@/lib/commerce/shopify-subscription-client");
    // Best-effort: a contract with nothing skipped simply reports so, which is not an error here.
    await shopifyUnskipBillingCycle(workspaceId, contractId);
    return;
  }
  if (!appstleBillingAttemptId) return;
  {
    // Nothing to unskip on a retired Appstle — the call would only throw AppstleRetiredError.
    const { isAppstleRetired } = await import("@/lib/appstle-retired");
    if (await isAppstleRetired()) return;
  }
  const { subscriptionUnskipOrder } = await import("@/lib/commerce/subscription");
  await subscriptionUnskipOrder(workspaceId, appstleBillingAttemptId);
}
