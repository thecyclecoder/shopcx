import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { subscriptionUpdateBillingInterval, subscriptionUpdateNextBillingDate } from "@/lib/commerce/subscription";
import { createAdminClient } from "@/lib/supabase/admin";
import { shouldBlockForFailedPayment } from "@/lib/portal/failed-payment-guard";
import { rollForwardToFutureBillingDate } from "@/lib/dunning";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

type BillingInterval = "DAY" | "WEEK" | "MONTH" | "YEAR";
function isValidInterval(v: string): v is BillingInterval {
  return v === "DAY" || v === "WEEK" || v === "MONTH" || v === "YEAR";
}

export const frequency: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  const intervalCount = clampInt(payload?.intervalCount, 0);
  const intervalRaw = s(payload?.interval).toUpperCase();

  if (!resolved || !contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (!intervalCount) return jsonErr({ error: "missing_intervalCount" }, 400);
  if (!isValidInterval(intervalRaw)) return jsonErr({ error: "invalid_interval" }, 400);

  // Block failed-payment Appstle subs — see failed-payment-guard.ts.
  // Internal subs are exempt (their flag can be stale after migration and
  // the internal-aware wrapper handles them correctly).
  if (shouldBlockForFailedPayment(resolved)) {
    return jsonErr({ error: "payment_failed_update_blocked", message: "This subscription has a failed payment. Update your payment method or cancel before changing frequency." }, 409);
  }

  const result = await subscriptionUpdateBillingInterval(auth.workspaceId, String(contractId), intervalRaw, intervalCount);
  if (!result.success) {
    return jsonErr({ error: "frequency_update_failed", message: result.error }, 502);
  }

  // ⭐ Phase 2: our DB row is the PLANNER. A frequency change updates the cadence on our row and
  // rolls `next_billing_date` forward to a future date by the NEW cadence, then sets Shopify's
  // DISPLAY date to match through the engine-dispatch chokepoint — it never re-pins the cycle
  // calendar (the charge resolves the first unbilled cycle by index at charge time). The old
  // behaviour let Shopify re-shape the cycle window on a frequency change and strand the sub
  // (ground truth 2026-10-08, Ashley Denson).
  const admin = createAdminClient();
  const newInterval = intervalRaw.toLowerCase();
  const { data: subRow } = await admin.from("subscriptions")
    .select("next_billing_date")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .maybeSingle();
  const prior = (subRow as { next_billing_date: string | null } | null)?.next_billing_date ?? null;
  const from = prior ? new Date(prior) : new Date();
  let nextBillingDate: string;
  try {
    nextBillingDate = rollForwardToFutureBillingDate(
      Number.isNaN(from.getTime()) ? new Date() : from,
      newInterval,
      intervalCount,
    ).toISOString();
  } catch {
    nextBillingDate = new Date(Date.now() + 86_400_000).toISOString();
  }
  await admin.from("subscriptions")
    .update({
      billing_interval: newInterval,
      billing_interval_count: intervalCount,
      next_billing_date: nextBillingDate,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId));
  // Display-only sync (never re-pins cycles). Non-fatal: cosmetic drift the daily reconciler catches.
  try {
    await subscriptionUpdateNextBillingDate(auth.workspaceId, String(contractId), nextBillingDate);
  } catch (e) {
    console.warn(`[frequency] ${contractId}: display next-billing-date sync threw (non-fatal):`, e instanceof Error ? e.message : e);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.frequency_changed",
      summary: `Customer changed delivery frequency to every ${intervalCount} ${intervalRaw.toLowerCase()}(s) via portal`,
      properties: { shopify_contract_id: String(contractId), interval: intervalRaw, intervalCount },
      createNote: false,
    });
  }

  return jsonOk({ ok: true, route, contractId, interval: intervalRaw, intervalCount, patch: {} });
};
