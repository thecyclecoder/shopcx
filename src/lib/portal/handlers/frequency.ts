import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, checkPortalBan, resolveSub } from "@/lib/portal/helpers";
import { appstleUpdateBillingInterval } from "@/lib/appstle";
import { createAdminClient } from "@/lib/supabase/admin";
import { shouldBlockForFailedPayment } from "@/lib/portal/failed-payment-guard";

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

  const result = await appstleUpdateBillingInterval(auth.workspaceId, String(contractId), intervalRaw, intervalCount);
  if (!result.success) {
    return jsonErr({ error: "frequency_update_failed", message: result.error }, 502);
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
