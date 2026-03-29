import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError } from "@/lib/portal/helpers";
import { decrypt } from "@/lib/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

function s(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeMethodType(v: unknown): "SHIPPING" | "LOCAL" | "PICK_UP" {
  const mt = s(v).toUpperCase();
  if (mt === "LOCAL") return "LOCAL";
  if (mt === "PICK_UP") return "PICK_UP";
  return "SHIPPING";
}

export const address: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const address1 = s(payload?.address1);
  const address2 = s(payload?.address2);
  const city = s(payload?.city);
  const provinceCode = s(payload?.provinceCode);
  const zip = s(payload?.zip);
  const countryCode = s(payload?.countryCode || "US");
  const country = s(payload?.country || "United States");
  const methodType = normalizeMethodType(payload?.methodType);
  const firstName = s(payload?.firstName);
  const lastName = s(payload?.lastName);
  const phone = s(payload?.phone);
  const company = s(payload?.company);

  if (!address1) return jsonErr({ error: "missing_address1" }, 400);
  if (!city) return jsonErr({ error: "missing_city" }, 400);
  if (!provinceCode) return jsonErr({ error: "missing_provinceCode" }, 400);
  if (!zip) return jsonErr({ error: "missing_zip" }, 400);

  try {
    const admin = createAdminClient();
    const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", auth.workspaceId).single();
    if (!ws?.appstle_api_key_encrypted) throw new Error("Appstle not configured");
    const apiKey = decrypt(ws.appstle_api_key_encrypted);

    await fetch(
      `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-shipping-address?contractId=${contractId}`,
      {
        method: "PUT",
        headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          address1, address2, city, zip, country, countryCode,
          province: provinceCode, provinceCode, firstName, lastName,
          methodType, phone: phone || undefined, company: company || undefined,
        }),
        cache: "no-store",
      }
    );
  } catch (e) {
    return handleAppstleError(e);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (customer) {
    await logPortalAction({
      workspaceId: auth.workspaceId, customerId: customer.id,
      eventType: "portal.address.changed",
      summary: `Customer updated shipping address via portal (${city}, ${provinceCode} ${zip})`,
      properties: { shopify_contract_id: String(contractId), city, provinceCode, zip },
      createNote: true,
    });
  }

  return jsonOk({
    ok: true, route, contractId,
    patch: { address: { firstName, lastName, address1, address2, city, provinceCode, zip, countryCode, country, methodType } },
  });
};
