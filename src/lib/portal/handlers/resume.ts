import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { subscriptionAction, subscriptionUpdateNextBillingDate } from "@/lib/commerce/subscription";

export const resume: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Route through the internal-aware wrapper (handles is_internal vs Appstle).
  const resumeResult = await subscriptionAction(auth.workspaceId, String(contractId), "resume");
  if (!resumeResult.success) return handleAppstleError(new Error(resumeResult.error || "Resume failed"));

  const admin = createAdminClient();

  // ⭐ Give the resumed sub a FUTURE billing date. Resuming only flips status back to active — the
  // row still carries the date it had when paused, which is now in the PAST. The manual resume
  // handler never set one at all (the auto-resume cron did, via `retimeAfterResume`). Left stale,
  // a ShopCX sub's date can sit behind its live cycle and strand it; an internal sub would take a
  // surprise immediate charge. Roll forward from the original date by the customer's own cadence so
  // their billing day is preserved — the pause just skips some cycles. Same roll-forward as
  // `retimeAfterResume` in src/lib/inngest/portal-auto-resume.ts.
  const { rollForwardToFutureBillingDate } = await import("@/lib/dunning");
  const { data: subRow } = await admin.from("subscriptions")
    .select("next_billing_date, billing_interval, billing_interval_count")
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .maybeSingle();
  const r = subRow as { next_billing_date: string | null; billing_interval: string | null; billing_interval_count: number | null } | null;
  const from = r?.next_billing_date ? new Date(r.next_billing_date) : new Date();
  let nextBillingDate: string;
  try {
    nextBillingDate = rollForwardToFutureBillingDate(
      Number.isNaN(from.getTime()) ? new Date() : from,
      r?.billing_interval ?? "month",
      r?.billing_interval_count ?? 1,
    ).toISOString();
  } catch {
    // rollForward refuses to return a past date; if it cannot, tomorrow is the safe floor.
    nextBillingDate = new Date(Date.now() + 86_400_000).toISOString();
  }

  // Update our DB: clear pause, set active, and set a future next_billing_date. The DB row is the
  // planner; Shopify's billing calendar is resolved at charge time, so we do NOT re-pin cycles here.
  await admin.from("subscriptions")
    .update({
      status: "active",
      pause_resume_at: null,
      next_billing_date: nextBillingDate,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId));

  // Move the vendor's displayed next-billing date to match, through the engine-dispatch chokepoint
  // (never branch on billing_source in a handler — that is how a migrated sub's writes vanish). The
  // SDK resolves internal | appstle | shopcx; for ShopCX this is display-only, since the charge
  // resolves the first unbilled cycle at charge time. Non-fatal: a failed display update is cosmetic
  // drift the daily reconciler catches, never a missed renewal.
  try {
    await subscriptionUpdateNextBillingDate(auth.workspaceId, String(contractId), nextBillingDate);
  } catch (e) {
    console.warn(`[resume] ${contractId}: display next-billing-date sync threw (non-fatal):`, e instanceof Error ? e.message : e);
  }

  // Log customer event
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.resumed",
      summary: `Subscription #${contractId} resumed early by customer`,
      properties: { shopify_contract_id: String(contractId) },
      createNote: false,
    });
  }

  // The Inngest auto-resume function will wake up later and no-op
  // since the subscription is already active

  return jsonOk({
    ok: true, route, contractId,
    patch: { status: "ACTIVE", pauseResumeAt: null },
  });
};
