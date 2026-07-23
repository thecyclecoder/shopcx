/**
 * Portal mutation guards.
 *
 * Two independent guards live here — every subscription-mutating portal route
 * runs the first through the dispatcher (`MUTATION_GATED_ROUTES`); replace-
 * variants runs both.
 *
 *   1. First-delivery gate (`canMutateSubscription`) — every mutation blocked
 *      until the sub's first order is delivered (anti-gaming).
 *   2. Suppressed-variant gate (`assertNewVariantsSelectable`) — a specific
 *      variant that is IN STOCK but NOT selectable for new portal choice
 *      (crisis availability lever — we're pulling that variant off the portal
 *      to preserve inventory for existing renewers). Existing sub lines on
 *      that variant are UNAFFECTED; only NEW selection is blocked. See
 *      [[docs/brain/libraries/portal__mutation-guard]].
 *
 * First-delivery gate details follow.
 *
 * First-delivery mutation gate.
 *
 * Customers can't modify a subscription (swap / qty / add / remove / change
 * date / frequency / pause / coupon / shipping protection) until the FIRST
 * order from that subscription has been delivered. This blocks "subscribe for
 * the intro deal, then immediately swap to something pricier / change the
 * schedule before the first box even ships."
 *
 * Renewal short-circuit: once a subscription has produced more than one order,
 * the first-order delivery question is moot — a second order only exists because
 * the first billing cycle already completed. So >1 order = past first delivery
 * = allowed. This is the fix for sub 2575ff54 (26 orders, migrated, is_internal
 * = true, SC-numbered Shopify orders) which used to fall through to the
 * EasyPost branch forever and never resolve.
 *
 * Delivery signal for the single-order case is determined by the ORDER, not the
 * subscription's is_internal flag (migrated subs carry is_internal=true even
 * though their orders are SC-numbered Shopify orders — keying on the sub flag
 * sent them down the wrong branch). The order-level signal:
 *   - shopify_order_id IS NULL → internal (Amplifier-fulfilled): we don't buy
 *     the EasyPost label so we never get a delivered webhook. If a tracking
 *     number exists we do a LIVE EasyPost lookup on portal visit (throttled,
 *     cached back onto the order). If no tracking number yet, the sub stays
 *     locked ONLY until the universal setup-grace age gate trips (below).
 *   - shopify_order_id present → Shopify: the order's `fulfillment_status` is
 *     the delivery proxy. "fulfilled" = shipped/delivered enough for the gate.
 *
 * Universal escape hatch: regardless of branch, a first order older than
 * SETUP_GRACE_MS (5 days) unlocks the subscription unconditionally. Internal
 * orders routinely carry no tracking number AND no fulfillment_status (some are
 * never imported to Amplifier at all), so without an age-only gate they'd stay
 * trapped in the "being set up" banner forever. (CEO 2026-07-23.)
 *
 * Fails OPEN (allows the mutation) on an EasyPost error — this is an
 * anti-gaming gate, not a security control, and we never want an API hiccup to
 * trap a legitimate customer whose order really did arrive.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Every portal subscription-mutating route that is BLOCKED while the gate holds
 * (canMutateSubscription → allowed=false). The dispatcher lowercases `route`
 * before the gate check (src/app/api/portal/route.ts:119), so every key here is
 * lowercase; we include both the concatenated (camelCase-lowered) and the
 * underscored variant so a client sending either lands the gate.
 *
 * Phase 2 expansion: the gate now covers EVERY subscription-touching action —
 * not just content/schedule/discount. During the first-delivery window the
 * subscription is truly read-only: no cancel, no pause/resume/reactivate, no
 * order-now, no payment-method change, no address change, no cancel-journey
 * transition. Any exception lets a customer bypass the anti-gaming intent
 * (e.g. cancel-then-repurchase to re-hit the intro deal, or pause+resume to
 * reset the schedule).
 */
export const MUTATION_GATED_ROUTES = new Set([
  // Content / schedule / discount (Phase 1 set).
  "replacevariants", "replace_variants",
  "removelineitem", "remove_line_item",
  "coupon",
  "frequency",
  "changedate", "change_date",
  "shippingprotection", "shipping_protection",
  "loyaltyapplytosubscription", "loyalty_apply_to_subscription",
  // Lifecycle (Phase 2).
  "cancel",
  "pause",
  "resume",
  "reactivate",
  "canceljourney", "cancel_journey",
  // Order-now (Phase 2) — pulling forward the next box skips the first-delivery observation window.
  "ordernow", "order_now",
  // Payment method (Phase 2) — mutating card details on a not-yet-delivered sub is a common attack shape.
  "updatepaymentmethod", "update_payment_method",
  "setsubscriptionpaymentmethod", "set_subscription_payment_method",
  // Address (Phase 2) — pre-delivery address changes are a fraud/mis-ship risk.
  "address",
]);

/** Don't re-hit EasyPost more than once per this window per order. */
const LOOKUP_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Universal setup-grace escape hatch. A first order older than this is past the
 * anti-gaming window UNCONDITIONALLY — no fulfillment_status, no tracking number,
 * no delivered webhook required. Internal (Amplifier) orders routinely have NONE
 * of those signals (SHOPCX-numbered orders that never imported to Amplifier carry
 * empty `fulfillments[]`, null `amplifier_*`, null `fulfillment_status`), which
 * used to trap the subscription in the "being set up" banner forever. 5 days ⇒
 * unlocked, no matter the fulfillment signal. (CEO 2026-07-23.)
 */
const SETUP_GRACE_MS = 5 * 24 * 60 * 60 * 1000;

export interface MutationGate {
  allowed: boolean;
  reason?: string;
  /** Coarse state for the UI: 'no_order' | 'not_shipped' | 'in_transit' | 'delivered'. */
  state?: string;
}

const DELIVERED_MESSAGE = "You'll be able to make changes to this subscription once your first order has been delivered.";
const NO_ORDER_REASON = "Your subscription is being set up. " + DELIVERED_MESSAGE;
const NOT_SHIPPED_REASON = "Your first order hasn't shipped yet. " + DELIVERED_MESSAGE;
const IN_TRANSIT_REASON = "Your first order is on its way. " + DELIVERED_MESSAGE;

/** The order-level fields the gate decision looks at. */
export interface GateOrder {
  id: string;
  created_at: string;
  fulfillment_status: string | null;
  delivered_at: string | null;
  easypost_status: string | null;
  easypost_checked_at: string | null;
  amplifier_tracking_number: string | null;
  amplifier_carrier: string | null;
  shopify_order_id: string | null;
}

/**
 * Pure decision — the outer function does the DB read + optional EasyPost lookup
 * side effect. Split so the three-branch predicate (renewal short-circuit,
 * order-level shopify_order_id-null branch, 7-day grace) is unit-testable
 * without touching Supabase.
 */
export type GateDecision =
  | { kind: "allow"; state: "delivered" }
  | { kind: "deny"; state: "no_order" | "not_shipped" | "in_transit"; reason: string }
  | { kind: "easypost_lookup"; tracking: string; carrier: string | null; order: GateOrder };

const FULFILLED_STATUSES = new Set(["fulfilled", "delivered", "partial", "partially_fulfilled"]);

export function decideMutationGate(
  first: GateOrder | undefined,
  orderCount: number,
  now: number,
): GateDecision {
  if (!first) {
    return { kind: "deny", state: "no_order", reason: NO_ORDER_REASON };
  }

  // (a) Renewal short-circuit — a second order only exists because the first
  // billing cycle already completed. Past first delivery ⇒ allowed. Banner off.
  if (orderCount > 1) {
    return { kind: "allow", state: "delivered" };
  }

  // Already known delivered → allow (cheap path, no API call).
  if (first.delivered_at || String(first.easypost_status || "").toLowerCase() === "delivered") {
    return { kind: "allow", state: "delivered" };
  }

  // (b) Universal setup-grace escape hatch — a first order older than
  // SETUP_GRACE_MS is past the anti-gaming window no matter its fulfillment
  // signal. This runs BEFORE the tracking/fulfillment branches on purpose: an
  // internal order can have NO tracking number, NO fulfillment_status, and no
  // Amplifier import at all (e.g. SHOPCX74 — never imported to Amplifier), which
  // otherwise leaves the sub locked in the "being set up" banner indefinitely.
  // 5 days ⇒ unlocked, full stop. (CEO 2026-07-23.)
  const firstAgeMs = now - new Date(first.created_at).getTime();
  if (firstAgeMs > SETUP_GRACE_MS) {
    return { kind: "allow", state: "delivered" };
  }

  // Within the setup window — use the best delivery signal we have.
  // Branch on the ORDER, not the subscription. shopify_order_id-null = internal.
  const isInternalOrder = first.shopify_order_id == null;

  if (isInternalOrder) {
    const tracking = first.amplifier_tracking_number;
    if (tracking) {
      // Throttle: if we looked it up recently and it wasn't delivered, trust the
      // stored status rather than hitting EasyPost again this visit.
      const checkedAt = first.easypost_checked_at ? new Date(first.easypost_checked_at).getTime() : 0;
      if (checkedAt && now - checkedAt < LOOKUP_THROTTLE_MS) {
        return { kind: "deny", state: "in_transit", reason: IN_TRANSIT_REASON };
      }
      return { kind: "easypost_lookup", tracking, carrier: first.amplifier_carrier, order: first };
    }
    // No tracking yet and still inside the setup window → not shipped.
    return { kind: "deny", state: "not_shipped", reason: NOT_SHIPPED_REASON };
  }

  // Shopify path — fulfillment status is the best delivery proxy we have.
  const ff = String(first.fulfillment_status || "").toLowerCase();
  if (FULFILLED_STATUSES.has(ff)) {
    return { kind: "allow", state: "delivered" };
  }
  return { kind: "deny", state: "not_shipped", reason: NOT_SHIPPED_REASON };
}

export async function canMutateSubscription(
  workspaceId: string,
  sub: { id: string; is_internal?: boolean | null },
): Promise<MutationGate> {
  const admin = createAdminClient();

  // Fetch the two OLDEST orders — one is enough for the delivery branches,
  // but a second row is the renewal-short-circuit signal (a sub with ≥2 orders
  // is past first delivery, no matter what the first order's state looks like).
  const { data: orders } = await admin
    .from("orders")
    .select("id, created_at, fulfillment_status, delivered_at, easypost_status, easypost_checked_at, amplifier_tracking_number, amplifier_carrier, shopify_order_id")
    .eq("workspace_id", workspaceId)
    .eq("subscription_id", sub.id)
    .order("created_at", { ascending: true })
    .limit(2);

  const first = (orders?.[0] as GateOrder | undefined) ?? undefined;
  const orderCount = orders?.length ?? 0;

  const decision = decideMutationGate(first, orderCount, Date.now());

  if (decision.kind === "allow") return { allowed: true, state: decision.state };
  if (decision.kind === "deny") return { allowed: false, state: decision.state, reason: decision.reason };

  // easypost_lookup — live check, then cache the result onto the order.
  try {
    const { lookupTracking } = await import("@/lib/easypost");
    const t = await lookupTracking(workspaceId, decision.tracking, decision.carrier || undefined);
    const status = String(t.status || "").toLowerCase();
    if (status === "delivered") {
      await admin.from("orders")
        .update({ easypost_status: status, delivered_at: new Date().toISOString(), easypost_checked_at: new Date().toISOString() })
        .eq("id", decision.order.id);
      return { allowed: true, state: "delivered" };
    }
    await admin.from("orders")
      .update({ easypost_status: status, easypost_checked_at: new Date().toISOString() })
      .eq("id", decision.order.id);
    return { allowed: false, state: "in_transit", reason: IN_TRANSIT_REASON };
  } catch (e) {
    // Fail open — don't trap a legit customer on an EasyPost hiccup.
    console.warn("[mutation-guard] EasyPost lookup failed, allowing:", e instanceof Error ? e.message : e);
    return { allowed: true, state: "delivered" };
  }
}

// ─────────────────── Suppressed-variant guard ───────────────────
//
// A crisis availability lever: a variant that is IN STOCK but must not be
// selectable via any portal flavor-change / swap / add-line path. The
// `inventory_quantity > 0` UI filter can't hide it, and Shopify admin
// deactivation would break renewals billed against that variant — so the list
// lives in `workspaces.portal_config.suppressed_variant_ids` (JSONB array of
// Shopify variant id strings) and every portal path that could newly SELECT
// a variant reads it: [[handlers/bootstrap]] filters the catalog it returns
// to the UI, and [[handlers/replace-variants]] server-side rejects a crafted
// request naming a suppressed variant so hiding-in-the-UI isn't the only bar.
//
// HARD INVARIANT: this ONLY blocks new selection. Existing subscription lines
// already on a suppressed variant are unchanged; their renewals still bill
// against that variant. Callers must not use this set to filter subscription
// LINES (`contract.lines`) — only NEW `newVariants` / `newOneTimeVariants`
// choices and the catalog surfaced for add/swap.

/** Strip a `gid://shopify/ProductVariant/123` prefix down to `123`. */
function stripGid(v: string): string {
  return v.includes("/") ? (v.split("/").pop() || v) : v;
}

/**
 * Pure predicate — given the variant IDs a caller is about to select and the
 * per-workspace suppressed set, return the offending IDs. Extracted from the
 * async guard so the failing state ("SC-TABS-SL-2 / 42614433480877 is
 * rejected") is unit-testable without touching Supabase.
 */
export function findSuppressedNewVariants(
  variantIds: Array<string | number>,
  suppressed: Set<string>,
): string[] {
  if (!suppressed.size) return [];
  const out: string[] = [];
  for (const raw of variantIds) {
    const id = stripGid(String(raw ?? "").trim());
    if (id && suppressed.has(id)) out.push(id);
  }
  return out;
}

/**
 * Read the workspace's suppressed-variant set. Consumed by
 * [[handlers/bootstrap]] to filter the swap/add catalog it returns to the
 * portal UI, and by [[handlers/replace-variants]] via
 * `assertNewVariantsSelectable`.
 */
export async function getSuppressedVariantIds(workspaceId: string): Promise<Set<string>> {
  const admin = createAdminClient();
  const { data: ws } = await admin
    .from("workspaces")
    .select("portal_config")
    .eq("id", workspaceId)
    .single();
  const cfg = (ws?.portal_config as { suppressed_variant_ids?: unknown } | null) || null;
  const raw = Array.isArray(cfg?.suppressed_variant_ids) ? cfg.suppressed_variant_ids : [];
  const out = new Set<string>();
  for (const v of raw) {
    const s = stripGid(String(v ?? "").trim());
    if (s) out.add(s);
  }
  return out;
}

/**
 * Server-side gate for `replaceVariants` / add-line: reject a request that
 * targets any suppressed variant, no matter what the UI showed. Returns
 * `{ ok: true }` when nothing was blocked (including the fast-path where no
 * suppression list is configured), or `{ ok: false, blocked }` naming the
 * offending variant ids so the caller can surface a stable 4xx.
 */
export async function assertNewVariantsSelectable(
  workspaceId: string,
  variantIds: Array<string | number>,
): Promise<{ ok: true } | { ok: false; blocked: string[] }> {
  if (!variantIds.length) return { ok: true };
  const suppressed = await getSuppressedVariantIds(workspaceId);
  const blocked = findSuppressedNewVariants(variantIds, suppressed);
  return blocked.length ? { ok: false, blocked } : { ok: true };
}
