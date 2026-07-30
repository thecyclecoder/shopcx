import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "self-healing-return-refund-rail",
    {
      title: "Self-healing return refunds — cap against the live ledger, fail loud, and sweep the stuck ones",
      why:
        "On 2026-07-20 four returns were found that had been received back at the warehouse and then never refunded. Three had been sitting between 41 and 55 days, and every one failed a DIFFERENT silent way: one had a null order reference so the refund call was rejected outright; one had a stored refund amount larger than what the gateway would still allow, because two small refunds had landed on that order a month earlier; one had actually already been refunded in full by hand, so only our own record was wrong; and the fourth was the customer who finally emailed us. Two real customers were short a combined $136.91 and the only reason anyone found out is that one of them wrote in. The rail cannot heal itself today: refund failures are returned as values rather than thrown, so the built-in retries never engage; the only artifact of a failure is a dashboard row nothing ever reads; there is no sweep looking for received-but-unrefunded returns; and the function that actually moves the money has neither a heartbeat nor a monitoring entry, so a total outage of it would be invisible. We promise customers in writing that their refund is automatic once the return scans back. Right now that promise depends on a customer noticing it was broken.",
      what:
        "The refund step reconciles against the live gateway ledger before it moves money — capping to what is actually refundable, stamping returns whose money already moved out of band instead of double-paying them, and repairing a missing order reference rather than dying on it. Failures become loud (thrown, retried, escalated) instead of silent. A daily sweep finds any return that was received but never refunded, reconciles it, and either completes it or escalates — so no customer ever has to email us to be paid back.",
      summary:
        "Harden src/lib/inngest/returns.ts `returnsIssueRefund`: reconcile via `getOrderRefundLedger` (src/lib/refund-ledger.ts) before dispatch, cap `net_refund_cents` at `refundableCents`, stamp out-of-band-refunded returns instead of re-refunding, and resolve a null `returns.order_id` from `shopify_order_gid`. Throw on failure so `retries: 2` engages. Close the EasyPost webhook gaps in src/app/api/webhooks/easypost/route.ts (`available_for_pickup` sets delivered at :161 but the event only fires for `delivered` at :195; the raw inn.gs fetch at :198 checks neither response status nor the preceding returns update at :190). Add the missing `returns-issue-refund` heartbeat + MONITORED_LOOPS entry (src/lib/control-tower/registry.ts has only `returns-process-delivery` at :1044) and a daily reconcile sweep.",
      owner: "retention",
      parent:
        '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: a refund that silently never lands is a billing-integrity failure of exactly the kind this mandate drives to zero, and Retention already owns the return-pipeline lifecycle and the returns-process-delivery loop.',
      blocked_by: ["order-refund-ledger-read-tool"],
      human_review:
        "After ship, confirm on the Control Tower that returns-issue-refund reports a heartbeat, and that the daily sweep's first run reports zero unreconciled returns.",
      phases: [
        {
          title: "Phase 1 — reconcile against the live ledger before moving money",
          why:
            "Each of the four stuck returns needed a different decision, and all four are decidable from one fact: what the gateway says is still refundable on that order. Without that read the rail either over-fires and gets refused, or would double-pay a customer whose refund already happened by hand. This is also the phase that makes a sweep safe to build at all — re-driving blindly would have handed one of those customers a second $133.62.",
          what:
            "Before dispatching a refund, the rail reads the live refundable balance and decides: pay the capped amount, or stamp the return as already-settled, or repair a missing order link — instead of firing a stale stored number at the gateway.",
          body: [
            "In `src/lib/inngest/returns.ts` `returnsIssueRefund`, before the `refundOrder` dispatch (currently the `issue-refund` step at :186), call `getOrderRefundLedger(workspace_id, ret.order_id)` from `src/lib/refund-ledger.ts` and branch:",
            "",
            "- **Null `returns.order_id`** — resolve it from `returns.shopify_order_gid` (trailing numeric id → `orders.shopify_order_id`, scoped to the workspace) and persist it, THEN continue. This is the SC131156 failure: `refundOrder` returns `orderId is required` and the return dies. Only the internal UUID is used for the join itself (CLAUDE.md: internal joins use UUIDs).",
            "- **`refundableCents === 0` and `refundedCents >= net_refund_cents`** — the money already moved outside ShopCX. STAMP the return (`status='refunded'`, `refunded_at=now()`, `refund_id='out_of_band_shopify'`) with a compare-and-set on `.is('refunded_at', null)` and issue NO refund. This is the SC130193 case and it is the one that makes a blind re-drive dangerous.",
            "- **`0 < refundableCents < net_refund_cents`** — refund `refundableCents` (the CAP) and record the shortfall on the return row for audit. This is the SC133086 / SC129432 case.",
            "- **`refundableCents >= net_refund_cents`** — unchanged behaviour, refund the stored contract.",
            "",
            "**Invariant to respect, do not break it.** `docs/brain/tables/returns.md` states: `net_refund_cents` is the contract — set at return-creation; never re-derive at refund time. That rule exists because an earlier pipeline recomputed the amount from line items + tax + label cost and drifted (`docs/brain/lifecycles/return-pipeline.md`). This phase does NOT re-derive intent: the stored contract remains the intent and is never raised, only CAPPED by what the gateway will still allow. Update both brain pages to state the refined rule — the contract is the intent, the live ledger is the ceiling.",
            "",
            "Money-moves-once is already guaranteed by `refundOrder`'s `request_key` pre-dispatch guard (src/lib/refund.ts), so this branch is safe under Inngest step retries.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- The refund step consults the live ledger before dispatch.",
            "- The out-of-band settled case is handled without firing a refund.",
            "- The refund-guard suite still passes.",
            "- The commerce refund suite still passes.",
            "- The brain's returns table page reflects the refined contract-vs-ceiling rule.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the refund step reads the live ledger",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "getOrderRefundLedger", path: "src/lib/inngest/returns.ts", expect: "present" },
            },
            {
              position: 3,
              description: "out-of-band settled returns are stamped, not re-refunded",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "out_of_band_shopify", path: "src/lib/inngest/returns.ts", expect: "present" },
            },
            {
              position: 4,
              description: "refund-guard suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:refund-guard" },
            },
            {
              position: 5,
              description: "commerce refund suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:commerce-refund" },
            },
            {
              position: 6,
              description: "brain records the contract-vs-ceiling rule",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "ceiling", path: "docs/brain/tables/returns.md", expect: "present" },
            },
          ],
        },
        {
          title: "Phase 2 — make every failure loud: throw, heartbeat, monitor, and close the webhook gaps",
          why:
            "Today a refund failure produces one dashboard row that nothing consumes, and the code returns the failure instead of throwing it, so the two configured retries are dead code on every real failure path. The function that actually moves money has no heartbeat and no monitoring entry at all, so a total outage of it looks exactly like a quiet week. On top of that the delivery webhook has a guaranteed-stuck path: one carrier status marks a return delivered but never fires the event that triggers the refund. A node without a switch, a heartbeat, and an owner is incomplete by our own hard rule — this one moves customer money.",
          what:
            "Refund and store-credit failures throw so retries engage and exhaustion escalates; the refund function gets its heartbeat and monitoring entry; and the delivery webhook stops silently dropping deliveries on the floor.",
          body: [
            "1. **Throw, don't return.** In `src/lib/inngest/returns.ts` `returnsIssueRefund`, the refund-failed (:205) and store-credit-failed (:175) branches capture failures as return values inside `step.run`, so Inngest's `retries: 2` never engages. Throw instead so the step retries; on final exhaustion escalate rather than writing the row back to the stuck shape (`status='delivered'`, `refunded_at` null) at :231.",
            "2. **Heartbeat + monitoring (CLAUDE.md node-completeness trio).** `returnsIssueRefund` has no `emitReactiveHeartbeat` (its sibling `returnsProcessDelivery` does, at :80) and `src/lib/control-tower/registry.ts` `MONITORED_LOOPS` has no entry for it — only `returns-process-delivery` at :1044. Add the end-of-run heartbeat in a try/finally, a `MONITORED_LOOPS` row (kind `reactive`, owner `retention`), and confirm kill-switch ancestry.",
            "3. **Close the EasyPost webhook gaps** in `src/app/api/webhooks/easypost/route.ts`:",
            "   - `available_for_pickup` sets `status='delivered'` + `delivered_at` at :161-163, but the event fire at :195 is gated on `trackerStatus === 'delivered'` only — a guaranteed permanently-stuck return. Fire for both.",
            "   - The `returns` update at :190 has its error unchecked; the code proceeds to fire the event regardless. Check it and bail loudly.",
            "   - The event is sent by a raw `fetch` to inn.gs at :198 whose response status is never inspected, whose throw is swallowed to `console.error`, and which sends nothing at all when the event key is unset — while still returning 200 so the carrier never retries. Use the `inngest` client (as `returnsProcessDelivery` itself does) and fail loudly.",
            "",
            "Do NOT change the delivery-detection semantics beyond the above — the goal is that a delivery can no longer be silently lost, not a redesign of the tracker mapping.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- returns-issue-refund has a MONITORED_LOOPS entry.",
            "- The refund function emits an end-of-run heartbeat.",
            "- The delivery webhook no longer sends the event via a raw inn.gs fetch.",
            "- The registry's invariant assertions still hold and the app builds.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "returns-issue-refund is registered in MONITORED_LOOPS",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "returns-issue-refund", path: "src/lib/control-tower/registry.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the refund function heartbeats",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "returns-issue-refund", path: "src/lib/inngest/returns.ts", expect: "present" },
            },
            {
              position: 4,
              description: "the raw inn.gs fetch is gone from the EasyPost webhook",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "inn\\.gs", path: "src/app/api/webhooks/easypost/route.ts", expect: "absent" },
            },
            {
              position: 5,
              description: "registry invariants hold at import (node-registry drift check)",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "check:node-registry-drift" },
            },
          ],
        },
        {
          title: "Phase 3 — the daily sweep that makes it self-healing",
          why:
            "Phases 1 and 2 stop NEW returns from getting stuck and make a stuck one visible. Neither rescues a return that is already stranded, and something always strands eventually — a carrier webhook that never arrives, a gateway blip, a human marking a return delivered in the dashboard through a path that fires no event. Our own brain page documents the exact query for finding these and nothing in production runs it. The whole point is that no customer should ever have to email us to be paid back.",
          what:
            "A daily reconciler that finds every return received but not refunded, decides each one against the live ledger, completes what it safely can, and escalates the rest to the founder with a real diagnosis.",
          body: [
            "Add an Inngest cron that finds returns where `status='delivered'` AND `refunded_at IS NULL` AND `easypost_shipment_id IS NOT NULL` — the exact query `docs/brain/tables/returns.md` already documents as a common query, with the `easypost_shipment_id` filter that `docs/brain/lifecycles/return-pipeline.md` mandates so Shopify-native returns we do not own the refund for are excluded.",
            "",
            "- For each hit, run the SAME Phase-1 reconcile (cap / stamp / repair-order-id) and re-drive via `returns/issue-refund`. Re-driving is safe because `refundOrder`'s `request_key` guard means the money can only move once.",
            "- Also cover the returns stranded UPSTREAM of delivery: `status IN ('label_created','in_transit')` with an `easypost_shipment_id`, aged past a threshold — `scripts/returns-spot-check.ts` already proves EasyPost holds the truth when our webhook missed it. Reuse that reconcile rather than re-implementing it, and do not hard-code a workspace the way that script does.",
            "- Anything the sweep CANNOT safely resolve (no billable transaction, an amount that cannot be reconciled, a return with no order) escalates as a founder card with the concrete diagnosis and the amount — never a bare 'needs review'.",
            "- Cadence + monitoring must satisfy the CLAUDE.md monitor-cadence invariant: a daily cron needs a 30h liveness window, and the run needs the heartbeat + `MONITORED_LOOPS` row + kill-switch ancestry trio.",
            "- Log the count it swept, the count it healed, and the count it escalated, so a silent zero-work run is distinguishable from a broken one.",
            "",
            "Brain, in the same PR: update `docs/brain/lifecycles/return-pipeline.md` — its 'Known gaps / not yet shipped: None identified' line is false as written, and its Phase-4 'do not retry blindly; manual fix path' guidance is superseded by the reconcile-then-re-drive rail. Also update the returns table and inngest brain pages.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- The sweep exists and filters to returns we own the refund for.",
            "- The sweep is registered in MONITORED_LOOPS.",
            "- The return-pipeline lifecycle page no longer claims there are no known gaps.",
            "- Registry invariants hold and the node registry has no drift.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the sweep filters to returns we own the refund for",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "easypost_shipment_id", path: "src/lib/inngest/returns.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the stale-return sweep is registered in MONITORED_LOOPS",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "returns-reconcile", path: "src/lib/control-tower/registry.ts", expect: "present" },
            },
            {
              position: 4,
              description: "the lifecycle page's false 'no known gaps' claim is corrected",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "None identified", path: "docs/brain/lifecycles/return-pipeline.md", expect: "absent" },
            },
            {
              position: 5,
              description: "node registry has no drift",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "check:node-registry-drift" },
            },
            {
              position: 6,
              description: "eyeball the first sweep run's healed/escalated counts on the Control Tower",
              kind: "human",
              exec_kind: "needs_human",
              params: null,
            },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "retention#subscription-continuity-billing-integrity",
    },
  );
  console.log(ok ? "authored: self-healing-return-refund-rail" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
