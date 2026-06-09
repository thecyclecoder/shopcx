import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { vaultPaymentMethod, savePaymentMethod } from "@/lib/integrations/braintree-customer";

function s(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }

/**
 * updatePaymentMethod — vault a new card (from Braintree Hosted Fields in the
 * portal) as the customer's default, then sweep their Appstle subs onto our
 * internal rails (strangler migration — spec § 1c). The in-house portal
 * previously had no add/update card flow; failed-payment subs couldn't
 * self-serve a new card.
 */
export const updatePaymentMethod: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  const nonce = s(payload?.paymentMethodNonce);
  const deviceData = s(payload?.deviceData) || undefined;
  if (!nonce) return jsonErr({ error: "missing_payment_method_nonce" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();
  // Resolve the Braintree customer id to vault against. Prefer an existing PM
  // row; for the customer's FIRST card there's none, so resolve-or-create the
  // Braintree customer (same helper the checkout client-token uses).
  const { data: existingPm } = await admin
    .from("customer_payment_methods")
    .select("braintree_customer_id")
    .eq("workspace_id", auth.workspaceId)
    .eq("customer_id", customer.id)
    .not("braintree_customer_id", "is", null)
    .limit(1)
    .maybeSingle();
  let braintreeCustomerId = existingPm?.braintree_customer_id as string | undefined;
  if (!braintreeCustomerId) {
    try {
      const { resolveBraintreeCustomerId } = await import("@/lib/integrations/braintree-customer");
      braintreeCustomerId = (await resolveBraintreeCustomerId({
        workspaceId: auth.workspaceId,
        customerId: customer.id,
        email: customer.email || "",
        firstName: (customer.first_name as string | null) || undefined,
        lastName: (customer.last_name as string | null) || undefined,
      })) || undefined;
    } catch (e) {
      return jsonErr({ error: "no_braintree_customer", message: e instanceof Error ? e.message : String(e) }, 502);
    }
  }
  if (!braintreeCustomerId) return jsonErr({ error: "no_braintree_customer" }, 400);

  // Vault the new card + make it default.
  let vaulted;
  try {
    vaulted = await vaultPaymentMethod(auth.workspaceId, braintreeCustomerId, nonce, deviceData);
  } catch (e) {
    return jsonErr({ error: "vault_failed", message: e instanceof Error ? e.message : String(e) }, 502);
  }
  await savePaymentMethod({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    braintreeCustomerId,
    braintreePaymentMethodToken: vaulted.token,
    paymentType: vaulted.paymentType,
    cardBrand: vaulted.cardBrand,
    last4: vaulted.last4,
    expirationMonth: vaulted.expirationMonth,
    expirationYear: vaulted.expirationYear,
    makeDefault: true,
  });

  // Strangler migration: fresh card on file → sweep Appstle subs to internal.
  let migratedCount = 0;
  try {
    const { migrateCustomerAppstleSubsToInternal } = await import("@/lib/migrate-to-internal");
    const mig = await migrateCustomerAppstleSubsToInternal(auth.workspaceId, customer.id);
    migratedCount = mig.migrated.length;
    if (mig.failed.length) console.error("[portal/payment] migration failures:", mig.failed);
  } catch (e) {
    console.error("[portal/payment] migration threw (non-fatal):", e instanceof Error ? e.message : e);
  }

  await logPortalAction({
    workspaceId: auth.workspaceId,
    customerId: customer.id,
    eventType: "portal.payment_method.updated",
    summary: `Customer updated payment method via portal${migratedCount ? ` (migrated ${migratedCount} sub(s) to internal)` : ""}`,
    properties: { last4: vaulted.last4, card_brand: vaulted.cardBrand, migrated_count: migratedCount },
    createNote: false,
  });

  return jsonOk({ ok: true, route, migrated_count: migratedCount, patch: { paymentMethod: { last4: vaulted.last4, cardBrand: vaulted.cardBrand } } });
};
