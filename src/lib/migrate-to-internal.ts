/**
 * Strangler migration: flip a customer's Appstle subscriptions to internal,
 * IN PLACE — no new rows, so the stable subscription id and every reference to
 * it (orders, tickets, customer_events, timeline) stay valid. Called wherever
 * we capture a payment method (checkout, portal payment-method update).
 *
 * HARD RULE — a migration MUST be billable. The internal scheduler charges via
 * the sub's customer's default Braintree payment method. So we resolve the
 * link group ([[customer_links]]), pick the member that has a default Braintree
 * PM, reassign the sub to it, and SKIP any sub when no linked account has a PM.
 * Linking is display-only, so reassigning customer_id across a link group is
 * safe and is how the sub becomes billable.
 *
 * Per sub: read the LIVE Appstle state (preserve grandfathered prices, cadence,
 * next date) → cancel the Appstle contract → flip the existing row to
 * is_internal=true / active / billable customer. Cancel-then-flip so a failure
 * stops the sub (re-runnable) rather than double-billing it.
 *
 * See docs/brain/specs/storefront-mvp.md § 1c.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppstleConfig } from "@/lib/subscription-items";
import { appstleSubscriptionAction } from "@/lib/appstle";

type Admin = ReturnType<typeof createAdminClient>;

export interface MigrateResult {
  migrated: Array<{ contractId: string; subId: string; billableCustomerId: string }>;
  skipped: Array<{ contractId: string; reason: string }>;
  failed: Array<{ contractId: string; error: string }>;
}

/** All customer ids in the same link group (incl. self). */
async function linkedCustomerIds(admin: Admin, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  const ids = (group || []).map((r) => r.customer_id as string);
  return ids.length ? ids : [customerId];
}

/** Pick the link-group member with a default Braintree PM (prefer `preferred`). */
async function findBillableCustomer(admin: Admin, workspaceId: string, customerIds: string[], preferred: string): Promise<string | null> {
  const { data: pms } = await admin
    .from("customer_payment_methods")
    .select("customer_id, braintree_payment_method_token")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIds)
    .eq("is_default", true)
    .eq("provider", "braintree");
  const withPm = new Set((pms || []).filter((p) => p.braintree_payment_method_token).map((p) => p.customer_id as string));
  if (withPm.has(preferred)) return preferred;
  for (const id of customerIds) if (withPm.has(id)) return id;
  return null;
}

export async function migrateCustomerAppstleSubsToInternal(workspaceId: string, customerId: string): Promise<MigrateResult> {
  const admin = createAdminClient();
  const result: MigrateResult = { migrated: [], skipped: [], failed: [] };

  const groupIds = await linkedCustomerIds(admin, customerId);
  const billableCustomerId = await findBillableCustomer(admin, workspaceId, groupIds, customerId);

  // Active Appstle subs across the whole link group.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, is_internal")
    .eq("workspace_id", workspaceId)
    .in("customer_id", groupIds)
    .neq("status", "cancelled")
    .eq("is_internal", false);
  if (!subs?.length) return result;

  // HARD RULE: a migration must be billable — no PM anywhere in the link group → skip all.
  if (!billableCustomerId) {
    for (const s of subs) result.skipped.push({ contractId: String(s.shopify_contract_id), reason: "no_braintree_pm_in_link_group" });
    return result;
  }

  const cfg = await getAppstleConfig(workspaceId);
  for (const sub of subs) {
    const contractId = String(sub.shopify_contract_id);
    if (!cfg) { result.failed.push({ contractId, error: "Appstle not configured" }); continue; }
    try {
      // Read the LIVE Appstle contract — source of truth for current
      // (grandfathered) prices, cadence, and next billing date.
      const live = await (
        await fetch(
          `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${cfg.apiKey}`,
          { headers: { "X-API-Key": cfg.apiKey }, cache: "no-store" },
        )
      ).json();
      if (!live || live.status === "CANCELLED") { result.skipped.push({ contractId, reason: "already_cancelled_at_appstle" }); continue; }

      const items = ((live.lines?.nodes as Array<Record<string, unknown>>) || [])
        .map((l) => ({
          variant_id: String((l.variantId as string) || "").split("/").pop() || "",
          title: (l.title as string) || "",
          variant_title: (l.variantTitle as string) || "",
          quantity: (l.quantity as number) || 1,
          price_cents: Math.round(parseFloat(String((l.currentPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100),
        }))
        .filter((i) => i.variant_id);
      const interval = String((live.billingPolicy as Record<string, unknown> | undefined)?.interval || "week").toLowerCase();
      const intervalCount = Number((live.billingPolicy as Record<string, unknown> | undefined)?.intervalCount || 1);
      const nextBillingDate = (live.nextBillingDate as string) || new Date().toISOString();

      // Cancel Appstle FIRST (safe failure mode: a later flip failure stops the
      // sub rather than letting both systems bill it).
      const cancelR = await appstleSubscriptionAction(workspaceId, contractId, "cancel", "Migrated to internal billing", "ShopCX migration");
      if (!cancelR.success) { result.failed.push({ contractId, error: `Appstle cancel failed: ${cancelR.error}` }); continue; }

      // Flip the EXISTING row in place → internal, active, billable customer.
      const { error: flipErr } = await admin
        .from("subscriptions")
        .update({
          is_internal: true,
          status: "active",
          customer_id: billableCustomerId,
          items,
          next_billing_date: nextBillingDate,
          billing_interval: interval,
          billing_interval_count: intervalCount,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);
      if (flipErr) { result.failed.push({ contractId, error: `flip failed (sub cancelled — re-run to recover): ${flipErr.message}` }); continue; }

      result.migrated.push({ contractId, subId: String(sub.id), billableCustomerId });
    } catch (e) {
      result.failed.push({ contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
