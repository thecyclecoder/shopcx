import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "order-refund-ledger-read-tool",
    {
      title: "Give Sol and June a live Shopify refund-ledger read (out-of-band refunds become visible)",
      why:
        "A customer ticket on 2026-07-20 burned a Sol first-touch, a June review, AND a founder ruling for one reason: no agent can see a refund that was issued directly in Shopify. An $89.42 pricing-correction refund on order SC133086 never mirrored into our local refund table, so the returns tool reported $229.26 still owed while the order itself read as partially refunded — a contradiction that is genuinely unresolvable with the tools Sol and June have today. A single Shopify transactions read dissolves it: the order was charged $229.26, $89.42 came back already, so $139.84 remained. Checked across the four affected orders that day, our local refund mirror was empty for all four despite real Shopify refunds on three of them, because that mirror is only ever written when our own code fires a refund. It therefore cannot be the source of truth for what a customer has already been paid — Shopify has to be. Until an agent can read that, this class of ticket escalates to the founder every single time.",
      what:
        "A new read-only refund-ledger library that answers the one question resolving this whole class — what is ACTUALLY still refundable on this order right now — from the live Shopify transaction ledger, and that flags refunds present in Shopify but missing from our mirror. It is wired as a data tool Sol can call at first touch and folded into June's escalation brief, so this class resolves in-leash instead of climbing the ladder to the founder.",
      summary:
        "Add src/lib/refund-ledger.ts `getOrderRefundLedger(workspaceId, orderId)` — reads GET /admin/api/{SHOPIFY_API_VERSION}/orders/{shopify_order_id}/transactions.json via getShopifyCredentials (src/lib/shopify-sync.ts), returns { saleCents, refundedCents, refundableCents, outOfBandCents, refunds[] }, and reconciles each Shopify refund against public.order_refunds so out-of-band refunds are explicitly surfaced. Wire it as a Sonnet data tool alongside get_returns (src/lib/sonnet-orchestrator-v2.ts:174) and into the cs-director brief (scripts/builder-worker.ts runCsDirectorCallJob).",
      owner: "cs",
      parent:
        '[[../functions/cs]] — "Escalation triage quality" mandate: this closes a whole class of FALSE escalation. June correctly hit a rail on ticket 5ed394f3 because the refund ledger was invisible to her; giving Sol and June the live refundable balance means this class resolves at first touch and never reaches the founder.',
      blocked_by: [],
      human_review:
        "After ship, open a ticket for an order with a partial refund and confirm Sol's reasoning cites the real remaining refundable balance rather than the full order total.",
      phases: [
        {
          title: "Phase 1 — src/lib/refund-ledger.ts: the live refundable-balance read",
          why:
            "Every consumer downstream (Sol, June, and the self-healing return sweep) needs the SAME primitive: what is still refundable on this order, per the gateway, right now. Building it once as a read-only library keeps the Shopify call in one place and means the agents and the money-moving rail can never disagree about the number.",
          what:
            "A new read-only library that returns the order's sale total, everything Shopify has already refunded, the remaining refundable balance, and which of those refunds are missing from our local mirror.",
          body: [
            "Create `src/lib/refund-ledger.ts` exporting `getOrderRefundLedger(workspaceId: string, orderId: string)`.",
            "",
            "- `orderId` is the INTERNAL `orders.id` UUID (CLAUDE.md: internal joins use UUIDs, never `shopify_*_id`). Resolve the row scoped to `workspace_id`, then use its `shopify_order_id` for the API call. Return a typed miss (never throw) when the order is absent or has no `shopify_order_id`.",
            "- Read credentials via `getShopifyCredentials(workspaceId)` from `src/lib/shopify-sync.ts` and call `GET https://{shop}/admin/api/{SHOPIFY_API_VERSION}/orders/{shopify_order_id}/transactions.json` (`SHOPIFY_API_VERSION` from `src/lib/shopify.ts:3`).",
            "- Compute from the transaction list: `saleCents` (sum of successful `kind='sale'`/`capture`), `refundedCents` (sum of successful `kind='refund'`), `refundableCents = max(0, saleCents - refundedCents)`.",
            "- Reconcile against `public.order_refunds` for the same `order_id`: mark each Shopify refund `mirroredLocally` when a mirror row matches on amount, and sum the unmatched into `outOfBandCents`. This is the field that makes an out-of-band refund VISIBLE — it is the exact signal that was missing on SC133086.",
            "- Return `{ ok, saleCents, refundedCents, refundableCents, outOfBandCents, refunds: [{ amountCents, gateway, processedAt, mirroredLocally }] }`. STRICTLY READ-ONLY — this library must never mutate; it performs no writes and issues no refund.",
            "- Reuse the pending-refund signal already modelled by `findPendingRefundTxn` (src/lib/shopify-order-actions.ts:71) so a gateway refund still settling is reported rather than counted as headroom.",
            "",
            "Per CLAUDE.md, a new library file requires a brain page in the same PR — add `docs/brain/libraries/refund-ledger.md` (exports, signature, callers) and link it from `docs/brain/tables/order_refunds.md`.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- `getOrderRefundLedger` is exported from src/lib/refund-ledger.ts.",
            "- The remaining-balance field `refundableCents` exists.",
            "- The out-of-band signal `outOfBandCents` exists.",
            "- The brain page for the new library exists.",
            "- The library performs no writes (no .update/.insert/.upsert on returns or order_refunds).",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "getOrderRefundLedger is exported",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "export async function getOrderRefundLedger", path: "src/lib/refund-ledger.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the remaining-refundable field exists",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "refundableCents", path: "src/lib/refund-ledger.ts", expect: "present" },
            },
            {
              position: 4,
              description: "the out-of-band refund signal exists",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "outOfBandCents", path: "src/lib/refund-ledger.ts", expect: "present" },
            },
            {
              position: 5,
              description: "brain page for the new library exists",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "getOrderRefundLedger", path: "docs/brain/libraries/refund-ledger.md", expect: "present" },
            },
            {
              position: 6,
              description: "library is read-only — no refund mutation",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "partialRefundByAmount|refundOrder\\(", path: "src/lib/refund-ledger.ts", expect: "absent" },
            },
          ],
        },
        {
          title: "Phase 2 — expose the ledger to Sol and to June's brief",
          why:
            "The library only pays off when the agents can actually see it. Sol needs it at first touch so this class never escalates; June needs it in her brief so that when something DOES reach her, she rules on the real number instead of hitting a rail. Ticket 5ed394f3 proves both seats were blind to the same fact.",
          what:
            "A `get_order_refund_ledger` data tool on the Sonnet orchestrator, and the same ledger summary rendered into the cs-director brief for every order attached to an escalated ticket.",
          body: [
            "1. Register a `get_order_refund_ledger` data tool in `src/lib/sonnet-orchestrator-v2.ts` next to the existing `get_returns` (:174) / `get_payment_methods` (:204) tools, with a handler that calls `getOrderRefundLedger` and returns the compact shape. CLAUDE.md: a customer-referenced surface gets a Sonnet data tool.",
            "   - The tool description must state plainly that `refundableCents` is the ceiling for any refund on that order and that `outOfBandCents > 0` means someone refunded outside ShopCX — the two facts that would have resolved Jim's ticket at first touch.",
            "2. Add the same ledger summary to the cs-director brief built in `scripts/builder-worker.ts` (`runCsDirectorCallJob`), for each order linked to the escalated ticket, so June rules with the real refundable balance in front of her.",
            "3. Update `docs/brain/orchestrator-tools.md` with the new tool and its contract.",
            "",
            "Do NOT give either seat a write path here — this phase is read-only visibility. Acting on the number is the existing remedy flow.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- The `get_order_refund_ledger` tool is registered on the Sonnet orchestrator.",
            "- The orchestrator test suite still passes.",
            "- The cs-director test suite still passes.",
            "- The tool is documented in the brain's orchestrator-tools page.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "get_order_refund_ledger is registered as a Sonnet data tool",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "get_order_refund_ledger", path: "src/lib/sonnet-orchestrator-v2.ts", expect: "present" },
            },
            {
              position: 3,
              description: "orchestrator suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:sonnet-orchestrator" },
            },
            {
              position: 4,
              description: "cs-director suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:cs-director" },
            },
            {
              position: 5,
              description: "the new tool is documented in the brain",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "get_order_refund_ledger", path: "docs/brain/orchestrator-tools.md", expect: "present" },
            },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "cs#escalation-triage-quality",
    },
  );
  console.log(ok ? "authored: order-refund-ledger-read-tool" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
