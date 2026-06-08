/**
 * Strangler migration: move a customer's Appstle subscriptions onto our
 * internal rails. The principle (spec § 1c): any time we capture a payment
 * method (checkout, portal payment-method update), sweep the customer's Appstle
 * subs to internal so future renewals bill on our Braintree token.
 *
 * For each active Appstle sub: read its LIVE state (current/grandfathered prices,
 * cadence, next billing date), create a merged internal sub, verify it exists,
 * THEN cancel the Appstle contract — never the reverse. If the Appstle cancel
 * fails we roll back the just-created internal sub so the customer is never
 * double-billed. Atomic + idempotent (already-internal subs are skipped;
 * cancelled Appstle rows are excluded).
 *
 * PAYMENT METHOD: the caller must have already vaulted the new Braintree token
 * and set it as the customer's default `customer_payment_methods` — the internal
 * renewal scheduler bills from that default. This helper does not vault cards.
 *
 * NOT yet wired into the live checkout charge path — it cancels real contracts,
 * so it needs a runtime test against real Appstle data first. See spec § 1c.
 */
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppstleConfig } from "@/lib/subscription-items";
import { appstleSubscriptionAction } from "@/lib/appstle";

export interface MigrateResult {
  migrated: Array<{ from: string; to: string }>;
  skipped: string[];
  failed: Array<{ contractId: string; error: string }>;
}

interface MigrateItem { variant_id: string; title?: string; variant_title?: string; quantity?: number; price_cents?: number }

export async function migrateCustomerAppstleSubsToInternal(
  workspaceId: string,
  customerId: string,
  opts?: { mergeIntoContractId?: string; extraItems?: MigrateItem[] },
): Promise<MigrateResult> {
  const admin = createAdminClient();
  const result: MigrateResult = { migrated: [], skipped: [], failed: [] };

  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, billing_interval, billing_interval_count, next_billing_date, is_internal, delivery_price_cents, shipping_address, shipping_method_code, shipping_rate_id, shopify_customer_id")
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .neq("status", "cancelled");
  if (!subs?.length) return result;

  const cfg = await getAppstleConfig(workspaceId);

  for (const sub of subs) {
    const contractId = String(sub.shopify_contract_id);
    if (sub.is_internal) { result.skipped.push(contractId); continue; }
    if (!cfg) { result.failed.push({ contractId, error: "Appstle not configured" }); continue; }

    try {
      // Read the LIVE Appstle contract — source of truth for current prices,
      // cadence, and next billing date (the local row can lag).
      const live = await (
        await fetch(
          `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${cfg.apiKey}`,
          { headers: { "X-API-Key": cfg.apiKey }, cache: "no-store" },
        )
      ).json();
      if (!live || live.status === "CANCELLED") { result.skipped.push(contractId); continue; }

      // Preserve current (grandfathered) per-line prices.
      const liveItems: MigrateItem[] = ((live.lines?.nodes as Array<Record<string, unknown>>) || [])
        .map((l) => ({
          variant_id: String((l.variantId as string) || "").split("/").pop() || "",
          title: (l.title as string) || "",
          variant_title: (l.variantTitle as string) || "",
          quantity: (l.quantity as number) || 1,
          price_cents: Math.round(parseFloat(String((l.currentPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100),
        }))
        .filter((i) => i.variant_id);

      const mergedItems = opts?.mergeIntoContractId === contractId && opts.extraItems?.length
        ? [...liveItems, ...opts.extraItems]
        : liveItems;

      // Inherit cadence + next billing date so the renewal rhythm doesn't shift.
      const interval = String((live.billingPolicy as Record<string, unknown> | undefined)?.interval || sub.billing_interval || "DAY").toLowerCase();
      const intervalCount = Number((live.billingPolicy as Record<string, unknown> | undefined)?.intervalCount || sub.billing_interval_count || 1);
      const nextBillingDate = (live.nextBillingDate as string) || sub.next_billing_date || new Date().toISOString();

      // 1) Create the internal sub FIRST and verify it exists.
      const newContractId = `internal-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const { data: created, error: createErr } = await admin
        .from("subscriptions")
        .insert({
          workspace_id: workspaceId,
          customer_id: customerId,
          shopify_customer_id: sub.shopify_customer_id || null,
          shopify_contract_id: newContractId,
          status: "active",
          billing_interval: interval,
          billing_interval_count: intervalCount,
          next_billing_date: nextBillingDate,
          items: mergedItems,
          delivery_price_cents: sub.delivery_price_cents || 0,
          applied_discounts: [],
          is_internal: true,
          shipping_address: sub.shipping_address,
          shipping_method_code: sub.shipping_method_code,
          shipping_rate_id: sub.shipping_rate_id,
        })
        .select("id")
        .single();
      if (createErr || !created) {
        result.failed.push({ contractId, error: `internal create failed: ${createErr?.message || "no row"}` });
        continue;
      }

      // 2) Only now cancel the Appstle contract. If it fails, roll back the
      //    just-created internal sub so the customer is never double-billed.
      const cancelR = await appstleSubscriptionAction(workspaceId, contractId, "cancel", "Migrated to internal billing", "ShopCX migration");
      if (!cancelR.success) {
        await admin.from("subscriptions").delete().eq("id", created.id);
        result.failed.push({ contractId, error: `Appstle cancel failed (internal rolled back): ${cancelR.error}` });
        continue;
      }

      result.migrated.push({ from: contractId, to: newContractId });
    } catch (e) {
      result.failed.push({ contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
