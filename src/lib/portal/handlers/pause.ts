import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, addDaysFromNow, findCustomer, logPortalAction, handleAppstleError } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

async function appstlePut(workspaceId: string, path: string, body?: unknown) {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
  const apiKey = decrypt(ws.appstle_api_key_encrypted);

  const res = await fetch(`https://subscription-admin.appstle.com${path}`, {
    method: "PUT",
    headers: { "X-API-Key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Appstle API error: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function appstlePost(workspaceId: string, path: string, body: unknown) {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId).single();
  if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
  const apiKey = decrypt(ws.appstle_api_key_encrypted);

  const res = await fetch(`https://subscription-admin.appstle.com${path}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Appstle API error: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const pause: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  const pauseDays = clampInt(payload?.pauseDays, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);
  if (![30, 60].includes(pauseDays)) return jsonErr({ error: "invalid_pauseDays" }, 400);

  const nextBillingDate = addDaysFromNow(pauseDays);

  try {
    await appstlePut(auth.workspaceId,
      `/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(nextBillingDate)}`
    );

    // Set portal custom attributes
    const attrs = [
      { key: "portal_last_action", value: `pause_${pauseDays}` },
      { key: "portal_last_action_at", value: new Date().toISOString() },
      { key: "portal_pause_days", value: String(pauseDays) },
      { key: "portal_paused_until", value: "" },
    ];
    await appstlePost(auth.workspaceId,
      `/api/external/v2/update-custom-note-attributes?overwriteExistingAttributes=true`,
      { subscriptionContractId: contractId, customAttributesList: attrs }
    ).catch(() => {});
  } catch (e) {
    return handleAppstleError(e);
  }

  // Log event + internal note
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.subscription.paused",
      summary: `Customer paused subscription for ${pauseDays} days via portal`,
      properties: { shopify_contract_id: String(contractId), pauseDays },
      createNote: true,
    });
  }

  return jsonOk({
    ok: true, route, contractId, pauseDays,
    patch: { nextBillingDate, customAttributes: [
      { key: "portal_last_action", value: `pause_${pauseDays}` },
      { key: "portal_last_action_at", value: new Date().toISOString() },
      { key: "portal_pause_days", value: String(pauseDays) },
    ] },
  });
};
