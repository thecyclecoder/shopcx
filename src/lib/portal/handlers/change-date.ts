import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

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

  try {
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    const res = await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(nextBillingDate)}`,
      { method: "PUT", headers: { "X-API-Key": apiKey }, cache: "no-store" }
    );
    if (!res.ok && res.status !== 204) {
      const errText = await res.text().catch(() => "");
      throw Object.assign(new Error(`Appstle API error: ${res.status}`), { details: errText });
    }
  } catch (e) {
    return handleAppstleError(e, { route: "changeDate", payload: { contractId, nextBillingDate } });
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
