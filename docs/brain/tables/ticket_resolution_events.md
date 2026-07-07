# ticket_resolution_events

The **write-ahead ledger** for every orchestrator turn — one row per `executeSonnetDecision()` call, inserted at the top of the executor BEFORE any customer-facing claim ships. Every branch (`direct_action` / `journey` / `playbook` / `workflow` / `macro` / `kb_response` / `ai_response` / `escalate` / clarification) shares the same row. The row's lifecycle stamps (`staged_at` → `shipped_at` → `verified_at` + `verified_outcome`) are the substrate M1's inline verify block reads against, M2's confidence-gated clarify keys off, and M4's compiler loop mines. See [[../specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension]] and [[../goals/guaranteed-ticket-handling]] § M2.

Written by [[../libraries/action-executor]] `executeSonnetDecision` (insert) + `stampResolutionShipped` (shipped_at from every send-path wrapper) + `stampResolutionVerified` (verified_at + verified_outcome from the direct-action `verifyActionInDB` block, or the executor's return-time verdict for message-only branches).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `ticket_id` | `uuid` | — | → [[tickets]].id · ON DELETE CASCADE — the resolved ticket |
| `turn_index` | `int` | — | 1-based monotonic per-ticket ordering; = `count(prior rows on ticket) + 1` at insert time |
| `problem` | `text` | ✓ | populated from `SonnetDecision.problem` — the orchestrator's one-line diagnosis (Phase 2 — [[../libraries/sonnet-orchestrator-v2]] `buildSystemPrompt` asks for it; `stageResolutionEvent` coerces empty/absent to NULL) |
| `confidence` | `numeric` | ✓ | populated from `SonnetDecision.confidence` — 0..1, CHECK-enforced (out-of-range or NaN → coerced to NULL in `stageResolutionEvent`, keeps the CHECK green) |
| `options` | `jsonb` | ✓ | populated from `SonnetDecision.options` — array of `{label, action_shape, expected_effect}` the model considered (non-array → NULL) |
| `chosen` | `jsonb` | ✓ | populated from `SonnetDecision.chosen` — the picked `{option_index, why}` (non-object or missing `option_index` → NULL) |
| `staged_at` | `timestamptz` | — | default `now()` — stamped at insert, BEFORE any customer-facing message ships |
| `shipped_at` | `timestamptz` | ✓ | stamped by [[../libraries/action-executor]] `stampResolutionShipped` on the first send in this turn (compare-and-set on NULL — a re-send in the same turn doesn't overwrite) |
| `verified_at` | `timestamptz` | ✓ | stamped by [[../libraries/action-executor]] `stampResolutionVerified` once per row (compare-and-set on NULL); NULL means the outcome is still in flight (escalated to an agent or M1's inline verify hasn't run yet) |
| `verified_outcome` | `text` | ✓ | CHECK ∈ `confirmed` \| `unbacked` \| `drifted` — `confirmed` = DB verify passed (or a message-only branch shipped cleanly); `drifted` = the executor's `verifyActionInDB` couldn't back the claim; `unbacked` = M1's inline verify block rejected the response before it shipped |
| `reasoning` | `text` | ✓ | the orchestrator's `SonnetDecision.reasoning` — the auditable "why this action" trail |

**CHECK constraints:** `confidence ∈ [0, 1] OR NULL` · `verified_outcome ∈ {'confirmed','unbacked','drifted'} OR NULL`.

**Indexes:**
- `(workspace_id, ticket_id, turn_index)` — the per-ticket-in-order read (spec Phase 1 verification), also covers `nextTurnIndex()`'s count-by-ticket at insert time.
- `(workspace_id, staged_at DESC)` — reporting rollups ("problem/confidence distribution across the last day" — spec Phase 2 verification).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id · `ticket_id` → [[tickets]].id.

**In:** none yet — future M1 (inline verify block) will bounce `verified_outcome='unbacked'` verdicts back onto this row; future M4 (compiler loop) will mine the row-set for prompt calibration but write only through [[sonnet_prompts]].

## Row lifecycle

Every orchestrator turn walks the same three stamps:

1. **Insert (`staged_at`)** — [[../libraries/action-executor]] `stageResolutionEvent` fires at the top of `executeSonnetDecision`, BEFORE any dispatch. Populates `workspace_id` + `ticket_id` + `turn_index` + `reasoning` + (Phase 2) `problem` / `confidence` / `options` / `chosen`. `_resolutionEventId` is stashed on the [[../libraries/action-executor]] `ActionContext` for the downstream stampers.
2. **Ship (`shipped_at`)** — every customer-facing send in this turn flows through `stampedSend` (which wraps the executor's outer `send`), which calls `stampResolutionShipped` after the message is delivered. Compare-and-set on `shipped_at IS NULL` — the first send wins, re-sends in the same turn don't rewrite the timestamp. All branches share this: `direct_action`'s confirmation, `journey`/`playbook`'s in-flight sends, `workflow`'s `sendReply`, `macro`/`kb_response`/`ai_response`, and the clarification branch. An `escalate`-with-holding-message path also stamps because it flows through the same wrapper.
3. **Verify (`verified_at` + `verified_outcome`)** — one row-terminal stamp:
   - **`direct_action`** stamps its own verdict from `verifyActionInDB`: `confirmed` when every action verified (or self-heal retried cleanly); `drifted` when a claim couldn't be backed by a DB read. This stamp fires FIRST — before the return-time stamp — so it wins the idempotent-once compare-and-set on `verified_at IS NULL`.
   - **Message-only branches** (`journey` / `playbook` / `macro` / `kb_response` / `ai_response` / `workflow`) and the clarification path get the return-time `confirmed` verdict from `executeSonnetDecision` when `messageSent` (or `statusManaged` / `_closedThisRun`) is true.
   - **Escalate paths leave `verified_outcome` NULL** — the agent takes over and the row stays open until the outcome is known (M4's compiler loop closes it out when the agent's resolution lands).
   - **M1's inline verify block** (planned in the parent goal) sets `verified_outcome='unbacked'` when the response is rejected before it ships — which is why the spec's Phase-1 verification asserts that a Phase-0-blocked run leaves `shipped_at NULL` + `verified_outcome='unbacked'`.

## RLS
Service-role only (RLS enabled with no policies). Every write goes through `createAdminClient()` from [[../libraries/action-executor]] — per CLAUDE.md's "All writes go through `createAdminClient()`" invariant. No client-side reads.

## Invariants
- **Never fail the executor on a ledger error.** `stageResolutionEvent` / `stampResolutionShipped` / `stampResolutionVerified` all swallow errors — the row is diagnostic + optimizer substrate, not a critical path. A ledger outage must never wedge a customer reply.
- **Idempotent stamps.** `shipped_at` + `verified_at` both compare-and-set on `IS NULL`, so a retry, self-heal, or workflow re-entry can't overwrite a first-ship / first-verify timestamp. Also protects the direct-action `drifted` verdict from being clobbered by the return-time `confirmed` fallback.
- **One row per turn.** `turn_index` is `count(prior rows) + 1` computed inside `stageResolutionEvent` — the `(workspace_id, ticket_id, turn_index)` index makes that count a single index scan. There is no unique on `(ticket_id, turn_index)` (concurrent inserts are impossible: the unified handler serializes with `concurrency=[{ limit: 1, key: "event.data.ticket_id" }]` — see [[../inngest/unified-ticket-handler]]).
- **`chosen.option_index` is not FK-checked.** `options` is authored by the model and `chosen.option_index` indexes into that array. Nothing enforces the range — bad indexes are surfaced by M4's compiler loop as prompt-calibration data.

## Migration

`supabase/migrations/20260917120000_ticket_resolution_events.sql` (apply: `npx tsx scripts/apply-ticket-resolution-events-migration.ts`). Idempotent — creates the table, both indexes, and enables RLS.

---

[[../README]] · [[tickets]] · [[ticket_messages]] · [[../libraries/action-executor]] · [[../libraries/sonnet-orchestrator-v2]] · [[../lifecycles/ticket-lifecycle]] · [[../specs/ticket-resolution-events-writeahead-ledger-and-decision-schema-extension]] · [[../goals/guaranteed-ticket-handling]] · [[../../CLAUDE]]
