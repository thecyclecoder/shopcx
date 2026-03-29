import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, addDaysFromNow, findCustomer, logPortalAction, handleAppstleError } from "@/lib/portal/helpers";
import { appstleSubscriptionAction } from "@/lib/appstle";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const reactivate: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const nextBillingDate = addDaysFromNow(1);

  try {
    // 1) Set next billing date to tomorrow
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(nextBillingDate)}`,
      { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" }
    );

    // 2) Resume subscription
    const result = await appstleSubscriptionAction(auth.workspaceId, String(contractId), "resume");
    if (!result.success) throw new Error(result.error || "Resume failed");
  } catch (e) {
    return handleAppstleError(e);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.subscription.reactivated",
      summary: "Customer reactivated subscription via portal",
      properties: { shopify_contract_id: String(contractId) },
      createNote: true,
    });
  }

  return jsonOk({
    ok: true, route, contractId,
    patch: { status: "ACTIVE", nextBillingDate, portalReactivatedAt: new Date().toISOString() },
  });
};
