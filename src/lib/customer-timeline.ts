/**
 * Customer timeline + anomaly detectors.
 *
 * Reads a customer's recent activity (orders, subscriptions, returns,
 * portal actions, Appstle webhooks) and merges into a chronological,
 * human-readable timeline. Then runs anomaly detectors that surface
 * contradictions between customer narrative and ground truth — the
 * things the AI orchestrator (and human agents) need to notice but
 * usually don't when staring at flat JSON.
 *
 * Two consumers:
 *   1. Sonnet orchestrator (`get_customer_timeline` data tool)
 *   2. Ticket detail page Timeline tab (agent UI)
 *
 * Source of truth is `customer_events` going forward (now richly enriched
 * — see `feedback_anomaly_framing_neutral` for framing rules), with
 * cross-reference reconstruction for legacy events.
 */

import { createAdminClient } from "@/lib/supabase/admin";

export type TimelineEntryType =
  | "order_placed"
  | "order_fulfilled"
  | "order_delivered"
  | "order_refunded"
  | "subscription_created"
  | "subscription_variant_changed"
  | "subscription_quantity_changed"
  | "subscription_paused"
  | "subscription_resumed"
  | "subscription_cancelled"
  | "subscription_frequency_changed"
  | "subscription_next_date_changed"
  | "subscription_coupon_applied"
  | "subscription_coupon_removed"
  | "payment_succeeded"
  | "payment_failed"
  | "return_created"
  | "return_delivered"
  | "return_refunded"
  | "portal_login"
  | "journey_started"
  | "journey_completed"
  | "ticket_created";

export interface TimelineEntry {
  at: string; // ISO timestamp
  type: TimelineEntryType;
  summary: string; // human one-liner
  ref?: string; // optional reference (order_number, contract_id, ticket_id, etc.)
  details?: Record<string, unknown>;
  confidence?: "direct" | "reconstructed"; // reconstructed = we filled in a missing field via cross-reference
}

export type AnomalySeverity = "info" | "warn";

export interface Anomaly {
  type: string;
  severity: AnomalySeverity;
  summary: string;
  evidence?: Record<string, unknown>;
}

export interface CustomerTimeline {
  customer: { id: string; email: string | null; name: string | null };
  linked_customer_ids: string[];
  window_days: number;
  current_state: {
    active_subscriptions: number;
    paused_subscriptions: number;
    cancelled_subscriptions: number;
    orders_in_window: number;
    open_returns: number;
    ltv_cents: number;
    retention_score: number | null;
  };
  anomalies: Anomaly[];
  timeline: TimelineEntry[];
}

interface OrderRow {
  id: string;
  order_number: string;
  created_at: string;
  total_cents: number;
  financial_status: string | null;
  fulfillment_status: string | null;
  line_items: Array<{ sku?: string; title?: string; variant_id?: string; variant_title?: string; quantity?: number; price_cents?: number }> | null;
  fulfillments: Array<{ status?: string; createdAt?: string; shipmentStatus?: string; trackingInfo?: Array<{ company?: string; number?: string; url?: string }> }> | null;
  tags: string | null;
}

interface SubRow {
  id: string;
  shopify_contract_id: string | null;
  status: string;
  items: Array<{ variant_id?: string; sku?: string; title?: string; variant_title?: string; quantity?: number; price_cents?: number; product_id?: string }> | null;
  next_billing_date: string | null;
  billing_interval: string | null;
  billing_interval_count: number | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  event_type: string;
  source: string | null;
  summary: string | null;
  properties: Record<string, unknown> | null;
  created_at: string;
}

interface ReturnRow {
  id: string;
  order_number: string | null;
  status: string;
  net_refund_cents: number | null;
  delivered_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

interface CustomerRow {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  ltv_cents: number | null;
  retention_score: number | null;
}

async function resolveLinkedCustomerIds(admin: ReturnType<typeof createAdminClient>, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  return (group || []).map((r: { customer_id: string }) => r.customer_id);
}

/**
 * Pull the most-recent variant info known about a subscription contract
 * BEFORE a given timestamp. Used to reconstruct `oldVariants` for legacy
 * `portal.items.swapped` events that have empty `oldVariants`.
 *
 * Strategy: scan events for the contract older than `before`, take the
 * most recent one that carries item detail. Falls back to the
 * originating order's line items (originOrder.name in subscription
 * payloads).
 */
function reconstructPriorVariants(
  contractId: string,
  before: string,
  events: EventRow[],
  orders: OrderRow[],
): Array<{ variant_id: string; title?: string; variant_title?: string; quantity?: number }> {
  const beforeMs = Date.parse(before);
  // Look at prior events on the same contract that carry items detail
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (Date.parse(e.created_at) >= beforeMs) continue;
    const props = e.properties as Record<string, unknown> | null;
    if (!props) continue;
    if (props.shopify_contract_id !== contractId && props.shopify_contract_id !== String(contractId)) continue;
    const items = props.items;
    if (Array.isArray(items) && items.length > 0 && typeof items[0] === "object" && (items[0] as Record<string, unknown>).variant_id) {
      return (items as Array<Record<string, unknown>>).map(it => ({
        variant_id: String(it.variant_id),
        title: it.title as string | undefined,
        variant_title: it.variant_title as string | undefined,
        quantity: it.quantity as number | undefined,
      }));
    }
  }
  // Last resort — orders with "First Subscription" tag close to contract creation typically seed the sub
  const firstSubOrder = orders.find(o => (o.tags || "").includes("First Subscription") && Date.parse(o.created_at) <= beforeMs);
  if (firstSubOrder?.line_items) {
    return firstSubOrder.line_items.filter(li => li.variant_id).map(li => ({
      variant_id: String(li.variant_id),
      title: li.title,
      variant_title: li.variant_title,
      quantity: li.quantity,
    }));
  }
  return [];
}

function fmtVariant(item: { title?: string; variant_title?: string; quantity?: number } | undefined): string {
  if (!item) return "";
  const qty = item.quantity || 1;
  const v = item.variant_title;
  const t = item.title || "item";
  return v ? `${qty}× ${t} — ${v}` : `${qty}× ${t}`;
}

/**
 * Variant lookup map: variant_id → { title, variant_title }. Built from
 * product_variants once per timeline build so we can render readable
 * names ("Hazelnut") instead of bare variant IDs ("42614446325933").
 */
type VariantLookup = Map<string, { title: string; variant_title: string | null }>;

async function buildVariantLookup(admin: ReturnType<typeof createAdminClient>, workspaceId: string): Promise<VariantLookup> {
  const lookup: VariantLookup = new Map();
  // product_variants has the canonical mapping; products.variants JSONB is a legacy mirror.
  const { data: variants } = await admin
    .from("product_variants")
    .select("shopify_variant_id, title, product_id")
    .eq("workspace_id", workspaceId);
  if (!variants) return lookup;
  // We also need product titles, so fetch products and join.
  const productIds = Array.from(new Set(variants.map((v: { product_id: string }) => v.product_id).filter(Boolean)));
  const { data: products } = await admin
    .from("products")
    .select("id, title")
    .in("id", productIds);
  const productTitles = new Map<string, string>();
  for (const p of products || []) productTitles.set(p.id, p.title || "");
  for (const v of variants as Array<{ shopify_variant_id: string; title: string; product_id: string }>) {
    if (!v.shopify_variant_id) continue;
    lookup.set(String(v.shopify_variant_id), {
      title: productTitles.get(v.product_id) || "",
      variant_title: v.title || null,
    });
  }
  return lookup;
}

function variantLabel(variantId: string, lookup: VariantLookup): string {
  const entry = lookup.get(String(variantId));
  if (!entry) return `variant ${variantId}`;
  const v = entry.variant_title && entry.variant_title !== "Default Title" ? entry.variant_title : null;
  if (entry.title && v) return `${entry.title} — ${v}`;
  return entry.title || v || `variant ${variantId}`;
}

function buildOrderTimelineEntries(orders: OrderRow[], variantLookup: VariantLookup): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const o of orders) {
    const items = (o.line_items || []).map(li => {
      // If variant_title is missing on the line item, fall back to the catalog lookup
      if (!li.variant_title && li.variant_id) {
        const looked = variantLookup.get(String(li.variant_id));
        if (looked?.variant_title) li = { ...li, variant_title: looked.variant_title };
      }
      return fmtVariant(li);
    }).filter(Boolean).join(", ");
    out.push({
      at: o.created_at,
      type: "order_placed",
      summary: `Order ${o.order_number} placed — ${items || "items unknown"} ($${(o.total_cents / 100).toFixed(2)})`,
      ref: o.order_number,
      details: {
        order_id: o.id,
        line_items: o.line_items,
        financial_status: o.financial_status,
        tags: o.tags,
      },
      confidence: "direct",
    });
    for (const f of o.fulfillments || []) {
      if (!f.createdAt) continue;
      const tracking = f.trackingInfo?.[0];
      const carrier = tracking?.company || "carrier";
      const tNum = tracking?.number ? ` (${carrier} ${tracking.number})` : "";
      out.push({
        at: f.createdAt,
        type: f.shipmentStatus === "delivered" ? "order_delivered" : "order_fulfilled",
        summary: f.shipmentStatus === "delivered"
          ? `Order ${o.order_number} delivered${tNum}`
          : `Order ${o.order_number} shipped${tNum}`,
        ref: o.order_number,
        details: { tracking: tracking || null, shipment_status: f.shipmentStatus },
        confidence: "direct",
      });
    }
    if (o.financial_status === "refunded" || o.financial_status === "partially_refunded") {
      // Add a coarse refund entry — exact refund details live in returns
      out.push({
        at: o.created_at, // we don't have a refunded_at on orders directly; approximate
        type: "order_refunded",
        summary: `Order ${o.order_number} refund applied (${o.financial_status})`,
        ref: o.order_number,
        confidence: "reconstructed",
      });
    }
  }
  return out;
}

function buildEventTimelineEntries(events: EventRow[], orders: OrderRow[], variantLookup: VariantLookup): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const props = (e.properties || {}) as Record<string, unknown>;
    const contractId = (props.shopify_contract_id as string) || "";

    switch (e.event_type) {
      case "subscription.created": {
        const items = props.items;
        const itemsStr = Array.isArray(items)
          ? items.map(it => typeof it === "string" ? it : fmtVariant(it as { title?: string; variant_title?: string; quantity?: number })).filter(Boolean).join(", ")
          : "";
        out.push({
          at: e.created_at,
          type: "subscription_created",
          summary: `Subscription created${itemsStr ? ` — ${itemsStr}` : ""}${props.next_billing_date ? ` (next bill ${(props.next_billing_date as string).slice(0, 10)})` : ""}`,
          ref: contractId,
          details: props,
          confidence: "direct",
        });
        break;
      }
      case "portal.items.swapped": {
        const newVariants = props.newVariants as Record<string, number> | undefined;
        const oldVariantDetails = props.oldVariantDetails as Array<{ variant_id: string; title?: string; variant_title?: string; quantity?: number }> | undefined;
        const oldVariants = props.oldVariants as number[] | undefined;

        // Reconstruct old variants if not provided by the handler (legacy events)
        const olds = oldVariantDetails && oldVariantDetails.length
          ? oldVariantDetails
          : reconstructPriorVariants(contractId, e.created_at, events.slice(0, i), orders);

        const oldStr = olds.length
          ? olds.map(v => {
              const lookedUp = variantLabel(v.variant_id, variantLookup);
              return lookedUp.startsWith("variant ") ? (v.variant_title || v.title || lookedUp) : lookedUp;
            }).join(", ")
          : (oldVariants && oldVariants.length ? oldVariants.map(v => variantLabel(String(v), variantLookup)).join(", ") : "previous items");
        const newStr = newVariants
          ? Object.keys(newVariants).map(v => variantLabel(v, variantLookup)).join(", ")
          : "new items";
        // Resolve new variant titles from product catalog via current sub state lookup happens at caller level for richer rendering
        out.push({
          at: e.created_at,
          type: "subscription_variant_changed",
          summary: `Subscription variant changed: ${oldStr} → ${newStr}`,
          ref: contractId,
          details: { from: olds, to: newVariants },
          confidence: (oldVariantDetails && oldVariantDetails.length) ? "direct" : "reconstructed",
        });
        break;
      }
      case "subscription.paused":
        out.push({ at: e.created_at, type: "subscription_paused", summary: "Subscription paused", ref: contractId, details: props, confidence: "direct" });
        break;
      case "subscription.activated":
        out.push({ at: e.created_at, type: "subscription_resumed", summary: "Subscription activated", ref: contractId, details: props, confidence: "direct" });
        break;
      case "subscription.cancelled":
        out.push({ at: e.created_at, type: "subscription_cancelled", summary: "Subscription cancelled", ref: contractId, details: props, confidence: "direct" });
        break;
      case "subscription.billing-interval-changed": {
        const bi = props.billing_interval as string | undefined;
        const bic = props.billing_interval_count as number | undefined;
        out.push({
          at: e.created_at,
          type: "subscription_frequency_changed",
          summary: `Billing frequency changed${bi ? ` to every ${bic || 1} ${bi.toLowerCase()}${(bic || 1) > 1 ? "s" : ""}` : ""}`,
          ref: contractId,
          details: props,
          confidence: "direct",
        });
        break;
      }
      case "subscription.next-order-date-changed": {
        const nbd = props.next_billing_date as string | undefined;
        out.push({
          at: e.created_at,
          type: "subscription_next_date_changed",
          summary: `Next order date changed${nbd ? ` to ${nbd.slice(0, 10)}` : ""}`,
          ref: contractId,
          details: props,
          confidence: "direct",
        });
        break;
      }
      case "subscription.billing-success": {
        const amt = props.order_amount as number | string | undefined;
        const orderName = props.order_name as string | undefined;
        out.push({
          at: e.created_at,
          type: "payment_succeeded",
          summary: `Payment succeeded${orderName ? ` — order ${orderName}` : ""}${amt ? ` ($${typeof amt === "number" ? amt.toFixed(2) : amt})` : ""}`,
          ref: contractId,
          details: props,
          confidence: "direct",
        });
        break;
      }
      case "subscription.billing-failure":
      case "subscription.billing-skipped":
        out.push({
          at: e.created_at,
          type: "payment_failed",
          summary: `Payment failed${props.status ? ` (${props.status})` : ""}`,
          ref: contractId,
          details: props,
          confidence: "direct",
        });
        break;
      case "portal.bootstrap":
        out.push({ at: e.created_at, type: "portal_login", summary: "Customer logged into portal", confidence: "direct" });
        break;
      case "ticket.created":
        out.push({ at: e.created_at, type: "ticket_created", summary: `Ticket created${e.summary ? `: ${e.summary}` : ""}`, confidence: "direct" });
        break;
      // Skip noise: customer.updated, subscription.updated cascades, email.sent
    }
  }
  return out;
}

function buildReturnTimelineEntries(returns: ReturnRow[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const r of returns) {
    out.push({
      at: r.created_at,
      type: "return_created",
      summary: `Return started for order ${r.order_number || "?"}${r.net_refund_cents ? ` (refund $${(r.net_refund_cents / 100).toFixed(2)})` : ""}`,
      ref: r.order_number || undefined,
      details: { return_id: r.id, status: r.status },
      confidence: "direct",
    });
    if (r.delivered_at) {
      out.push({ at: r.delivered_at, type: "return_delivered", summary: `Return for order ${r.order_number || "?"} delivered to warehouse`, ref: r.order_number || undefined, confidence: "direct" });
    }
    if (r.refunded_at) {
      out.push({
        at: r.refunded_at,
        type: "return_refunded",
        summary: `Return refund issued${r.net_refund_cents ? ` ($${(r.net_refund_cents / 100).toFixed(2)})` : ""} for order ${r.order_number || "?"}`,
        ref: r.order_number || undefined,
        confidence: "direct",
      });
    }
  }
  return out;
}

/**
 * Anomaly detectors — surface contradictions between customer framing
 * and ground truth. Stay neutral; describe facts, not fault. See
 * feedback_anomaly_framing_neutral.
 */
function detectAnomalies(orders: OrderRow[], subs: SubRow[], events: EventRow[], variantLookup: VariantLookup): Anomaly[] {
  const out: Anomaly[] = [];

  // ── subscription_changed_after_order_locked ──
  // For each subscription, find the most recent FULFILLED order that
  // shares a contract context. If the order's shipped variant differs
  // from the current sub variant, flag — the in-flight (or recently
  // delivered) shipment carries the original variant.
  for (const sub of subs) {
    const subVariants = (sub.items || []).map(i => i.variant_id).filter(Boolean).map(String);
    if (!subVariants.length) continue;

    // Find this sub's most recent variant-change event
    const changeEvent = events.find(e =>
      (e.event_type === "portal.items.swapped" || e.event_type === "subscription.updated") &&
      (e.properties as Record<string, unknown> | null)?.shopify_contract_id === sub.shopify_contract_id
    );

    // Find most recent fulfilled order for this customer
    const fulfilled = orders.find(o => o.fulfillment_status === "fulfilled");
    if (!fulfilled) continue;
    const shippedVariants = (fulfilled.line_items || []).map(li => li.variant_id).filter(Boolean).map(String);
    if (!shippedVariants.length) continue;

    const overlap = shippedVariants.some(v => subVariants.includes(v));
    if (overlap) continue; // variant matches — no anomaly

    // Was the sub changed between order placement and now?
    const subEditTs = sub.created_at ? Date.parse(sub.created_at) : 0;
    const orderTs = Date.parse(fulfilled.created_at);
    if (changeEvent || subEditTs > orderTs) {
      const shippedLabel = shippedVariants.map(v => variantLabel(v, variantLookup)).join(", ");
      const subLabel = subVariants.map(v => variantLabel(v, variantLookup)).join(", ");
      out.push({
        type: "subscription_changed_after_order_locked",
        severity: "info",
        summary: `Order ${fulfilled.order_number} shipped with ${shippedLabel}; subscription now lists ${subLabel}. Subscription was changed after the order entered fulfillment — once in the 3PL queue, in-flight orders cannot be redirected. Subscription change applies to future cycles.`,
        evidence: {
          order_number: fulfilled.order_number,
          shipped_variants: shippedVariants,
          shipped_label: shippedLabel,
          current_sub_variants: subVariants,
          current_sub_label: subLabel,
          order_placed_at: fulfilled.created_at,
          sub_contract_id: sub.shopify_contract_id,
        },
      });
    }
  }

  // ── charged_within_3d_no_fulfillment ──
  const now = Date.now();
  for (const o of orders) {
    if (o.financial_status !== "paid") continue;
    if (o.fulfillment_status === "fulfilled") continue;
    const age = now - Date.parse(o.created_at);
    if (age <= 3 * 24 * 60 * 60 * 1000) {
      out.push({
        type: "charged_within_3d_no_fulfillment",
        severity: "info",
        summary: `Order ${o.order_number} placed ${Math.floor(age / 86400000)}d ago, paid but not yet fulfilled. Normal processing window; no action needed unless customer specifically asks.`,
        evidence: { order_number: o.order_number, order_placed_at: o.created_at, financial_status: o.financial_status },
      });
    }
  }

  // ── multiple_active_subs_same_product ──
  const productCounts = new Map<string, { count: number; contracts: string[] }>();
  for (const sub of subs) {
    if (sub.status !== "active") continue;
    for (const it of sub.items || []) {
      if (!it.product_id) continue;
      const e = productCounts.get(String(it.product_id)) || { count: 0, contracts: [] };
      e.count += 1;
      e.contracts.push(sub.shopify_contract_id || sub.id);
      productCounts.set(String(it.product_id), e);
    }
  }
  for (const [productId, info] of productCounts.entries()) {
    if (info.count > 1) {
      out.push({
        type: "multiple_active_subscriptions_same_product",
        severity: "info",
        summary: `Customer has ${info.count} active subscriptions containing the same product (id ${productId}). These are legitimate separate subscriptions — charges are not double-billing. See feedback_no_double_billing_framing.`,
        evidence: { product_id: productId, contract_ids: info.contracts },
      });
    }
  }

  return out;
}

/**
 * Build a customer's timeline + anomaly list. `windowDays` controls how
 * far back to look (default 60 — most ticket-relevant context lives in
 * the last two months).
 */
export async function buildCustomerTimeline(
  workspaceId: string,
  customerId: string,
  options: { windowDays?: number } = {},
): Promise<CustomerTimeline> {
  const admin = createAdminClient();
  const windowDays = options.windowDays ?? 60;
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const linkedIds = await resolveLinkedCustomerIds(admin, customerId);
  const variantLookup = await buildVariantLookup(admin, workspaceId);

  const [customerRes, ordersRes, subsRes, eventsRes, returnsRes, dunningRes] = await Promise.all([
    admin.from("customers").select("id, email, first_name, last_name, ltv_cents, retention_score").eq("id", customerId).single(),
    admin.from("orders").select("id, order_number, created_at, total_cents, financial_status, fulfillment_status, line_items, fulfillments, tags").in("customer_id", linkedIds).gte("created_at", windowStart).order("created_at", { ascending: true }),
    admin.from("subscriptions").select("id, shopify_contract_id, status, items, next_billing_date, billing_interval, billing_interval_count, created_at, updated_at").in("customer_id", linkedIds),
    admin.from("customer_events").select("id, event_type, source, summary, properties, created_at").in("customer_id", linkedIds).gte("created_at", windowStart).order("created_at", { ascending: true }),
    admin.from("returns").select("id, order_number, status, net_refund_cents, delivered_at, refunded_at, created_at").in("customer_id", linkedIds).neq("status", "cancelled").gte("created_at", windowStart),
    admin.from("dunning_cycles").select("id, shopify_contract_id, status, started_at").in("customer_id", linkedIds).in("status", ["active", "skipped"]),
  ]);

  const customer = customerRes.data as CustomerRow | null;
  const orders = (ordersRes.data || []) as OrderRow[];
  const subs = (subsRes.data || []) as SubRow[];
  const events = (eventsRes.data || []) as EventRow[];
  const returns = (returnsRes.data || []) as ReturnRow[];
  const dunningCycles = (dunningRes.data || []) as Array<{ id: string; shopify_contract_id: string; status: string; started_at: string | null }>;

  // Build the timeline by merging all sources, then sort chronologically.
  const orderEntries = buildOrderTimelineEntries(orders, variantLookup);
  const eventEntries = buildEventTimelineEntries(events, orders, variantLookup);
  const returnEntries = buildReturnTimelineEntries(returns);
  const timeline = [...orderEntries, ...eventEntries, ...returnEntries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Detect anomalies
  const anomalies = detectAnomalies(orders, subs, events, variantLookup);

  // Dunning anomaly is data-tool driven, not order/sub driven — add separately
  if (dunningCycles.length) {
    for (const dc of dunningCycles) {
      anomalies.push({
        type: "dunning_active",
        severity: "info",
        summary: `Active dunning cycle (${dc.status}) on subscription contract ${dc.shopify_contract_id}. Customer may have a failed payment they haven't been notified about, or they may already know via the payment-update email.`,
        evidence: { contract_id: dc.shopify_contract_id, cycle_status: dc.status, started_at: dc.started_at },
      });
    }
  }

  const activeCount = subs.filter(s => s.status === "active").length;
  const pausedCount = subs.filter(s => s.status === "paused").length;
  const cancelledCount = subs.filter(s => s.status === "cancelled").length;
  const openReturns = returns.filter(r => r.status !== "refunded" && r.status !== "cancelled").length;

  return {
    customer: {
      id: customerId,
      email: customer?.email || null,
      name: customer ? [customer.first_name, customer.last_name].filter(Boolean).join(" ") || null : null,
    },
    linked_customer_ids: linkedIds,
    window_days: windowDays,
    current_state: {
      active_subscriptions: activeCount,
      paused_subscriptions: pausedCount,
      cancelled_subscriptions: cancelledCount,
      orders_in_window: orders.length,
      open_returns: openReturns,
      ltv_cents: customer?.ltv_cents || 0,
      retention_score: customer?.retention_score ?? null,
    },
    anomalies,
    timeline,
  };
}

/**
 * Compact one-line per entry, for orchestrator context. Skips redundant
 * fields, keeps timestamps minimal.
 */
export function timelineToText(t: CustomerTimeline): string {
  const lines: string[] = [];
  if (t.anomalies.length) {
    lines.push("=== ANOMALIES (read first) ===");
    for (const a of t.anomalies) {
      lines.push(`⚑ [${a.severity}] ${a.type}`);
      lines.push(`  ${a.summary}`);
    }
    lines.push("");
  }
  lines.push(`=== STATE ===`);
  lines.push(`Active subs: ${t.current_state.active_subscriptions} | Paused: ${t.current_state.paused_subscriptions} | Cancelled: ${t.current_state.cancelled_subscriptions}`);
  lines.push(`Orders in last ${t.window_days}d: ${t.current_state.orders_in_window} | Open returns: ${t.current_state.open_returns}`);
  lines.push(`LTV: $${(t.current_state.ltv_cents / 100).toFixed(2)} | Retention score: ${t.current_state.retention_score ?? "—"}`);
  lines.push("");
  lines.push(`=== TIMELINE (last ${t.window_days}d) ===`);
  for (const e of t.timeline) {
    const ts = new Date(e.at).toISOString().replace("T", " ").slice(0, 16);
    const conf = e.confidence === "reconstructed" ? " [reconstructed]" : "";
    lines.push(`${ts}  ${e.summary}${conf}`);
  }
  return lines.join("\n");
}
