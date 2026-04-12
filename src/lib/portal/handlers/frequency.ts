import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { appstleUpdateBillingInterval } from "@/lib/appstle";

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

  const contractId = clampInt(payload?.contractId, 0);
  const intervalCount = clampInt(payload?.intervalCount, 0);
  const intervalRaw = s(payload?.interval).toUpperCase();

  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (!intervalCount) return jsonErr({ error: "missing_intervalCount" }, 400);
  if (!isValidInterval(intervalRaw)) return jsonErr({ error: "invalid_interval" }, 400);

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
