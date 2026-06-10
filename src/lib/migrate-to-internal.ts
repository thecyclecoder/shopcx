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
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAppstleConfig } from "@/lib/subscription-items";
import { appstleSubscriptionAction } from "@/lib/appstle";
import { inferAppstleLineBase, resolveLineSnsPct, type AppstleLine } from "@/lib/appstle-pricing";

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

/**
 * Translate live Appstle line items into internal catalog references. Migrating to
 * internal means dropping Shopify ids: each line resolves to our variant + product
 * UUIDs, and we store NO baked price — the pricing engine derives it from the
 * catalog + rule. The only exception is a grandfathered line (the customer was
 * paying below the catalog-derived S&S price): we lock their base via
 * price_override_cents so the engine reproduces it. Lines whose variant isn't in
 * our catalog keep the legacy shape (Shopify id + baked price) as a safety net.
 */
async function appstleLinesToInternalItems(
  admin: Admin,
  workspaceId: string,
  lines: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const items: Array<Record<string, unknown>> = [];
  for (const l of lines) {
    const shopifyVid = String((l.variantId as string) || "").split("/").pop() || "";
    if (!shopifyVid) continue;
    const quantity = (l.quantity as number) || 1;
    const currentPriceCents = Math.round(parseFloat(String((l.currentPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100);
    const title = (l.title as string) || "";
    const variantTitle = (l.variantTitle as string) || "";

    const { data: v } = await admin
      .from("product_variants")
      .select("id, product_id, price_cents, title, sku")
      .eq("shopify_variant_id", shopifyVid)
      .maybeSingle();

    if (!v) {
      // Not in our catalog — keep the legacy shape so nothing is lost.
      items.push({ variant_id: shopifyVid, title, variant_title: variantTitle, quantity, price_cents: currentPriceCents });
      continue;
    }

    // SMART PRICING (heal-by-migration): use the shared inference on the line we
    // already fetched. Reads pricingPolicy.basePrice directly when present
    // (isolates the true base from stacked discounts; distinguishes standard from
    // grandfathered); reverse-engineers currentPrice/(1−sns) only for the
    // baked/flat (pricingPolicy:null) subs Appstle left behind.
    const msrp = (v.price_cents as number) || 0;
    const snsPct = await resolveLineSnsPct(admin, workspaceId, v.product_id as string);
    const { trueBaseCents, isGrandfathered } = inferAppstleLineBase(l as AppstleLine, msrp, snsPct);

    const item: Record<string, unknown> = {
      variant_id: v.id,
      product_id: v.product_id,
      title: title || undefined,
      variant_title: variantTitle || (v.title as string) || undefined,
      sku: (v.sku as string) || undefined,
      quantity,
    };
    // Grandfathered (true base < catalog MSRP) → lock the base so the engine
    // reproduces their price. Standard subs use the catalog (no override).
    if (isGrandfathered && trueBaseCents > 0) item.price_override_cents = trueBaseCents;
    items.push(item);
  }
  return items;
}

/**
 * Self-healing guard: if the customer's link group still has any Appstle subs AND
 * a working default Braintree PM, migrate them. Cheap when there's nothing to do
 * (one count query) — runs the actual migration only when a straggler exists, and
 * then never again (no Appstle subs left). Call it wherever subs are fetched.
 */
export async function ensureGroupMigratedIfBillable(workspaceId: string, customerId: string): Promise<number> {
  const admin = createAdminClient();
  const groupIds = await linkedCustomerIds(admin, customerId);

  const { count: appstleCount } = await admin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .in("customer_id", groupIds)
    .eq("is_internal", false)
    .neq("status", "expired");
  if (!appstleCount) return 0;

  const { data: pm } = await admin
    .from("customer_payment_methods")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("customer_id", groupIds)
    .eq("provider", "braintree")
    .eq("status", "active")
    .eq("is_default", true)
    .limit(1)
    .maybeSingle();
  if (!pm) return 0;

  const r = await migrateCustomerAppstleSubsToInternal(workspaceId, customerId);
  return r.migrated.length;
}

export async function migrateCustomerAppstleSubsToInternal(
  workspaceId: string,
  customerId: string,
  opts: { isRecovery?: boolean } = {},
): Promise<MigrateResult> {
  const admin = createAdminClient();
  const result: MigrateResult = { migrated: [], skipped: [], failed: [] };

  const groupIds = await linkedCustomerIds(admin, customerId);
  const billableCustomerId = await findBillableCustomer(admin, workspaceId, groupIds, customerId);

  // ALL Appstle subs across the link group — active, paused, AND cancelled.
  // Adding a payment method sweeps the customer's whole book onto internal rails.
  const { data: subs } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, is_internal, items, billing_interval, billing_interval_count, next_billing_date")
    .eq("workspace_id", workspaceId)
    .in("customer_id", groupIds)
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
    const isCancelled = sub.status === "cancelled";
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
      const liveUsable = !!live && live.status !== "CANCELLED";

      let items: Array<Record<string, unknown>>;
      let interval: string;
      let intervalCount: number;
      let nextBillingDate: string;
      if (liveUsable) {
        // Translate Appstle lines → internal catalog UUID references (no baked
        // price; grandfathered lines get a price_override_cents).
        items = await appstleLinesToInternalItems(admin, workspaceId, (live.lines?.nodes as Array<Record<string, unknown>>) || []);
        interval = String((live.billingPolicy as Record<string, unknown> | undefined)?.interval || "week").toLowerCase();
        intervalCount = Number((live.billingPolicy as Record<string, unknown> | undefined)?.intervalCount || 1);
        nextBillingDate = (live.nextBillingDate as string) || new Date().toISOString();

        // Cancel Appstle FIRST (safe failure mode: a later flip failure stops the
        // sub rather than letting both systems bill it). Already-cancelled subs
        // have nothing to cancel.
        if (!isCancelled) {
          const cancelR = await appstleSubscriptionAction(workspaceId, contractId, "cancel", "migrated to shopcx", "ShopCX migration");
          if (!cancelR.success) { result.failed.push({ contractId, error: `Appstle cancel failed: ${cancelR.error}` }); continue; }
        }
      } else {
        // No usable live Appstle data. Only safe for cancelled subs (they won't
        // bill) — migrate them onto internal rails using the local row. An
        // active/paused sub we can't read is left alone (re-runnable).
        if (!isCancelled) { result.skipped.push({ contractId, reason: "appstle_unavailable" }); continue; }
        items = (sub.items as Array<Record<string, unknown>>) || [];
        interval = String(sub.billing_interval || "week").toLowerCase();
        intervalCount = Number(sub.billing_interval_count || 1);
        nextBillingDate = (sub.next_billing_date as string) || new Date().toISOString();
      }

      // Flip the EXISTING row in place → internal, billable customer, PRESERVING
      // status (active→active, paused→paused, cancelled→cancelled). Replace the
      // Shopify/Appstle contract id with a native internal id so the sub is no
      // longer Shopify-tied and a stale Appstle webhook can't clobber it.
      const internalContractId = `internal-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const { error: flipErr } = await admin
        .from("subscriptions")
        .update({
          shopify_contract_id: internalContractId,
          is_internal: true,
          status: sub.status,
          customer_id: billableCustomerId,
          items,
          next_billing_date: nextBillingDate,
          billing_interval: interval,
          billing_interval_count: intervalCount,
          updated_at: new Date().toISOString(),
        })
        .eq("workspace_id", workspaceId)
        .eq("shopify_contract_id", contractId);
      if (flipErr) { result.failed.push({ contractId, error: `flip failed (re-run to recover): ${flipErr.message}` }); continue; }

      result.migrated.push({ contractId, subId: String(sub.id), billableCustomerId });

      // Timeline event so a human agent sees the migration on the customer's
      // timeline (Appstle contract cancelled → now billed internally on Braintree).
      try {
        const { logCustomerEvent } = await import("@/lib/customer-events");
        await logCustomerEvent({
          workspaceId,
          customerId: billableCustomerId,
          eventType: "subscription.migrated",
          source: opts.isRecovery ? "payment_recovery" : "migration",
          summary: `Subscription migrated to internal billing — Appstle contract ${contractId} cancelled, now billed on Braintree (${internalContractId}).`,
          properties: { subscription_id: String(sub.id), appstle_contract_id: contractId, internal_contract_id: internalContractId, status: sub.status, is_recovery: !!opts.isRecovery },
        });
      } catch (e) {
        console.error(`[migrate] timeline event failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
      }

      // Monitor: record + verify this migration. Pre-migration charge = sum of
      // the live Appstle per-line charge (products only). Non-fatal.
      try {
        const liveLines = liveUsable ? ((live.lines?.nodes as Array<Record<string, unknown>>) || []) : [];
        const preCharge = liveLines.reduce((s, l) => {
          const amt = Math.round(parseFloat(String((l.currentPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100);
          return s + amt * Number(l.quantity || 1);
        }, 0);
        const { recordMigrationAudit, verifyMigration } = await import("@/lib/migration-audit");
        const auditId = await recordMigrationAudit({
          workspaceId,
          subscriptionId: String(sub.id),
          appstleContractId: contractId,
          internalContractId,
          preMigrationChargeCents: preCharge,
          isRecovery: !!opts.isRecovery,
        });
        if (auditId) await verifyMigration(auditId);
      } catch (e) {
        console.error(`[migrate] audit failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
      }
    } catch (e) {
      result.failed.push({ contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
