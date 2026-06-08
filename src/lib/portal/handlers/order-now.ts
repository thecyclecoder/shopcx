import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { appstleGetUpcomingOrders, appstleAttemptBilling } from "@/lib/appstle";
import { createAdminClient } from "@/lib/supabase/admin";

export const orderNow: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Get upcoming orders to find the billing attempt ID
  const ordersRes = await appstleGetUpcomingOrders(auth.workspaceId, String(contractId));
  if (!ordersRes.success || !ordersRes.orders?.length) {
    return jsonErr({ error: "no_upcoming_orders", message: "No upcoming orders found to bill." }, 400);
  }

  const billingAttemptId = ordersRes.orders[0].id;
  const result = await appstleAttemptBilling(auth.workspaceId, billingAttemptId);
  if (!result.success) {
    return handleAppstleError(new Error(result.error || "Billing failed"));
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.order_now",
      summary: "Customer triggered immediate billing via portal",
      properties: { shopify_contract_id: String(contractId), billingAttemptId },
      createNote: true,
    });
  }

  return jsonOk({ ok: true, route, contractId, patch: {} });
};
