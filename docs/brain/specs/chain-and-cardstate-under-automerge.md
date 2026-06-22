# Phase chain + card-state status break under auto-merge ⏳

**Owner:** [[../functions/platform]] · **Parent:** fixes [[build-all-phases-chain]] + [[spec-card-db-companion]] under [[auto-ship-pipeline]] auto-merge. · **Found in use 2026-06-22:** owner hit **"Build all"** on `storefront-ltv-proxy-reconciler` (4 phases). P1 built + auto-merged (#260, `chain_phases=true`), but: (a) the card stayed in **Planned** (should be **In progress** — 1 of 4 phases shipped), and (b) **P2 never auto-queued** — the chain stalled after one phase.

Two bugs, related:

## Bug A — merge-write doesn't roll up the card status
`markSpecCardMergeShipped` ([[../libraries/spec-card-state]]) stores `opts.status` verbatim, and the caller (`reconcileMergedJobs`, [[../libraries/agent-jobs]]) passed the **H1-emoji-derived status** (`planned` — the H1 is still ⏳) instead of a **rollup of `phase_states`**. Result: `phase_states[0]="shipped"` but top-level `status="planned"`, and since `resolveBoardStatus` takes `max(markdownStatus, state.status)` and both read `planned`, the card shows Planned despite a shipped phase.
- **Fix:** the merge-write must set `status` = **rollup of `phase_states`**: `all shipped → shipped`; `any shipped/in_progress but not all → in_progress`; `else planned`. Derive it from `phase_states` (which it already has), not from the H1 emoji. (Same rollup the board uses for markdown.)

## Bug B — the chain doesn't continue after an auto-merged phase
`queueNextChainedPhase` ([[../libraries/agent-jobs]]) fires inside `reconcileMergedJobs` on a `chain_phases` build's **completed→merged transition**. But [[auto-ship-pipeline]] auto-merges the PR **via the GitHub webhook (server-side)** and marks the job merged there — so by the time `reconcileMergedJobs` runs on the next board render, the job is **already merged** (no transition to catch) → `queueNextChainedPhase` is skipped and the chain stalls. (The whole point of "Build all" is no clicks between phases; it broke the moment auto-merge started doing the merge.)
- **Fix:** the chain continuation must fire from the **auto-merge path itself** (the webhook handler that marks the job merged), not only from `reconcileMergedJobs`'s transition. Whichever path flips a `chain_phases` build to merged calls `queueNextChainedPhase` (idempotent + deduped, so it's safe if both paths run). Same for the spec_card_state merge-write — it must happen on the auto-merge path too, so a card flips shipped/in_progress instantly even when no one loads the board.

## Verification
- "Build all" on a multi-phase spec → P1 builds → **auto-merges** → the card shows **In progress** (rolled-up status, not Planned) → **P2 auto-queues** within the webhook window (no board load, no click) → repeats to all-✅.
- After P1 auto-merges, `spec_card_state.status` = `in_progress` (not `planned`); after the final phase, `shipped`.
- A `chain_phases` build that auto-merges queues exactly one next-phase build (no duplicate even if `reconcileMergedJobs` also runs).
- Negative: a single-phase spec auto-merges → status `shipped`, no phantom next-phase queued; a non-chain build is unaffected.

## Phase 1 — rollup status on merge + chain-continue on the auto-merge path ⏳
`markSpecCardMergeShipped`/its caller derive `status` from `phase_states` rollup; the auto-merge webhook path ([[auto-ship-pipeline]]) calls both `markSpecCardMergeShipped` and `queueNextChainedPhase` (idempotent) so card-state + chain advance without a board render. Brain: [[build-all-phases-chain]] · [[spec-card-db-companion]] · [[auto-ship-pipeline]] · [[../libraries/agent-jobs]] · [[../libraries/spec-card-state]].
