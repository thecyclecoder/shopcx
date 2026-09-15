/**
 * The LOCAL half of a pause / cancel / resume — shared by every billing engine.
 *
 * ⭐ This used to live inside `appstleSubscriptionAction`, which meant it ran only when the write
 * went to Appstle. The moment a subscription moved to a ShopCX-owned Shopify contract, a cancel
 * skipped all of it: the row stayed `active`, `next_billing_date` kept advertising a future charge,
 * dunning kept an open cycle, and the renewal cron went on billing a customer who had cancelled.
 *
 * Extracted rather than copied deliberately — two implementations of cancel-truth is how they
 * diverge, and this one is load-bearing for "a cancelled subscription must not be billed."
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { applyCancelTruth } from "@/lib/subscription-cancel-truth";
import { endDunningForSubscription } from "@/lib/dunning";

const LOCAL_STATUS: Record<string, string> = { pause: "paused", cancel: "cancelled", resume: "active" };

/**
 * Record WHY a subscription was cancelled.
 *
 * ⚠️ `subscriptions` has no cancel-reason column. Only the APPSTLE path ever preserved a reason,
 * and it preserved it inside the vendor — so on the internal and ShopCX engines every
 * portal/journey/playbook cancel silently discarded it, and churn analysis on those subs has no
 * reason at all. `customer_events` is durable, queryable, and already where the rest of the
 * subscription lifecycle is recorded.
 *
 * Separate from `applySubscriptionStatusTruth` because the internal engine applies its own local
 * truth and only needs THIS half; running the whole thing again would re-close dunning and
 * re-run the customer rollup.
 */
export async function recordCancelReason(
  workspaceId: string,
  contractId: string,
  opts?: { cancelReason?: string; cancelledBy?: string },
): Promise<void> {
  if (!opts?.cancelReason && !opts?.cancelledBy) return;
  try {
    const admin = createAdminClient();
    const { logCustomerEvent } = await import("@/lib/customer-events");
    const { data: row } = await admin
      .from("subscriptions").select("id, customer_id")
      .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
    if (!row?.customer_id) return;
    await logCustomerEvent({
      workspaceId,
      customerId: String(row.customer_id),
      eventType: "subscription.cancelled",
      source: "commerce",
      summary: opts.cancelReason ? `Subscription cancelled — ${opts.cancelReason}` : "Subscription cancelled",
      properties: {
        shopify_contract_id: contractId,
        subscription_id: row.id,
        cancel_reason: opts.cancelReason ?? null,
        cancelled_by: opts.cancelledBy ?? null,
      },
    });
  } catch (e) {
    // Never fail the cancel because the audit note did — the customer asked to stop.
    console.error(`[status-truth] cancel-reason note failed for ${contractId}:`, e instanceof Error ? e.message : e);
  }
}

export async function applySubscriptionStatusTruth(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  /**
   * Why, and who asked. Recorded on a cancel.
   *
   * ⚠️ `subscriptions` has no cancel-reason column: only the APPSTLE path ever preserved a reason,
   * and it preserved it inside the vendor. So on the internal and ShopCX engines every
   * portal/journey/playbook cancel silently discarded it — and churn analysis on those subs has no
   * reason at all. Written to `customer_events`, which is durable, queryable, and already the
   * place the rest of the subscription lifecycle is recorded.
   */
  opts?: { cancelReason?: string; cancelledBy?: string },
): Promise<void> {
  const admin = createAdminClient();
  const localUpdate: Record<string, unknown> = {
    status: LOCAL_STATUS[action],
    updated_at: new Date().toISOString(),
  };
  // On cancel: null next_billing_date and stamp cancelled_at in the SAME write as the status. A
  // cancelled row must never advertise a future charge date.
  applyCancelTruth(localUpdate, action);

  // A pause or cancel ENDS dunning (CEO rule). An open cycle would keep retrying them, and a later
  // card update would resume + charge a subscription they deliberately stopped.
  if (action === "pause" || action === "cancel") {
    await endDunningForSubscription(workspaceId, contractId, action === "pause" ? "paused" : "cancelled");
  }

  if (action === "cancel") {
    await recordCancelReason(workspaceId, contractId, opts);
  }

  const { data: sub } = await admin
    .from("subscriptions")
    .update(localUpdate)
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .select("customer_id")
    .single();

  // Keep customers.subscription_status in step — highest priority across all of their subs.
  if (sub?.customer_id) {
    const { data: allSubs } = await admin
      .from("subscriptions").select("status").eq("customer_id", sub.customer_id);
    const statuses = new Set((allSubs || []).map((s) => s.status));
    const customerStatus = statuses.has("active") ? "active"
      : statuses.has("paused") ? "paused"
      : statuses.has("cancelled") ? "cancelled"
      : "never";
    await admin.from("customers").update({
      subscription_status: customerStatus,
      updated_at: new Date().toISOString(),
    }).eq("id", sub.customer_id);
  }
}

/**
 * Uniform refusal for an op that has no ShopCX-owned equivalent yet.
 *
 * ⚠️ Loud, never silent. The alternative — falling through to the Appstle wrapper — sends the write
 * to a vendor that no longer holds the contract, fails at the boundary, and returns before the
 * local write, so the UI reports an error while the subscription quietly keeps billing.
 */
export function shopcxUnsupported(op: string): { success: false; error: string } {
  return {
    success: false,
    error: `${op} is not supported for ShopCX-billed subscriptions yet — refusing rather than routing to Appstle, which no longer holds this contract`,
  };
}
