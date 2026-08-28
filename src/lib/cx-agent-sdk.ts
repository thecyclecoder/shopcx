/**
 * cx-agent-sdk — deterministic READ-ONLY CX data SDK for the three box CX agents
 * (Sol / Cora / June). Phase 1 of docs/brain/specs/cx-box-agents-sol-cora-june-
 * deterministic-sdk-toolset-and-brain-access-no-raw-sql.md.
 *
 * The CX box sessions were improvising raw DB queries and missing the right columns —
 * a playbook lookup that turned up empty because chosen_path=playbook got no slug is
 * the derived-from ticket. This SDK gives all three the SAME typed, deterministic
 * read-only surface so their data access is correct by construction, not a guess:
 *
 *   getCxCustomer       — customer + merged identity (all linked customer_ids in the
 *                         same group_id) + primary profile
 *   getCxOrders         — recent orders w/ line items (quantity, charged line total,
 *                         computed per-unit, variant title, subscription_id) — the
 *                         merged-identity fan-out is already applied.
 *   getCxSubscriptions  — subs w/ configured line price_cents / price_override_cents,
 *                         applied_discounts, status, next_billing_date — the merged-
 *                         identity fan-out is already applied.
 *   getCxProducts       — the workspace's active product catalog (variants/flavors/
 *                         pricing) so a variant_title / per-unit compare is deterministic.
 *   getCxPolicies       — the workspace's active `sonnet_prompts` rules the orchestrator
 *                         reads every turn — same source loadLiveRules uses.
 *   getCxBundle         — one Promise.all composing all five.
 *   formatCxBundle      — plain-text snapshot the three prompts embed at the top of
 *                         the prepared bundle so the agents START with the right shape.
 *
 * NEVER mutates. The box sessions call this SDK through scripts/cx-agent-sdk-tool.ts;
 * the deterministic worker (scripts/builder-worker.ts) remains the only mutator via
 * the agents' typed JSON verdicts (writeDirection / applyAnalyzerVerdict / the CS-
 * Director-call executor).
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { linkGroupIds } from "@/lib/customer-links";
import { getAmplifierOnHandBySku } from "@/lib/inventory/read";
import { suggestEmailCorrection } from "@/lib/email-typo";
import { getOrderRefundLedger, type OrderRefundLedger } from "@/lib/refund-ledger";

type Admin = ReturnType<typeof createAdminClient>;

// ── Shapes ────────────────────────────────────────────────────────────────────

export interface CxCustomer {
  /** The primary customer_id passed in. */
  customer_id: string;
  /** All customer_ids in the same link group (linked accounts are one human). */
  linked_customer_ids: string[];
  /** Primary profile — the customer row for the passed customer_id. */
  profile: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    subscription_status: string | null;
    retention_score: number | null;
    email_marketing_status: string | null;
    sms_marketing_status: string | null;
    shopify_customer_id: string | null;
  } | null;
}

export interface CxOrderLine {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  /** The actual per-unit price the customer was charged (line total ÷ qty). */
  per_unit_cents: number;
  /** The line total the customer was charged. */
  line_total_cents: number;
  sku: string | null;
}

export interface CxOrder {
  order_number: string | null;
  shopify_order_id: string | null;
  total_cents: number;
  financial_status: string | null;
  created_at: string;
  source_name: string | null;
  subscription_id: string | null;
  line_items: CxOrderLine[];
}

export interface CxSubscriptionItem {
  title: string;
  variant_id: string | null;
  variant_title: string | null;
  quantity: number;
  /** Configured line price (Shopify contracts). */
  price_cents: number | null;
  /** Configured line override (internal contracts store realized price here). */
  price_override_cents: number | null;
  /** The realized cents per unit — price_cents ?? price_override_cents ?? 0. */
  realized_cents: number;
}

export interface CxSubscriptionDiscount {
  id: string | null;
  title: string | null;
  type: string | null;
  value: number | null;
  value_type: string | null;
}

export interface CxSubscription {
  id: string;
  customer_id: string;
  shopify_contract_id: string | null;
  status: string;
  billing_interval: string | null;
  billing_interval_count: number | null;
  next_billing_date: string | null;
  created_at: string;
  items: CxSubscriptionItem[];
  applied_discounts: CxSubscriptionDiscount[];
}

export interface CxProductVariant {
  id: string;
  title: string | null;
  price_cents: number | null;
  /** 3PL SKU this variant ships as — the join key for ship truth. */
  sku: string | null;
  /**
   * ⭐ SHIP TRUTH — units the 3PL physically holds for this variant's SKU, from canonical
   * `inventory_levels` (location='amplifier_3pl'). NULL means we have no 3PL row for the SKU and
   * therefore cannot vouch for it — treat NULL as unknown, never as "in stock".
   *
   * This exists because the SDK previously reported every active variant with a price and NO stock
   * signal at all, so an agent reading it could not tell a shippable flavor from a dead one. On
   * 2026-08-28 Sol promised a customer Strawberry Lemonade off this list while the 3PL held zero
   * (ticket 0c9f11a7); the order could not include it and she was billed anyway.
   */
  on_hand: number | null;
  /** Convenience: `on_hand > 0`. NULL when on_hand is unknown — callers must not coerce it to true. */
  in_stock: boolean | null;
}

export interface CxProduct {
  id: string;
  title: string | null;
  handle: string | null;
  status: string | null;
  variants: CxProductVariant[];
}

export interface CxPolicy {
  category: string;
  title: string;
  content: string;
}

export interface CxBundle {
  workspace_id: string;
  customer_id: string | null;
  customer: CxCustomer | null;
  orders: CxOrder[];
  subscriptions: CxSubscription[];
  products: CxProduct[];
  policies: CxPolicy[];
}

// ── Actionable outcomes catalog (Phase 1 of sol-dispatch-matches-journey-playbook-workflow) ───

/**
 * A journey the workspace has ACTIVE that matches a resolved intent. Sol names the slug on the
 * Direction (`plan.journey_slug` — see [[../libraries/ticket-directions]]) so Phase 2's cheap-
 * execution turn can APPLY it via `launchJourneyForTicket` — never a freeform "click below" reply.
 */
export interface CxActionableJourney {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger_intent: string;
  channels: string[];
  priority: number;
}

/**
 * A playbook the workspace has ACTIVE that matches a resolved intent. Sol names the slug on the
 * Direction (`plan.playbook_slug` — see [[../libraries/ticket-directions]]) so Phase 2's cheap-
 * execution turn can start it via `startPlaybook` / `executePlaybookStep`.
 */
export interface CxActionablePlaybook {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  trigger_intents: string[];
  priority: number;
}

/**
 * A workflow the workspace has ENABLED whose `trigger_tag` matches the resolved intent. Rendered
 * to Sol so a workflow-shaped intent (order_tracking / cancel_request / …) surfaces alongside
 * the journey + playbook catalog.
 */
export interface CxActionableWorkflow {
  id: string;
  name: string;
  template: string;
  trigger_tag: string;
  channels: string[];
}

/**
 * The full deterministic catalog of matched mechanisms for one intent in one workspace — the
 * shape `listActionableOutcomes` returns. An empty catalog (no matches on any of the three
 * axes) is Sol's signal that the correct Direction is `chosen_path='stateless'` (an AI reply);
 * a non-empty catalog is Sol's signal to name a specific `journey_slug` / `playbook_slug` on
 * the Direction so the mechanism is APPLIED, not merely described.
 */
export interface CxActionableOutcomes {
  workspace_id: string;
  intent: string;
  channel: string | null;
  journeys: CxActionableJourney[];
  playbooks: CxActionablePlaybook[];
  workflows: CxActionableWorkflow[];
}

// ── Live remedy state for a single order (Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first) ──

/**
 * One `returns` row surfaced to a money-remedy proposer / executor guard. Focused on the fields
 * that decide whether a NEW money remedy would double-pay an already-committed refund path:
 *
 *  - `status` — `open` / `label_created` / `in_transit` / `delivered` / `refunded` / `cancelled` / `closed`
 *    (per [[../tables/returns]]). Anything with `refunded_at IS NULL` AND `status != 'cancelled'` is
 *    LIVE — the return refund is either pending EasyPost delivery or already fired but pending
 *    reconciliation; either way a fresh money remedy on the same order would be a second payout.
 *  - `refunded_at` — the terminal timestamp on a return that already paid out. NULL == live.
 *  - `net_refund_cents` — the amount the return will refund on receipt (the [[../tables/returns]]
 *    contract; the ledger caps it downward at fire time but never raises it).
 *  - `resolution_type` — `refund_return` / `store_credit_return` / `refund_no_return` / `store_credit_no_return`.
 *    A store-credit resolution moves no money on the CARD side but still commits value.
 */
export interface CxRemedyReturnRow {
  id: string;
  status: string;
  resolution_type: string | null;
  net_refund_cents: number;
  label_cost_cents: number;
  refunded_at: string | null;
  delivered_at: string | null;
  shipped_at: string | null;
  created_at: string;
  refund_id: string | null;
  tracking_number: string | null;
}

/**
 * One `order_refunds` mirror row for a succeeded/settled refund on the order. Written by the
 * refund chokepoint at [[../libraries/refund]] `refundOrder` (see [[../tables/order_refunds]]).
 * We surface only the fields a proposer / guard needs to reason about remaining refundable value.
 */
export interface CxRemedyRefundRow {
  id: string;
  vendor: string;
  vendor_refund_id: string | null;
  amount_cents: number;
  status: string;
  requested_at: string;
}

/**
 * The live remedy state of a SINGLE order. Read-only snapshot the CS Director's proposer + the
 * executor's hard-reject guard both consume — the WHOLE point (spec:
 * a-money-remedy-must-read-the-live-remedy-state-first Phase 1) is that a money remedy proposer
 * MUST see this before proposing a refund. Ticket 86043da0 (Jan Bloom): SC135494 $182.95 order,
 * $15 already refunded, a live `returns` row with `refunded_at IS NULL` and
 * `net_refund_cents=18295` — a proposal for another $167.95 refund would have double-paid the
 * whole order.
 */
export interface CxOrderRemedyState {
  /** True when we resolved a row in `orders`. Everything else is null-safe on `found=false`. */
  found: boolean;
  workspace_id: string;
  order_id: string | null;
  order_number: string | null;
  shopify_order_id: string | null;
  financial_status: string | null;
  total_cents: number;
  /**
   * Total refunds actually settled on the order. When `headroom_confidence='live'` this is the
   * Shopify-transaction ledger's `refundedCents` (mirrored + out-of-band). When the live ledger
   * can't be read (`headroom_confidence='degraded'`) it falls back to the sum of
   * `order_refunds.amount_cents` where `status IN ('succeeded','settled')` — accurate for our own
   * refunds but blind to money moved directly in the Shopify admin.
   */
  refunds_succeeded_cents: number;
  /**
   * The CEILING for any NEW money remedy on this order — a partial_refund whose `amount_cents`
   * exceeds this is a double-pay. When `headroom_confidence='live'` this is the ledger's
   * `refundableCents` (`max(0, sale - refunded - pending)`, so an out-of-band refund lowers it
   * correctly). When `headroom_confidence='degraded'` this is the mirror fallback
   * `total_cents - refunds_succeeded_cents` (floored at 0) — the caller MUST refuse a money
   * decision rather than trust the number, per the spec's "refund guard that cannot verify
   * headroom must refuse" rule.
   */
  remaining_refundable_cents: number;
  /**
   * Sum of settled Shopify refunds NOT reconciled to a row in `public.order_refunds` — money
   * moved outside ShopCX (a manual refund in the Shopify admin, an Appstle-side refund, etc.).
   * `> 0` explains WHY `remaining_refundable_cents` is lower than the mirror-only math implies;
   * this is the exact signal that would have prevented the SC126000 double-refund proposal on
   * ticket dac9f0c7 (yvette jong, 2026-08-24). Zero when the live ledger reads clean OR when the
   * ledger call failed and we're in `headroom_confidence='degraded'` fallback (we don't invent an
   * out-of-band figure we couldn't read).
   */
  out_of_band_refunds_cents: number;
  /**
   * How much to trust `refunds_succeeded_cents` + `remaining_refundable_cents`:
   *  - `"live"`   — computed from the Shopify transactions ledger (`getOrderRefundLedger`); the
   *                 numbers include out-of-band refunds and are the true headroom right now.
   *  - `"degraded"` — the ledger call failed (Shopify down, non-Shopify order, missing
   *                   shopify_order_id) OR no order was resolved. The numbers reflect only what
   *                   `public.order_refunds` mirrors, so an out-of-band refund is invisible and
   *                   headroom is potentially OVERSTATED. A refund guard that cannot verify
   *                   headroom must REFUSE, never assume — this is the marker to check first.
   */
  headroom_confidence: "live" | "degraded";
  /**
   * The `order_refunds` mirror rows kept for provenance. When `headroom_confidence='live'` these
   * are no longer the source of the totals (the ledger is) — they explain WHICH of the settled
   * refunds ShopCX itself issued, so `refunded_so_far - sum(succeeded_refunds) === out_of_band`.
   */
  succeeded_refunds: CxRemedyRefundRow[];
  /** Every non-cancelled return on the order, most-recent-first. */
  returns: CxRemedyReturnRow[];
  /**
   * The subset of `returns` that are LIVE — the return refund has not fired yet and the return is
   * not cancelled. `refunded_at IS NULL` AND `status != 'cancelled'`. A money remedy proposer that
   * finds ANY live open return on the target order must ACCOUNT for it — the refund pipeline will
   * fire the return's refund on EasyPost delivery, and a separate proposer refund is a double-pay.
   */
  open_returns: CxRemedyReturnRow[];
}

/** Reference the caller passes to identify the order — any one of the three columns resolves it. */
export interface CxOrderRemedyStateRef {
  orderId?: string | null;
  shopifyOrderId?: string | null;
  orderNumber?: string | null;
}

const REMEDY_STATE_TERMINAL_REFUND_STATUSES = new Set(["succeeded", "settled"]);
const REMEDY_STATE_LIVE_RETURN_EXCLUDED_STATUSES = new Set(["cancelled"]);

/**
 * Live remedy state for a single order. Reads-only from [[../tables/orders]] + [[../tables/returns]]
 * + [[../tables/order_refunds]]; scoped to the workspace on every query (learning #6 — workspace
 * scope is re-asserted on every read, not inferred). A missing order returns `found:false` with
 * empty arrays so a caller can't mistake it for "clean state" — the guard MUST fail-safe.
 *
 * Resolution: the caller can pass any of `orderId` (internal `orders.id` UUID),
 * `shopifyOrderId`, or `orderNumber`. We try the most-specific first (orderId → shopifyOrderId
 * → orderNumber) so the executor's `partial_refund` handler (which resolves the internal UUID
 * up-front) can pass `orderId` and skip a second lookup. Read-only; safe to call from a Sonnet
 * tool or the box CX SDK.
 */
export interface GetOrderRemedyStateOpts {
  /**
   * Injectable Shopify-ledger reader — defaults to [[refund-ledger]] `getOrderRefundLedger`.
   * Overridable so the unit test can pin the live-vs-degraded branching without hitting
   * Shopify. The real path passes the workspaceId + resolved internal order UUID, matching
   * `getOrderRefundLedger`'s CLAUDE.md hard-rule contract (internal joins use UUIDs).
   */
  getLedger?: (workspaceId: string, orderId: string) => Promise<OrderRefundLedger>;
}

export async function getOrderRemedyState(
  admin: Admin,
  workspaceId: string,
  ref: CxOrderRemedyStateRef,
  opts?: GetOrderRemedyStateOpts,
): Promise<CxOrderRemedyState> {
  const empty: CxOrderRemedyState = {
    found: false,
    workspace_id: workspaceId,
    order_id: null,
    order_number: ref.orderNumber ?? null,
    shopify_order_id: ref.shopifyOrderId ?? null,
    financial_status: null,
    total_cents: 0,
    refunds_succeeded_cents: 0,
    remaining_refundable_cents: 0,
    out_of_band_refunds_cents: 0,
    // No order → no ledger read → cannot claim a trustworthy headroom. `degraded` so a caller
    // treats the zero as "unknown", not "clean".
    headroom_confidence: "degraded",
    succeeded_refunds: [],
    returns: [],
    open_returns: [],
  };

  let query = admin
    .from("orders")
    .select("id, order_number, shopify_order_id, total_cents, financial_status")
    .eq("workspace_id", workspaceId)
    .limit(1);
  if (ref.orderId) query = query.eq("id", ref.orderId);
  else if (ref.shopifyOrderId) query = query.eq("shopify_order_id", ref.shopifyOrderId);
  else if (ref.orderNumber) query = query.eq("order_number", ref.orderNumber);
  else return empty;

  const { data: orderRows } = await query;
  const order = (orderRows?.[0] as {
    id: string;
    order_number: string | null;
    shopify_order_id: string | null;
    total_cents: number | null;
    financial_status: string | null;
  } | undefined) ?? null;
  if (!order) return empty;

  const [refundsRes, returnsRes] = await Promise.all([
    admin
      .from("order_refunds")
      .select("id, vendor, vendor_refund_id, amount_cents, status, requested_at")
      .eq("workspace_id", workspaceId)
      .eq("order_id", order.id)
      .order("requested_at", { ascending: false }),
    admin
      .from("returns")
      .select(
        "id, status, resolution_type, net_refund_cents, label_cost_cents, refunded_at, delivered_at, shipped_at, created_at, refund_id, tracking_number",
      )
      .eq("workspace_id", workspaceId)
      .eq("order_id", order.id)
      .order("created_at", { ascending: false }),
  ]);

  const refundsRaw = (refundsRes.data ?? []) as Array<{
    id: string;
    vendor: string;
    vendor_refund_id: string | null;
    amount_cents: number | null;
    status: string;
    requested_at: string;
  }>;
  const succeeded_refunds: CxRemedyRefundRow[] = refundsRaw
    .filter((r) => REMEDY_STATE_TERMINAL_REFUND_STATUSES.has(String(r.status)))
    .map((r) => ({
      id: r.id,
      vendor: r.vendor,
      vendor_refund_id: r.vendor_refund_id ?? null,
      amount_cents: r.amount_cents ?? 0,
      status: r.status,
      requested_at: r.requested_at,
    }));
  const refunds_succeeded_cents = succeeded_refunds.reduce((acc, r) => acc + (r.amount_cents ?? 0), 0);

  const returnsRaw = (returnsRes.data ?? []) as Array<{
    id: string;
    status: string;
    resolution_type: string | null;
    net_refund_cents: number | null;
    label_cost_cents: number | null;
    refunded_at: string | null;
    delivered_at: string | null;
    shipped_at: string | null;
    created_at: string;
    refund_id: string | null;
    tracking_number: string | null;
  }>;
  const returns: CxRemedyReturnRow[] = returnsRaw.map((r) => ({
    id: r.id,
    status: r.status,
    resolution_type: r.resolution_type ?? null,
    net_refund_cents: r.net_refund_cents ?? 0,
    label_cost_cents: r.label_cost_cents ?? 0,
    refunded_at: r.refunded_at ?? null,
    delivered_at: r.delivered_at ?? null,
    shipped_at: r.shipped_at ?? null,
    created_at: r.created_at,
    refund_id: r.refund_id ?? null,
    tracking_number: r.tracking_number ?? null,
  }));
  const open_returns: CxRemedyReturnRow[] = returns.filter(
    (r) => !r.refunded_at && !REMEDY_STATE_LIVE_RETURN_EXCLUDED_STATUSES.has(String(r.status)),
  );

  const totalCents = order.total_cents ?? 0;
  // Mirror-only fallback numbers — used ONLY when the live ledger call fails, so a caller sees the
  // (potentially overstated) mirror figure with `headroom_confidence='degraded'` and can refuse the
  // money decision rather than trust it. See CxOrderRemedyState.headroom_confidence.
  const mirrorRefundedCents = refunds_succeeded_cents;
  const mirrorRemainingCents = Math.max(0, totalCents - mirrorRefundedCents);

  const getLedger = opts?.getLedger ?? getOrderRefundLedger;
  const ledger = await getLedger(workspaceId, order.id);

  const liveRefundedCents = ledger.ok ? ledger.refundedCents : mirrorRefundedCents;
  const liveRemainingCents = ledger.ok ? ledger.refundableCents : mirrorRemainingCents;
  const outOfBandCents = ledger.ok ? ledger.outOfBandCents : 0;
  const headroomConfidence: CxOrderRemedyState["headroom_confidence"] = ledger.ok ? "live" : "degraded";

  return {
    found: true,
    workspace_id: workspaceId,
    order_id: order.id,
    order_number: order.order_number ?? null,
    shopify_order_id: order.shopify_order_id ?? null,
    financial_status: order.financial_status ?? null,
    total_cents: totalCents,
    refunds_succeeded_cents: liveRefundedCents,
    remaining_refundable_cents: liveRemainingCents,
    out_of_band_refunds_cents: outOfBandCents,
    headroom_confidence: headroomConfidence,
    succeeded_refunds,
    returns,
    open_returns,
  };
}

/**
 * Plain-text rendering of `getOrderRemedyState` — the shape the CS Director's session reads on the
 * mandatory precondition tool call AND the shape the founder card renders on `remedy_state`. Every
 * line is deterministic (no clock, no locale-dependent formatting) so a snapshot test can pin the
 * exact wording. A `found:false` state renders explicitly so a caller can tell "no order matched"
 * from "the order is clean" — never a silent empty snapshot.
 */
export function formatOrderRemedyState(state: CxOrderRemedyState): string {
  const parts: string[] = [];
  const label = state.order_number
    ? `#${state.order_number}`
    : state.shopify_order_id
      ? `shopify:${state.shopify_order_id}`
      : state.order_id
        ? `id:${state.order_id.slice(0, 8)}`
        : "(unresolved)";
  if (!state.found) {
    parts.push(`ORDER REMEDY STATE for ${label}: (order not found in this workspace)`);
    return parts.join("\n");
  }
  const oob = state.out_of_band_refunds_cents > 0
    ? ` · out_of_band ${DOLLARS(state.out_of_band_refunds_cents)}`
    : "";
  const confidence = state.headroom_confidence === "degraded"
    ? " · ⚠ HEADROOM DEGRADED (live ledger unreadable — mirror-only figures; a refund guard must REFUSE, not trust)"
    : "";
  parts.push(
    `ORDER REMEDY STATE for ${label}: total ${DOLLARS(state.total_cents)} · financial_status=${state.financial_status ?? "?"} · refunded_so_far ${DOLLARS(state.refunds_succeeded_cents)}${oob} · REMAINING REFUNDABLE ${DOLLARS(state.remaining_refundable_cents)}${confidence}`,
  );
  if (state.succeeded_refunds.length === 0) {
    parts.push("  refunds: (none)");
  } else {
    parts.push("  refunds:");
    for (const r of state.succeeded_refunds) {
      parts.push(
        `    - ${DOLLARS(r.amount_cents)} · ${r.vendor}${r.vendor_refund_id ? ` (txn ${r.vendor_refund_id})` : ""} · ${r.status} · ${r.requested_at.slice(0, 19)}`,
      );
    }
  }
  if (state.returns.length === 0) {
    parts.push("  returns: (none)");
  } else {
    parts.push("  returns:");
    for (const r of state.returns) {
      const live = !r.refunded_at && !REMEDY_STATE_LIVE_RETURN_EXCLUDED_STATUSES.has(String(r.status));
      const flag = live ? " ⚠ LIVE (refund will fire on delivery)" : "";
      const refundedAt = r.refunded_at ? ` · refunded_at=${r.refunded_at.slice(0, 19)}` : "";
      parts.push(
        `    - status=${r.status} · resolution=${r.resolution_type ?? "?"} · net_refund ${DOLLARS(r.net_refund_cents)}${refundedAt}${flag}`,
      );
    }
  }
  if (state.open_returns.length > 0) {
    const returnRefunds = state.open_returns.reduce((acc, r) => acc + (r.net_refund_cents ?? 0), 0);
    parts.push(
      `  ⚠ ${state.open_returns.length} live return(s) will refund ${DOLLARS(returnRefunds)} on receipt — a fresh money remedy on this order will DOUBLE-PAY.`,
    );
  }
  return parts.join("\n");
}

// ── Ticket id UUID guard ──────────────────────────────────────────────────────

/**
 * Canonical UUID v4-shape pattern the CX box agents' ticket tool validates ids
 * against BEFORE hitting Postgres. Without this guard, a malformed id (the 8-hex
 * '3cc11e10' incident) reaches `.eq('id', ticketId)` and Postgres raises 22P02
 * (invalid input syntax for type uuid), crashing the agent's tool call instead
 * of returning the intended clean "ticket not found" signal.
 */
export const CX_TICKET_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidCxTicketId(ticketId: unknown): ticketId is string {
  return typeof ticketId === "string" && CX_TICKET_ID_UUID_RE.test(ticketId);
}

/**
 * Self-correcting message the ticket tool prints when it rejects a malformed id.
 * The wording explicitly tells the agent to pass the FULL 36-char UUID rather
 * than a shortened prefix — an agent copying a `.slice(0,8)` display stub gets
 * a usable signal instead of a raw driver exception.
 */
export function invalidCxTicketIdMessage(ticketId: unknown): string {
  const shown = typeof ticketId === "string" ? ticketId : String(ticketId ?? "");
  return `"${shown}" is not a valid ticket id — pass the FULL ticket UUID (36 chars), not a shortened prefix`;
}

// ── Getters ───────────────────────────────────────────────────────────────────

const RECENT_ORDER_DAYS = 180;
const RECENT_ORDER_CAP = 25;

/**
 * Customer + merged identity. The linked-accounts group means one human across
 * separate customer rows (different emails, same person); every per-customer
 * query in the SDK is fanned out across the group so a claim on a sibling
 * profile is visible to the agent (Roxana's ticket — see resolveLinkedCustomerIds
 * in sonnet-orchestrator-v2.ts). Uses the shared linkGroupIds helper so the
 * expansion rule can't drift between the SDK and the deployed orchestrator.
 */
export async function getCxCustomer(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxCustomer> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  const { data: c } = await admin
    .from("customers")
    .select(
      "first_name, last_name, email, subscription_status, retention_score, email_marketing_status, sms_marketing_status, shopify_customer_id",
    )
    .eq("id", customerId)
    .maybeSingle();
  return {
    customer_id: customerId,
    linked_customer_ids: linked,
    profile: c
      ? {
          first_name: (c.first_name as string | null) ?? null,
          last_name: (c.last_name as string | null) ?? null,
          email: (c.email as string | null) ?? null,
          subscription_status: (c.subscription_status as string | null) ?? null,
          retention_score: (c.retention_score as number | null) ?? null,
          email_marketing_status: (c.email_marketing_status as string | null) ?? null,
          sms_marketing_status: (c.sms_marketing_status as string | null) ?? null,
          shopify_customer_id: (c.shopify_customer_id as string | null) ?? null,
        }
      : null,
  };
}

/**
 * Recent orders w/ enriched line items. `per_unit_cents` is the ACTUAL charged
 * amount ÷ qty (line total, not the original unit price Shopify stamps pre-
 * discount) — matches the surface computeChargedLineTotals in
 * sonnet-orchestrator-v2 gives the deployed orchestrator, so Cora / Sol / June
 * grade the same numbers the customer sees on their receipt.
 */
export async function getCxOrders(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxOrder[]> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  // Window: the last RECENT_ORDER_DAYS (180), but ALWAYS keep at least the 3
  // most recent orders even when they're older — the same rule the box's
  // get_customer_account uses. A hard date floor hid a disputed RENEWAL's
  // older first order (ticket 125741eb, marty), letting the agent read the
  // renewal as a first order. Fetch the most recent (no floor), then window
  // to max(within-180d, 3) so the renewal-vs-first-order signal survives.
  const cutoffIso = new Date(Date.now() - RECENT_ORDER_DAYS * 86400_000).toISOString();
  const { data: rawOrders } = await admin
    .from("orders")
    .select(
      "order_number, shopify_order_id, total_cents, line_items, payment_details, financial_status, source_name, subscription_id, created_at",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", linked)
    .order("created_at", { ascending: false })
    .limit(RECENT_ORDER_CAP);
  if (!rawOrders?.length) return [];
  const withinCount = rawOrders.filter(o => String(o.created_at) >= cutoffIso).length;
  const orders = rawOrders.slice(0, Math.max(withinCount, 3));

  // Pre-fetch variant titles for enrichment (only when there are any variant_ids).
  const variantIds = new Set<string>();
  for (const o of orders) {
    const items = (o.line_items as Array<{ variant_id?: string | null }> | null) ?? [];
    for (const i of items) if (i.variant_id) variantIds.add(String(i.variant_id));
  }
  const variantTitleMap = new Map<string, string>();
  if (variantIds.size > 0) {
    const { data: products } = await admin
      .from("products")
      .select("variants")
      .eq("workspace_id", workspaceId);
    for (const p of products || []) {
      const vs = (p.variants as Array<{ id?: string; title?: string }> | null) ?? [];
      for (const v of vs) {
        if (v.id && v.title) variantTitleMap.set(String(v.id), v.title);
      }
    }
  }

  return orders.map((o) => {
    const rawLines = (o.line_items as Array<{
      title?: string;
      quantity?: number;
      price_cents?: number | null;
      line_total_cents?: number | null;
      total_cents?: number | null;
      sku?: string | null;
      variant_id?: string | null;
      variant_title?: string | null;
    }> | null) ?? [];
    const payment = (o.payment_details as { subtotal_cents?: number | null } | null) ?? null;
    const orderTotal = (o.total_cents as number | null) ?? 0;
    const subtotal = payment?.subtotal_cents ?? orderTotal;
    // Sum of raw line prices × qty — used to scale each line to its realized share
    // of subtotal when the order carries no per-line total.
    const rawSum = rawLines.reduce((acc, l) => acc + Math.round(((l.price_cents ?? 0) * (l.quantity ?? 1))), 0);
    const scale = rawSum > 0 && subtotal > 0 ? subtotal / rawSum : 1;
    return {
      order_number: (o.order_number as string | null) ?? null,
      shopify_order_id: (o.shopify_order_id as string | null) ?? null,
      total_cents: orderTotal,
      financial_status: (o.financial_status as string | null) ?? null,
      created_at: o.created_at as string,
      source_name: (o.source_name as string | null) ?? null,
      subscription_id: (o.subscription_id as string | null) ?? null,
      line_items: rawLines.map((l) => {
        const qty = l.quantity ?? 1;
        // Prefer an explicit line total when present (internal/amplifier orders
        // stamp it); otherwise scale the raw line to its share of the order
        // subtotal (accounts for post-checkout discounts / coupons).
        const lineTotal = l.line_total_cents ?? l.total_cents ?? Math.round((l.price_cents ?? 0) * qty * scale);
        const perUnit = qty > 0 ? Math.round(lineTotal / qty) : 0;
        const resolvedTitle = l.variant_title ?? (l.variant_id ? variantTitleMap.get(String(l.variant_id)) ?? null : null);
        return {
          title: l.title ?? "",
          variant_id: (l.variant_id as string | null) ?? null,
          variant_title: resolvedTitle,
          quantity: qty,
          per_unit_cents: perUnit,
          line_total_cents: lineTotal,
          sku: (l.sku as string | null) ?? null,
        };
      }),
    };
  });
}

/**
 * Active + recent subscriptions w/ configured line pricing (price_cents /
 * price_override_cents), applied_discounts (the JSONB coupons block internal
 * subs + Shopify contracts both persist here), and status. Fan-out across the
 * linked-account group.
 */
export async function getCxSubscriptions(
  admin: Admin,
  workspaceId: string,
  customerId: string,
): Promise<CxSubscription[]> {
  const linked = await linkGroupIds(admin, workspaceId, customerId);
  const { data: subs } = await admin
    .from("subscriptions")
    .select(
      "id, customer_id, shopify_contract_id, status, items, applied_discounts, billing_interval, billing_interval_count, next_billing_date, created_at",
    )
    .eq("workspace_id", workspaceId)
    .in("customer_id", linked)
    .order("created_at", { ascending: false });
  if (!subs?.length) return [];
  return subs.map((s) => {
    const rawItems = (s.items as Array<{
      title?: string;
      variant_id?: string | null;
      variant_title?: string | null;
      quantity?: number;
      price_cents?: number | null;
      price_override_cents?: number | null;
    }> | null) ?? [];
    const items: CxSubscriptionItem[] = rawItems.map((i) => {
      const price = (i.price_cents as number | null) ?? null;
      const override = (i.price_override_cents as number | null) ?? null;
      return {
        title: i.title ?? "",
        variant_id: (i.variant_id as string | null) ?? null,
        variant_title: (i.variant_title as string | null) ?? null,
        quantity: (i.quantity as number | undefined) ?? 1,
        price_cents: price,
        price_override_cents: override,
        realized_cents: price ?? override ?? 0,
      };
    });
    const rawDiscounts = (s.applied_discounts as Array<{
      id?: string | null;
      title?: string | null;
      type?: string | null;
      value?: number | null;
      valueType?: string | null;
    }> | null) ?? [];
    const applied_discounts: CxSubscriptionDiscount[] = rawDiscounts.map((d) => ({
      id: (d.id as string | null) ?? null,
      title: (d.title as string | null) ?? null,
      type: (d.type as string | null) ?? null,
      value: (d.value as number | null) ?? null,
      value_type: (d.valueType as string | null) ?? null,
    }));
    return {
      id: s.id as string,
      customer_id: s.customer_id as string,
      shopify_contract_id: (s.shopify_contract_id as string | null) ?? null,
      status: (s.status as string) ?? "",
      billing_interval: (s.billing_interval as string | null) ?? null,
      billing_interval_count: (s.billing_interval_count as number | null) ?? null,
      next_billing_date: (s.next_billing_date as string | null) ?? null,
      created_at: s.created_at as string,
      items,
      applied_discounts,
    };
  });
}

/**
 * The workspace's active product catalog — variants (flavors) + pricing so the
 * agents can cite a real variant_title (Berry vs Peach) and compare the AI's
 * per-unit claim against the MSRP. Read-only from `products.status='active'`.
 */
export async function getCxProducts(admin: Admin, workspaceId: string): Promise<CxProduct[]> {
  const { data: products } = await admin
    .from("products")
    .select("id, title, handle, status, variants")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (!products?.length) return [];

  // ── ship truth ──────────────────────────────────────────────────────────────────────
  // The 3PL is the ONLY authority for what can actually ship (founder 2026-08-28: "the 3PL is the
  // only true source of inventory, not Shopify"). Amplifier rows key on SKU and carry no variant
  // id, so we bridge shopify variant id → sku through `product_variants`, then sku → on-hand.
  const [{ data: pvRows }, amplifier] = await Promise.all([
    admin
      .from("product_variants")
      .select("shopify_variant_id, sku")
      .eq("workspace_id", workspaceId),
    getAmplifierOnHandBySku(admin, workspaceId),
  ]);
  const skuByVariant = new Map<string, string>();
  for (const r of (pvRows ?? []) as Array<{ shopify_variant_id: unknown; sku: unknown }>) {
    if (r.shopify_variant_id != null && r.sku) skuByVariant.set(String(r.shopify_variant_id), String(r.sku));
  }

  return products.map((p) => {
    const vs = (p.variants as Array<{ id?: string; title?: string; price_cents?: number | null }> | null) ?? [];
    return {
      id: p.id as string,
      title: (p.title as string | null) ?? null,
      handle: (p.handle as string | null) ?? null,
      status: (p.status as string | null) ?? null,
      variants: vs
        .filter((v) => !!v.id)
        .map((v) => {
          const sku = skuByVariant.get(String(v.id)) ?? null;
          // `undefined` (no 3PL row for this SKU) stays NULL — unknown is not "in stock".
          const onHand = sku ? amplifier.get(sku) : undefined;
          return {
            id: String(v.id),
            title: (v.title as string | null) ?? null,
            price_cents: (v.price_cents as number | null) ?? null,
            sku,
            on_hand: onHand ?? null,
            in_stock: onHand === undefined ? null : onHand > 0,
          };
        }),
    };
  });
}

/**
 * The workspace's active policies — the SAME `sonnet_prompts` rows the deployed
 * orchestrator reads every turn (loadLiveRules in agent-todos/triage.ts). Enabled
 * + approved only.
 */
export async function getCxPolicies(admin: Admin, workspaceId: string): Promise<CxPolicy[]> {
  const { data } = await admin
    .from("sonnet_prompts")
    .select("category, title, content")
    .eq("workspace_id", workspaceId)
    .eq("enabled", true)
    .eq("status", "approved")
    .order("category")
    .order("sort_order");
  if (!data?.length) return [];
  return data.map((p) => ({
    category: (p.category as string) ?? "",
    title: (p.title as string) ?? "",
    content: String(p.content ?? ""),
  }));
}

/**
 * One-shot bundle — every getter above in parallel. Returned as typed data so a
 * caller can render its own shape; formatCxBundle below is the plain-text
 * rendering the three worker briefs embed.
 */
export async function getCxBundle(
  admin: Admin,
  workspaceId: string,
  customerId: string | null,
): Promise<CxBundle> {
  if (!customerId) {
    const [products, policies] = await Promise.all([
      getCxProducts(admin, workspaceId),
      getCxPolicies(admin, workspaceId),
    ]);
    return {
      workspace_id: workspaceId,
      customer_id: null,
      customer: null,
      orders: [],
      subscriptions: [],
      products,
      policies,
    };
  }
  const [customer, orders, subscriptions, products, policies] = await Promise.all([
    getCxCustomer(admin, workspaceId, customerId),
    getCxOrders(admin, workspaceId, customerId),
    getCxSubscriptions(admin, workspaceId, customerId),
    getCxProducts(admin, workspaceId),
    getCxPolicies(admin, workspaceId),
  ]);
  return {
    workspace_id: workspaceId,
    customer_id: customerId,
    customer,
    orders,
    subscriptions,
    products,
    policies,
  };
}

/**
 * Deterministic READ-ONLY catalog reader — Phase 1 of
 * [[../specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta]].
 *
 * Returns the workspace's ACTIVE journeys / playbooks / workflows whose trigger matches
 * `intent`, so Sol's first-touch box session ([[../libraries/ticket-directions]] `writeDirection`)
 * can record the specific matched mechanism on the Direction — `chosen_path='journey'` +
 * `plan.journey_slug=<slug>` or `chosen_path='playbook'` + `plan.playbook_slug=<slug>` — instead
 * of composing a freeform reply that references a CTA it never launched. An empty catalog is
 * Sol's signal that the correct Direction is `chosen_path='stateless'` (an AI reply); a
 * non-empty catalog is her signal to name a slug so Phase 2 can APPLY the mechanism.
 *
 * Matching:
 *   - Journeys ([[../tables/journey_definitions]]): `is_active=true` AND
 *     `lower(trigger_intent) = lower(intent)` — scalar text column.
 *   - Playbooks ([[../tables/playbooks]]): `is_active=true` AND intent is a case-insensitive
 *     member of `trigger_intents[]` — text[] column. Case-insensitivity is applied in-memory
 *     after the workspace filter, following the same pattern the deployed orchestrator uses
 *     (sonnet-orchestrator-v2 + playbook-executor); the catalog per workspace is small so this
 *     is O(#playbooks) not a scan.
 *   - Workflows ([[../tables/workflows]]): `enabled=true` AND `lower(trigger_tag) = lower(intent)`.
 *
 * Optional `opts.channel` narrows journeys + workflows to those whose `channels[]` includes the
 * ticket's channel; when omitted (or when a mechanism's `channels[]` is empty), the mechanism
 * passes. Read-only; scoped to `workspaceId` on every query (learning #6 — the workspace scope
 * is re-asserted on the write, not inferred). Empty result is a valid, non-error outcome — Sol
 * treats it as "no active mechanism for this intent" and picks `stateless`.
 */
export async function listActionableOutcomes(
  admin: Admin,
  workspaceId: string,
  intent: string,
  opts?: { channel?: string | null },
): Promise<CxActionableOutcomes> {
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const target = norm(intent);
  const channel = opts?.channel ? String(opts.channel) : null;
  const channelNorm = channel ? channel.toLowerCase() : null;

  const empty: CxActionableOutcomes = {
    workspace_id: workspaceId,
    intent,
    channel,
    journeys: [],
    playbooks: [],
    workflows: [],
  };
  if (!target) return empty;

  const channelMatches = (channels: string[] | null | undefined): boolean => {
    if (!channelNorm) return true;
    const arr = channels ?? [];
    if (arr.length === 0) return true;
    return arr.some((c) => (c ?? "").toLowerCase() === channelNorm);
  };

  const [journeyRes, playbookRes, workflowRes] = await Promise.all([
    admin
      .from("journey_definitions")
      .select("id, slug, name, description, trigger_intent, channels, priority")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("priority", { ascending: false }),
    admin
      .from("playbooks")
      .select("id, slug, name, description, trigger_intents, priority")
      .eq("workspace_id", workspaceId)
      .eq("is_active", true)
      .order("priority", { ascending: false }),
    admin
      .from("workflows")
      .select("id, name, template, trigger_tag, channels")
      .eq("workspace_id", workspaceId)
      .eq("enabled", true),
  ]);

  const journeyRows = (journeyRes.data ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    trigger_intent: string | null;
    channels: string[] | null;
    priority: number | null;
  }>;
  const journeys: CxActionableJourney[] = journeyRows
    .filter((j) => norm(j.trigger_intent) === target)
    .filter((j) => channelMatches(j.channels))
    .map((j) => ({
      id: j.id,
      slug: j.slug,
      name: j.name,
      description: j.description,
      trigger_intent: j.trigger_intent ?? "",
      channels: j.channels ?? [],
      priority: j.priority ?? 0,
    }));

  const playbookRows = (playbookRes.data ?? []) as Array<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    trigger_intents: string[] | null;
    priority: number | null;
  }>;
  const playbooks: CxActionablePlaybook[] = playbookRows
    .filter((p) => (p.trigger_intents ?? []).some((ti) => norm(ti) === target))
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      name: p.name,
      description: p.description,
      trigger_intents: p.trigger_intents ?? [],
      priority: p.priority ?? 0,
    }));

  const workflowRows = (workflowRes.data ?? []) as Array<{
    id: string;
    name: string;
    template: string | null;
    trigger_tag: string | null;
    channels: string[] | null;
  }>;
  const workflows: CxActionableWorkflow[] = workflowRows
    .filter((w) => norm(w.trigger_tag) === target)
    .filter((w) => channelMatches(w.channels))
    .map((w) => ({
      id: w.id,
      name: w.name,
      template: w.template ?? "",
      trigger_tag: w.trigger_tag ?? "",
      channels: w.channels ?? [],
    }));

  return { workspace_id: workspaceId, intent, channel, journeys, playbooks, workflows };
}

// ── Formatting ────────────────────────────────────────────────────────────────

const DOLLARS = (cents: number | null | undefined) =>
  cents == null ? "?" : `$${(cents / 100).toFixed(2)}`;

export function formatCxCustomer(c: CxCustomer | null): string {
  if (!c) return "CUSTOMER: (no customer resolved)";
  const linked = c.linked_customer_ids.filter((id) => id !== c.customer_id);
  const linkedLine = linked.length ? ` · linked accounts (same human): ${linked.join(", ")}` : "";
  const p = c.profile;
  if (!p) return `CUSTOMER: ${c.customer_id}${linkedLine} · (profile row not found)`;
  const name = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "(no name)";
  // Mistyped-email flag (all three agents see it): a customer typed as gmaik.com is unreachable —
  // every reply/journey CTA/magic-link bounces and a duplicate account silently spawns. Deterministic,
  // dependency-free (mailcheck). SUGGESTS only — the agent confirms with the customer / links accounts;
  // it is never permission to mutate an address into a DIFFERENT live customer's.
  const typo = suggestEmailCorrection(p.email ?? "");
  const typoLine = typo.changed
    ? ` · ⚠️ EMAIL LIKELY MISTYPED (${typo.confidence}): did you mean <${typo.corrected}>? — confirm before relying on this address`
    : "";
  return `CUSTOMER: ${name} <${p.email ?? ""}> (id ${c.customer_id})${linkedLine} · sub: ${p.subscription_status ?? "none"} · retention: ${p.retention_score ?? 0} · email_marketing: ${p.email_marketing_status ?? "?"} · sms_marketing: ${p.sms_marketing_status ?? "?"}${typoLine}`;
}

export function formatCxOrders(orders: CxOrder[]): string {
  if (!orders.length) return "ORDERS: (none on record)";
  const cutoffIso = new Date(Date.now() - RECENT_ORDER_DAYS * 86400_000).toISOString();
  const someOlder = orders.some((o) => o.created_at < cutoffIso);
  const lines: string[] = [
    someOlder
      ? `ORDERS (last ${RECENT_ORDER_DAYS} days had fewer than 3 — showing the 3 most recent; some are older than ${RECENT_ORDER_DAYS} days):`
      : `ORDERS (last ${RECENT_ORDER_DAYS} days, cap ${RECENT_ORDER_CAP}):`,
  ];
  for (const o of orders) {
    const items = o.line_items
      .map((i) => {
        const variant = i.variant_title ? ` (${i.variant_title})` : "";
        return `${i.title}${variant} x${i.quantity} @ ${DOLLARS(i.per_unit_cents)}/unit (line ${DOLLARS(i.line_total_cents)})`;
      })
      .join(", ");
    const sub = o.subscription_id ? ` · sub ${o.subscription_id}` : " · one-time";
    lines.push(
      `  - #${o.order_number ?? "?"} ${o.created_at.slice(0, 10)} ${DOLLARS(o.total_cents)} ${o.financial_status ?? "?"}${sub}: ${items}`,
    );
  }
  return lines.join("\n");
}

export function formatCxSubscriptions(subs: CxSubscription[]): string {
  if (!subs.length) return "SUBSCRIPTIONS: (none)";
  const lines: string[] = ["SUBSCRIPTIONS:"];
  for (const s of subs) {
    const items = s.items
      .map((i) => {
        const variant = i.variant_title ? ` (${i.variant_title})` : "";
        const src = i.price_cents != null ? "price" : i.price_override_cents != null ? "override" : "?";
        return `${i.title}${variant} x${i.quantity} @ ${DOLLARS(i.realized_cents)} [${src}]`;
      })
      .join(", ");
    const discounts = s.applied_discounts.length
      ? ` · discounts: ${s.applied_discounts.map((d) => `${d.title ?? d.id ?? "?"}${d.value != null ? ` (${d.value_type ?? "?"} ${d.value})` : ""}`).join(", ")}`
      : "";
    const cadence = `every ${s.billing_interval_count ?? 1} ${s.billing_interval ?? "month"}`;
    lines.push(
      `  - ${s.id} [${s.status}] contract: ${s.shopify_contract_id ?? "(internal)"} · ${cadence} · next: ${s.next_billing_date ?? "?"} · ${items}${discounts}`,
    );
  }
  return lines.join("\n");
}

/**
 * Plain-text product catalog for an agent brief — WITH ship truth per variant.
 *
 * "active" is a merchandising flag, not a promise that anything can ship. Every variant is now
 * tagged from the 3PL: `OUT OF STOCK` (0 on hand), `stock unknown` (no 3PL row), or a unit count.
 * Rendering these identically is what let Sol offer a customer a flavor the warehouse could not
 * ship (ticket 0c9f11a7, 2026-08-28).
 */
export function formatCxProducts(products: CxProduct[]): string {
  if (!products.length) return "PRODUCTS: (no active products)";
  const oos: string[] = [];
  const lines: string[] = [
    "PRODUCTS (active — variants + MSRP + SHIP TRUTH from the 3PL):",
    "  ⚠️ NEVER offer, promise, or reorder a variant marked OUT OF STOCK or stock unknown — 'active' is a",
    "     merchandising flag, not a guarantee it can ship. Check this list before naming a flavor.",
  ];
  for (const p of products) {
    const variants = p.variants
      .map((v) => {
        const stock =
          v.in_stock === null
            ? "⚠️ stock unknown"
            : v.in_stock
              ? `${v.on_hand} on hand`
              : "⛔ OUT OF STOCK";
        if (v.in_stock === false) oos.push(`${p.title ?? "(untitled)"} / ${v.title ?? "(default)"}`);
        return `${v.title ?? "(default)"} [${v.id}] @ ${DOLLARS(v.price_cents)} — ${stock}`;
      })
      .join(", ");
    lines.push(`  - ${p.title ?? "(untitled)"} · ${variants || "(no variants)"}`);
  }
  if (oos.length) {
    lines.push(`  ⛔ CANNOT SHIP RIGHT NOW (${oos.length}): ${oos.join(" · ")}`);
  }
  return lines.join("\n");
}

/**
 * Plain-text rendering of the actionable-outcomes catalog Phase 1's Sol-brief can embed. Empty
 * catalog is rendered explicitly ("no matching mechanism") so the Direction author sees "pick
 * chosen_path='stateless'" as the correct call rather than fabricating a slug.
 */
export function formatActionableOutcomes(o: CxActionableOutcomes): string {
  const parts: string[] = [
    `ACTIONABLE OUTCOMES for intent="${o.intent}"${o.channel ? ` channel=${o.channel}` : ""}:`,
  ];
  if (o.journeys.length === 0 && o.playbooks.length === 0 && o.workflows.length === 0) {
    parts.push("  (no matching active mechanism — Direction should be chosen_path='stateless')");
    return parts.join("\n");
  }
  if (o.journeys.length) {
    parts.push("  Journeys:");
    for (const j of o.journeys) {
      const desc = j.description ? ` — ${j.description.slice(0, 80)}` : "";
      const chs = j.channels.length ? ` [channels: ${j.channels.join(", ")}]` : "";
      parts.push(`    - ${j.slug} (${j.name})${chs}${desc}`);
    }
  }
  if (o.playbooks.length) {
    parts.push("  Playbooks:");
    for (const p of o.playbooks) {
      const desc = p.description ? ` — ${p.description.slice(0, 80)}` : "";
      const ints = p.trigger_intents.length ? ` [intents: ${p.trigger_intents.join(", ")}]` : "";
      parts.push(`    - ${p.slug} (${p.name})${ints}${desc}`);
    }
  }
  if (o.workflows.length) {
    parts.push("  Workflows:");
    for (const w of o.workflows) {
      const chs = w.channels.length ? ` [channels: ${w.channels.join(", ")}]` : "";
      parts.push(`    - ${w.name} template=${w.template} trigger_tag=${w.trigger_tag}${chs}`);
    }
  }
  return parts.join("\n");
}

export function formatCxPolicies(policies: CxPolicy[]): string {
  if (!policies.length) return "POLICIES: (no active sonnet_prompts rules)";
  const lines: string[] = ["POLICIES (active sonnet_prompts, category + title + content excerpt):"];
  for (const p of policies) {
    const excerpt = p.content.replace(/\s+/g, " ").slice(0, 400);
    lines.push(`  - [${p.category}] ${p.title}: ${excerpt}`);
  }
  return lines.join("\n");
}

/**
 * Plain-text rendering of the full bundle — the three worker briefs embed this
 * so the agent starts every session with the SAME deterministic snapshot of the
 * customer's data + the workspace's catalog + policies. No raw SQL needed.
 */
export function formatCxBundle(b: CxBundle): string {
  return [
    "--- CX SDK snapshot (deterministic read-only; call the SDK, not raw SQL) ---",
    formatCxCustomer(b.customer),
    formatCxSubscriptions(b.subscriptions),
    formatCxOrders(b.orders),
    formatCxProducts(b.products),
    formatCxPolicies(b.policies),
  ].join("\n");
}

// ── CLI dispatch ──────────────────────────────────────────────────────────────

/** The named verbs the box-side CLI (scripts/cx-agent-sdk-tool.ts) accepts. */
export const CX_SDK_VERBS = [
  "customer",
  "orders",
  "subscriptions",
  "products",
  "policies",
  "bundle",
  // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first — the live remedy state for
  // ONE order. Takes an extra order reference (order_number / shopify_order_id / order_id) and is
  // the mandatory precondition for any money remedy the CS Director proposes (mirrors the
  // get_policies precondition pattern that already gates Sol's non-money asks). See
  // `formatOrderRemedyState` above for the text shape the founder card + the box session both read.
  "remedy_state",
] as const;
export type CxSdkVerb = (typeof CX_SDK_VERBS)[number];

export function isCxSdkVerb(v: string): v is CxSdkVerb {
  return (CX_SDK_VERBS as readonly string[]).includes(v);
}

/**
 * Dispatch a verb to its formatted text output. The CLI (scripts/cx-agent-sdk-
 * tool.ts) is a very thin wrapper around this — one place tests can exercise
 * the SDK's read + render surface without shelling to node.
 *
 * `remedy_state` requires an extra order reference via `opts.orderRef` — any one of
 * `orderNumber` / `shopifyOrderId` / `orderId`. When none of the three is provided we return an
 * explicit "no order reference" message rather than falling through to a bare snapshot (a silent
 * empty state would look like "clean order" — the exact class the Phase-1 spec closes).
 */
export async function runCxSdkVerb(
  admin: Admin,
  verb: CxSdkVerb,
  workspaceId: string,
  customerId: string | null,
  opts?: { orderRef?: CxOrderRemedyStateRef },
): Promise<string> {
  switch (verb) {
    case "customer": {
      if (!customerId) return "CUSTOMER: (no customer resolved on this ticket)";
      const c = await getCxCustomer(admin, workspaceId, customerId);
      return formatCxCustomer(c);
    }
    case "orders": {
      if (!customerId) return "ORDERS: (no customer resolved on this ticket)";
      const o = await getCxOrders(admin, workspaceId, customerId);
      return formatCxOrders(o);
    }
    case "subscriptions": {
      if (!customerId) return "SUBSCRIPTIONS: (no customer resolved on this ticket)";
      const s = await getCxSubscriptions(admin, workspaceId, customerId);
      return formatCxSubscriptions(s);
    }
    case "products": {
      const p = await getCxProducts(admin, workspaceId);
      return formatCxProducts(p);
    }
    case "policies": {
      const p = await getCxPolicies(admin, workspaceId);
      return formatCxPolicies(p);
    }
    case "bundle": {
      const b = await getCxBundle(admin, workspaceId, customerId);
      return formatCxBundle(b);
    }
    case "remedy_state": {
      const ref = opts?.orderRef ?? {};
      if (!ref.orderId && !ref.shopifyOrderId && !ref.orderNumber) {
        return "REMEDY STATE: (no order reference — pass order_number / shopify_order_id / order_id)";
      }
      const s = await getOrderRemedyState(admin, workspaceId, ref);
      return formatOrderRemedyState(s);
    }
  }
}
