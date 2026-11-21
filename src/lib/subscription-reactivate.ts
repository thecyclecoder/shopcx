/**
 * subscription-reactivate — the ONE reactivation path shared by the portal and the journey mini-site.
 *
 * Before this existed, only the portal (`portal/handlers/reactivate.ts`) could restart a cancelled
 * or paused subscription. The win-back journey (`reactivate-journey-builder.ts`) showed a
 * "Yes, restart my subscription" button, but the single-step journey only RECORDED the click
 * (`/api/journey/[token]/step`) — no outcome was ever emitted, and the outcome handler keyed on a
 * `session.subscription_id` the win-back mint never set. Customers were told "we'll email you" and
 * nothing restarted. Rule (CEO 2026-11-16): cancels, saves and account management exist on two
 * surfaces and must stay in sync — so both surfaces now call this function.
 *
 * Behaviour:
 *   1. `ensureShopcxEngine` is the ONLY engine resolution here — a never-migrated Appstle sub
 *      (appstle_retired switch on) is revived ON SHOPCX from our mirror (born ACTIVE on the chosen
 *      date, customer's own price); every other engine is a pass-through. Typed refusals
 *      `needs_payment_method` / `needs_address` are returned, not thrown.
 *   2. Unless it was just rebuilt on ShopCX, the restart date is set through the commerce SDK
 *      (`subscriptionUpdateNextBillingDate`), which branches internal | shopcx | appstle and
 *      dispatches to the right writer / vendor wrapper — reactivate never hand-rolls the vendor
 *      call nor resolves `billing_source` itself (check-vendor-dispatch-in-sdk).
 *   3. Resume through `subscriptionAction` (internal-aware), then the local row is stamped active.
 */
import { subscriptionAction } from "@/lib/commerce/subscription";
import { createAdminClient } from "@/lib/supabase/admin";

export type ReactivateFailureReason = "needs_payment_method" | "needs_address" | "appstle_not_configured" | "error";

export type ReactivateResult =
  | { ok: true; contractId: string; nextBillingDate: string; revivedOnShopcx: boolean }
  | { ok: false; reason: ReactivateFailureReason; message: string; details?: unknown };

/** Default first-charge date for a restart: tomorrow (+15 min so it never lands in the past). */
export function defaultReactivationDate(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000 + 15 * 60 * 1000).toISOString();
}

export async function reactivateSubscription(
  workspaceId: string,
  contractIdIn: string,
  opts: { nextBillingDate?: string } = {},
): Promise<ReactivateResult> {
  let contractId = String(contractIdIn);
  let nextBillingDate = opts.nextBillingDate || defaultReactivationDate();
  let revivedOnShopcx = false;

  try {
    // ensureShopcxEngine is the appstle_retired chokepoint and the ONLY engine resolution this
    // flow does — reactivate never resolves billing_source itself (check-vendor-dispatch-in-sdk):
    // engine dispatch stays inside the commerce SDK chokepoints. For a never-migrated Appstle sub
    // (switch on) it rebuilds the subscription ON ShopCX, born active on the chosen date, and
    // surfaces needs_payment_method / needs_address refusals; for every other engine (a ShopCX
    // contract, an internal sub, or an Appstle sub while the switch is off) it is a pass-through
    // no-op that returns the live contract id unchanged.
    const { ensureShopcxEngine, ensureFailureText } = await import("@/lib/commerce/shopcx-revive");
    const ens = await ensureShopcxEngine(workspaceId, contractId, "resume", { nextBillingDate });
    if (!ens.ok) {
      if (ens.reason === "needs_payment_method" || ens.reason === "needs_address") {
        return { ok: false, reason: ens.reason, message: ens.error };
      }
      return { ok: false, reason: "error", message: ensureFailureText(ens) };
    }
    contractId = ens.contractId;
    revivedOnShopcx = ens.built;

    if (!revivedOnShopcx) {
      // Not freshly rebuilt on ShopCX (a fresh build is already born on the chosen date) → set the
      // restart date through the commerce SDK, which branches internal | shopcx | appstle and
      // dispatches to the right internal writer / Shopify / Appstle vendor wrapper. Never hand-roll
      // the Appstle vendor PUT (check-no-direct-appstle-mutations).
      const { subscriptionUpdateNextBillingDate } = await import("@/lib/commerce/subscription");
      const d = await subscriptionUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
      if (!d.success) {
        if (/not configured/i.test(d.error || "")) {
          return { ok: false, reason: "appstle_not_configured", message: "Appstle not configured" };
        }
        return { ok: false, reason: "error", message: d.error || "Could not set next billing date" };
      }
    }

    if (revivedOnShopcx) {
      const { applySubscriptionStatusTruth } = await import("@/lib/commerce/subscription-status-truth");
      await applySubscriptionStatusTruth(workspaceId, contractId, "resume");
      // The build rolls a lapsed date forward; report the date actually on the contract.
      const { data: row } = await createAdminClient().from("subscriptions").select("next_billing_date")
        .eq("workspace_id", workspaceId).eq("shopify_contract_id", contractId).maybeSingle();
      if (row?.next_billing_date) nextBillingDate = String(row.next_billing_date);
    } else {
      const result = await subscriptionAction(workspaceId, contractId, "resume");
      if (!result.success) return { ok: false, reason: "error", message: result.error || "Resume failed" };
    }
  } catch (e) {
    const err = e as { message?: string; details?: unknown };
    return { ok: false, reason: "error", message: err?.message || "Unknown error", details: err?.details };
  }

  await createAdminClient().from("subscriptions")
    .update({
      status: "active",
      next_billing_date: nextBillingDate,
      pause_resume_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId);

  return { ok: true, contractId, nextBillingDate, revivedOnShopcx };
}
