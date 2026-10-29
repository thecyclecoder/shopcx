import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, addDaysFromNow, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub, portalFetch } from "@/lib/portal/helpers";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { subscriptionAction } from "@/lib/commerce/subscription";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const reactivate: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  let contractId = resolved?.shopify_contract_id || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Accept custom date from frontend, default to tomorrow
  let nextBillingDate = typeof payload?.nextBillingDate === "string" && payload.nextBillingDate
    ? new Date(payload.nextBillingDate as string).toISOString()
    : addDaysFromNow(1);

  try {
    // 1) Set next billing date — Appstle subs go through the Appstle API; internal
    //    subs get their date from the DB update below (no Appstle contract exists).
    const { resolveBillingSource } = await import("@/lib/internal-subscription");
    let engine = await resolveBillingSource(auth.workspaceId, String(contractId));

    // ⭐ appstle_retired: a never-migrated Appstle sub is REVIVED ON SHOPCX, built from our mirror
    // with the customer's chosen date — never through Appstle. The contract is born ACTIVE, so the
    // vendor resume below is skipped; only the local truth is applied.
    let revivedOnShopcx = false;
    if (engine === "appstle") {
      const { ensureShopcxEngine, ensureFailureText } = await import("@/lib/commerce/shopcx-revive");
      const ens = await ensureShopcxEngine(auth.workspaceId, String(contractId), "resume", { nextBillingDate });
      if (!ens.ok) {
        if (ens.reason === "needs_payment_method" || ens.reason === "needs_address") {
          return jsonErr({ error: ens.reason, message: ens.error }, 409);
        }
        throw new Error(ensureFailureText(ens));
      }
      if (ens.engine === "shopcx") {
        contractId = ens.contractId;
        engine = "shopcx";
        revivedOnShopcx = ens.built;
      }
    }

    // ShopCX: the date has to reach the CONTRACT, not just our mirror — the portal and every
    // Shopify-sourced view read it from there. Through the SDK; the DB update below still runs.
    if (engine === "shopcx" && !revivedOnShopcx) {
      const { subscriptionUpdateNextBillingDate } = await import("@/lib/commerce/subscription");
      const d = await subscriptionUpdateNextBillingDate(auth.workspaceId, String(contractId), nextBillingDate);
      if (!d.success) throw new Error(d.error || "Could not set next billing date");
    }

    if (engine === "appstle") {
      const { healOnTouch } = await import("@/lib/appstle-pricing");
      await healOnTouch(auth.workspaceId, String(contractId));
      const admin = createAdminClient();
      const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
      if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
      const apiKey = decrypt(ws.appstle_api_key_encrypted);

      await portalFetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(nextBillingDate)}`,
        { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" }
      );
    }

    // 2) Resume subscription (wrapper is internal-aware). A contract just revived on ShopCX was
    //    created ACTIVE on the chosen date — only the local status truth remains.
    if (revivedOnShopcx) {
      const { applySubscriptionStatusTruth } = await import("@/lib/commerce/subscription-status-truth");
      await applySubscriptionStatusTruth(auth.workspaceId, String(contractId), "resume");
      // The build rolls a lapsed date forward; use the date actually on the contract.
      const { data: row } = await createAdminClient().from("subscriptions").select("next_billing_date")
        .eq("workspace_id", auth.workspaceId).eq("shopify_contract_id", String(contractId)).maybeSingle();
      if (row?.next_billing_date) nextBillingDate = String(row.next_billing_date);
    } else {
      const result = await subscriptionAction(auth.workspaceId, String(contractId), "resume");
      if (!result.success) throw new Error(result.error || "Resume failed");
    }
  } catch (e) {
    return handleAppstleError(e);
  }

  // Update local DB: status + next billing date
  {
    const adminDb = createAdminClient();
    await adminDb.from("subscriptions")
      .update({
        status: "active",
        next_billing_date: nextBillingDate,
        pause_resume_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_contract_id", String(contractId));
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.reactivated",
      summary: "Customer reactivated subscription via portal",
      properties: { shopify_contract_id: String(contractId), nextBillingDate },
      createNote: true,
    });
  }

  return jsonOk({
    ok: true, route, contractId,
    patch: { status: "ACTIVE", nextBillingDate, portalReactivatedAt: new Date().toISOString() },
  });
};
