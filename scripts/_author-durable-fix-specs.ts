/**
 * Author the two durable-fix specs from the goal-build jam:
 *  1) serialize goal-member spec builds (platform) — prevent hot-file collisions
 *  2) refund idempotency guard inside the commerce/refund facade (retention)
 * Both STANDALONE (mandate-parented) so neither blocks the guaranteed-ticket-
 * handling goal's atomic merge. Land in_review (Vale → Ada).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = await authorSpecRowStructured(
    WS,
    "serialize-goal-member-spec-builds",
    {
      title: "Serialize goal-member spec builds to prevent hot-file merge collisions",
      why: "The guaranteed-ticket-handling goal jammed: 8 specs built in PARALLEL off the same goal-branch base, all editing hot files (src/lib/action-executor.ts, the orchestrator). 5 merged and 3 (#1245/#1246/#1248) went DIRTY/conflicting, and the box left them PARKED instead of re-driving — a human had to resolve them by hand. The collisions were pure file-overlap between INDEPENDENT specs (no blocked_by relation), so blocked_by ordering alone would not have prevented them.",
      what: "Goal-member spec builds dispatch serially: at most one in-flight build per goal, in blocked_by-topological order, each cut from the CURRENT goal-branch head so it can never conflict on merge. Any goal PR that still goes DIRTY (base moved under it) is auto-re-driven, never left parked.",
      summary: "**Brain refs:** [[../libraries/builder-worker]] [[../libraries/agent-jobs]] [[../libraries/github-pr-resolve]] [[../recipes/pm-flow-data-sources]]. Grounded in the 2026-07-06 jam: 8 kind='build' jobs for guaranteed-ticket-handling member specs ran concurrently off origin/goal/guaranteed-ticket-handling; #1245/#1246/#1248 conflicted on action-executor.ts imports + the refund handlers and parked as needs_attention/DIRTY.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Autonomous build platform" mandate: goal-member spec builds must not collide on shared hot files, and a dirty goal PR must self-heal rather than park.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — serialize goal-member build dispatch",
          why: "Parallel builds off a stale goal-branch base are the collision source; cutting each build from the current head eliminates the conflict class.",
          what: "The box dispatches at most one goal-member build per goal at a time, in blocked_by-topo order, each rebased on the latest goal branch.",
          body: "In scripts/builder-worker.ts build-claim/dispatch, gate claiming a kind='build' job for a goal-member spec (parent = a goal milestone; join specs.milestone_id → goal_milestones → goal) on: (a) every blocked_by spec already merged into the goal branch, AND (b) NO other in-flight build (claimed/building) for the SAME goal, AND (c) it is the earliest not-yet-built member in blocked_by-topological order. Cut the build branch from the current goal-branch head. This preserves cross-GOAL parallelism (different goals still build concurrently) while serializing within a goal. Cite the build-claim query + goals-table membership.",
          verification: "Unit test of the dispatch-eligibility predicate: given a goal with 2+ ready member specs, exactly one is claimable at a time; the next becomes claimable only after the prior merges into the goal branch. Observationally: replaying the guaranteed-ticket-handling member set through the predicate yields a serial order with zero concurrent in-flight builds for that goal. Cross-goal: two different goals with ready specs both dispatch (parallelism preserved).",
          status: "planned",
        },
        {
          title: "Phase 2 — auto-re-drive a DIRTY goal PR instead of parking it",
          why: "Even with serialization, a goal PR can go dirty (a hotfix lands on the goal branch); today the box parks it and waits for a human.",
          what: "A box reconcile detects a goal-member build PR whose mergeStateStatus is DIRTY/CONFLICTING and re-drives it (rebase onto current goal branch + re-run tsc/tests, or rebuild) rather than leaving it needs_attention.",
          body: "Add a reconcile (near the existing pr-resolve / needs-attention lanes) that, for each open goal-member build PR, reads GitHub mergeStateStatus via [[../libraries/github-pr-resolve]] getPr; on DIRTY, enqueue a rebase-or-rebuild job that merges the current goal branch into the PR branch, resolves trivially-additive conflicts, gates on tsc, and pushes — or, on a semantic conflict, re-drives the spec build off the current goal branch. Conservative: on a failed GitHub read, keep the PR as-is (fail closed). Cite the pr-resolve lane + builder-worker reconcile cadence.",
          verification: "A synthetic goal-member PR made DIRTY (base advanced) is detected within one reconcile and a rebase/rebuild job enqueued; the PR returns to MERGEABLE with no human touch. A PR whose GitHub state can't be read is left untouched (no false re-drive).",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" },
  );
  console.log("spec 1 (serialize-goal-member-spec-builds):", a ? "authored" : "FAILED");

  const b = await authorSpecRowStructured(
    WS,
    "refund-idempotency-guard-in-commerce-refund-facade",
    {
      title: "Move the order_refunds idempotency guard into commerce/refund.issueRefund (single choke point)",
      why: "Refund-integrity (#1244) put the verify-by-refund-id guard at the HANDLER level (partial_refund, redeem_points) calling refundOrder with a requestKey. Commerce-sdk (#1245) added issueRefund as the SDK facade plus a $-bearing replacement whose refund half calls issueRefund WITHOUT the guard — a double-refund risk on retry. During the goal-jam merge the two handlers were kept on the guarded refundOrder path and the facade-migration deferred; issueRefund's own docstring says the mirror 'will layer in here (the shared choke point) — one commit, one migration point'.",
      what: "The order_refunds mirror check + request_key live INSIDE issueRefund, so EVERY refund caller (partial_refund, redeem_points, $-replacement, future) is idempotency-guarded automatically; the two handlers migrate onto the facade and drop their inline guard.",
      summary: "**Brain refs:** [[../libraries/commerce__refund]] [[../libraries/action-executor]] [[../tables/order_refunds]]. Grounded in src/lib/commerce/refund.ts (issueRefund — no requestKey today), src/lib/refund.ts (refundOrder + hashRefundRequestKey), src/lib/action-executor.ts partial_refund/redeem_points (guarded) + create_replacement_order refund half (UNguarded).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: every refund path guarded against double-refund at one choke point.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — the guard moves inside issueRefund",
          why: "A single choke point means no refund path can be added without the guard — the durable fix, not a per-handler patch.",
          what: "issueRefund computes/accepts requestKey, checks the order_refunds mirror, short-circuits on a prior succeeded/settled row, and forwards requestKey to refundOrder.",
          body: "In src/lib/commerce/refund.ts: add optional requestKey to IssueRefundArgs; when absent compute it via hashRefundRequestKey(orderId, amountCents, reason) ([[../libraries/refund]]). Before delegating, look up order_refunds by (workspace_id, order_id, request_key) in ('succeeded','settled') and short-circuit to a success result if found. Forward requestKey to refundOrder so the write-side hash matches the read. Cite commerce/refund.ts + refund.ts.",
          verification: "Unit/integration: calling issueRefund twice for the same (order, amount, reason) fires the vendor ONCE — the second returns success via the mirror short-circuit. A distinct (amount|reason) is NOT short-circuited. The forwarded requestKey matches the order_refunds row hashRefundRequestKey computes.",
          status: "planned",
        },
        {
          title: "Phase 2 — migrate the handlers + close the $-replacement gap",
          why: "With the guard in the facade, the inline handler guards are redundant and the unguarded $-replacement refund becomes safe.",
          what: "partial_refund + redeem_points call issueRefund (dropping their inline guard); create_replacement_order's refund half routes through issueRefund → now guarded.",
          body: "In src/lib/action-executor.ts: partial_refund (~:1196) and redeem_points_as_refund (~:1300) call issueRefund and remove their inline requestKey/order_refunds block (now duplicated inside the facade). create_replacement_order's refund half (~:2165) also routes through issueRefund. Single source of truth = commerce/refund.issueRefund.",
          verification: "All three refund paths short-circuit on a duplicate request_key (integration test per handler). A $-replacement retried does NOT double-refund. grep confirms no inline order_refunds guard remains in the handlers (the guard lives only in issueRefund).",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log("spec 2 (refund-idempotency-guard-in-commerce-refund-facade):", b ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
