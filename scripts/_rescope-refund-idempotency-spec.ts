/**
 * Re-scope + un-stall the refund idempotency spec after the 2026-07-07
 * investigation: the order_refunds mirror + requestKey guard built on the
 * guaranteed-ticket-handling goal branch did NOT reach main — the commerce-SDK
 * refactor stubbed src/lib/commerce/refund.ts ("implementations arrive in M2c")
 * and issueRefund was never built, so request-level refund idempotency is
 * currently ABSENT on main. partial_refund → refundOrder has no dedup; a repeat
 * fire (retry / duplicate orchestrator turn / double-click) with no open return
 * row double-refunds. The old spec targeted the non-existent issueRefund facade
 * and had Phase 1 falsely marked shipped. Restore the guard at the REAL choke
 * point (refundOrder — every refund path resolves there), buildable now. All
 * phases reset to planned. retention-owned. Upserts the existing slug in place.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const s = await authorSpecRowStructured(
    WS,
    "refund-idempotency-guard-in-commerce-refund-facade",
    {
      title: "Restore request-level refund idempotency at the refundOrder choke point (it is currently absent on main)",
      why: "A 2026-07-07 investigation found request-level double-refund protection is NOT live on main. The order_refunds mirror plus request-key guard was built on the guaranteed-ticket-handling goal branch, but the commerce-SDK refactor stubbed the commerce refund facade (a placeholder whose comment says implementations arrive later) and the issueRefund facade was never built — so the guard reached neither main nor a real choke point. Today the orchestrator's partial_refund handler resolves an order and calls refundOrder with no dedup at all; the only guard that exists is a narrow returns-table stamp that stops the returns pipeline from also refunding an open return, which does nothing for a repeated price-adjustment refund that has no return row. So a refund action that fires twice — an Inngest retry, a duplicate orchestrator turn, an operator double-click — refunds the customer twice. The original spec aimed to move the guard into a facade that does not exist; the real fix is to put the guard where every refund path already converges.",
      what: "A first-class refunds ledger table that records EVERY refund (order, internal-vs-gateway, amount, reason, refund_id, request key, status, timestamps) — so the business can finally audit 'have we refunded this / any internal orders' — AND enforces idempotency: the dedup check lives INSIDE refundOrder, the single choke point every refund path (partial_refund, redeem_points, the replacement-order refund half, returns) already resolves to, so a duplicate refund request for the same order, amount, and reason fires the gateway once and every repeat short-circuits to the prior result. Today refunds have no structured record at all — customer_events is lossy (most rows carry no method/amount), which is why we can't currently answer that audit question. When the commerce issueRefund facade is eventually built, it calls refundOrder and inherits both the ledger and the guard for free.",
      summary: "**Brain refs:** [[../libraries/action-executor]] [[../tables/order_refunds]]. **Investigation 2026-07-07:** order_refunds / hashRefundRequestKey / requestKey symbols are ABSENT from src on main; git shows refund-integrity phases merged only into goal/guaranteed-ticket-handling, and src/lib/commerce/refund.ts is an `export {}` stub. Grounded in: src/lib/refund.ts refundOrder (~:134 — the choke point per its own header 'every refund path resolves to refundOrder'; its existing double-refund guard only stamps open returns rows ~:230), src/lib/action-executor.ts partial_refund (~:1033, no request-level dedup) + redeem_points + create_replacement_order refund half, src/lib/commerce/refund.ts (stub — issueRefund not built). Supersedes the original facade-targeted scope (issueRefund does not exist).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: every refund path is guarded against double-refund at one real choke point that exists on main today.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — the refunds ledger table + request key + guard inside refundOrder",
          why: "refundOrder is where every refund path already converges, so a ledger + guard there covers all callers automatically and does not depend on the unbuilt commerce facade. It is also the durable audit record refunds have never had — today customer_events can't answer 'have we refunded any internal orders' (most rows lack method/amount).",
          what: "A first-class refunds ledger recording every refund (with an is_internal / gateway flag so internal-vs-Shopify is auditable) plus a request key; before dispatching to the gateway, refundOrder looks up a prior succeeded/settled row for that key and short-circuits to a success result if found, else records the refund.",
          body: "Add the order_refunds ledger table via migration — workspace_id, order_id, request_key, amount_cents, reason, gateway ('braintree'|'shopify'), is_internal (order has no shopify_order_id), refund_id, status ('succeeded'|'settled'|'failed'), timestamps — with a unique index on (workspace_id, order_id, request_key). AUTHOR the brain page (docs/brain/tables/order_refunds.md — none exists today; this table is the source of truth for 'have we refunded X'). In src/lib/refund.ts refundOrder: accept an optional requestKey in RefundOrderOptions; when absent compute it deterministically from (order_id, amount_cents, reason). Before the gateway dispatch (~:170), look up the ledger by (workspace_id, order_id, request_key) in ('succeeded','settled') and short-circuit to a success result if present; on a fresh refund insert the row (capturing is_internal from the order's shopify_order_id) and stamp its final status + refund_id after the gateway returns — so EVERY refund lands in the ledger, not just deduped ones. Keep the existing returns-stamp double-refund guard (~:230) — a different collision. Cite refundOrder's dispatch + the new table.",
          verification: "Calling refundOrder twice for the same (order, amount, reason) fires the gateway ONCE — the second returns success via the ledger short-circuit (integration test, stubbed gateway asserts one call). A distinct amount or reason is NOT short-circuited. The unique index rejects a duplicate (workspace_id, order_id, request_key). Every successful refund writes exactly one ledger row with the correct is_internal flag (a query can now count internal-order refunds). The returns-stamp guard still fires for return-vs-direct collisions.",
          status: "planned",
        },
        {
          title: "Phase 2 — pass stable request keys from the handlers; close the retry gap",
          why: "With the guard in refundOrder, the handlers just need to pass a stable key tied to the action so an Inngest retry or a duplicate orchestrator turn reuses the same key and short-circuits instead of double-refunding.",
          what: "partial_refund, redeem_points, and the create_replacement_order refund half pass a stable requestKey (e.g. derived from ticket + order + amount) into refundOrder, so a repeat of the same logical action is idempotent end-to-end.",
          body: "In src/lib/action-executor.ts, partial_refund (~:1051), redeem_points_as_refund, and create_replacement_order's refund half pass an explicit requestKey derived from the stable action identity (ticket_id + order_id + amount_cents + reason) into refundOrder's options, so a retried step reuses the key. Verify the returns Inngest refund path (returnsIssueRefund) also routes through refundOrder so it shares the ledger. Cite the refund handlers + the returns refund step.",
          verification: "Re-firing partial_refund (same ticket, order, amount) does NOT double-refund — the second resolves via the ledger short-circuit (integration test per handler). A replacement-order refund retried does not double-refund. The returns refund path writes to the same order_refunds ledger. grep confirms every refund caller supplies or inherits a request key.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log("refund spec re-scoped + reset:", s ? "ok" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
