/**
 * orders-classification — Phase 1: classifyOrder facets.
 *                        Phase 2: queryOrders() with time range + first-vs-repeat + pagination.
 *
 * A read chokepoint that classifies any `orders` row on four orthogonal facets:
 *
 *  - source        — shopify | internal | amazon, discriminated from documented
 *                    tells (`source_name`, `shopify_order_id`, `braintree_*`,
 *                    `amplifier_*`, `amazon_order_id`).
 *  - origin        — checkout | renewal, DELEGATED to `bucketOrder` — the SoT
 *                    for renewal/subscription discrimination
 *                    (see docs/brain/libraries/order-bucketing.md).
 *  - cartType      — subscription | one_time, DELEGATED to `bucketOrder`
 *                    (defined only for checkout origin).
 *  - customerRecency — first_time | repeat, defined ONLY for the checkout
 *                    origin. Resolved by `queryOrders` (Phase 2) via a batched
 *                    prior-order lookup — a customer with ANY prior order
 *                    (renewals counted) is `repeat`. Left undefined by
 *                    `classifyOrder` alone (it has no DB access).
 *
 * Any place in the codebase that needs "first-time vs repeat customer" or
 * "checkout vs renewal" should call `classifyOrder` (or `queryOrders`) instead
 * of hand-rolling predicates against raw columns.
 * See docs/brain/specs/orders-classification-sdk.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { bucketOrder, type OrderBucket } from "./order-bucketing";

export type OrderSource = "shopify" | "internal" | "amazon";
export type OrderOrigin = "checkout" | "renewal";
export type OrderCartType = "subscription" | "one_time";
export type CustomerRecency = "first_time" | "repeat";

/**
 * Minimal orders-row shape classifyOrder reads. All fields are optional so
 * callers can pass a partial select from the orders table; unknown fields
 * default to null and the classifier still returns a well-formed verdict.
 */
export interface ClassifyOrderInput {
  source_name?: string | null;
  tags?: string | string[] | null;
  subscription_id?: string | null;
  shopify_order_id?: string | null;
  braintree_transaction_id?: string | null;
  amplifier_order_id?: string | null;
  amazon_order_id?: string | null;
}

export interface ClassifyOrderResult {
  source: OrderSource;
  origin: OrderOrigin;
  cartType?: OrderCartType;
  customerRecency?: CustomerRecency;
}

export interface ClassifyOrderOptions {
  /**
   * Optional `workspaces.order_source_mapping` — pass-through to
   * `bucketOrder` so custom mappings (numeric Shopify ids → replacement, etc.)
   * still apply to the origin/cartType facets.
   */
  sourceMapping?: Record<string, string>;
}

// source_name values written by internal writers (never by Shopify sync).
// Kept in sync with:
//   • src/app/api/checkout/route.ts            → "storefront"
//   • src/lib/inngest/internal-subscription-renewals.ts →
//       "internal_subscription_renewal" / "internal_subscription_comp_renewal"
//   • src/lib/commerce/order.ts createOrder     → "internal" / "shopcx-created"
const INTERNAL_SOURCE_NAMES = new Set<string>([
  "storefront",
  "internal",
  "internal_subscription_renewal",
  "internal_subscription_comp_renewal",
  "shopcx-created",
]);

// source_name values that mark a row as Amazon-sourced. Amazon revenue mostly
// lives in daily_amazon_order_snapshots, but the orders table can carry an
// Amazon-sourced row when marked explicitly.
const AMAZON_SOURCE_NAMES = new Set<string>(["amazon"]);

function detectSource(order: ClassifyOrderInput): OrderSource {
  const src = (order.source_name || "").toLowerCase();
  if (AMAZON_SOURCE_NAMES.has(src) || order.amazon_order_id) return "amazon";
  if (INTERNAL_SOURCE_NAMES.has(src)) return "internal";
  // No shopify_order_id AND a braintree charge on the row → an internal order
  // whose source_name was never stamped (defensive fallback).
  if (!order.shopify_order_id && order.braintree_transaction_id) return "internal";
  return "shopify";
}

/**
 * Classify one orders row on {source, origin, cartType, customerRecency}.
 *
 * `origin` + `cartType` are derived from `bucketOrder` and MUST NOT be
 * re-derived here — a drift in the renewal predicate would silently corrupt
 * ROAS. Phase 1 does not fill `customerRecency` (Phase 2's queryOrders adds
 * the batched prior-order lookup).
 */
export function classifyOrder(
  order: ClassifyOrderInput,
  options: ClassifyOrderOptions = {},
): ClassifyOrderResult {
  const bucket: OrderBucket = bucketOrder(order, options.sourceMapping ?? {});
  const source = detectSource(order);

  let origin: OrderOrigin;
  let cartType: OrderCartType | undefined;
  if (bucket === "recurring") {
    origin = "renewal";
    cartType = undefined;
  } else if (bucket === "new_sub") {
    origin = "checkout";
    cartType = "subscription";
  } else if (bucket === "one_time") {
    origin = "checkout";
    cartType = "one_time";
  } else {
    // "replacement" — a draft/replacement order. Treat as checkout with no
    // cart-type facet (it is not a subscription creation and not a renewal).
    origin = "checkout";
    cartType = undefined;
  }

  return { source, origin, cartType };
}

// ── Phase 2 — queryOrders() ────────────────────────────────────────────

/** Filters for queryOrders. Any subset is optional; all filters AND together. */
export interface QueryOrdersFilters {
  /** One or more sources. Array form matches ANY of the listed sources. */
  source?: OrderSource | OrderSource[];
  /** checkout | renewal (or an array). */
  origin?: OrderOrigin | OrderOrigin[];
  /** subscription | one_time (or an array). Only checkout rows carry this. */
  cartType?: OrderCartType | OrderCartType[];
  /** first_time | repeat. Only checkout rows carry this (renewals never do). */
  customerRecency?: CustomerRecency | CustomerRecency[];
  /** ISO timestamp or Date — orders.created_at >= since. */
  since?: string | Date;
  /** ISO timestamp or Date — orders.created_at <= until. */
  until?: string | Date;
  /** Rolling window: orders in the last N days (relative to now). Mutually exclusive with since/until. */
  lastDays?: number;
  /** Passed through to bucketOrder for workspace-custom source mappings. */
  sourceMapping?: Record<string, string>;
  /** Per-page cap (Postgres cap is 1000). Defaults to 500. */
  pageSize?: number;
  /** Hard cap on total returned rows. Defaults to Infinity. */
  maxRows?: number;
}

/** The row shape queryOrders returns. Ships the raw fields callers need PLUS the classification verdict. */
export interface OrderRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string | null;
  email: string | null;
  total_cents: number;
  source_name: string | null;
  tags: string | string[] | null;
  shopify_order_id: string | null;
  braintree_transaction_id: string | null;
  amplifier_order_id: string | null;
  amazon_order_id: string | null;
  created_at: string;
  classification: ClassifyOrderResult;
}

export interface QueryOrdersDeps {
  /** Optional admin client (tests inject a fake). Defaults to createAdminClient(). */
  admin?: SupabaseClient;
}

/** Columns queryOrders selects. Everything classifyOrder + the recency lookup need. */
const QUERY_ORDERS_COLUMNS =
  "id, workspace_id, customer_id, subscription_id, order_number, email, total_cents, source_name, tags, shopify_order_id, braintree_transaction_id, amplifier_order_id, amazon_order_id, created_at";

interface RawQueryOrderRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  order_number: string | null;
  email: string | null;
  total_cents: number | null;
  source_name: string | null;
  tags: string | string[] | null;
  shopify_order_id: string | null;
  braintree_transaction_id: string | null;
  amplifier_order_id: string | null;
  amazon_order_id: string | null;
  created_at: string;
}

function toIso(ts: string | Date): string {
  return ts instanceof Date ? ts.toISOString() : ts;
}

function asArray<T>(v: T | T[] | undefined): T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

/**
 * Batch-resolve the earliest orders.created_at per customer_id. Paginates past
 * the 1000-row cap (via cursor on `(created_at ASC, id ASC)`) so a caller
 * with a heavy-repeat customer set never silently truncates.
 *
 * Rationale: the first-vs-repeat convention counts ANY prior order (renewals
 * included) — matching `customers.first_order_at` and the welcome-email path.
 * We compute it here off the raw orders table so the SDK is self-contained
 * and testable with a single fake admin client.
 */
async function resolveCustomerFirstOrderAt(
  admin: SupabaseClient,
  workspaceId: string,
  customerIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (customerIds.length === 0) return out;

  const pageSize = 1000;
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (true) {
    let q = admin
      .from("orders")
      .select("id, customer_id, created_at")
      .eq("workspace_id", workspaceId)
      .in("customer_id", customerIds);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.gt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.gt.${cursorId})`,
      );
    }
    q = q
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as { id: string; customer_id: string | null; created_at: string }[];
    if (rows.length === 0) break;

    for (const r of rows) {
      if (!r.customer_id) continue;
      const existing = out.get(r.customer_id);
      if (!existing || r.created_at < existing) out.set(r.customer_id, r.created_at);
    }

    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  return out;
}

/**
 * Paginated read of `orders` for a workspace, classifying each row and
 * filtering by any subset of {source, origin, cartType, customerRecency, time}.
 *
 * Pagination cursor is `(created_at DESC, id DESC)` so this walks past
 * PostgREST's 1000-row response cap.
 *
 * Time range is first-class: pass either `lastDays` (rolling window) OR
 * `since`/`until` (ISO or Date). All facet filters AND with the time filters.
 * No raw `.from(...)` bucket predicates leak to callers.
 */
export async function queryOrders(
  workspaceId: string,
  filters: QueryOrdersFilters = {},
  deps: QueryOrdersDeps = {},
): Promise<OrderRow[]> {
  const admin = deps.admin ?? createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.pageSize ?? 500));
  const maxRows = filters.maxRows ?? Number.POSITIVE_INFINITY;

  // Time range — lastDays wins over since/until when both are set (rolling window).
  let sinceIso: string | undefined;
  let untilIso: string | undefined;
  if (typeof filters.lastDays === "number" && filters.lastDays > 0) {
    const nowMs = Date.now();
    sinceIso = new Date(nowMs - filters.lastDays * 24 * 60 * 60 * 1000).toISOString();
  } else {
    if (filters.since !== undefined) sinceIso = toIso(filters.since);
    if (filters.until !== undefined) untilIso = toIso(filters.until);
  }

  const sourceFilter = asArray(filters.source);
  const originFilter = asArray(filters.origin);
  const cartTypeFilter = asArray(filters.cartType);
  const recencyFilter = asArray(filters.customerRecency);

  // ── Read + classify + facet-filter (except recency), paginated ──
  const collected: OrderRow[] = [];
  let cursorCreatedAt: string | null = null;
  let cursorId: string | null = null;

  while (collected.length < maxRows) {
    let q = admin
      .from("orders")
      .select(QUERY_ORDERS_COLUMNS)
      .eq("workspace_id", workspaceId);
    if (sinceIso) q = q.gte("created_at", sinceIso);
    if (untilIso) q = q.lte("created_at", untilIso);
    if (cursorCreatedAt && cursorId) {
      q = q.or(
        `created_at.lt.${cursorCreatedAt},and(created_at.eq.${cursorCreatedAt},id.lt.${cursorId})`,
      );
    }
    q = q
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(pageSize);

    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as RawQueryOrderRow[];
    if (rows.length === 0) break;

    for (const r of rows) {
      const cls = classifyOrder(r, { sourceMapping: filters.sourceMapping });
      if (sourceFilter && !sourceFilter.includes(cls.source)) continue;
      if (originFilter && !originFilter.includes(cls.origin)) continue;
      if (cartTypeFilter) {
        if (!cls.cartType || !cartTypeFilter.includes(cls.cartType)) continue;
      }
      collected.push({
        id: r.id,
        workspace_id: r.workspace_id,
        customer_id: r.customer_id,
        subscription_id: r.subscription_id,
        order_number: r.order_number,
        email: r.email,
        total_cents: Number(r.total_cents ?? 0),
        source_name: r.source_name,
        tags: r.tags,
        shopify_order_id: r.shopify_order_id,
        braintree_transaction_id: r.braintree_transaction_id,
        amplifier_order_id: r.amplifier_order_id,
        amazon_order_id: r.amazon_order_id,
        created_at: r.created_at,
        classification: cls,
      });
      if (collected.length >= maxRows) break;
    }

    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
  }

  // ── Resolve customerRecency on checkout rows (renewal rows never carry it) ──
  const needRecencyCustomers = new Set<string>();
  for (const row of collected) {
    if (row.classification.origin !== "checkout") continue;
    if (row.customer_id) needRecencyCustomers.add(row.customer_id);
  }

  if (needRecencyCustomers.size > 0) {
    const firstOrderAt = await resolveCustomerFirstOrderAt(
      admin,
      workspaceId,
      [...needRecencyCustomers],
    );
    for (const row of collected) {
      if (row.classification.origin !== "checkout") continue;
      if (!row.customer_id) continue;
      const firstAt = firstOrderAt.get(row.customer_id);
      // A customer with no orders at all (shouldn't happen — this row IS one)
      // or whose earliest matches this row → first_time. Otherwise → repeat.
      let recency: CustomerRecency;
      if (!firstAt) {
        recency = "first_time";
      } else if (row.created_at <= firstAt) {
        recency = "first_time";
      } else {
        recency = "repeat";
      }
      row.classification = { ...row.classification, customerRecency: recency };
    }
  }

  // ── Apply recency filter after resolution ──
  if (recencyFilter) {
    return collected.filter((row) => {
      // Renewals have no customerRecency; a customerRecency filter is a
      // checkout-scoped facet, so drop renewals from the result.
      const rec = row.classification.customerRecency;
      return rec !== undefined && recencyFilter.includes(rec);
    });
  }

  return collected;
}
