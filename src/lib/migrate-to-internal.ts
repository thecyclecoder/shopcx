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
import { subscriptionAction } from "@/lib/commerce/subscription";
import { inferAppstleLineBase, resolveLineSnsPct, type AppstleLine } from "@/lib/appstle-pricing";

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Appstle bills shipping protection as a regular **line item** titled "Shipping
 * Protection". Internally it is NOT a catalog item — it's a flag on the sub
 * (`shipping_protection_added` + `shipping_protection_amount_cents`) and the
 * pricing engine bills it separately, on TOP of the product subtotal (see
 * [[pricing]] / [[internal-subscription-renewals]]). So a migration must convert
 * that line into the flag, never leave it in `items[]`. Match the same title
 * convention the audit's `items_on_uuids` check and the pricing engine use
 * (case-insensitive substring). */
function isShippingProtectionLine(l: Record<string, unknown>): boolean {
  return String((l.title as string) || "").toLowerCase().includes("shipping protection");
}

/**
 * A live Appstle line the migration could NOT map to an internal variant (no
 * catalog match by shopify_variant_id OR sku — out of stock / discontinued / no
 * internal product). It is DROPPED from items[] (so `items_on_uuids` can't fail
 * forever on a dangling Shopify id) and recorded as a migration_audits note. A
 * $0 line is safe to drop; a `paid` drop also pages a human (short order risk).
 */
export interface DroppedLine {
  title: string;
  shopifyVariantId: string;
  sku: string | null;
  priceCents: number;
  quantity: number;
  paid: boolean;
}

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

/**
 * Pick the link-group member with a default Braintree PM (prefer `preferred`),
 * AND return that default `customer_payment_methods` row id so the migration can
 * PIN it onto the flipped sub (mirrors the recovery flow's pin —
 * payment-method-update.ts). The default-card fallback stays the safety net, but
 * pinning makes the charge explicit (the portal shows the card; a later default
 * change can't silently move the renewal).
 */
async function findBillableCustomer(
  admin: Admin,
  workspaceId: string,
  customerIds: string[],
  preferred: string,
): Promise<{ customerId: string; paymentMethodId: string } | null> {
  const { data: pms } = await admin
    .from("customer_payment_methods")
    .select("id, customer_id, braintree_payment_method_token")
    .eq("workspace_id", workspaceId)
    .in("customer_id", customerIds)
    .eq("is_default", true)
    .eq("provider", "braintree");
  // customer_id → its default PM row id (only rows with a usable Braintree token).
  const pmByCustomer = new Map<string, string>();
  for (const p of pms || []) {
    if (p.braintree_payment_method_token && !pmByCustomer.has(p.customer_id as string)) {
      pmByCustomer.set(p.customer_id as string, p.id as string);
    }
  }
  if (pmByCustomer.has(preferred)) return { customerId: preferred, paymentMethodId: pmByCustomer.get(preferred)! };
  for (const id of customerIds) if (pmByCustomer.has(id)) return { customerId: id, paymentMethodId: pmByCustomer.get(id)! };
  return null;
}

/**
 * Translate live Appstle line items into internal catalog references. Migrating to
 * internal means dropping Shopify ids: each line resolves to our variant + product
 * UUIDs, and we store NO baked price — the pricing engine derives it from the
 * catalog + rule. The only exception is a grandfathered line (the customer was
 * paying below the catalog-derived S&S price): we lock their base via
 * price_override_cents so the engine reproduces it. A line whose variant isn't in
 * our catalog by shopify_variant_id OR sku is genuinely unmappable: it is DROPPED
 * (returned in `droppedLines`) rather than left as a dangling Shopify-id line that
 * fails the `items_on_uuids` audit forever — Therese's out-of-stock ACV Gummies.
 */
async function appstleLinesToInternalItems(
  admin: Admin,
  workspaceId: string,
  lines: Array<Record<string, unknown>>,
): Promise<{ items: Array<Record<string, unknown>>; shippingProtectionCents: number; droppedLines: DroppedLine[] }> {
  const items: Array<Record<string, unknown>> = [];
  const droppedLines: DroppedLine[] = [];
  let shippingProtectionCents = 0;
  for (const l of lines) {
    const quantity = (l.quantity as number) || 1;
    const currentPriceCents = Math.round(parseFloat(String((l.currentPrice as Record<string, unknown> | undefined)?.amount ?? "0")) * 100);
    const title = (l.title as string) || "";
    const variantTitle = (l.variantTitle as string) || "";

    // Shipping protection is a flag internally, never a catalog line: capture its
    // charge for `shipping_protection_amount_cents` and EXCLUDE it from items[].
    // The engine re-adds it on top of the product subtotal via the flag, so the
    // customer's total is unchanged while the product-only subtotal is what the
    // audit's `pricing_preserved` compares against.
    if (isShippingProtectionLine(l)) {
      shippingProtectionCents += currentPriceCents * quantity;
      continue;
    }

    const shopifyVid = String((l.variantId as string) || "").split("/").pop() || "";
    if (!shopifyVid) continue;
    const lineSku = String((l.sku as string) || "").trim();

    // Resolve the internal variant by shopify_variant_id first, then by sku
    // (workspace-scoped) — a migrated line can carry a Shopify id we never synced
    // while its sku still resolves the variant (mirrors the audit's auto-heal).
    let v: { id: string; product_id: string; price_cents: number | null; title: string | null; sku: string | null } | null = null;
    const { data: byShopId } = await admin
      .from("product_variants")
      .select("id, product_id, price_cents, title, sku")
      .eq("shopify_variant_id", shopifyVid)
      .maybeSingle();
    v = byShopId;
    if (!v && lineSku) {
      const { data: bySku } = await admin
        .from("product_variants")
        .select("id, product_id, price_cents, title, sku")
        .eq("workspace_id", workspaceId)
        .eq("sku", lineSku)
        .maybeSingle();
      v = bySku;
    }

    if (!v) {
      // Genuinely unmappable (out of stock / discontinued / no internal product).
      // DROP it — leaving a dangling Shopify-id line fails `items_on_uuids` forever
      // (the retry loop never clears). A $0 line is safe to drop; a paid drop is
      // surfaced to the caller, which pages a human (short order risk).
      droppedLines.push({
        title: title || variantTitle || shopifyVid,
        shopifyVariantId: shopifyVid,
        sku: lineSku || null,
        priceCents: currentPriceCents,
        quantity,
        paid: currentPriceCents > 0,
      });
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
    // Grandfathered (true base STRICTLY BELOW catalog MSRP) → lock the base so the
    // engine reproduces their price. Standard subs use the catalog (no override).
    // INVARIANT (base ≤ MSRP): price_override_cents exists ONLY to preserve a base
    // below MSRP. An at-or-above-MSRP override is a no-op at best and inflates the
    // charge at worst — it feeds the −25% S&S + quantity-break math from too high a
    // starting point (the Lisa Baker bug). The explicit `trueBaseCents < msrp` cap is
    // belt-and-suspenders on top of `isGrandfathered` (also strict-below-MSRP): even
    // if that flag's definition drifts, a base ≥ MSRP is never stored here.
    // See docs/brain/specs/base-price-never-above-msrp.md.
    if (isGrandfathered && trueBaseCents > 0 && trueBaseCents < msrp) {
      item.price_override_cents = trueBaseCents;
    }
    items.push(item);
  }
  return { items, shippingProtectionCents, droppedLines };
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

/**
 * Comp migration: flip ONE Appstle contract → internal **comp** sub, WITHOUT the
 * billable-PM requirement. A comp sub ships free (base $0, no charge) — so "a
 * migration must be billable" does not apply. Reuses translate-lines +
 * cancel-contract; the customer_id is preserved (no reassignment to a billable
 * member, since nothing is ever charged). Sets comp=true + every item's
 * price_override_cents=0 (base $0). The renewal path then ships it free, gated on
 * the customer's comp_role allowlist. See docs/brain/specs/comp-subscriptions.md.
 *
 * Idempotent: a contract already flipped to internal+comp returns ok with its
 * existing internal id. No migration_audit is recorded (the 8-check audit expects
 * a billable card, which a comp sub deliberately lacks).
 */
export async function migrateContractToInternalComp(
  workspaceId: string,
  contractId: string,
  opts: { compNote?: string } = {},
): Promise<{ ok: boolean; subId?: string; internalContractId?: string; error?: string }> {
  const admin = createAdminClient();

  // Find the sub by its Appstle/Shopify contract id within the workspace.
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, shopify_contract_id, status, is_internal, comp, customer_id, items, billing_interval, billing_interval_count, next_billing_date")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (!sub) return { ok: false, error: `subscription not found for contract ${contractId}` };

  // Already an internal comp sub → nothing to do.
  if (sub.is_internal && sub.comp) {
    return { ok: true, subId: String(sub.id), internalContractId: String(sub.shopify_contract_id) };
  }

  const cfg = await getAppstleConfig(workspaceId);
  if (!cfg) return { ok: false, error: "Appstle not configured" };

  const isCancelled = sub.status === "cancelled";
  try {
    // Read the LIVE Appstle contract — source of truth for items/cadence/next date.
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
      // Comp subs ship free (base $0), so a protection charge never applies — we
      // take only the converted product items and drop any protection line.
      ({ items } = await appstleLinesToInternalItems(admin, workspaceId, (live.lines?.nodes as Array<Record<string, unknown>>) || []));
      interval = String((live.billingPolicy as Record<string, unknown> | undefined)?.interval || "week").toLowerCase();
      intervalCount = Number((live.billingPolicy as Record<string, unknown> | undefined)?.intervalCount || 1);
      nextBillingDate = (live.nextBillingDate as string) || new Date().toISOString();

      // Cancel Appstle FIRST so a later flip failure stops the sub rather than
      // letting Appstle keep billing it.
      if (!isCancelled) {
        const cancelR = await subscriptionAction(workspaceId, contractId, "cancel", "migrated to shopcx (comp)", "ShopCX comp migration");
        if (!cancelR.success) return { ok: false, error: `Appstle cancel failed: ${cancelR.error}` };
      }
    } else {
      if (!isCancelled) return { ok: false, error: "appstle_unavailable (active/paused sub left alone — re-runnable)" };
      items = (sub.items as Array<Record<string, unknown>>) || [];
      interval = String(sub.billing_interval || "week").toLowerCase();
      intervalCount = Number(sub.billing_interval_count || 1);
      nextBillingDate = (sub.next_billing_date as string) || new Date().toISOString();
    }

    // Comp = base $0: force every line's price_override_cents to 0 (overrides any
    // grandfathered base inferred above) and strip any baked price.
    const compItems = items.map((i) => {
      const { price_cents: _drop, ...rest } = i as Record<string, unknown>;
      void _drop;
      return { ...rest, price_override_cents: 0 };
    });

    // Flip the EXISTING row in place → internal comp. customer_id preserved (comp
    // never charges, so no billable reassignment). Status preserved.
    const internalContractId = `internal-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const { error: flipErr } = await admin
      .from("subscriptions")
      .update({
        shopify_contract_id: internalContractId,
        // Retain the origin id so the Appstle cancel webhook (guard) + portal
        // resolveSub map the old numeric id back to THIS row, not a dead shell.
        migrated_from_contract_id: contractId,
        is_internal: true,
        comp: true,
        comp_note: opts.compNote ?? null,
        status: sub.status,
        items: compItems,
        next_billing_date: nextBillingDate,
        billing_interval: interval,
        billing_interval_count: intervalCount,
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", contractId);
    if (flipErr) return { ok: false, error: `flip failed (re-run to recover): ${flipErr.message}` };

    // Timeline event. (No migration_audit — a comp sub has no billable card by design.)
    try {
      const { logCustomerEvent } = await import("@/lib/customer-events");
      await logCustomerEvent({
        workspaceId,
        customerId: sub.customer_id as string | null,
        eventType: "subscription.migrated",
        source: "comp_migration",
        summary: `Subscription migrated to internal COMP (free) billing — Appstle contract ${contractId} cancelled, now ships free internally (${internalContractId}).`,
        properties: { subscription_id: String(sub.id), appstle_contract_id: contractId, internal_contract_id: internalContractId, status: sub.status, comp: true, comp_note: opts.compNote ?? null },
      });
    } catch (e) {
      console.error(`[migrate-comp] timeline event failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
    }

    return { ok: true, subId: String(sub.id), internalContractId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function migrateCustomerAppstleSubsToInternal(
  workspaceId: string,
  customerId: string,
  opts: { isRecovery?: boolean } = {},
): Promise<MigrateResult> {
  const admin = createAdminClient();
  const result: MigrateResult = { migrated: [], skipped: [], failed: [] };

  const groupIds = await linkedCustomerIds(admin, customerId);
  const billable = await findBillableCustomer(admin, workspaceId, groupIds, customerId);

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
  if (!billable) {
    for (const s of subs) result.skipped.push({ contractId: String(s.shopify_contract_id), reason: "no_braintree_pm_in_link_group" });
    return result;
  }
  const billableCustomerId = billable.customerId;
  // PIN the customer's default card onto each migrated sub (the recovery flow
  // already does this; migration should too). Idempotent — a re-run re-pins the
  // CURRENT default. Subs left unpinned still bill via the default-card fallback.
  const defaultPaymentMethodId = billable.paymentMethodId;

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
      // Shipping protection moves from an Appstle line → an internal flag on the
      // flipped sub. 0 when the contract had no protection line.
      let shippingProtectionCents = 0;
      // Lines the migration couldn't map to an internal variant → dropped, noted on
      // the audit (and a paid drop pages a human). Empty unless something unmappable.
      let droppedLines: DroppedLine[] = [];
      if (liveUsable) {
        // Translate Appstle lines → internal catalog UUID references (no baked
        // price; grandfathered lines get a price_override_cents). A "Shipping
        // Protection" line is pulled out into the flag below, not items[].
        ({ items, shippingProtectionCents, droppedLines } = await appstleLinesToInternalItems(admin, workspaceId, (live.lines?.nodes as Array<Record<string, unknown>>) || []));
        interval = String((live.billingPolicy as Record<string, unknown> | undefined)?.interval || "week").toLowerCase();
        intervalCount = Number((live.billingPolicy as Record<string, unknown> | undefined)?.intervalCount || 1);
        nextBillingDate = (live.nextBillingDate as string) || new Date().toISOString();

        // Cancel Appstle FIRST (safe failure mode: a later flip failure stops the
        // sub rather than letting both systems bill it). Already-cancelled subs
        // have nothing to cancel.
        if (!isCancelled) {
          const cancelR = await subscriptionAction(workspaceId, contractId, "cancel", "migrated to shopcx", "ShopCX migration");
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
          // Retain the origin id so the Appstle cancel webhook (guard) + portal
          // resolveSub map the old numeric id back to THIS row, not a dead shell.
          migrated_from_contract_id: contractId,
          is_internal: true,
          status: sub.status,
          customer_id: billableCustomerId,
          // Pin the default card so the renewal charges it explicitly (the
          // default-card fallback stays the safety net for any unpinned sub).
          payment_method_id: defaultPaymentMethodId,
          items,
          // Carry shipping protection across as a flag (engine bills it on top of
          // the product subtotal). Only set when the contract actually had it, so
          // a protection-free sub is untouched.
          ...(shippingProtectionCents > 0
            ? { shipping_protection_added: true, shipping_protection_amount_cents: shippingProtectionCents }
            : {}),
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
      // the live Appstle per-line charge (products only). Shipping protection is
      // EXCLUDED — it's a flag the engine bills separately, and the audit's
      // `pricing_preserved` compares this baseline against the engine's
      // product_subtotal_cents (which also excludes protection). Non-fatal.
      try {
        const liveLines = liveUsable ? ((live.lines?.nodes as Array<Record<string, unknown>>) || []) : [];
        const preCharge = liveLines.reduce((s, l) => {
          if (isShippingProtectionLine(l)) return s;
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
          droppedLines,
        });
        if (auditId) await verifyMigration(auditId);
      } catch (e) {
        console.error(`[migrate] audit failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
      }

      // A PAID line we couldn't map was dropped → the next renewal would ship a
      // short order. The drop is recorded in the audit note; a paid drop ALSO
      // pages a human to add the right variant or refund (never silent). A $0
      // free-gift/promo drop is safe and stays note-only.
      const paidDrops = droppedLines.filter((d) => d.paid);
      if (paidDrops.length) {
        try {
          const { notifyOpsAlert } = await import("@/lib/notify-ops-alert");
          await notifyOpsAlert(workspaceId, {
            severity: "critical",
            title: "Migration dropped a PAID unmappable subscription line",
            lines: [
              `Sub ${sub.id} (${internalContractId}) — ${paidDrops.length} paid line(s) had no internal variant (by id or sku) and were dropped.`,
              ...paidDrops.map((d) => `• ${d.title} (variant ${d.shopifyVariantId}${d.sku ? `, sku ${d.sku}` : ""}) ×${d.quantity} @ ${d.priceCents}¢`),
              `Add the correct internal variant to the sub or refund — the next renewal will otherwise ship short.`,
            ],
          });
        } catch (e) {
          console.error(`[migrate] paid-drop ops alert failed (non-fatal) for ${contractId}:`, e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      result.failed.push({ contractId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
