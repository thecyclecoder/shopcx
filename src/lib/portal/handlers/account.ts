import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { directActionHandlers } from "@/lib/action-executor";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Portal route: update the logged-in customer's contact info
 * (name / email / phone). Wraps the update_customer_info direct
 * action so the same validation, Shopify customerUpdate sync, and
 * audit behaviour apply whether the change came from a ticket reply
 * or the customer's portal.
 *
 * Body: { first_name?, last_name?, email?, phone_number? }
 */
export const updateAccount: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload || typeof payload !== "object") {
    return jsonErr({ error: "missing_body" }, 400);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const handler = directActionHandlers.update_customer_info;
  if (!handler) return jsonErr({ error: "handler_not_registered" }, 500);

  const admin = createAdminClient();
  const result = await handler(
    {
      admin,
      workspaceId: auth.workspaceId,
      ticketId: "",         // no ticket — pure portal action
      customerId: customer.id,
      channel: "portal",
      sandbox: false,
    } as Parameters<typeof handler>[0],
    {
      type: "update_customer_info",
      first_name: typeof payload.first_name === "string" ? payload.first_name : undefined,
      last_name: typeof payload.last_name === "string" ? payload.last_name : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      phone_number: typeof payload.phone_number === "string" ? payload.phone_number : undefined,
    },
  );

  if (!result.success) {
    return jsonErr({ error: "update_failed", message: result.error || "Could not update" }, 400);
  }

  await logPortalAction({
    workspaceId: auth.workspaceId, customerId: customer.id,
    eventType: "portal.account.updated",
    summary: result.summary || "Customer updated account info",
    properties: { fields_changed: Object.keys(payload) },
    createNote: false,
  });

  return jsonOk({ ok: true, route, summary: result.summary });
};
