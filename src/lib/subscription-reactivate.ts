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
 * Behaviour (lifted unchanged from the portal handler):
 *   1. Never-migrated Appstle sub → revived ON SHOPCX from our mirror via `ensureShopcxEngine`
 *      (born ACTIVE on the chosen date, customer's own price). Typed refusals
 *      `needs_payment_method` / `needs_address` are returned, not thrown.
 *   2. ShopCX contract → next billing date set on the contract through the commerce SDK.
 *   3. Legacy Appstle path (only while the appstle_retired switch is off) → Appstle date API.
 *   4. Resume through `subscriptionAction` (internal-aware), then the local row is stamped active.
 */
import { subscriptionAction } from "@/lib/commerce/subscription";
import { decrypt } from "@/lib/crypto";
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
    const { resolveBillingSource } = await import("@/lib/internal-subscription");
    let engine = await resolveBillingSource(workspaceId, contractId);

    if (engine === "appstle") {
      const { ensureShopcxEngine, ensureFailureText } = await import("@/lib/commerce/shopcx-revive");
      const ens = await ensureShopcxEngine(workspaceId, contractId, "resume", { nextBillingDate });
      if (!ens.ok) {
        if (ens.reason === "needs_payment_method" || ens.reason === "needs_address") {
          return { ok: false, reason: ens.reason, message: ens.error };
        }
        return { ok: false, reason: "error", message: ensureFailureText(ens) };
      }
      if (ens.engine === "shopcx") {
        contractId = ens.contractId;
        engine = "shopcx";
        revivedOnShopcx = ens.built;
      }
    }

    if (engine === "shopcx" && !revivedOnShopcx) {
      const { subscriptionUpdateNextBillingDate } = await import("@/lib/commerce/subscription");
      const d = await subscriptionUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
      if (!d.success) return { ok: false, reason: "error", message: d.error || "Could not set next billing date" };
    }

    if (engine === "appstle") {
      const { healOnTouch } = await import("@/lib/appstle-pricing");
      await healOnTouch(workspaceId, contractId);
      const admin = createAdminClient();
      const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
      if (!ws?.appstle_api_key_encrypted) return { ok: false, reason: "appstle_not_configured", message: "Appstle not configured" };
      const apiKey = decrypt(ws.appstle_api_key_encrypted);
      const { portalFetch } = await import("@/lib/portal/helpers");
      await portalFetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(nextBillingDate)}`,
        { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" },
      );
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
