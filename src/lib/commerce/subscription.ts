/**
 * commerce/subscription.ts — Display + mutation ops for subscriptions.
 *
 * DISPLAY: Every op is internal-vs-Appstle-aware via `./price.ts.priceSubscription`
 * (branches on `sub.is_internal`) so `SubscriptionView.pricing` is fully
 * populated on the returned view — no downstream surface renders $NaN / $0.
 *
 * `listSubscriptions` and `listSubscriptionsByCustomer` back onto the
 * `commerce_list_subscriptions` Postgres RPC — one round trip per page projects
 * the sub + latest renewal order + upcoming (projected) order (see
 * [[../../docs/brain/tables/subscriptions]] and the accompanying migration
 * `supabase/migrations/20260914120000_commerce_list_subscriptions_rpc.sql`).
 * The SDK walks past Postgres' 1000-row default cap by cursor-paginating on
 * `(updated_at DESC, id DESC)` — matches the goal's "no silent truncation"
 * invariant and the [[../../docs/brain/README]] § Probing technique note.
 *
 * MUTATION: Every subscription mutation flows through here as one canonical
 * subscriptionX surface (renaming the current appstleX + subX exports).
 * Each op branches on isInternalSubscription() — internal → internalSub*
 * handlers; else → the existing appstleX / subX wrappers, which top-guard
 * with healOnTouch and handle the Appstle boundary.
 *
 * Ships with zero call-site consumers — the M3 harness compares parity before
 * any surface migrates. Phase 3 flips src/lib/appstle.ts and
 * src/lib/subscription-items.ts to thin @deprecated shims that call the
 * mutation exports below; M4/M5 migrates callers off the shims.
 *
 * See docs/brain/reference/commerce-sdk-inventory.html § Rename map for
 * the full old→new pairing, and docs/brain/libraries/commerce__subscription.md
 * for the surface reference.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { priceSubscription } from "./price";
import type {
  SubscriptionLineView,
  SubscriptionListFilters,
  SubscriptionView,
  SubscriptionLatestOrderView,
  SubscriptionUpcomingOrderView,
} from "./types";
import {
  isInternalSubscription,
  internalSubscriptionAction,
  internalSubSkipNextOrder,
  internalSubUpdateBillingInterval,
  internalSubUpdateNextBillingDate,
  internalSubUpdateShippingAddress,
  type ShippingAddressInput,
} from "@/lib/internal-subscription";
import {
  appstleSubscriptionAction,
  appstleSkipNextOrder,
  appstleUpdateBillingInterval,
  appstleUpdateNextBillingDate,
  appstleSwitchPaymentMethod,
  appstleSendPaymentUpdateEmail,
  appstleAddFreeProduct,
  appstleSwapProduct,
  appstleAttemptBilling,
  appstleSkipUpcomingOrder,
  appstleUnskipOrder,
  appstleGetUpcomingOrders,
  orderNowByContract,
} from "@/lib/appstle";
import {
  subAddItem,
  subRemoveItem,
  subChangeQuantity,
  subSwapVariant,
  subUpdateLineItemPrice,
  subscriptionApplyCoupon,
  subscriptionRemoveCoupon,
} from "@/lib/subscription-items";

export type { SubscriptionView, SubscriptionLineView, SubscriptionPricingView, SubscriptionListFilters } from "./types";

// ── Raw shapes returned by the RPC / from `subscriptions` ────────────

interface RawSubscriptionRow {
  id: string;
  workspace_id: string;
  customer_id: string | null;
  shopify_contract_id: string | null;
  status: string;
  is_internal: boolean | null;
  comp: boolean | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  last_payment_status: string | null;
  items: unknown;
  delivery_price_cents: number | null;
  shipping_address: Record<string, unknown> | null;
  shipping_protection_added: boolean | null;
  shipping_protection_amount_cents: number | null;
  applied_discounts: unknown;
  pricing_offer_id: string | null;
  payment_method_id: string | null;
  pause_resume_at: string | null;
  subscription_created_at: string | null;
  avalara_quote_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawLatestOrder {
  id: string;
  order_number: string | null;
  financial_status: string | null;
  delivery_status: string | null;
  total_cents: number | null;
  created_at: string;
  delivered_at: string | null;
}

interface RawItem {
  line_id?: string;
  variant_id?: string;
  product_id?: string | null;
  title?: string;
  variant_title?: string | null;
  sku?: string | null;
  quantity?: number;
  is_gift?: boolean;
  price_override_cents?: number | null;
}

interface CommerceListRow {
  sub: RawSubscriptionRow;
  latest_order: RawLatestOrder | null;
  upcoming_order: { next_billing_date: string | null } | null;
}

// ── Shape helpers ────────────────────────────────────────────────────

function coerceStatus(s: string | null): SubscriptionView["status"] {
  if (s === "paused" || s === "cancelled" || s === "active") return s;
  return "cancelled";
}

function coerceLastPaymentStatus(s: string | null): SubscriptionView["last_payment_status"] {
  if (s === "succeeded" || s === "failed" || s === "skipped") return s;
  return null;
}

function buildLineViews(items: unknown, priced: Map<string, { base_cents: number; unit_cents: number }>): SubscriptionLineView[] {
  const arr = Array.isArray(items) ? (items as RawItem[]) : [];
  return arr.map((it) => {
    const lineId = String(it.line_id ?? it.variant_id ?? "");
    const variantId = String(it.variant_id ?? "");
    const p = priced.get(lineId) || priced.get(variantId) || { base_cents: 0, unit_cents: 0 };
    return {
      line_id: lineId,
      variant_id: variantId,
      product_id: it.product_id ?? null,
      title: it.title ?? "",
      variant_title: it.variant_title ?? null,
      sku: it.sku ?? null,
      quantity: Number(it.quantity ?? 1),
      is_gift: Boolean(it.is_gift),
      price_override_cents: it.price_override_cents ?? null,
      base_cents: p.base_cents,
      unit_cents: p.unit_cents,
    };
  });
}

function buildLatestOrder(row: RawLatestOrder | null): SubscriptionLatestOrderView | null {
  if (!row) return null;
  return {
    id: row.id,
    order_number: row.order_number ?? "",
    financial_status: row.financial_status,
    delivery_status: row.delivery_status,
    total_cents: Number(row.total_cents ?? 0),
    created_at: row.created_at,
    delivered_at: row.delivered_at,
  };
}

async function buildViewFromRaw(
  workspaceId: string,
  sub: RawSubscriptionRow,
  latest: RawLatestOrder | null,
): Promise<SubscriptionView> {
  const rawForPrice: Record<string, unknown> = {
    id: sub.id,
    is_internal: sub.is_internal ?? false,
    items: sub.items,
    delivery_price_cents: sub.delivery_price_cents ?? 0,
    shipping_protection_added: sub.shipping_protection_added ?? false,
    shipping_protection_amount_cents: sub.shipping_protection_amount_cents ?? 0,
    applied_discounts: sub.applied_discounts,
  };
  const { priced, pricing } = await priceSubscription(workspaceId, rawForPrice);

  const upcoming: SubscriptionUpcomingOrderView | null = sub.next_billing_date
    ? {
        next_billing_date: sub.next_billing_date,
        projected_total_cents: pricing.total_cents,
      }
    : null;

  return {
    id: sub.id,
    workspace_id: sub.workspace_id,
    customer_id: sub.customer_id,
    shopify_contract_id: sub.shopify_contract_id,
    status: coerceStatus(sub.status),
    is_internal: Boolean(sub.is_internal),
    comp: Boolean(sub.comp),
    billing_interval: sub.billing_interval,
    billing_interval_count: sub.billing_interval_count,
    next_billing_date: sub.next_billing_date,
    last_payment_status: coerceLastPaymentStatus(sub.last_payment_status),
    items: buildLineViews(sub.items, priced),
    pricing: {
      msrp_cents: pricing.msrp_cents,
      subtotal_cents: pricing.subtotal_cents,
      discount_cents: pricing.discount_cents,
      shipping_cents: pricing.shipping_cents,
      protection_cents: pricing.protection_cents,
      tax_cents: null,
      total_cents: pricing.total_cents,
      free_shipping: pricing.free_shipping,
      pills: pricing.pills,
    },
    shipping_address: sub.shipping_address,
    shipping_protection_added: Boolean(sub.shipping_protection_added),
    shipping_protection_amount_cents: sub.shipping_protection_amount_cents ?? 0,
    applied_discounts: Array.isArray(sub.applied_discounts) ? (sub.applied_discounts as Array<Record<string, unknown>>) : [],
    pricing_offer_id: sub.pricing_offer_id,
    payment_method_id: sub.payment_method_id,
    pause_resume_at: sub.pause_resume_at ?? null,
    subscription_created_at: sub.subscription_created_at ?? null,
    avalara_quote_at: sub.avalara_quote_at ?? null,
    latest_order: buildLatestOrder(latest),
    upcoming_order: upcoming,
    created_at: sub.created_at,
    updated_at: sub.updated_at,
  };
}

// ── Display ops ──────────────────────────────────────────────────────

const SUBSCRIPTION_COLUMNS =
  "id, workspace_id, customer_id, shopify_contract_id, status, is_internal, comp, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items, delivery_price_cents, shipping_address, shipping_protection_added, shipping_protection_amount_cents, applied_discounts, pricing_offer_id, payment_method_id, pause_resume_at, subscription_created_at, avalara_quote_at, created_at, updated_at";

/**
 * Resolve a subscription by upstream contract id (Appstle's
 * `shopify_contract_id`, our legacy boundary key), priced for display.
 * Returns `null` when no row matches — callers pick their own error
 * shape.
 *
 * Portal detail routes accept either the internal UUID or the legacy
 * contract id in their URL, and this op is the SDK-side companion to
 * `getSubscription` for the second shape.
 */
export async function getSubscriptionByContractId(
  workspaceId: string,
  contractId: string,
): Promise<SubscriptionView | null> {
  const admin = createAdminClient();
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("shopify_contract_id", contractId)
    .maybeSingle();
  if (error) throw error;
  if (!sub) return null;

  const raw = sub as RawSubscriptionRow;
  const { data: latest } = await admin
    .from("orders")
    .select("id, order_number, financial_status, delivery_status, total_cents, created_at, delivered_at")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", raw.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return buildViewFromRaw(workspaceId, raw, (latest as RawLatestOrder | null) ?? null);
}

/**
 * Fetch one subscription by internal UUID, priced for display.
 * Latest renewal is joined in the same call so a caller can render the "last
 * shipped" chip without a second query.
 * Throws if the sub is missing or not in the given workspace.
 */
export async function getSubscription(workspaceId: string, subId: string): Promise<SubscriptionView> {
  const admin = createAdminClient();
  const { data: sub, error } = await admin
    .from("subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", subId)
    .maybeSingle();
  if (error) throw error;
  if (!sub) throw new Error(`getSubscription: not found — workspace=${workspaceId} sub=${subId}`);

  const { data: latest } = await admin
    .from("orders")
    .select("id, order_number, financial_status, delivery_status, total_cents, created_at, delivered_at")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", subId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return buildViewFromRaw(workspaceId, sub as RawSubscriptionRow, (latest as RawLatestOrder | null) ?? null);
}

/**
 * All subscriptions belonging to one customer, priced for display. Walks past
 * the 1000-row cap via the same cursor pagination as `listSubscriptions`.
 * Note: match is direct on `customer_id` — link-follow (`linkedIds`) is a
 * caller-side concern, not a Display invariant.
 */
export async function listSubscriptionsByCustomer(workspaceId: string, customerId: string): Promise<SubscriptionView[]> {
  return listSubscriptions(workspaceId, { customer_id: customerId });
}

/**
 * List subscriptions for a workspace with cursor-pagination past the 1000-row
 * cap. Backs onto the `commerce_list_subscriptions` RPC — one round trip per
 * page projects sub + latest_order + upcoming_order. Filters map 1:1 to
 * `SubscriptionListFilters`.
 *
 * "No silent truncation" (the goal invariant): the SDK walks until the RPC
 * returns fewer rows than `page_size`. `max_rows` is an optional caller-set
 * ceiling — omit it to walk the whole workspace.
 */
export async function listSubscriptions(
  workspaceId: string,
  filters: SubscriptionListFilters = {},
): Promise<SubscriptionView[]> {
  const admin = createAdminClient();
  const pageSize = Math.max(1, Math.min(1000, filters.page_size ?? 500));
  const maxRows = filters.max_rows ?? Number.POSITIVE_INFINITY;

  const out: SubscriptionView[] = [];
  let cursorUpdatedAt: string | null = null;
  let cursorId: string | null = null;

  while (out.length < maxRows) {
    const { data, error } = await admin.rpc("commerce_list_subscriptions", {
      p_workspace_id: workspaceId,
      p_status: filters.status ?? null,
      p_last_payment_status: filters.last_payment_status ?? null,
      p_is_internal: filters.is_internal ?? null,
      p_comp: filters.comp ?? null,
      p_customer_id: filters.customer_id ?? null,
      p_cursor_updated_at: cursorUpdatedAt,
      p_cursor_id: cursorId,
      p_limit: pageSize,
    });
    if (error) throw error;

    const rows = (data ?? []) as CommerceListRow[];
    if (rows.length === 0) break;

    // Fill in per-sub scalars the RPC's jsonb projection does not carry
    // (pause_resume_at, subscription_created_at, avalara_quote_at). One
    // batched read per page — no per-row round trip.
    const pageIds = rows.map((r) => r.sub.id);
    const extrasMap = new Map<string, { pause_resume_at: string | null; subscription_created_at: string | null; avalara_quote_at: string | null }>();
    if (pageIds.length > 0) {
      const { data: extras, error: extrasErr } = await admin
        .from("subscriptions")
        .select("id, pause_resume_at, subscription_created_at, avalara_quote_at")
        .eq("workspace_id", workspaceId)
        .in("id", pageIds);
      if (extrasErr) throw extrasErr;
      for (const row of (extras ?? []) as Array<{ id: string; pause_resume_at: string | null; subscription_created_at: string | null; avalara_quote_at: string | null }>) {
        extrasMap.set(row.id, {
          pause_resume_at: row.pause_resume_at ?? null,
          subscription_created_at: row.subscription_created_at ?? null,
          avalara_quote_at: row.avalara_quote_at ?? null,
        });
      }
    }

    for (const row of rows) {
      if (out.length >= maxRows) break;
      const extras = extrasMap.get(row.sub.id);
      const subWithExtras: RawSubscriptionRow = {
        ...row.sub,
        pause_resume_at: extras?.pause_resume_at ?? row.sub.pause_resume_at ?? null,
        subscription_created_at: extras?.subscription_created_at ?? row.sub.subscription_created_at ?? null,
        avalara_quote_at: extras?.avalara_quote_at ?? row.sub.avalara_quote_at ?? null,
      };
      const view = await buildViewFromRaw(workspaceId, subWithExtras, row.latest_order);
      out.push(view);
    }

    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1].sub;
    cursorUpdatedAt = last.updated_at;
    cursorId = last.id;
  }

  return out;
}

// ── Mutation ops ─────────────────────────────────────────────────────

type OpResult = { success: boolean; error?: string };

// ── Status: pause / resume / cancel ─────────────────────────────────

export async function subscriptionAction(
  workspaceId: string,
  contractId: string,
  action: "pause" | "cancel" | "resume",
  cancelReason?: string,
  cancelledBy?: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubscriptionAction(workspaceId, contractId, action);
  }
  return appstleSubscriptionAction(workspaceId, contractId, action, cancelReason, cancelledBy);
}

// ── Schedule ────────────────────────────────────────────────────────

export async function subscriptionSkipNextOrder(
  workspaceId: string,
  contractId: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubSkipNextOrder(workspaceId, contractId);
  }
  return appstleSkipNextOrder(workspaceId, contractId);
}

/**
 * Skip the upcoming order — thin re-export of the appstle wrapper.
 * Different from `subscriptionSkipNextOrder` in that the upstream helper
 * targets the top-of-queue upcoming order (Appstle top-orders response)
 * rather than the sub's scheduled next order. Preserves the Appstle
 * internal-* guard.
 */
export async function subscriptionSkipUpcomingOrder(
  workspaceId: string,
  contractId: string,
): Promise<OpResult> {
  return appstleSkipUpcomingOrder(workspaceId, contractId);
}

/**
 * Unskip a previously-skipped billing attempt — thin re-export of the
 * appstle wrapper. Used by the dunning-cycle payday-retry path.
 */
export async function subscriptionUnskipOrder(
  workspaceId: string,
  billingAttemptId: string,
): Promise<OpResult> {
  return appstleUnskipOrder(workspaceId, billingAttemptId);
}

/**
 * Fetch the upcoming-orders list for a subscription — thin re-export of
 * the appstle wrapper. Preserves the JSON-id string coercion at the
 * boundary. Dunning + order-now callers depend on this.
 */
export async function subscriptionGetUpcomingOrders(
  workspaceId: string,
  contractId: string,
): Promise<{
  success: boolean;
  orders?: { id: string; billingDate: string; status: string }[];
  error?: string;
}> {
  return appstleGetUpcomingOrders(workspaceId, contractId);
}

export async function subscriptionUpdateBillingInterval(
  workspaceId: string,
  contractId: string,
  interval: "DAY" | "WEEK" | "MONTH" | "YEAR",
  intervalCount: number,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateBillingInterval(workspaceId, contractId, interval, intervalCount);
  }
  return appstleUpdateBillingInterval(workspaceId, contractId, interval, intervalCount);
}

export async function subscriptionUpdateNextBillingDate(
  workspaceId: string,
  contractId: string,
  nextBillingDate: string,
): Promise<OpResult> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return internalSubUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
  }
  return appstleUpdateNextBillingDate(workspaceId, contractId, nextBillingDate);
}

// ── Payment method ──────────────────────────────────────────────────

export async function subscriptionSwitchPaymentMethod(
  workspaceId: string,
  contractId: string,
  paymentMethodId: string,
): Promise<OpResult> {
  // Internal branch is handled inside appstleSwitchPaymentMethod (Braintree
  // token → customer_payment_methods.is_default flip). Delegate to preserve
  // that path exactly; the wrapper top-guards with healOnTouch on the
  // Appstle branch.
  return appstleSwitchPaymentMethod(workspaceId, contractId, paymentMethodId);
}

export async function subscriptionSendPaymentUpdateEmail(
  workspaceId: string,
  contractId: string,
): Promise<OpResult> {
  return appstleSendPaymentUpdateEmail(workspaceId, contractId);
}

// ── Line items ──────────────────────────────────────────────────────

export async function subscriptionAddItem(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<OpResult> {
  return subAddItem(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionRemoveItem(
  workspaceId: string,
  contractId: string,
  variantOrLine: string | { variantId?: string; lineGid?: string },
): Promise<OpResult & { alreadyAbsent?: boolean }> {
  return subRemoveItem(workspaceId, contractId, variantOrLine);
}

export async function subscriptionChangeQuantity(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number,
): Promise<OpResult> {
  return subChangeQuantity(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionSwapVariant(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
  quantity: number = 1,
): Promise<OpResult & { newLineGid?: string }> {
  return subSwapVariant(workspaceId, contractId, oldVariantId, newVariantId, quantity);
}

export async function subscriptionUpdateLineItemPrice(
  workspaceId: string,
  contractId: string,
  variantId: string,
  basePriceCents: number,
  lineGid?: string,
): Promise<OpResult> {
  return subUpdateLineItemPrice(workspaceId, contractId, variantId, basePriceCents, lineGid);
}

// ── Live-contract helpers (raw-URL wrappers for the AI stack) ────────
//
// action-executor.ts previously reached into the upstream vendor URL
// (subscription-contracts/contract-external + shipping-address PUT)
// directly, which pinned the vendor name into the AI-stack module. We
// wrap those two paths here so the executor can call SDK ops and stay
// vendor-agnostic. The internal-sub branch short-circuits with an
// early return + a synthesized `.lines.nodes` shape mirroring the
// upstream one, so the caller's line-resolution logic stays identical.

/**
 * Fetch the live contract shape from the upstream vendor — used by
 * action-executor.ts's variant-driven remove-item + update-line-item
 * fallbacks that need to resolve a line GID from a variant_id when the
 * local `subscriptions.items` may be stale. Returns the raw
 * `{ lines: { nodes: [...] } }` shape the callers already parse. Bounces
 * on internal contracts with an empty nodes array (internal subs manage
 * lines through the DB, not the vendor).
 */
export async function subscriptionGetLiveContract(
  workspaceId: string,
  contractId: string,
): Promise<{ ok: boolean; error?: string; lines?: { nodes: Array<{ id?: string; variantId?: string; title?: string }> } }> {
  if (await isInternalSubscription(workspaceId, contractId)) {
    return { ok: true, lines: { nodes: [] } };
  }
  const { getAppstleConfig } = await import("@/lib/subscription-items");
  const cfg = await getAppstleConfig(workspaceId);
  if (!cfg) return { ok: false, error: "Subscription vendor not configured" };
  const res = await fetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${contractId}?api_key=${cfg.apiKey}`,
    { headers: { "X-API-Key": cfg.apiKey }, cache: "no-store" },
  );
  if (!res.ok) return { ok: false, error: `Contract fetch failed: ${res.status}` };
  const json = (await res.json()) as { lines?: { nodes?: unknown[] } };
  const nodes = (json.lines?.nodes ?? []) as Array<{ id?: string; variantId?: string; title?: string }>;
  return { ok: true, lines: { nodes } };
}

/**
 * Update the shipping address a subscription bills/ships to. Called by
 * the action-executor's `update_shipping_address` direct-action handler,
 * by the address-change journey completion route, and by any other SDK
 * consumer that changes a customer's address.
 *
 * Both branches write `subscriptions.shipping_address` (the SoT column
 * the internal renewal cron and every dashboard/portal read consumes),
 * but they do OPPOSITE additional work:
 *
 * - **Internal branch:** ONLY writes the column — the row IS the source
 *   of truth its renewal reads. Returns `{ success: false, error }` on a
 *   DB write failure so a caller can tell a dropped write from a
 *   completed one (the exact defect this closes: the prior implementation
 *   returned `{ success: true }` without writing anything).
 * - **Appstle branch:** issues the vendor PUT first (Appstle owns the
 *   contract's fulfillment — without this, the next order ships to the
 *   old address), then mirrors the address onto our column. A local-write
 *   failure AFTER a successful vendor PUT does NOT flip the result to
 *   failure — the customer's address DID change where it ships from —
 *   it's logged loudly instead, the same shape as the compensating-write
 *   rail. The two branches must NEVER be collapsed into a single local
 *   write with no vendor call: that would silently drop every Appstle
 *   address change.
 */
export interface UpdateShippingAddressDeps {
  isInternal(workspaceId: string, contractId: string): Promise<boolean>;
  getVendorApiKey(workspaceId: string): Promise<string | null>;
  vendorFetch(url: string, init: RequestInit): Promise<Response>;
  writeLocal(
    workspaceId: string,
    contractId: string,
    address: ShippingAddressInput,
  ): Promise<{ success: boolean; error?: string }>;
}

/** Real deps for prod. Extracted so tests can inject fakes. */
export function defaultUpdateShippingAddressDeps(): UpdateShippingAddressDeps {
  return {
    isInternal: isInternalSubscription,
    async getVendorApiKey(workspaceId: string) {
      const admin = createAdminClient();
      const { data: ws } = await admin
        .from("workspaces")
        .select("appstle_api_key_encrypted")
        .eq("id", workspaceId)
        .single();
      const enc = (ws as { appstle_api_key_encrypted?: string | null } | null)?.appstle_api_key_encrypted;
      if (!enc) return null;
      const { decrypt } = await import("@/lib/crypto");
      return decrypt(enc);
    },
    async vendorFetch(url, init) {
      const { loggedCommerceFetch } = await import("@/lib/commerce/call-log");
      return loggedCommerceFetch(url, init, "update-shipping-address");
    },
    writeLocal: internalSubUpdateShippingAddress,
  };
}

export async function subscriptionUpdateShippingAddress(
  workspaceId: string,
  contractId: string,
  address: ShippingAddressInput,
  deps: UpdateShippingAddressDeps = defaultUpdateShippingAddressDeps(),
): Promise<OpResult> {
  if (await deps.isInternal(workspaceId, contractId)) {
    const w = await deps.writeLocal(workspaceId, contractId, address);
    if (!w.success) return { success: false, error: w.error };
    return { success: true };
  }
  const apiKey = await deps.getVendorApiKey(workspaceId);
  if (!apiKey) return { success: false, error: "Subscription vendor not configured" };
  const res = await deps.vendorFetch(
    `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-shipping-address?contractId=${contractId}`,
    {
      method: "PUT",
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        address1: address.address1,
        address2: address.address2 || "",
        city: address.city,
        zip: address.zip,
        country: address.country,
        countryCode: address.country,
        province: address.province,
        provinceCode: address.province,
        firstName: address.firstName,
        lastName: address.lastName,
        phone: address.phone,
      }),
    },
  );
  if (!res.ok) {
    // Vendor rejected — do NOT mirror an address the vendor never accepted.
    return { success: false, error: `Vendor ${res.status}` };
  }
  // Vendor accepted → mirror onto our row so every internal reader
  // (dashboard, portal, renewal fallback chain) reflects the current
  // address. A DB failure AFTER a successful vendor PUT does NOT flip
  // the caller's result — the customer's address DID change where it
  // ships from — it's logged loudly instead.
  const local = await deps.writeLocal(workspaceId, contractId, address);
  if (!local.success) {
    console.error(
      `[subscriptionUpdateShippingAddress] Appstle vendor PUT succeeded but local row write failed for contract ${contractId}: ${local.error ?? "unknown"}`,
    );
  }
  return { success: true };
}

// ── Coupons ─────────────────────────────────────────────────────────

/**
 * Apply a coupon to a subscription — internal-aware dispatcher.
 * Delegates to the existing `subscription-items.ts` wrapper which:
 *   - internal subs → resolveCoupon (internal-wins → Shopify fallback) then
 *     internalSubApplyDiscount so we never write an unresolvable code onto
 *     subscriptions.applied_discounts;
 *   - Appstle subs → healOnTouch then applyDiscountWithReplace which enforces
 *     the 1-coupon-per-sub invariant on Appstle's side.
 */
export async function applyCoupon(
  workspaceId: string,
  contractId: string,
  code: string,
): Promise<OpResult> {
  return subscriptionApplyCoupon(workspaceId, contractId, code);
}

/**
 * Remove a coupon from a subscription — internal-aware dispatcher.
 * Delegates to the existing `subscription-items.ts` wrapper.
 */
export async function removeCoupon(
  workspaceId: string,
  contractId: string,
  discountIdOrCode: string,
): Promise<OpResult> {
  return subscriptionRemoveCoupon(workspaceId, contractId, discountIdOrCode);
}

// ── Free / swap product convenience wrappers ────────────────────────

export async function subscriptionAddFreeProduct(
  workspaceId: string,
  contractId: string,
  variantId: string,
  quantity: number = 1,
): Promise<OpResult> {
  return appstleAddFreeProduct(workspaceId, contractId, variantId, quantity);
}

export async function subscriptionSwapProduct(
  workspaceId: string,
  contractId: string,
  oldVariantId: string,
  newVariantId: string,
): Promise<OpResult> {
  return appstleSwapProduct(workspaceId, contractId, oldVariantId, newVariantId);
}

// ── Billing ─────────────────────────────────────────────────────────

/**
 * Immediate billing retry against a specific Appstle billing-attempt id.
 *
 * Preserves the internal-* early return: when the caller passes a synthetic
 * `internal-<contract>` id (stamped by dunning on internal subs), the Appstle
 * PUT is skipped and success is returned — the real renewal is driven by
 * the internal daily renewal cron. See docs/brain/libraries/appstle.md § Gotchas
 * (signature vercel:cdfbac68e30a91f9).
 */
export async function subscriptionAttemptBilling(
  workspaceId: string,
  billingAttemptId: string,
): Promise<OpResult> {
  return appstleAttemptBilling(workspaceId, billingAttemptId);
}

/**
 * Flavor-aware "order now" (bill_now) for a sub identified by contract id.
 *
 * Preserves the Angel-precedent Braintree-vs-Appstle branch: internal subs
 * fire the `internal-subscription/renewal-attempt` Inngest event (async
 * Braintree charge → order → Avalara → advance next_billing_date); Appstle
 * subs go through get-upcoming → attempt-billing. See
 * docs/brain/libraries/appstle.md § orderNowByContract + § Gotchas.
 */
export async function subscriptionOrderNow(
  workspaceId: string,
  contractId: string,
): Promise<OpResult & { summary?: string; internal?: boolean }> {
  return orderNowByContract(workspaceId, contractId);
}

// ── Create ─────────────────────────────────────────────────────────

/** Item shape accepted by `createSubscription`. `variant_id` is the internal
 *  UUID (Shopify is being sunset — see [[../../CLAUDE]] § Local conventions). */
export interface CreateSubscriptionItem {
  variant_id: string;
  product_id?: string | null;
  title?: string;
  variant_title?: string | null;
  sku?: string | null;
  quantity?: number;
  is_gift?: boolean;
  price_override_cents?: number | null;
}

export interface CreateSubscriptionInput {
  vendor: "internal" | "appstle";
  customer_id: string;
  items: CreateSubscriptionItem[];
  billing_interval: "day" | "week" | "month" | "year";
  billing_interval_count: number;
  /** ISO-8601 date/datetime for the first renewal. Required. */
  next_billing_date: string;
  status?: "active" | "paused" | "cancelled";
  is_internal?: boolean;
  comp?: boolean;
  shipping_address?: Record<string, unknown> | null;
  delivery_price_cents?: number;
  shipping_protection_added?: boolean;
  shipping_protection_amount_cents?: number;
  applied_discounts?: Array<Record<string, unknown>>;
  payment_method_id?: string | null;
  /** Optional contract id for the internal branch — defaults to
   *  `internal-${uuid}` at insert time when omitted. */
  shopify_contract_id?: string | null;
}

export interface CreateSubscriptionResult {
  success: boolean;
  error?: string;
  subscription_id?: string;
  shopify_contract_id?: string | null;
}

/**
 * Pure: turn a `CreateSubscriptionInput` into the `subscriptions`-row shape.
 * Extracted so the shape (defaults, item normalization, next_billing_date
 * coercion) can be pinned in `node:test` without standing up a Supabase
 * client. Mirrors `commerce/order.buildCreateOrderRow`.
 */
export function buildCreateSubscriptionRow(
  workspaceId: string,
  input: CreateSubscriptionInput,
  opts: { shopify_contract_id?: string } = {},
): Record<string, unknown> {
  const items = input.items.map((it) => ({
    line_id: String(it.variant_id),
    variant_id: String(it.variant_id),
    product_id: it.product_id ?? null,
    title: it.title ?? "",
    variant_title: it.variant_title ?? null,
    sku: it.sku ?? null,
    quantity: Number(it.quantity ?? 1),
    is_gift: Boolean(it.is_gift),
    price_override_cents: it.price_override_cents ?? null,
  }));

  const iso = /^\d{4}-\d{2}-\d{2}$/.test(input.next_billing_date)
    ? new Date(`${input.next_billing_date}T00:00:00Z`).toISOString()
    : new Date(input.next_billing_date).toISOString();

  return {
    workspace_id: workspaceId,
    customer_id: input.customer_id,
    shopify_contract_id: opts.shopify_contract_id ?? input.shopify_contract_id ?? null,
    status: input.status ?? "active",
    is_internal: input.is_internal ?? (input.vendor === "internal"),
    comp: Boolean(input.comp),
    billing_interval: input.billing_interval,
    billing_interval_count: input.billing_interval_count,
    next_billing_date: iso,
    items,
    delivery_price_cents: input.delivery_price_cents ?? 0,
    shipping_address: input.shipping_address ?? null,
    shipping_protection_added: Boolean(input.shipping_protection_added),
    shipping_protection_amount_cents: input.shipping_protection_amount_cents ?? null,
    applied_discounts: input.applied_discounts ?? [],
    subscription_created_at: new Date().toISOString(),
  };
}

/**
 * Create a fresh subscription — internal-aware dispatcher. Mirrors the
 * appstle-vs-internal branch shape used by [[./subscription]]'s other
 * mutation ops:
 *
 *  - `vendor: 'internal'` → inserts a `subscriptions` row with
 *    `is_internal=true`, `status='active'` (default), and
 *    `next_billing_date` populated. No upstream (Appstle) round trip —
 *    internal subs are managed entirely by shopcx (see
 *    [[../internal-subscription]]).
 *  - `vendor: 'appstle'` → currently unsupported; the compiler-loop
 *    primitive only ships the internal path in Phase 1.
 *
 * Returns `{ success, subscription_id, shopify_contract_id }` on success and
 * `{ success: false, error }` on any failure.
 */
export async function createSubscription(
  workspaceId: string,
  input: CreateSubscriptionInput,
): Promise<CreateSubscriptionResult> {
  const admin = createAdminClient();

  if (input.vendor === "internal") {
    const row = buildCreateSubscriptionRow(workspaceId, input);
    const { data, error } = await admin
      .from("subscriptions")
      .insert(row)
      .select("id, shopify_contract_id")
      .single();
    if (error) return { success: false, error: error.message };
    const inserted = data as { id: string; shopify_contract_id: string | null };
    if (!inserted.shopify_contract_id) {
      const synth = `internal-${inserted.id}`;
      await admin
        .from("subscriptions")
        .update({ shopify_contract_id: synth })
        .eq("id", inserted.id);
      return { success: true, subscription_id: inserted.id, shopify_contract_id: synth };
    }
    return {
      success: true,
      subscription_id: inserted.id,
      shopify_contract_id: inserted.shopify_contract_id,
    };
  }

  if (input.vendor === "appstle") {
    return {
      success: false,
      error:
        "createSubscription: vendor 'appstle' not supported in Phase 1 — internal subs only",
    };
  }

  return {
    success: false,
    error: `createSubscription: unknown vendor '${input.vendor as string}'`,
  };
}
