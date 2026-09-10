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

export async function applySubscriptionStatusTruth(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
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
