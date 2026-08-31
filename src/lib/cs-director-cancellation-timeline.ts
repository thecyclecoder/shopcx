/**
 * Per-contract cancellation timeline for the CS Director's brief.
 *
 * The CS Director cannot check charge-vs-cancel ordering she cannot see. Ticket
 * f773b8ec (bonnie marlette, 2026-08-21) is the ground truth: contract
 * 27806990509 cancelled at 2026-07-17T08:39:51, thirty-six minutes AFTER the
 * last renewal billed at 08:03:45 — every "post-cancel renewal" was an ordinary
 * pre-cancel charge. The cancel moment lived in `billing_forecast_events` the
 * whole time and was never surfaced.
 *
 * `buildCancellationTimeline` merges each subscription's cancel timestamp,
 * `billing_forecast_events` rows, and orders into ONE chronological sequence
 * per contract so charge_at vs cancelled_at is readable in a glance. The
 * cs-director-call skill's mandatory cancelled-but-charged rule reads this
 * directly.
 *
 * Pure function — no I/O. The caller pre-loads the three arrays; the library
 * merges and sorts them so it is unit-testable against fixed fixtures.
 */

export interface CancellationTimelineSubscription {
  id: string;
  shopify_contract_id: string | null;
  status: string | null;
  cancelled_at: string | null;
}

export interface CancellationTimelineEvent {
  shopify_contract_id: string | null;
  event_type: string;
  created_at: string;
  forecast_date?: string | null;
  delta_cents?: number | null;
  description?: string | null;
}

export interface CancellationTimelineOrder {
  order_number: string | null;
  shopify_order_id?: string | null;
  created_at: string;
  total_cents?: number | null;
  financial_status?: string | null;
  subscription_id?: string | null;
  shopify_contract_id?: string | null;
}

export type TimelineRowKind = "forecast_event" | "order" | "cancellation";

export interface TimelineRow {
  at: string;
  kind: TimelineRowKind;
  label: string;
  is_cancellation: boolean;
  is_charge: boolean;
}

export interface SubscriptionCancellationTimeline {
  subscription_id: string;
  shopify_contract_id: string | null;
  cancelled_at: string | null;
  rows: TimelineRow[];
  truncated: boolean;
  post_cancellation_charges: number;
}

export const CANCELLATION_TIMELINE_EVENT_CAP = 20;

const CANCELLATION_EVENT_TYPE = "cancellation";
const BILLING_SUCCESS_EVENT_TYPE = "billing_success";

function fmtDelta(cents: number | null | undefined): string {
  if (!cents) return "";
  return ` $${(Math.abs(cents) / 100).toFixed(2)}`;
}

function eventLabel(e: CancellationTimelineEvent): string {
  const parts: string[] = [e.event_type];
  const money = fmtDelta(e.delta_cents ?? null);
  if (money) parts.push(money.trim());
  if (e.forecast_date) parts.push(`forecast ${e.forecast_date}`);
  if (e.description) parts.push(`— ${String(e.description).slice(0, 120)}`);
  return parts.join(" ");
}

function orderLabel(o: CancellationTimelineOrder): string {
  const num = o.order_number ? `#${o.order_number}` : "(order)";
  const money = o.total_cents != null ? ` $${(o.total_cents / 100).toFixed(2)}` : "";
  const status = o.financial_status ? ` ${o.financial_status}` : "";
  return `ORDER ${num}${money}${status}`.trim();
}

export function buildCancellationTimeline(input: {
  subscriptions: CancellationTimelineSubscription[];
  events: CancellationTimelineEvent[];
  orders: CancellationTimelineOrder[];
  eventCap?: number;
}): SubscriptionCancellationTimeline[] {
  const cap = input.eventCap ?? CANCELLATION_TIMELINE_EVENT_CAP;

  return input.subscriptions.map((sub) => {
    const subEvents = sub.shopify_contract_id
      ? input.events.filter((e) => e.shopify_contract_id === sub.shopify_contract_id)
      : [];
    const subOrders = input.orders.filter((o) => {
      if (o.subscription_id && o.subscription_id === sub.id) return true;
      if (sub.shopify_contract_id && o.shopify_contract_id === sub.shopify_contract_id) return true;
      return false;
    });

    const rows: TimelineRow[] = [];

    for (const e of subEvents) {
      const isCancel = e.event_type === CANCELLATION_EVENT_TYPE;
      const isCharge = e.event_type === BILLING_SUCCESS_EVENT_TYPE;
      rows.push({
        at: e.created_at,
        kind: isCancel ? "cancellation" : "forecast_event",
        label: eventLabel(e),
        is_cancellation: isCancel,
        is_charge: isCharge,
      });
    }

    for (const o of subOrders) {
      rows.push({
        at: o.created_at,
        kind: "order",
        label: orderLabel(o),
        is_cancellation: false,
        is_charge: true,
      });
    }

    const hasCancelRow = rows.some((r) => r.is_cancellation);
    if (sub.cancelled_at && !hasCancelRow) {
      rows.push({
        at: sub.cancelled_at,
        kind: "cancellation",
        label: "cancellation (from subscriptions.cancelled_at)",
        is_cancellation: true,
        is_charge: false,
      });
    }

    rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

    const cancelIso =
      sub.cancelled_at ?? rows.find((r) => r.is_cancellation)?.at ?? null;
    const postCancelCharges = cancelIso
      ? rows.filter((r) => r.is_charge && r.at > cancelIso).length
      : 0;

    let truncated = false;
    let capped = rows;
    if (rows.length > cap) {
      truncated = true;
      capped = rows.slice(-cap);
    }

    return {
      subscription_id: sub.id,
      shopify_contract_id: sub.shopify_contract_id,
      cancelled_at: sub.cancelled_at,
      rows: capped,
      truncated,
      post_cancellation_charges: postCancelCharges,
    };
  });
}

export function formatCancellationTimelineForBrief(
  timelines: SubscriptionCancellationTimeline[],
): string {
  if (!timelines.length) {
    return "CANCELLATION TIMELINE: no subscriptions on this customer.";
  }
  const lines: string[] = [];
  lines.push(
    "CANCELLATION TIMELINE (per contract; chronological — a cancelled-but-charged claim REQUIRES charge_at > cancelled_at, cite both timestamps from here):",
  );
  for (const t of timelines) {
    const truncNote = t.truncated
      ? ` · truncated to most recent ${CANCELLATION_TIMELINE_EVENT_CAP} rows`
      : "";
    lines.push(
      `  contract ${t.shopify_contract_id ?? "(none)"} · sub ${t.subscription_id} · cancelled_at ${
        t.cancelled_at ?? "(never)"
      } · post-cancellation charges: ${t.post_cancellation_charges}${truncNote}`,
    );
    if (!t.rows.length) {
      lines.push("    (no forecast events or orders)");
      continue;
    }
    for (const r of t.rows) {
      const marker = r.is_cancellation ? "CANCELLED" : r.kind === "order" ? "→ CHARGE" : "·";
      lines.push(`    ${marker} ${r.at.slice(0, 19)} — ${r.label}`);
    }
  }
  return lines.join("\n");
}
