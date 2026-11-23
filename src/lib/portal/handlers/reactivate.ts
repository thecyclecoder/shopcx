import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, addDaysFromNow, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
// ⭐ Vendor writes go through the commerce SDK, never the Appstle wrapper directly. Calling the
// vendor straight bypasses billing_source resolution, so a migrated subscription's change would
// hit Appstle for a contract it no longer holds — failing there and returning BEFORE the local
// write, leaving the customer's change silently unapplied.
import { reactivateSubscription } from "@/lib/subscription-reactivate";
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
  const requestedDate = typeof payload?.nextBillingDate === "string" && payload.nextBillingDate
    ? new Date(payload.nextBillingDate as string).toISOString()
    : addDaysFromNow(1);

  // ⭐ Shared with the win-back journey (src/lib/subscription-reactivate.ts) so the portal and the
  // mini-site restart a subscription the exact same way.
  const r = await reactivateSubscription(auth.workspaceId, String(contractId), { nextBillingDate: requestedDate });
  if (!r.ok) {
    if (r.reason === "needs_payment_method" || r.reason === "needs_address") {
      return jsonErr({ error: r.reason, message: r.message }, 409);
    }
    if (r.reason === "appstle_not_configured") return handleAppstleError(new Error("Appstle not configured"));
    return handleAppstleError({ message: r.message, details: r.details });
  }
  contractId = r.contractId;
  const nextBillingDate = r.nextBillingDate;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.reactivated",
      summary: "Customer reactivated subscription via portal",
      properties: { shopify_contract_id: String(contractId), nextBillingDate },
      createNote: true,
    });
    // Out-of-stock flavors swapped on restart — same behaviour + same note as the win-back journey.
    const { crisisSwapNote } = await import("@/lib/crisis-restart-swap");
    const swapNote = crisisSwapNote(r.crisisSwaps);
    if (swapNote) {
      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.subscription.crisis_swapped_on_restart",
        summary: swapNote,
        properties: { shopify_contract_id: String(contractId), crisis_swaps: r.crisisSwaps.map((x) => ({ crisis_id: x.crisisId, from: x.fromLabel, to: x.toLabel, ok: x.ok, error: x.error ?? null })) },
        createNote: true,
      });
    }
  }

  return jsonOk({
    ok: true, route, contractId,
    crisisSwaps: r.crisisSwaps.filter((x) => x.ok).map((x) => ({ from: x.fromLabel, to: x.toLabel, expectedRestock: x.expectedRestock })),
    patch: { status: "ACTIVE", nextBillingDate, portalReactivatedAt: new Date().toISOString() },
  });
};
