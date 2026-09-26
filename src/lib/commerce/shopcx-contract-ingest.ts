/**
 * Ingest a Shopify subscription contract that was born OUTSIDE our own code.
 *
 * ⭐ Why this exists. Almost all storefront traffic lands on Shopify PDPs, and a PDP checkout with
 * a selling plan creates a real `SubscriptionContract` that our app owns — Shopify tells us via
 * `subscription_contracts/create`. Until this module, that topic fell to the webhook route's
 * `default:` no-op, so the contract existed on Shopify and **nowhere in ShopCX**: no portal row, no
 * renewal candidate, no ticket context, no analytics. Two live examples were found that way
 * (36020093101 / 36020289709, both from 2026-09-15 PDP checkouts). Shopify charges nothing on its
 * own, so an un-ingested contract is a customer who subscribed and will never be billed.
 *
 * ⚠️ Not every app-owned contract belongs here. We create contracts ourselves — migration from
 * Appstle, and the one-time-charge rail — and those already have (or deliberately do NOT want) a
 * `subscriptions` row. Ingesting them would duplicate a migrated customer or turn a single $1
 * charge into a recurring subscription.
 *
 * `originOrder` looks like it should settle this and does not: measured 2026-09-17 across all 23
 * app-owned contracts, contracts we created with `subscriptionContractAtomicCreate` also carry one.
 * Ownership is therefore decided by OUR OWN claim markers, and the ingest runs on a delay so those
 * markers are written before it looks (see `src/lib/inngest/shopcx-contract-ingest.ts`).
 *
 * See [[docs/brain/libraries/commerce__shopcx-contract-ingest]].
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { errText } from "@/lib/error-text";
import { getContractForIngest, type IngestContract } from "@/lib/commerce/shopify-subscription-client";

export type IngestOutcome =
  | { ingested: true; subscriptionId: string; contractId: string; created: boolean }
  | { ingested: false; reason: string; contractId: string };

/** Contracts created by one of our own rails are claimed by that rail, not by ingestion. */
async function existingClaim(workspaceId: string, contractId: string): Promise<string | null> {
  const admin = createAdminClient();
  const gid = `gid://shopify/SubscriptionContract/${contractId}`;

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (sub) return "already ingested";

  // The migration marker is written in the same breath as the create, and holds the GID form.
  const { data: migrated } = await admin
    .from("appstle_contract_snapshots")
    .select("appstle_contract_id")
    .eq("workspace_id", workspaceId)
    .in("migrated_to_contract_id", [gid, contractId])
    .limit(1)
    .maybeSingle();
  if (migrated) return "created by the Appstle migration";

  const { data: otc } = await admin
    .from("one_time_charges")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .limit(1)
    .maybeSingle();
  if (otc) return "created by the one-time-charge rail";

  return null;
}

/**
 * Find the ShopCX customer behind a contract, creating one only as a last resort.
 *
 * Order matters: the Shopify customer id is the join we trust, email is the fallback for a customer
 * who reached us through some other door first, and an insert is what is left. `orders/create` for
 * the same checkout usually wins the race and has already made this row — the delay in front of the
 * ingest is partly so that stays true and we do not mint a duplicate customer.
 */
async function resolveCustomer(
  workspaceId: string,
  c: IngestContract,
): Promise<{ id: string } | null> {
  const admin = createAdminClient();

  if (c.customerId) {
    const { data } = await admin
      .from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("shopify_customer_id", c.customerId).maybeSingle();
    if (data) return data;
  }
  if (c.email) {
    const { data } = await admin
      .from("customers").select("id")
      .eq("workspace_id", workspaceId).eq("email", c.email).maybeSingle();
    if (data) {
      // Backfill the join we wish we had had, so the next contract resolves on the first try.
      if (c.customerId) {
        await admin.from("customers")
          .update({ shopify_customer_id: c.customerId })
          .eq("id", data.id).is("shopify_customer_id", null);
      }
      return data;
    }
  }
  if (!c.email) return null;

  const { data: created, error } = await admin
    .from("customers")
    .insert({
      workspace_id: workspaceId,
      email: c.email,
      first_name: c.firstName,
      last_name: c.lastName,
      phone: c.phone,
      shopify_customer_id: c.customerId,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`[shopcx-ingest] customer insert failed for ${c.email}: ${error.message}`);
    return null;
  }
  return created;
}

/**
 * `subscriptions.items` in the Appstle shape every reader already speaks.
 *
 * `price_cents` is the REALIZED per-unit rate — base less our structural discounts (Subscribe &
 * Save, volume, legacy rate) — matching `mirrorContractToItems`. A customer coupon is excluded on
 * purpose: it is not part of the line's standing price, and baking it in would show a one-use code
 * as the permanent rate.
 */
async function buildItems(workspaceId: string, c: IngestContract): Promise<Record<string, unknown>[]> {
  const admin = createAdminClient();
  const items: Record<string, unknown>[] = [];
  for (const l of c.lines) {
    const variantId = String(l.variantId ?? "").replace("gid://shopify/ProductVariant/", "");
    let variantTitle = l.variantTitle;
    let productId = String(l.productId ?? "").replace("gid://shopify/Product/", "") || null;
    if (variantId) {
      // join: products!innershopify_product_id — the Shopify product id lives on the parent
      // `products` row, not on the variant; inner-join the parent and project that column.
      const { data: v } = await admin
        .from("product_variants")
        .select("title, products!inner(shopify_product_id)")
        .eq("workspace_id", workspaceId)
        .eq("shopify_variant_id", variantId)
        .maybeSingle();
      if (v) {
        variantTitle = variantTitle ?? (v as { title?: string }).title ?? null;
        const joined = (v as {
          products?:
            | { shopify_product_id?: string | null }
            | Array<{ shopify_product_id?: string | null }>
            | null;
        }).products;
        const productRow = Array.isArray(joined) ? joined[0] : joined;
        productId = productId ?? productRow?.shopify_product_id ?? null;
      }
    }
    const qty = l.quantity || 1;
    const unitBase = l.currentPrice != null ? Math.round(parseFloat(l.currentPrice) * 100) : 0;
    items.push({
      line_id: l.id.replace("gid://shopify/SubscriptionLine/", ""),
      variant_id: variantId || null,
      product_id: productId,
      sku: l.sku,
      title: l.title,
      variant_title: variantTitle,
      quantity: qty,
      price_cents: Math.round((unitBase * qty - l.structuralDiscountCents) / qty),
      selling_plan: l.sellingPlanName,
    });
  }
  return items;
}

function mapStatus(shopifyStatus: string): string {
  switch (String(shopifyStatus).toUpperCase()) {
    case "ACTIVE": return "active";
    case "PAUSED": return "paused";
    default: return "cancelled";
  }
}

/**
 * Read the contract from Shopify and make it a ShopCX subscription.
 *
 * Idempotent by the claim check: run it twice and the second call reports "already ingested".
 * `force` exists for the backfill of contracts that predate this module — it skips only the
 * "already ingested" arm, never the migration / one-time-charge arms, because those are
 * correctness boundaries rather than duplicate protection.
 */
export async function ingestShopifyContract(
  workspaceId: string,
  contractId: string,
  opts: { force?: boolean } = {},
): Promise<IngestOutcome> {
  const bare = String(contractId).replace("gid://shopify/SubscriptionContract/", "");
  try {
    const claim = await existingClaim(workspaceId, bare);
    if (claim && !(opts.force && claim === "already ingested")) {
      return { ingested: false, reason: claim, contractId: bare };
    }

    const read = await getContractForIngest(workspaceId, bare);
    if (!read.success || !read.contract) {
      return { ingested: false, reason: `contract unreadable: ${read.error}`, contractId: bare };
    }
    const c = read.contract;
    if (c.truncated) {
      // 250 lines is far past anything real; say so rather than silently mirroring a partial cart.
      console.error(`[shopcx-ingest] ${bare}: more than 250 lines — items mirror is TRUNCATED`);
    }

    // ⚠️ Only a LIVE contract becomes a subscription. `create` never fires for a cancelled one, so
    // this only bites the backfill path — where it matters: ingesting a dead contract mints a
    // `cancelled` row that never existed as a customer relationship, inflating churn and cancel
    // counts with contracts that were test artifacts or one-off rails. Caught doing exactly that
    // on 36047061165 while verifying this module.
    const live = String(c.status).toUpperCase();
    if (live !== "ACTIVE" && live !== "PAUSED") {
      return { ingested: false, reason: `contract is ${live} — not a live subscription`, contractId: bare };
    }

    const customer = await resolveCustomer(workspaceId, c);
    if (!customer) {
      return { ingested: false, reason: "no customer could be resolved (contract has no email)", contractId: bare };
    }

    const status = mapStatus(c.status);
    const row: Record<string, unknown> = {
      workspace_id: workspaceId,
      customer_id: customer.id,
      shopify_contract_id: bare,
      shopify_customer_id: c.customerId,
      // ⭐ The whole point. Without this the renewal cron never selects the row and the portal
      // routes its edits to the wrong engine.
      billing_source: "shopcx",
      is_internal: false,
      status,
      billing_interval: c.interval ? c.interval.toLowerCase() : null,
      billing_interval_count: c.intervalCount,
      // A cancelled contract cannot advertise a future charge date (subscriptions cancel-truth).
      next_billing_date: status === "cancelled" ? null : c.nextBillingDate,
      items: await buildItems(workspaceId, c),
      delivery_price_cents: c.deliveryPriceCents ?? 0,
      shipping_address: c.shippingAddress,
      subscription_created_at: c.createdAt,
      applied_discounts: dedupeDiscounts(c.discounts.map((d) => ({
        id: d.id,
        title: d.title ?? "",
        type: d.type ?? "",
        // Persisted so the money resolver can exclude shipping-target (free-shipping) discounts
        // from the product subtotal instead of zeroing it — see computeDisplayCoupon in ./price.
        targetType: d.targetType,
        value: d.value,
        valueType: d.valueType,
      }))),
      // ⚠️ NOT `payment_method_id`. That column is a uuid FK to `customer_payment_methods` — the
      // pinned Braintree card on the INTERNAL rail. A Shopify `CustomerPaymentMethod` gid is a
      // different thing entirely and the write is rejected by the type. The contract's own payment
      // method stays on Shopify, where `subscriptionBillingAttemptCreate` reads it.
      updated_at: new Date().toISOString(),
    };
    if (status === "cancelled") row.cancelled_at = new Date().toISOString();

    const admin = createAdminClient();
    const { data: saved, error } = await admin
      .from("subscriptions")
      .upsert(row, { onConflict: "workspace_id,shopify_contract_id" })
      .select("id")
      .single();
    if (error || !saved) {
      return { ingested: false, reason: `write failed: ${error?.message ?? "no row returned"}`, contractId: bare };
    }

    // The originating checkout, straight from the contract — no heuristic matching needed, unlike
    // the Appstle path which has to guess from tags and SKUs (see subscription-order-link.ts).
    // Only ever FILLS a null link.
    if (c.originOrderId) {
      await admin
        .from("orders")
        .update({ subscription_id: saved.id })
        .eq("workspace_id", workspaceId)
        .eq("shopify_order_id", c.originOrderId)
        .is("subscription_id", null);
    }

    return { ingested: true, subscriptionId: saved.id, contractId: bare, created: true };
  } catch (err) {
    return { ingested: false, reason: `threw: ${errText(err)}`, contractId: bare };
  }
}

/**
 * Collapse per-LINE discounts into the one entry a customer should see.
 *
 * ⭐ A migrated contract carries its structural discounts **scoped per line** — the atomic create
 * takes `{line, discounts}` — so a 4-line contract genuinely holds four "Subscribe & Save" records.
 * That is correct pricing (each line is discounted once) but it renders as the same discount listed
 * four times in the portal. Measured 2026-09-24: 54 of 202 migrated rows.
 *
 * Grouping is by title AND value, so two genuinely different discounts that share a title still
 * both survive.
 */
function dedupeDiscounts<T extends { title: string; value: number; valueType: string }>(list: T[]): T[] {
  const seen = new Map<string, T>();
  for (const d of list) {
    const key = `${d.title}|${d.value}|${d.valueType}`;
    if (!seen.has(key)) seen.set(key, d);
  }
  return [...seen.values()];
}

/**
 * Re-mirror ONLY what the portal renders — lines, discounts, shipping cost — from the live contract.
 *
 * ⭐ Why this is separate from `syncShopifyContract`. The migration swap updates
 * `shopify_contract_id`, `billing_source`, `status` and `next_billing_date`, but **not `items`** —
 * so a migrated row kept its Appstle-era prices. Measured on wave 1: **13 of 25 rows showed the
 * customer a price HIGHER than their new contract will actually charge** (up to $43.13 out), which
 * is the pricing correction the migration had just applied to their contract and never mirrored.
 * It errs in the customer's favour, but the portal and CS both quote it.
 *
 * Dates and status are deliberately NOT touched here: the migration computes the billing date with
 * care (clamping, schedule pinning) and a blanket sync would overwrite that with whatever Shopify's
 * display field happens to say.
 */
export async function mirrorContractPricing(
  workspaceId: string,
  contractId: string,
): Promise<{ ok: boolean; error?: string }> {
  const bare = String(contractId).replace("gid://shopify/SubscriptionContract/", "");
  try {
    const read = await getContractForIngest(workspaceId, bare);
    if (!read.success || !read.contract) return { ok: false, error: read.error };
    const c = read.contract;
    const admin = createAdminClient();
    const { error } = await admin
      .from("subscriptions")
      .update({
        items: await buildItems(workspaceId, c),
        applied_discounts: dedupeDiscounts(c.discounts.map((d) => ({
          id: d.id, title: d.title ?? "", type: d.type ?? "",
          targetType: d.targetType, value: d.value, valueType: d.valueType,
        }))),
        delivery_price_cents: c.deliveryPriceCents ?? 0,
        updated_at: new Date().toISOString(),
      })
      // ⚠️ Scope BOTH. `shopify_contract_id` is minted externally and is not globally unique, so
      // filtering on it alone can overwrite ANOTHER tenant's row.
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", bare);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errText(err) };
  }
}

/**
 * Bring an ALREADY-ingested contract back in step after a Shopify-side edit.
 *
 * Deliberately narrower than the create path: a merchant editing lines in the Shopify admin should
 * move our mirror, but this webhook also fires for every edit WE make, so it must not undo the
 * things ShopCX owns.
 *
 * - `next_billing_date` is skipped while dunning is active — dunning holds a past date on purpose
 *   and will set the real one when it finishes. Same rule as the Appstle webhook.
 * - A contract with no `subscriptions` row falls through to a full ingest, which is what recovers a
 *   contract whose `create` webhook was lost.
 */
export async function syncShopifyContract(
  workspaceId: string,
  contractId: string,
): Promise<IngestOutcome> {
  const bare = String(contractId).replace("gid://shopify/SubscriptionContract/", "");
  const admin = createAdminClient();

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, billing_source")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", bare)
    .maybeSingle();

  if (!sub) return ingestShopifyContract(workspaceId, bare);

  // A row we bill on another engine is not ours to rewrite from a Shopify read.
  if ((sub as { billing_source?: string }).billing_source !== "shopcx") {
    return { ingested: false, reason: `row is billed by ${(sub as { billing_source?: string }).billing_source ?? "internal"}`, contractId: bare };
  }

  try {
    const read = await getContractForIngest(workspaceId, bare);
    if (!read.success || !read.contract) {
      return { ingested: false, reason: `contract unreadable: ${read.error}`, contractId: bare };
    }
    const c = read.contract;
    const status = mapStatus(c.status);

    const { data: dunning } = await admin
      .from("dunning_cycles")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("shopify_contract_id", bare)
      .in("status", ["active", "skipped"])
      .limit(1)
      .maybeSingle();

    const patch: Record<string, unknown> = {
      status,
      billing_interval: c.interval ? c.interval.toLowerCase() : null,
      billing_interval_count: c.intervalCount,
      items: await buildItems(workspaceId, c),
      delivery_price_cents: c.deliveryPriceCents ?? 0,
      applied_discounts: c.discounts.map((d) => ({
        id: d.id, title: d.title ?? "", type: d.type ?? "",
        targetType: d.targetType, value: d.value, valueType: d.valueType,
      })),
      // See the create path: `payment_method_id` is the internal-rail Braintree FK, not this.
      updated_at: new Date().toISOString(),
    };
    if (c.shippingAddress) patch.shipping_address = c.shippingAddress;
    if (status === "cancelled") {
      patch.next_billing_date = null;
      const { data: prior } = await admin
        .from("subscriptions").select("cancelled_at").eq("id", sub.id).maybeSingle();
      patch.cancelled_at = (prior as { cancelled_at?: string } | null)?.cancelled_at ?? new Date().toISOString();
    } else if (!dunning) {
      patch.next_billing_date = c.nextBillingDate;
    }

    const { error } = await admin.from("subscriptions").update(patch).eq("id", sub.id);
    if (error) return { ingested: false, reason: `write failed: ${error.message}`, contractId: bare };
    return { ingested: true, subscriptionId: sub.id, contractId: bare, created: false };
  } catch (err) {
    return { ingested: false, reason: `threw: ${errText(err)}`, contractId: bare };
  }
}
