/**
 * Follow-up to refund-idempotency-guard-in-commerce-refund-facade (PR #1265,
 * building). That spec creates the order_refunds ledger with a post-success
 * mirror insert — so it records refunds going FORWARD but starts EMPTY. To make
 * the ledger the source of truth for "have we refunded X / any internal orders"
 * historically, backfill it from the two places refunds live today: the returns
 * table (structured) and customer_events order.refunded rows (lossy). Authored
 * as a follow-up (not an edit) because the base spec is already building.
 * retention-owned, blocked_by the base spec. Lands in_review.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const s = await authorSpecRowStructured(
    WS,
    "backfill-order-refunds-ledger-from-history",
    {
      title: "Backfill the order_refunds ledger from historical refunds so past refunds are auditable too",
      why: "The refund-idempotency spec creates the order_refunds ledger with a post-success mirror insert — it captures every refund from the moment it ships, but the table starts empty, so the whole refund history stays trapped where it lives today: structured on the returns table (net_refund_cents / refund_id / refunded_at) and unstructured on customer_events order.refunded rows (a 2026-07-07 scan found 249 such events, most missing method and amount). Without a backfill, a question like 'have we ever refunded an internal order' can be answered for the future but not the past. Backfill is cheap (the history is small) and makes order_refunds the single source of truth for refunds, past and present. Note: this is an AUDIT backfill, not an idempotency one — it does not retroactively guard already-completed refunds (those are done); it makes them visible.",
      what: "A one-time, idempotent backfill that populates order_refunds from the two historical refund sources — the returns table (high-confidence structured rows) and customer_events order.refunded (best-effort, collapsing double-logs and flagging rows too lossy to fully recover) — with each backfilled row tagged as a backfill and its vendor/internal-vs-Shopify derived from the order, so historical refunds become queryable in the same ledger new refunds land in.",
      summary: "**Brain refs:** [[../tables/order_refunds]] [[../tables/returns]] [[../tables/customer_events]] [[../libraries/refund]]. **Derived-from-ticket:** 49ddd6c4 (the refund audit gap surfaced here). Follows [[../specs/refund-idempotency-guard-in-commerce-refund-facade]] (PR #1265 — creates order_refunds + the mirror insert). Grounded in the 2026-07-07 scan: 249 customer_events order.refunded rows, 242 with method='?'/no amount, exactly 1 attributable to an internal (Braintree) order; returns table carries net_refund_cents + refund_id + refunded_at for return-driven refunds; orders has no refund-amount column (only a Shopify-sourced financial_status).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: the refunds ledger is the complete audit record — historical refunds are queryable there, not only future ones.',
      blocked_by: ["refund-idempotency-guard-in-commerce-refund-facade"],
      phases: [
        {
          title: "Phase 1 — backfill from the returns table (structured, high-confidence)",
          why: "Return-driven refunds already have clean structured data (amount, refund_id, timestamp), so they backfill into the ledger losslessly and cover the well-recorded slice of history first.",
          what: "Every returns row with a refund (refunded_at / refund_id set) gets a corresponding order_refunds row — order, amount from net_refund_cents, vendor/internal derived from the order, the existing refund_id, status settled, tagged as a backfill — idempotent so re-running inserts nothing new.",
          body: "For each returns row where refunded_at is not null (net_refund_cents, refund_id, order_id, refunded_at), insert an order_refunds row: order_id, amount_cents = net_refund_cents, vendor derived from the order (Shopify vs internal via shopify_order_id), vendor_refund_id = refund_id, status = 'settled', a stable request_key (e.g. hashActionRefundKey('return', return_id, order_id, amount_cents, reason-or-'return')) and a source='backfill' marker. Idempotent: skip if an order_refunds row already exists for that (workspace_id, order_id, request_key) — so it composes with the base spec's live mirror (a return refunded AFTER the base ships is already in the ledger and must not be duplicated). Cite the returns refund columns + order_refunds.",
          verification: "After backfill, every returns row with refunded_at has exactly one matching order_refunds row (amount = net_refund_cents, correct vendor, source='backfill'). Re-running the backfill inserts zero additional rows (idempotent). A return refunded post-base-ship (already mirrored live) is not duplicated.",
          status: "planned",
        },
        {
          title: "Phase 2 — best-effort backfill from customer_events; flag the unrecoverable",
          why: "Direct/partial refunds not tied to a return live only in customer_events, which is lossy — recovering what we can (and explicitly flagging what we can't) is better than leaving that history invisible, and it surfaces exactly how incomplete the pre-ledger record was.",
          what: "customer_events order.refunded rows not already represented (by a returns backfill or a live mirror row) become order_refunds rows where enough data exists (order ref + amount), collapsing duplicate logs of the same refund_id, and rows too lossy to attribute (no amount/method) are counted and logged rather than silently dropped.",
          body: "For each customer_events order.refunded row, resolve the order (properties.order_id or order_number) and, where amount_cents + a refund identity exist, upsert an order_refunds row (source='backfill', vendor/internal derived from the order, status='settled') keyed on a stable request_key so multiple event-logs of the SAME refund_id collapse to one row and anything already in the ledger (returns backfill or live mirror) is skipped. Rows with method='?'/no amount are NOT fabricated — count and log them as unrecoverable-from-events so the coverage gap is explicit (no silent truncation). Cite customer_events order.refunded + order_refunds.",
          verification: "A recoverable customer_events refund (order ref + amount) yields one order_refunds row; N event-logs of the same refund_id collapse to a single row. Rows already covered by Phase 1 or the live mirror are not duplicated. The count of unrecoverable (lossy) events is reported, not hidden. A post-backfill query can total historical refunds and internal-order refunds from order_refunds alone.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log("backfill spec:", s ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
