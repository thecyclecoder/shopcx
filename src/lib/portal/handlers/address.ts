import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, clampInt, findCustomer, logPortalAction, handleAppstleError, checkPortalBan } from "@/lib/portal/helpers";
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

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const contractId = clampInt(payload?.contractId, 0);
  if (!contractId) return jsonErr({ error: "missing_contractId" }, 400);

  const address1 = s(payload?.address1);
  const address2 = s(payload?.address2);
  const city = s(payload?.city);
  const provinceCode = s(payload?.provinceCode) || s(payload?.province);
  const zip = s(payload?.zip);
  const countryCode = s(payload?.countryCode || "US");
  const country = s(payload?.country || "United States");
  const methodType = normalizeMethodType(payload?.methodType);
  const firstName = s(payload?.firstName);
  const lastName = s(payload?.lastName);
  const phone = s(payload?.phone);
  const company = s(payload?.company);
  const skipVerification = payload?.skipVerification === true;

  if (!address1) return jsonErr({ error: "missing_address1" }, 400);
  if (!city) return jsonErr({ error: "missing_city" }, 400);
  if (!provinceCode) return jsonErr({ error: "missing_provinceCode" }, 400);
  if (!zip) return jsonErr({ error: "missing_zip" }, 400);

  // EasyPost address verification (unless skipped — e.g. customer confirmed the entered address)
  if (!skipVerification) {
    try {
      const { verifyAddress } = await import("@/lib/easypost");
      const verification = await verifyAddress(auth.workspaceId, {
        street1: address1,
        street2: address2 || undefined,
        city,
        state: provinceCode,
        zip,
        country: countryCode,
        name: [firstName, lastName].filter(Boolean).join(" ") || undefined,
        phone: phone || undefined,
      });

      if (!verification.valid) {
        // Return verification result so frontend can show suggested vs entered
        return jsonOk({
          ok: false,
          route,
          verification: {
            valid: false,
            entered: { address1, address2, city, province: provinceCode, zip },
            suggested: verification.suggestedAddress ? {
              address1: verification.suggestedAddress.street1,
              address2: verification.suggestedAddress.street2 || "",
              city: verification.suggestedAddress.city,
              province: verification.suggestedAddress.state,
              zip: verification.suggestedAddress.zip,
            } : null,
            errors: verification.errors,
          },
        });
      }

      // Use the verified address if different from entered
      // (EasyPost may have corrected formatting)
    } catch (e) {
      // If EasyPost is not configured or fails, proceed without verification
      console.warn("[portal/address] EasyPost verification skipped:", e instanceof Error ? e.message : e);
    }
  }

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
