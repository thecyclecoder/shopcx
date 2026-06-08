import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleUpdateNextBillingDate } from "@/lib/appstle";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

export const changeDate: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  const dateStr = s(payload?.nextBillingDate);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (!dateStr) return jsonErr({ error: "missing_nextBillingDate" }, 400);

  // Validate date range: tomorrow to 60 days from now
  const picked = new Date(dateStr + "T00:00:00Z");
  if (isNaN(picked.getTime())) return jsonErr({ error: "invalid_date" }, 400);

  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2));
  const maxDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 90));

  if (picked < tomorrow) return jsonErr({ error: "date_too_early" }, 400);
  if (picked > maxDate) return jsonErr({ error: "date_too_far" }, 400);

  const nextBillingDate = picked.toISOString();

  // Block changes on subscriptions with a failed last payment. Customers in
  // this state were silently pushing dates around on dormant payment-failed
  // contracts (seen on ticket 52a0a618 — customer had two subs, changed the
  // date on the failed-payment one thinking it would stop billing on the
  // active one). The right next step here is updating the payment method or
  // cancelling — not moving the date.
  {
    const admin = createAdminClient();
    const { data: sub } = await admin
      .from("subscriptions")
      .select("last_payment_status")
      .eq("workspace_id", auth.workspaceId)
      .eq("shopify_contract_id", String(contractId))
      .maybeSingle();
    if (sub?.last_payment_status === "failed") {
      return jsonErr({ error: "payment_failed_update_blocked", message: "This subscription has a failed payment. Update your payment method or cancel before changing the next order date." }, 409);
    }
  }

  // Route through the internal-aware wrapper (handles is_internal vs Appstle).
  const dateResult = await appstleUpdateNextBillingDate(auth.workspaceId, String(contractId), nextBillingDate);
  if (!dateResult.success) {
    return handleAppstleError(new Error(dateResult.error || "Date update failed"), { route: "changeDate", payload: { contractId, nextBillingDate } });
  }

  // Update local DB
  const admin = createAdminClient();
  await admin.from("subscriptions")
    .update({ next_billing_date: nextBillingDate, updated_at: new Date().toISOString() })
    .eq("workspace_id", auth.workspaceId)
    .eq("shopify_contract_id", String(contractId));

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    const label = picked.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.date.changed",
      summary: `Customer changed next order date to ${label} via portal`,
      properties: { shopify_contract_id: String(contractId), nextBillingDate },
      createNote: false,
    });
  }

  return jsonOk({ ok: true, route, contractId, patch: { nextBillingDate } });
};
