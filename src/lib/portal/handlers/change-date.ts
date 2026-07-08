import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { appstleUpdateNextBillingDate } from "@/lib/appstle";
import { shouldBlockForFailedPayment } from "@/lib/portal/failed-payment-guard";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

export const changeDate: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const resolved = await resolveSub(createAdminClient(), auth.workspaceId, payload?.contractId, auth.loggedInCustomerId);
  const contractId = resolved?.shopify_contract_id || "";
  const dateStr = s(payload?.nextBillingDate);
  if (!resolved || !contractId) return jsonErr({ error: "missing_contractId" }, 400);
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

  // Block failed-payment Appstle subs — see failed-payment-guard.ts.
  // Internal subs are exempt (their flag can be stale after migration and
  // the internal-aware wrapper handles them correctly).
  if (shouldBlockForFailedPayment(resolved)) {
    return jsonErr({ error: "payment_failed_update_blocked", message: "This subscription has a failed payment. Update your payment method or cancel before changing the next order date." }, 409);
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
