/**
 * Portal route: list the customer's saved payment methods. Read-only
 * for v1 — adding a new card vault requires the Braintree client-side
 * Hosted Fields integration which lands as a follow-up. The shape of
 * this endpoint is forward-compatible with the eventual mutations.
 *
 * Returns ALL active payment methods on the customer + any linked
 * customer profiles. A linked account's saved cards are usable by the
 * shared person; the dunning pipeline already treats them as one
 * eligible pool, so the portal mirrors that.
 *
 * Output shape:
 * {
 *   ok: true,
 *   methods: [{ id, brand, last4, expiration_month, expiration_year,
 *               payment_type, is_default, provider, status }],
 *   migrationEnabled: boolean,  // workspace flag — when true the UI
 *                               // shows the "add new card" CTA; when
 *                               // false the section is read-only.
 * }
 */
import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const paymentMethods: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Expand to the customer's link group — same pattern as support /
  // subscriptions handlers. A shared person should see one combined
  // wallet across all their linked profiles.
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  let ids = [customer.id];
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    ids = (g || []).map((r) => r.customer_id as string);
    if (!ids.includes(customer.id)) ids.push(customer.id);
  }

  const { data: rows } = await admin
    .from("customer_payment_methods")
    .select("id, card_brand, last4, expiration_month, expiration_year, payment_type, is_default, provider, status, created_at")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .eq("status", "active")
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  const { data: ws } = await admin
    .from("workspaces")
    .select("portal_migration_enabled")
    .eq("id", auth.workspaceId)
    .single();

  return jsonOk({
    ok: true,
    route,
    methods: (rows || []).map((r) => ({
      id: r.id,
      brand: r.card_brand,
      last4: r.last4,
      expiration_month: r.expiration_month,
      expiration_year: r.expiration_year,
      payment_type: r.payment_type,
      is_default: r.is_default,
      provider: r.provider,
      status: r.status,
    })),
    migrationEnabled: !!ws?.portal_migration_enabled,
  });
};
