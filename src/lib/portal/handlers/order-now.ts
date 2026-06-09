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
  if (!resolved || !contractId) return jsonErr({ error: "missing_contractId" }, 400);

  // Internal subs: fire the SAME renewal pipeline a scheduled charge uses
  // (charge → order → Avalara → Amplifier → advance next billing date). Async via
  // Inngest, so this returns immediately and the order shows up shortly.
  if (resolved.is_internal) {
    if (resolved.status !== "active") {
      return jsonErr({ error: "not_active", message: "This subscription isn't active." }, 409);
    }
    const { inngest } = await import("@/lib/inngest/client");
    await inngest.send({
      name: "internal-subscription/renewal-attempt",
      data: { subscription_id: resolved.id, workspace_id: auth.workspaceId },
    });
    const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
    if (customer) {
      await logPortalAction({
        workspaceId: auth.workspaceId, customerId: customer.id,
        eventType: "portal.order_now",
        summary: "Customer triggered an immediate renewal via portal (internal sub)",
        properties: { subscription_id: resolved.id },
        createNote: true,
      });
    }
    return jsonOk({ ok: true, route, contractId, patch: {} });
  }

  // Appstle subs: attempt the upcoming Appstle billing.
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
