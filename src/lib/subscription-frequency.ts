/**
 * Shared subscription frequency change — the ONE sequence both the Portal and the
 * next-order journey run when a customer changes delivery cadence.
 *
 * CEO parity rule (2026-11-22): cancels, saves and account management exist on the
 * Portal AND in journeys and must stay in sync. The journey edit route used to call
 * `subscriptionUpdateBillingInterval` alone and skip the next-bill-date roll-forward
 * that fixed the stranded-sub bug (Ashley Denson, 2026-10-08), so a journey frequency
 * change re-pinned the cycle window and stranded the sub. This extracts the Portal's
 * full sequence so both surfaces run it identically.
 *
 * Our DB row is the PLANNER: a frequency change updates the cadence on our row and
 * rolls `next_billing_date` forward to a FUTURE date by the NEW cadence, then sets
 * Shopify's DISPLAY date to match through the engine-dispatch chokepoint — it never
 * re-pins the cycle calendar (the charge resolves the first unbilled cycle by index
 * at charge time). See [[docs/brain/libraries/subscription-frequency]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { subscriptionUpdateBillingInterval, subscriptionUpdateNextBillingDate } from "@/lib/commerce/subscription";
import { rollForwardToFutureBillingDate } from "@/lib/dunning";

type Admin = ReturnType<typeof createAdminClient>;

export type BillingInterval = "DAY" | "WEEK" | "MONTH" | "YEAR";

export function isValidBillingInterval(v: string): v is BillingInterval {
  return v === "DAY" || v === "WEEK" || v === "MONTH" || v === "YEAR";
}

export interface ChangeFrequencyResult {
  success: boolean;
  error?: string;
  /** Normalized interval (UPPER) actually applied. */
  interval: BillingInterval | null;
  intervalCount: number;
  /** The rolled-forward next billing date (ISO), when the change succeeded. */
  nextBillingDate?: string;
}

/**
 * Change a subscription's billing interval across engines, then roll `next_billing_date`
 * forward by the NEW cadence and sync Shopify's display date. Normalizes interval casing
 * the way the Portal does. Returns a typed result both surfaces map to their own response.
 *
 * Callers own their surface-specific gates (ban check, failed-payment guard, first-delivery
 * gate, consent/logging) — this helper is just the shared mutation sequence.
 */
export async function changeSubscriptionFrequency(
  workspaceId: string,
  contractId: string,
  interval: string,
  intervalCount: number,
  admin: Admin = createAdminClient(),
): Promise<ChangeFrequencyResult> {
  const intervalUpper = (interval || "").trim().toUpperCase();
  const count = Math.floor(Number(intervalCount) || 0);

  if (!contractId) return { success: false, error: "missing_contractId", interval: null, intervalCount: count };
  if (!count) return { success: false, error: "missing_intervalCount", interval: null, intervalCount: count };
  if (!isValidBillingInterval(intervalUpper)) {
    return { success: false, error: "invalid_interval", interval: null, intervalCount: count };
  }

  // 1. Vendor/engine write through the commerce SDK (resolves billing_source).
  const result = await subscriptionUpdateBillingInterval(workspaceId, contractId, intervalUpper, count);
  if (!result.success) {
    return { success: false, error: result.error, interval: intervalUpper, intervalCount: count };
  }

  // 2. Roll next_billing_date forward by the NEW cadence on our planner row.
  const newInterval = intervalUpper.toLowerCase();
  const { data: subRow } = await admin
    .from("subscriptions")
    .select("next_billing_date")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  const prior = (subRow as { next_billing_date: string | null } | null)?.next_billing_date ?? null;
  const from = prior ? new Date(prior) : new Date();
  let nextBillingDate: string;
  try {
    nextBillingDate = rollForwardToFutureBillingDate(
      Number.isNaN(from.getTime()) ? new Date() : from,
      newInterval,
      count,
    ).toISOString();
  } catch {
    nextBillingDate = new Date(Date.now() + 86_400_000).toISOString();
  }

  await admin
    .from("subscriptions")
    .update({
      billing_interval: newInterval,
      billing_interval_count: count,
      next_billing_date: nextBillingDate,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId);

  // 3. Display-only sync (never re-pins cycles). Non-fatal: cosmetic drift the daily
  //    reconciler catches.
  try {
    await subscriptionUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
  } catch (e) {
    console.warn(`[subscription-frequency] ${contractId}: display next-billing-date sync threw (non-fatal):`, e instanceof Error ? e.message : e);
  }

  return { success: true, interval: intervalUpper, intervalCount: count, nextBillingDate };
}
