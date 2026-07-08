# honor-required-outcomes

`src/lib/honor-required-outcomes.ts` — Phase 2 of the **message-is-last** pipeline. The middle step: walks every pending [[../tables/ticket_required_outcomes]] row, fires each action via the existing `directActionHandlers` dispatch, verifies against the DB via `verifyActionInDB`, and marks each item `verified` or `failed`. Actions run to completion (or fail loudly) FIRST — no customer message is composed while any item is still pending. See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]].

**Design:** the top-level `honorRequiredOutcomes` is the wire-in point (real DB, real dispatchers). Two smaller primitives — `decideOutcome` and `replyGateBlocked` — carry the actual logic and are pure enough to test with `node:test` + injected fakes, so the "actions run BEFORE the reply gate ever passes" ordering invariant is provably true without spinning up Supabase.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `HonorContext` | interface | The subset of [[action-executor]] `ActionContext` the honor step needs (`admin`, `workspace_id`, `ticket_id`, `customer_id`, `channel`, `sandbox`). |
| `OutcomeDecision` | union: `{verdict:'verified'} \| {verdict:'failed', reason}` | Terminal decision produced by `decideOutcome`. |
| `OutcomeHonorResult` | interface | One decision the honor step made on a single outcome (id + kind + description + final_status + failed_reason). |
| `HonorSummary` | interface | Rollup of one honor pass: `attempted`, `all_verified`, `failed_items`, `skipped_already_verified`, `carried_forward_failed`. |
| `ReplyGateVerdict` | interface | `{blocked, pending[], failed[], verified_count}`. |
| `decideOutcome(action, dispatch, verify)` | pure | Fires `dispatch(action)`, then `verify(action)`, folds into a single verdict. **Verify is NEVER called if dispatch failed** — the honor step wastes no work on a false success path. |
| `replyGateBlocked(outcomes)` | pure | `blocked=true` when ANY row is not `verified`. `done` rows count as "not ship-worthy" — the executor fired but the DB predicate hasn't been confirmed. |
| `outcomeToActionParams(outcome)` | pure | Builds an [[action-executor]] `ActionParams` from a stored row — `{type: kind, ...target_ids}`. |
| `honorRequiredOutcomes(ctx)` | wire-in | Top-level honor pass. Walks pending items in authored order, calls `decideOutcome` per item, marks status via [[ticket-required-outcomes]] CAS transitions, returns `HonorSummary`. |
| `honorSummaryToLedgerOutcome(summary)` | pure | Maps `HonorSummary` → [[../tables/ticket_resolution_events]] `verified_outcome` enum (`confirmed` \| `drifted` \| `unbacked`). |

## Ordering invariant

The whole point of Phase 2 is that **execution finishes before reply-drafting starts**. The primitives express that as a two-step contract callers follow:

```ts
const summary = await honorRequiredOutcomes(ctx);
const gate = replyGateBlocked(await listRequiredOutcomes(ctx.admin, ctx.ticket_id));
if (gate.blocked) {
  // Escalate — never compose a reply while gate.pending/gate.failed have entries.
} else {
  // Now (and only now) compose the reply. Every claim it asserts is backed by
  // a status='verified' row.
}
```

The `decideOutcome` verify-runs-AFTER-dispatch order and the "verify is skipped if dispatch failed" branch guarantee the honor step never opens the gate on a false success. The tests in `honor-required-outcomes.test.ts` drive the Judy scenario twice — happy path (both items verified → gate opens) and failure path (apply_coupon dispatch fails → gate REMAINS BLOCKED, the $15 credit is named for the Phase-4 escalation) — and assert the exact event ordering.

## Callers

Phase 2 lands the SDK; wire-in sites land as later phases:

- **Sol's box session** (`scripts/builder-worker.ts` → `runTicketHandleJob`) — invokes `honorRequiredOutcomes` between Direction-authoring and reply-drafting. Gated by [[required-outcomes-validator]] `validateRequiredOutcomes` (Phase 1 of [[../specs/secure-sol-required-outcomes-dispatch]]): an outcome pointing at another customer's `contract_id` / a disallowed kind is rejected BEFORE this SDK is called, so the honor step never dispatches on an unscoped identifier.
- **[[action-executor]] `executeSonnetDecision`** — Phase 3 wire-in will call `replyGateBlocked` at every reply-composition site (Sol box reply, playbook/journey, macro/kb/ai_response, workflow, clarification) and refuse to compose a reply while `blocked===true`.
- **[[sol-policy-bait-guard]]** — Phase 3 extends `assessSolReplyBaitRisk` beyond bait risk to also refuse a reply whose claims are unbacked by verified rows.
- **`src/inngest/unified-ticket-handler.ts`** — Phase 4 completion gate uses `honorRequiredOutcomes` on the resolve step and `hasUnverifiedOutcomes` on the auto-close step.

## Invariants

- **Verify is never called on a failed dispatch.** `decideOutcome` short-circuits after `dispatch` returns `success=false` or throws — the executor's `verifyActionInDB` reads a real DB, so a probe on an action that never fired would be a false negative (and a wasted round-trip). The test `decideOutcome: verify is NEVER called if dispatch returned success=false` pins this.
- **A `done` row is not ship-worthy.** `done` means the handler returned success but the DB verify hasn't confirmed. The Phase-3 send guard treats it the same as `pending` — a reply that claims a done outcome is still asserting an unverified DB state.
- **Terminal failures are not retried.** `honorRequiredOutcomes` surfaces `carried_forward_failed` items in the summary but never re-fires a `failed` row. A caller who wants to retry authors a fresh Direction (which authors a fresh required-outcome row) — never an in-place status reset of a landed failure.

## Test + migration
- Tests: `npx tsx --test src/lib/honor-required-outcomes.test.ts` (22 tests: decideOutcome permutations, replyGateBlocked branches, Judy ordering + failure).
- No new migration — reuses [[../tables/ticket_required_outcomes]] (Phase 1) and [[../tables/ticket_resolution_events]].

---

[[../README]] · [[../tables/ticket_required_outcomes]] · [[../tables/ticket_resolution_events]] · [[../tables/ticket_directions]] · [[action-executor]] · [[ticket-required-outcomes]] · [[sol-policy-bait-guard]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]] · [[../../CLAUDE]]
