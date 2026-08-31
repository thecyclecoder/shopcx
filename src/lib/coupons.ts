/**
 * Coupon engine — resolves a code from our internal `coupons` table first
 * ("internal wins"), then falls back to a real-time Shopify discount-code
 * lookup, normalizing both into one entire-order discount model. The internal
 * subscription renewal scheduler applies the discount at charge time and
 * consumes `recurring_cycle_limit` per charge.
 *
 * Scope is always "order" — we ignore Shopify product scope for internal subs.
 * Discounts stack on subscribe-and-save + the quantity break (those are pricing
 * tiers, not coupons). One coupon per subscription.
 *
 * See docs/brain/specs/storefront-mvp.md § Phase 1b.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt } from "@/lib/crypto";
import { couponApplicableToSubStatus } from "@/lib/subscription-items";
import { getShopifyCredentials } from "@/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import { getLinkedShopifyCustomerIds } from "@/lib/loyalty";

type Admin = ReturnType<typeof createAdminClient>;

export type CouponType = "percentage" | "fixed_amount";

export interface ResolvedCoupon {
  code: string;
  type: CouponType;
  value: number; // percentage: 0-100 · fixed_amount: cents
  recurring_cycle_limit: number | null; // 1 | N | null (forever)
  /** Shopify appliesOncePerCustomer OR usageLimit===1 → at most one redemption per customer. */
  one_time?: boolean;
  source: "internal" | "shopify";
  coupon_id?: string; // internal row id — the MASTER row for derived codes
  /** Derived from a master ("WELCOME-GSXN")? Redemption → ledger, not used_at. */
  is_derived?: boolean;
  /** The customer the derived code resolves to (its rightful owner). */
  customer_id?: string;
}

/** An entry stored in subscriptions.applied_discounts. */
export interface AppliedDiscount {
  code?: string;
  type?: CouponType;
  value?: number;
  recurring_cycle_limit?: number | null;
  remaining_cycles?: number | null; // decremented per charge; null = forever
  source?: "internal" | "shopify";
  // Legacy entries may only carry { id, title } — handled defensively.
  id?: string;
  title?: string;
}

/** Resolve a code → normalized discount. Internal table wins; else Shopify. */
export async function resolveCoupon(
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null> {
  const admin = createAdminClient();

  // 1. Internal table exact match (internal wins). A MASTER row is never
  //    directly usable on its own — it's only redeemed via a derived
  //    "{PREFIX}-{short_code}" code (handled in step 2), so skip masters here.
  const { data: rows } = await admin
    .from("coupons")
    .select("id, code, type, value, recurring_cycle_limit, customer_id, single_use, used_at, is_master")
    .eq("workspace_id", workspaceId)
    .ilike("code", code)
    .limit(1);
  const row = rows?.[0];
  if (row && !row.is_master) {
    // Customer-scoped coupons only resolve for that customer, and only once.
    if (row.customer_id && (!customerId || String(row.customer_id) !== String(customerId))) return null;
    if (row.single_use && row.used_at) return null;
    return {
      code: row.code,
      type: row.type as CouponType,
      value: row.value,
      recurring_cycle_limit: row.recurring_cycle_limit,
      source: "internal",
      coupon_id: row.id,
    };
  }

  // 2. Derived master code — "{PREFIX}-{short_code}" (e.g. WELCOME-GSXN).
  const derived = await resolveDerivedCoupon(admin, workspaceId, code, customerId);
  if (derived) return derived;

  // 3. Real-time Shopify lookup (transitional — legacy codes). Pass the
  //    redeeming customerId so a customer-scoped Shopify code (customerSelection
  //    with a customers.customers[].id list) rejects a non-owner, closing the
  //    gap our storefront had at src/lib/coupons.ts:167 pre-Phase-2.
  return resolveShopifyCoupon(admin, workspaceId, code, customerId);
}

/**
 * Resolve a derived master code — "{PREFIX}-{short_code}" (e.g. WELCOME-GSXN).
 * The master holds the terms; the suffix is a customer's permanent short_code.
 * No coupon row exists per customer — the code is virtual until redeemed, and
 * single-use is enforced by the coupon_redemptions ledger.
 *
 * Returns null (silently falls through) when: the format doesn't split, no
 * master matches the prefix, the master is expired, the suffix doesn't resolve
 * to a customer, the redeeming customer isn't the code's owner, or the
 * per-customer redemption limit for the current cycle is already reached.
 */
async function resolveDerivedCoupon(
  admin: Admin,
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null> {
  // Split on the LAST hyphen so master prefixes may themselves contain hyphens.
  const idx = code.lastIndexOf("-");
  if (idx <= 0 || idx === code.length - 1) return null;
  const prefix = code.slice(0, idx);
  const suffix = code.slice(idx + 1).toUpperCase();

  // Master by prefix (case-insensitive).
  const { data: masters } = await admin
    .from("coupons")
    .select("id, code, type, value, recurring_cycle_limit, per_customer_limit, redemption_cycle_started_at, valid_until")
    .eq("workspace_id", workspaceId)
    .eq("is_master", true)
    .ilike("code", prefix)
    .limit(1);
  const master = masters?.[0];
  if (!master) return null;

  // Offer expiry.
  if (master.valid_until && new Date(master.valid_until as string) < new Date()) return null;

  // Suffix → the owning customer (short_code is unique per workspace).
  const { data: owner } = await admin
    .from("customers")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("short_code", suffix)
    .maybeSingle();
  if (!owner) return null;

  // Bind: only the rightful owner may redeem their own derived code. The suffix
  // is a guessable 5-char code, so this check is what prevents abuse — we never
  // apply WELCOME-GSXN to anyone but the customer GSXN resolves to.
  if (!customerId || String(owner.id) !== String(customerId)) return null;

  // Per-customer redemption limit within the CURRENT cycle. WELCOME's cycle
  // starts at the epoch (counts forever → one use). A reissuable campaign bumps
  // redemption_cycle_started_at on each launch, so prior redemptions stop
  // counting and the customer is eligible again.
  const limit = (master.per_customer_limit as number | null) ?? 1;
  const cycleStart = (master.redemption_cycle_started_at as string | null) || "1970-01-01T00:00:00Z";
  const { count } = await admin
    .from("coupon_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("coupon_id", master.id)
    .eq("customer_id", owner.id)
    .gte("redeemed_at", cycleStart);
  if ((count || 0) >= limit) return null;

  return {
    code: `${master.code}-${suffix}`,
    type: master.type as CouponType,
    value: master.value,
    recurring_cycle_limit: master.recurring_cycle_limit,
    source: "internal",
    coupon_id: master.id,
    is_derived: true,
    customer_id: owner.id,
  };
}

async function resolveShopifyCoupon(
  admin: Admin,
  workspaceId: string,
  code: string,
  customerId?: string | null,
): Promise<ResolvedCoupon | null> {
  const { data: ws } = await admin
    .from("workspaces")
    .select("shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.shopify_access_token_encrypted || !ws?.shopify_myshopify_domain) return null;
  try {
    const token = decrypt(ws.shopify_access_token_encrypted);
    // customerSelection tells us which specific Shopify customers a discount is
    // scoped to. Previously we did NOT read this field — a personal
    // customer-scoped code (e.g. one minted for the loyalty program or the
    // review reward) resolved as if it were global, so a different customer on
    // /api/checkout could redeem someone else's code. Shopify's OWN checkout
    // still enforces the binding, but our in-house storefront does not until
    // we mirror the check here — same shape as the internal branch at line 70.
    // The DiscountCustomerAll type is a marker (allCustomers=true → no
    // binding); DiscountCustomers.customers[].id is the list of scoped
    // shopify customer gids. A DiscountCustomerSegments payload (an audience
    // segment) is treated as "not scoped to a specific customer" for our
    // purposes — we can't cheaply enumerate a segment on this hot path, and
    // Shopify's own checkout still gates it.
    const res = await fetch(
      `https://${ws.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            codeDiscountNodeByCode(code: ${JSON.stringify(code)}) {
              codeDiscount {
                ... on DiscountCodeBasic {
                  recurringCycleLimit
                  appliesOncePerCustomer
                  usageLimit
                  customerSelection {
                    ... on DiscountCustomerAll { allCustomers }
                    ... on DiscountCustomers { customers { id } }
                  }
                  customerGets {
                    value {
                      ... on DiscountPercentage { percentage }
                      ... on DiscountAmount { amount { amount } }
                    }
                  }
                }
              }
            }
          }`,
        }),
        cache: "no-store",
      },
    );
    const gql = await res.json();
    const cd = gql?.data?.codeDiscountNodeByCode?.codeDiscount;
    if (!cd) return null;
    const val = cd.customerGets?.value;
    // recurringCycleLimit: 0/null = forever, 1 = one charge, N = N charges.
    const rawLimit = cd.recurringCycleLimit;
    const recurring_cycle_limit = rawLimit && Number(rawLimit) > 0 ? Number(rawLimit) : null;
    // One-time PER CUSTOMER: appliesOncePerCustomer, or a global usageLimit of 1.
    const one_time = !!cd.appliesOncePerCustomer || Number(cd.usageLimit) === 1;

    // Resolve the code's OWNING internal customer_id from customerSelection.
    // Only DiscountCustomers (an explicit customer list) produces an owner;
    // DiscountCustomerAll leaves owner null (open to everyone), and a
    // DiscountCustomerSegments payload we can't cheaply enumerate stays null.
    let ownerId: string | null = null;
    const selectionCustomers: Array<{ id?: string }> = Array.isArray(cd.customerSelection?.customers)
      ? cd.customerSelection.customers
      : [];
    if (selectionCustomers.length > 0) {
      const shopifyIds = selectionCustomers
        .map((c) => String(c.id || "").replace(/^gid:\/\/shopify\/Customer\//, ""))
        .filter(Boolean);
      if (shopifyIds.length > 0) {
        const { data: owners } = await admin
          .from("customers")
          .select("id")
          .eq("workspace_id", workspaceId)
          .in("shopify_customer_id", shopifyIds);
        // If ANY of the scoped shopify_customer_ids resolves to the REDEEMING
        // customer, let them redeem. Note this is a direct id match, not a
        // link-group expansion: codes minted by createCustomerDiscount already
        // scope customerSelection to every linked shopify id, so a linked
        // sibling's own internal id is in this set and matches. A code minted
        // by hand in the Shopify admin against a single profile will reject a
        // linked sibling — deliberate, and the safe direction. If no internal
        // row matches at all, ownerId stays null and the check below rejects
        // by default rather than opening the code to whoever asks.
        const ids = new Set<string>();
        for (const o of owners ?? []) if (o?.id) ids.add(String(o.id));
        if (ids.size > 0) {
          if (customerId && ids.has(String(customerId))) {
            ownerId = String(customerId);
          } else {
            // No match to the redeemer — pin one representative id so the
            // reject predicate below fires (mirrors the internal branch at
            // line 70's `String(row.customer_id) !== String(customerId)`).
            ownerId = [...ids][0];
          }
        }
      }
    }

    // Reject a mismatch exactly like the internal branch at line 70: if the
    // code is bound to a specific customer, only that customer may redeem.
    if (ownerId && (!customerId || String(ownerId) !== String(customerId))) return null;

    if (val?.percentage != null) {
      return {
        code,
        type: "percentage",
        value: Math.round(Number(val.percentage) * 100),
        recurring_cycle_limit,
        one_time,
        source: "shopify",
        customer_id: ownerId || undefined,
      };
    }
    if (val?.amount?.amount != null) {
      return {
        code,
        type: "fixed_amount",
        value: Math.round(parseFloat(val.amount.amount) * 100),
        recurring_cycle_limit,
        one_time,
        source: "shopify",
        customer_id: ownerId || undefined,
      };
    }
    return null;
  } catch (e) {
    console.error("[coupons] Shopify resolve failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * The shared chokepoint every ShopCX-authored customer-scoped Shopify discount
 * flows through — loyalty redemption (`src/app/api/loyalty/redeem/route.ts`),
 * the product-review reward (`src/lib/portal/handlers/review-journey.ts`), and
 * anything else that used to hand-roll `discountCodeBasicCreate`. Lifted
 * verbatim from the loyalty route's original mutation so behaviour is
 * unchanged: `usageLimit: 1`, `appliesOncePerCustomer: true`,
 * `customerSelection.customers.add: [gid://shopify/Customer/{shopify_customer_id}, …]`
 * (fanned out over the customer's linked accounts via
 * `getLinkedShopifyCustomerIds`), plus `startsAt` / `endsAt`.
 *
 * Fallback: 5 of 29,054 purchasers have no `shopify_customer_id`. In that case
 * we mint an internal customer-scoped coupon via `mintCustomerCoupon` instead
 * of failing the reward — Shopify has nothing to bind to, but the in-house
 * storefront (which `resolveCoupon` reads for) does. The internal fallback
 * also fires if the Shopify API returns userErrors; the caller sees `source =
 * 'internal'` and knows there is no Shopify discount node id to persist.
 *
 * Behavior-preserving refactor: 2,116 loyalty_redemptions depend on this path
 * (spec § Phase 2). The loyalty route calls this with the same field mapping
 * it used inline.
 */
export interface CreateCustomerDiscountResult {
  code: string;
  source: "shopify" | "internal";
  shopifyDiscountNodeId: string | null;
}

export async function createCustomerDiscount(
  workspaceId: string,
  customerId: string,
  opts: {
    /** Discount in DOLLARS (matches the loyalty route's `tier.discount_value`). */
    amount: number;
    /** Prefix for the minted code — e.g. `LOYALTY`, `REVIEW`. Default: `DISC`. */
    codePrefix?: string;
    /** Days from now the code stays valid. */
    expiryDays: number;
    /** Full Shopify discount title (visible in the admin). */
    title: string;
    /** Whether the discount is valid on one-time-purchase items. Default true. */
    appliesOnOneTimePurchase?: boolean;
    /** Whether the discount is valid on subscription items. Default true. */
    appliesOnSubscription?: boolean;
    /** combinesWith config forwarded verbatim to the Shopify mutation. */
    combinesWith?: {
      productDiscounts?: boolean;
      shippingDiscounts?: boolean;
      orderDiscounts?: boolean;
    };
    /** Extra shopify_customer_ids to include in customerSelection (e.g. the
     * loyalty route's raw `member.shopify_customer_id` when the internal
     * customer row is missing). */
    additionalShopifyCustomerIds?: string[];
  },
): Promise<CreateCustomerDiscountResult | null> {
  const admin = createAdminClient();

  const codePrefix = (opts.codePrefix || "DISC").toUpperCase();
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let random = "";
  for (let i = 0; i < 6; i++) random += chars[Math.floor(Math.random() * chars.length)];
  const code = `${codePrefix}-${opts.amount}-${random}`;

  const linkedIds = await getLinkedShopifyCustomerIds(workspaceId, customerId).catch(() => [] as string[]);
  const gidSet = new Set<string>(linkedIds.map((id) => `gid://shopify/Customer/${id}`));
  for (const extra of opts.additionalShopifyCustomerIds || []) {
    if (extra) gidSet.add(`gid://shopify/Customer/${extra}`);
  }

  // No Shopify customer id anywhere in the linked group → fall back to the
  // internal coupon path. The in-house storefront's `resolveCoupon` reads that
  // row; Shopify checkout doesn't see it, but the 5-of-29,054 edge case is
  // exactly those customers who never went through Shopify.
  if (gidSet.size === 0) {
    const minted = await mintCustomerCoupon(workspaceId, customerId, {
      type: "fixed_amount",
      value: Math.round(opts.amount * 100),
      recurring_cycle_limit: 1,
      codePrefix,
    });
    if (!minted) return null;
    return { code: minted.code, source: "internal", shopifyDiscountNodeId: null };
  }

  const customerGids = [...gidSet];
  const startsAt = new Date();
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + opts.expiryDays);

  const DISCOUNT_CREATE_MUTATION = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id codeDiscount { ... on DiscountCodeBasic { codes(first: 1) { nodes { code } } } } }
        userErrors { field message }
      }
    }
  `;

  try {
    const { shop, accessToken } = await getShopifyCredentials(workspaceId);
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: DISCOUNT_CREATE_MUTATION,
          variables: {
            basicCodeDiscount: {
              title: opts.title,
              code,
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              usageLimit: 1,
              appliesOncePerCustomer: true,
              customerSelection: {
                customers: { add: customerGids },
              },
              combinesWith: {
                productDiscounts: opts.combinesWith?.productDiscounts ?? true,
                shippingDiscounts: opts.combinesWith?.shippingDiscounts ?? true,
                orderDiscounts: opts.combinesWith?.orderDiscounts ?? true,
              },
              customerGets: {
                appliesOnOneTimePurchase: opts.appliesOnOneTimePurchase ?? true,
                appliesOnSubscription: opts.appliesOnSubscription ?? true,
                items: { all: true },
                value: {
                  discountAmount: {
                    amount: opts.amount,
                    appliesOnEachItem: false,
                  },
                },
              },
            },
          },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("[coupons] createCustomerDiscount Shopify API error:", res.status, text);
      // Fallback to internal — Shopify unreachable / unauthorized shouldn't
      // eat the customer's reward.
      const minted = await mintCustomerCoupon(workspaceId, customerId, {
        type: "fixed_amount",
        value: Math.round(opts.amount * 100),
        recurring_cycle_limit: 1,
        codePrefix,
      });
      if (!minted) return null;
      return { code: minted.code, source: "internal", shopifyDiscountNodeId: null };
    }
    const gqlResult = await res.json();
    const userErrors = gqlResult?.data?.discountCodeBasicCreate?.userErrors;
    if (userErrors?.length > 0) {
      console.error(
        "[coupons] createCustomerDiscount userErrors:",
        userErrors.map((e: { message: string }) => e.message).join(", "),
      );
      return null;
    }
    const shopifyDiscountNodeId =
      gqlResult?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || null;
    // Suppress the unused-var warning — we deliberately do not persist the
    // fresh admin client on the internal-fallback path here.
    void admin;
    return { code, source: "shopify", shopifyDiscountNodeId };
  } catch (e) {
    console.error("[coupons] createCustomerDiscount failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Apply a coupon to an internal sub's applied_discounts (one coupon per sub). */
export async function applyCouponToSub(
  workspaceId: string,
  contractId: string,
  code: string,
  customerId?: string | null,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const resolved = await resolveCoupon(workspaceId, code, customerId);
  if (!resolved) return { success: false, error: "coupon_not_found" };

  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, applied_discounts, status")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();
  if (!sub) return { success: false, error: "subscription_not_found" };
  if (!couponApplicableToSubStatus(sub.status as string | null | undefined)) {
    return { success: false, error: "subscription_not_active" };
  }

  const existing = (sub.applied_discounts as AppliedDiscount[]) || [];
  const kept = existing.filter((d) => (d.code || d.title) !== resolved.code);
  const entry: AppliedDiscount = {
    code: resolved.code,
    type: resolved.type,
    value: resolved.value,
    recurring_cycle_limit: resolved.recurring_cycle_limit,
    remaining_cycles: resolved.recurring_cycle_limit,
    source: resolved.source,
  };
  await admin
    .from("subscriptions")
    .update({ applied_discounts: [...kept, entry], updated_at: new Date().toISOString() })
    .eq("id", sub.id);

  // Record the redemption (derived → ledger row; legacy one-off → burn used_at).
  await recordCouponRedemption(workspaceId, resolved, customerId, { subscriptionId: sub.id });
  return { success: true };
}

/**
 * Record a coupon redemption at the moment it's actually consumed.
 *
 * - Derived master codes (WELCOME-GSXN): append a coupon_redemptions row. This
 *   is the only place a row is written for the master flow — so we never
 *   pre-generate per-customer coupon rows, only per-redemption ledger rows.
 * - Legacy explicit single-use coupons: burn the row's used_at (unchanged).
 *
 * Idempotency is best-effort: callers should invoke this once per successful
 * application. The ledger is also the redemption-analytics source.
 */
export async function recordCouponRedemption(
  workspaceId: string,
  resolved: ResolvedCoupon,
  customerId?: string | null,
  ctx?: { subscriptionId?: string | null; orderId?: string | null },
): Promise<void> {
  const admin = createAdminClient();
  if (resolved.is_derived && resolved.coupon_id) {
    const cid = customerId || resolved.customer_id;
    if (!cid) return;
    await admin
      .from("coupon_redemptions")
      .insert({
        workspace_id: workspaceId,
        coupon_id: resolved.coupon_id,
        customer_id: cid,
        derived_code: resolved.code,
        order_id: ctx?.orderId || null,
        subscription_id: ctx?.subscriptionId || null,
      })
      .then(() => undefined, (e) => {
        console.warn("[coupons] redemption ledger insert failed:", e?.message || e);
      });
    return;
  }
  if (resolved.source === "internal" && resolved.coupon_id) {
    await admin
      .from("coupons")
      .update({ used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", resolved.coupon_id)
      .is("used_at", null);
    return;
  }
  // Shopify-sourced coupon (no row in our coupons table) — record by code so a
  // one-time/limited code can't be re-granted to the same customer on a later
  // renewal. coupon_id is null; derived_code carries the code.
  if (resolved.source === "shopify" && customerId) {
    await admin
      .from("coupon_redemptions")
      .insert({
        workspace_id: workspaceId,
        coupon_id: null,
        customer_id: customerId,
        derived_code: resolved.code,
        order_id: ctx?.orderId || null,
        subscription_id: ctx?.subscriptionId || null,
      })
      .then(() => undefined, (e) => {
        console.warn("[coupons] shopify redemption insert failed:", e?.message || e);
      });
  }
}

/** How many times this customer has already redeemed `code` (any source). */
export async function countCouponRedemptions(
  workspaceId: string,
  code: string,
  customerId: string,
): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("coupon_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("customer_id", customerId)
    .ilike("derived_code", code);
  return count || 0;
}

/**
 * Renewal-time coupon resolution. The sub stores coupon CODES (references), not
 * frozen values. For each code we live-read the current Shopify/internal coupon,
 * check this customer's prior redemptions, apply the discount if still valid, and
 * report which codes to KEEP vs DROP (a one-time or cycle-exhausted code is
 * dropped after this charge). Appstle automatic discounts + unresolvable codes
 * are dropped silently — our pricing rules own quantity breaks / free shipping.
 *
 * Returns the discount to subtract NOW, the codes to keep on the sub, and the
 * resolved coupons that should be recorded as redeemed AFTER a successful charge.
 */
export async function resolveRenewalDiscount(
  workspaceId: string,
  appliedDiscounts: Array<Record<string, unknown>> | null,
  subtotalCents: number,
  customerId: string | null,
): Promise<{ discountCents: number; keepCodes: string[]; toRedeem: ResolvedCoupon[] }> {
  const list = ((appliedDiscounts as AppliedDiscount[] | null) || []).filter(Boolean);
  let remaining = subtotalCents;
  let discountCents = 0;
  const keepCodes: string[] = [];
  const toRedeem: ResolvedCoupon[] = [];
  const seen = new Set<string>();

  for (const d of list) {
    const code = (d.code || d.title || "").trim();
    // Drop entries with no usable code (Appstle AUTOMATIC discounts have only a
    // title like "Buy 3 Discount" but resolve to nothing — our pricing rules
    // already apply those). Dedup repeated codes.
    if (!code || seen.has(code.toLowerCase())) continue;
    seen.add(code.toLowerCase());

    const resolved = await resolveCoupon(workspaceId, code, customerId);
    if (!resolved) continue; // unresolvable / Appstle automatic → drop

    // Per-customer cap: one_time → 1; else recurring_cycle_limit (null = forever).
    const limit = resolved.one_time ? 1 : resolved.recurring_cycle_limit;
    const usedCount = customerId ? await countCouponRedemptions(workspaceId, code, customerId) : 0;
    if (limit != null && usedCount >= limit) continue; // already exhausted → drop

    const amt = resolved.type === "percentage"
      ? Math.round(remaining * (resolved.value / 100))
      : Math.min(resolved.value, remaining);
    const applied = Math.max(0, Math.min(amt, remaining));
    discountCents += applied;
    remaining -= applied;
    toRedeem.push(resolved);

    // Keep the code only if it has cycles left AFTER recording this redemption.
    if (limit == null || usedCount + 1 < limit) keepCodes.push(resolved.code);
  }

  return { discountCents, keepCodes, toRedeem };
}

/**
 * Derive a customer's code for a master coupon ("WELCOME-GSXN"). No row is
 * written — the coupon is virtual until redeemed (see recordCouponRedemption).
 * Returns null if the master doesn't exist or the customer has no short_code
 * (the BEFORE-INSERT trigger assigns one to every new customer, so this is
 * effectively always present).
 */
export async function deriveCustomerCoupon(
  workspaceId: string,
  customerId: string,
  masterCode: string,
): Promise<{ code: string } | null> {
  const admin = createAdminClient();
  const { data: master } = await admin
    .from("coupons")
    .select("code")
    .eq("workspace_id", workspaceId)
    .eq("is_master", true)
    .ilike("code", masterCode)
    .maybeSingle();
  if (!master?.code) return null;
  const sc = await ensureCustomerShortCode(admin, customerId);
  if (!sc) return null;
  return { code: `${master.code}-${sc}` };
}

// Crockford base32 (no I/L/O/U) — mirrors the customers_assign_short_code
// trigger so a code generated here is indistinguishable from a trigger one.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Return the customer's short_code, assigning one if it's missing. New
 * customers get a short_code from a BEFORE INSERT trigger, but a customer
 * MATCHED (not inserted) without one — e.g. a pre-trigger record — would
 * otherwise force the caller into the legacy `WELCOME-{custid}-{rand}` mint.
 * Assigning here guarantees a clean derived `{MASTER}-{short_code}` code.
 */
export async function ensureCustomerShortCode(admin: Admin, customerId: string): Promise<string | null> {
  const { data: cust } = await admin
    .from("customers")
    .select("short_code, workspace_id")
    .eq("id", customerId)
    .maybeSingle();
  if (cust?.short_code) return cust.short_code as string;
  if (!cust) return null;

  for (let attempt = 0; attempt < 12; attempt++) {
    let candidate = "";
    for (let i = 0; i < 5; i++) candidate += CROCKFORD[Math.floor(Math.random() * 32)];
    // Guard on short_code IS NULL so a concurrent assignment never gets
    // clobbered; unique (workspace_id, short_code) rejects collisions → retry.
    const { error } = await admin
      .from("customers")
      .update({ short_code: candidate })
      .eq("id", customerId)
      .is("short_code", null);
    if (!error) {
      const { data: re } = await admin.from("customers").select("short_code").eq("id", customerId).maybeSingle();
      if (re?.short_code) return re.short_code as string;
    }
  }
  return null;
}

/** Remove a coupon from an internal sub's applied_discounts. */
export async function removeCouponFromSub(
  workspaceId: string,
  contractId: string,
  codeOrId: string,
): Promise<{ success: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data: sub } = await admin
    .from("subscriptions")
    .select("id, applied_discounts")
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", String(contractId))
    .single();
  if (!sub) return { success: false, error: "subscription_not_found" };
  const existing = (sub.applied_discounts as AppliedDiscount[]) || [];
  const remaining = existing.filter((d) => d.code !== codeOrId && d.title !== codeOrId && d.id !== codeOrId);
  await admin
    .from("subscriptions")
    .update({ applied_discounts: remaining, updated_at: new Date().toISOString() })
    .eq("id", sub.id);
  return { success: true };
}

/**
 * The discount (cents) a single resolved coupon takes off a subtotal.
 * Percentage off the subtotal, or a fixed cents amount (capped at the subtotal).
 */
export function couponDiscountCents(
  resolved: Pick<ResolvedCoupon, "type" | "value">,
  subtotalCents: number,
): number {
  if (subtotalCents <= 0) return 0;
  const d = resolved.type === "percentage"
    ? Math.round(subtotalCents * (Math.max(0, Math.min(100, resolved.value)) / 100))
    : Math.max(0, resolved.value);
  return Math.max(0, Math.min(d, subtotalCents));
}

/**
 * True iff `code` matches the exact canonical shape minted by
 * `redeem_points` / `apply_loyalty_coupon`'s regen path —
 * `LOYALTY-<value>-<6-char-random>`. Case-insensitive on letters.
 *
 * Refuses PostgreSQL LIKE wildcards (`%`, `_`), backslashes, hyphens
 * outside the two positions above, and any other punctuation — the primary
 * defense the materializer relies on to refuse pattern-injection lookups
 * like `LOYALTY-%` that would otherwise match another customer's
 * redemption via `.ilike("discount_code", code)` and materialize a
 * discount the caller did not earn.
 *
 * Spec: loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * § Phase 2 Fix 1 (sec:real-vuln finding on src/lib/coupons.ts:816/:847).
 * Exported for unit tests.
 */
export function isCanonicalLoyaltyCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return /^LOYALTY-\d{1,3}-[A-Za-z0-9]{6}$/i.test(code);
}

/**
 * Escape PostgreSQL LIKE wildcards (`%`, `_`) and the backslash so an
 * `.ilike("col", escapeIlikeWildcards(input))` behaves as literal
 * case-insensitive equality on the untrusted input — regardless of whether
 * the caller already validated the shape upstream. Belt-and-braces layer
 * behind `isCanonicalLoyaltyCode` for `ensureInternalLoyaltyCouponRow`.
 *
 * Order matters: backslash MUST be replaced first so subsequent replacements
 * of `%` / `_` don't double-escape themselves. Exported for unit tests.
 */
export function escapeIlikeWildcards(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

/**
 * Pure: true iff a `loyalty_redemptions` row is currently apply-eligible
 * — the state gate `ensureInternalLoyaltyCouponRow` uses to refuse
 * materializing a stale / consumed / expired redemption as a fresh
 * internal `coupons` row (coupon-replay attack; spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * § Phase 3 Fix 2).
 *
 * Eligible iff `status='active'`, `used_at IS NULL`, and (`expires_at IS
 * NULL` or `expires_at > now`). Any other status ('used' / 'expired' /
 * 'rolled_back' / 'redeemed_as_refund' / …) is refused — fail-closed by
 * design. `expires_at` exactly equal to `now` is treated as EXPIRED so a
 * race at the boundary doesn't hand out a coupon that would immediately be
 * void.
 *
 * Exported for unit tests. `now` defaults to the real clock; pass an
 * explicit `Date` in tests for reproducibility.
 */
export function isRedemptionStateApplyEligible(
  redemption: {
    status: string;
    used_at: string | null;
    expires_at: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (redemption.status !== "active") return false;
  if (redemption.used_at != null) return false;
  if (redemption.expires_at != null) {
    const exp = new Date(redemption.expires_at).getTime();
    if (!Number.isFinite(exp)) return false;
    if (exp <= now.getTime()) return false;
  }
  return true;
}

/**
 * Materialize a LOYALTY-* code as an internal `coupons` row scoped to the
 * contract-owning customer. Idempotent — a coupons row already keyed by the
 * `(workspace_id, lower(code))` unique index is returned as-is with no
 * re-write.
 *
 * NET-ZERO on points — this reads the existing loyalty_redemptions row for
 * `discount_value` ONLY. `spendPoints` was already called at redeem time;
 * we never re-charge.
 *
 * Why (spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value,
 * ticket 46a7aa75): LOYALTY-* codes are minted in Shopify by `redeem_points`
 * so `resolveCoupon` at renewal time reaches step 3 (real-time Shopify
 * lookup) to re-hydrate them. A deleted / dying Shopify code returns null →
 * `resolveRenewalDiscount` drops the entry → the internal renewal charges
 * full price on a discount the customer earned. Materializing the redemption
 * as an internal coupons row moves the resolution to step 1 (internal wins),
 * which survives Shopify deleting the code.
 *
 * Rails preserved: `single_use=true` + `recurring_cycle_limit=1` = one
 * charge, one loyalty coupon per order/renewal ceiling — same rails as the
 * Shopify-side `usageLimit=1` + `appliesOncePerCustomer=true` mint at
 * `redeem_points`.
 *
 * Returns the ResolvedCoupon shape for the row (existing or new). Returns
 * `null` when no `loyalty_redemptions` row exists for this code (we can't
 * infer the discount value from thin air) OR when an existing row is scoped
 * to a different customer (we won't silently rebind — that would open the
 * code to a stranger).
 */
export async function ensureInternalLoyaltyCouponRow(
  workspaceId: string,
  code: string,
  contractOwnerCustomerId: string,
): Promise<ResolvedCoupon | null> {
  // Phase-2 Fix-1 (spec:
  // loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value)
  // — refuse ANY non-canonical LOYALTY code upfront so a caller submitting
  // `LOYALTY-%` (a PostgREST/Supabase LIKE wildcard) can never reach the
  // `.ilike("discount_code", code)` lookup below. `subscriptionApplyCoupon`
  // is expected to gate on `isCanonicalLoyaltyCode` too — this is
  // defense-in-depth for any future caller that forgets.
  if (!isCanonicalLoyaltyCode(code)) return null;

  const admin = createAdminClient();
  // Second layer: escape LIKE wildcards on the .ilike input even after the
  // shape check. A canonical code has no `%` / `_` / `\` in it, so this is a
  // no-op on the happy path — but leaves the queries safe if the caller
  // gate ever drifts.
  const safeCode = escapeIlikeWildcards(code);

  const readExisting = async (): Promise<ResolvedCoupon | null> => {
    const { data: rows } = await admin
      .from("coupons")
      .select("id, code, type, value, recurring_cycle_limit, customer_id, single_use, used_at, is_master")
      .eq("workspace_id", workspaceId)
      .ilike("code", safeCode)
      .limit(1);
    const row = rows?.[0];
    if (!row || row.is_master) return null;
    // Enforce customer binding: don't silently rebind a code to a different
    // customer. If the existing internal row belongs to someone else, refuse
    // — the caller falls through to the Shopify step (which will still work
    // if the Shopify code exists) or fails cleanly.
    if (row.customer_id && String(row.customer_id) !== String(contractOwnerCustomerId)) return null;
    if (row.single_use && row.used_at) return null;
    return {
      code: row.code as string,
      type: row.type as CouponType,
      value: row.value as number,
      recurring_cycle_limit: row.recurring_cycle_limit as number | null,
      source: "internal",
      coupon_id: row.id as string,
    };
  };

  // 1. Already an internal row for this code? Use it.
  const cached = await readExisting();
  if (cached) return cached;

  // 2. Look up the loyalty_redemptions row for this code — the source of
  //    truth for `discount_value` AND for the ownership + state guards
  //    added in Phase-3 Fix-2 (sec:real-vuln coupon-replay finding on
  //    `src/lib/subscription-items.ts:1432` / `src/lib/coupons.ts:895-918`).
  //    Pre-fix the lookup filtered on `(workspace_id, discount_code)` ONLY
  //    and inserted a fresh single-use coupon regardless of whether the
  //    redemption was another customer's, already consumed, or expired.
  //    Fix requires member ownership match + apply-eligible state.
  const { data: red } = await admin
    .from("loyalty_redemptions")
    .select("id, member_id, discount_value, status, used_at, expires_at")
    .eq("workspace_id", workspaceId)
    .ilike("discount_code", safeCode)
    .limit(1)
    .maybeSingle();
  if (!red) return null;

  // 2a. STATE guard — the redemption must be currently apply-eligible.
  //     Refuses status != 'active', used_at != null, or a past expires_at.
  //     Fail-closed at the boundary so a stale / consumed / expired code
  //     cannot be revived as a fresh internal single-use coupon on ANY
  //     customer's contract.
  if (
    !isRedemptionStateApplyEligible({
      status: (red as { status?: string }).status ?? "",
      used_at: (red as { used_at?: string | null }).used_at ?? null,
      expires_at: (red as { expires_at?: string | null }).expires_at ?? null,
    })
  ) {
    return null;
  }

  // 2b. OWNERSHIP guard — the redemption's `loyalty_members` row MUST
  //     resolve to the same native `customer_id` as `contractOwnerCustomerId`.
  //     Fallback: when the member has no native `customer_id`, compare
  //     the member's `shopify_customer_id` to the contract owner's
  //     `shopify_customer_id` (a single customers lookup). No link-group
  //     expansion — a coupon minted for a sibling profile does NOT
  //     transfer to another profile's contract (matches the Shopify-side
  //     customer binding the pre-fix path relied on for authorisation).
  const memberId = (red as { member_id?: string }).member_id;
  if (!memberId) return null;
  const { data: member } = await admin
    .from("loyalty_members")
    .select("id, customer_id, shopify_customer_id")
    .eq("id", memberId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!member) return null;
  const memberNativeCustomerId = (member as { customer_id?: string | null }).customer_id;
  if (memberNativeCustomerId != null && memberNativeCustomerId !== "") {
    if (String(memberNativeCustomerId) !== String(contractOwnerCustomerId)) return null;
  } else {
    const memberShopifyId = (member as { shopify_customer_id?: string | null }).shopify_customer_id;
    if (!memberShopifyId) return null;
    const { data: owner } = await admin
      .from("customers")
      .select("shopify_customer_id")
      .eq("id", contractOwnerCustomerId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    const ownerShopifyId = (owner as { shopify_customer_id?: string | null } | null)?.shopify_customer_id;
    if (!ownerShopifyId || String(ownerShopifyId) !== String(memberShopifyId)) return null;
  }

  const valueCents = Math.round(Number(red.discount_value) * 100);
  if (!Number.isFinite(valueCents) || valueCents <= 0) return null;

  // 3. Insert via the shared low-level helper.
  const insertedResolved = await insertInternalLoyaltyCouponRowUnchecked(
    admin,
    workspaceId,
    code,
    contractOwnerCustomerId,
    valueCents,
  );
  if (insertedResolved) return insertedResolved;
  // Unique-index conflict → the winning inserter's row is ours.
  return await readExisting();
}

/**
 * LOW-LEVEL insert for the internal loyalty coupon row — writes directly to
 * `public.coupons` with `single_use=true`, `recurring_cycle_limit=1`,
 * `type='fixed_amount'`, `customer_id=contractOwnerCustomerId`.
 *
 * ⚠️  UNCHECKED. Bypasses the canonical-shape / owner-match / state
 * eligibility guards that `ensureInternalLoyaltyCouponRow` uses to defend
 * the online `subscriptionApplyCoupon` path (Phase-2 Fix-1 + Phase-3 Fix-2).
 * ONLY callable from:
 *   (a) `ensureInternalLoyaltyCouponRow` itself (which pre-verifies), and
 *   (b) a NAMED, one-customer ship-time remediation script that has
 *       already resolved a specific historical redemption + verified the
 *       contract owner OUT-OF-BAND against a CS-Director spec write-up.
 *
 * Do NOT expose to any request-time / agent-driven caller. Returns null on
 * unique-index conflict; caller re-reads the row.
 *
 * Spec: loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value
 * § Phase 3 Fix 2 — "Keep any ship-time one-customer remediation explicit
 * and separate if it must handle a previously-applied historical row."
 */
export async function insertInternalLoyaltyCouponRowUnchecked(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  code: string,
  contractOwnerCustomerId: string,
  valueCents: number,
): Promise<ResolvedCoupon | null> {
  const { data: inserted, error } = await admin
    .from("coupons")
    .insert({
      workspace_id: workspaceId,
      code,
      type: "fixed_amount",
      value: valueCents,
      scope: "order",
      recurring_cycle_limit: 1,
      customer_id: contractOwnerCustomerId,
      single_use: true,
    })
    .select("id")
    .single();
  if (error || !inserted) return null;
  return {
    code,
    type: "fixed_amount",
    value: valueCents,
    recurring_cycle_limit: 1,
    source: "internal",
    coupon_id: inserted.id as string,
  };
}

/** Mint a customer-scoped, single-use coupon (used by the smart popup). */
export async function mintCustomerCoupon(
  workspaceId: string,
  customerId: string,
  opts: { type: CouponType; value: number; recurring_cycle_limit?: number | null; codePrefix?: string },
): Promise<{ code: string } | null> {
  const admin = createAdminClient();
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const cust = customerId.replace(/-/g, "").slice(0, 6).toUpperCase();
  const code = `${opts.codePrefix || "SAVE"}-${cust}-${rand}`;
  const { error } = await admin.from("coupons").insert({
    workspace_id: workspaceId,
    code,
    type: opts.type,
    value: opts.value,
    scope: "order",
    recurring_cycle_limit: opts.recurring_cycle_limit ?? 1,
    customer_id: customerId,
    single_use: true,
  });
  if (error) {
    console.error("[coupons] mint failed:", error.message);
    return null;
  }
  return { code };
}

/**
 * Compute the entire-order discount for a renewal from applied_discounts, and
 * return the consumed list (cycles decremented, auto-expired entries dropped).
 * The scheduler uses `discountCents` for the charge and persists
 * `nextAppliedDiscounts` ONLY after a successful charge (don't burn a cycle on
 * a failed charge). Stacks multiple discounts on the running subtotal.
 */
export function computeAppliedDiscountCents(
  appliedDiscounts: Array<Record<string, unknown>> | null,
  subtotalCents: number,
): { discountCents: number; nextAppliedDiscounts: Array<Record<string, unknown>> } {
  const list = (appliedDiscounts as AppliedDiscount[] | null) || [];
  let remainingSubtotal = subtotalCents;
  let discountCents = 0;
  const next: AppliedDiscount[] = [];

  for (const d of list) {
    // Legacy/code-only entries (no type) can't be computed — keep, no discount.
    if (d.type !== "percentage" && d.type !== "fixed_amount") {
      next.push(d);
      continue;
    }
    // Already exhausted (shouldn't be present) — drop.
    if (d.remaining_cycles != null && d.remaining_cycles <= 0) continue;

    let amt = d.type === "percentage"
      ? Math.round(remainingSubtotal * ((d.value || 0) / 100))
      : Math.min(d.value || 0, remainingSubtotal);
    amt = Math.max(0, Math.min(amt, remainingSubtotal));
    discountCents += amt;
    remainingSubtotal -= amt;

    // Consume a cycle (forever = null → keep).
    if (d.remaining_cycles == null) {
      next.push(d);
    } else {
      const rem = d.remaining_cycles - 1;
      if (rem > 0) next.push({ ...d, remaining_cycles: rem });
      // rem <= 0 → drop (auto-expire after this charge)
    }
  }

  return { discountCents, nextAppliedDiscounts: next as Array<Record<string, unknown>> };
}
