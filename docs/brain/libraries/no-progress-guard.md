# libraries/no-progress-guard

Circuit-breaker for the Sonnet orchestrator that stops paying for Opus turns when a ticket is stuck in a no-progress loop (Phase 3 of [[../specs/ticket-merge-summary-and-context-cap]]).

**File:** `src/lib/no-progress-guard.ts`

## Why this exists

A merged long-running ticket that keeps receiving inbound customer messages will keep triggering the orchestrator ([[../inngest/unified-ticket-handler]] `sonnet-orchestrate` step). Once `ai_turn_count >= 1`, [[model-picker]] routes to Opus. If the orchestrator has genuinely nothing new to say (customer keeps asking the same thing, the AI has no additional path forward), each new inbound pays another full-context Opus turn for no state change — the Goodhart failure the north star exists to prevent (bounded proxy silently destroying the objective).

Phase 1/2 stop the **cache-recost** on tickets that ARE making progress (durable `merge_summary` + cached per-ticket prefix). This guard stops the **turn recost** on tickets that AREN'T.

## Predicates (pure, exported)

### `NO_PROGRESS_M = 3` — the streak threshold.
Small enough to catch a stuck ticket after two clear failures; large enough that a customer sending "wait" then "actually…" back-to-back doesn't over-trigger.

### `inboundStreakSinceLastResponse(messages) → number`
Walks the message tail backwards from the newest. Increments on `direction='inbound' && author_type='customer'`. Resets on either:
- An action-executed system note (`author_type='system'` matching the same [[sonnet-orchestrator-v2]] `Action / Applied / Refund / …` marker list the convo renderer uses — kept aligned so the two views can't disagree).
- An outbound reply that isn't a system note (`direction='outbound' && author_type !== 'system'`) — i.e. a real customer-facing AI/agent reply, not a routing / model-picker breadcrumb.

Non-action system notes (routing, `Orchestrator model: opus (turn>=1)`, merge stubs) are **transparent** — they don't mask a genuine streak.

### `shouldTripNoProgressCircuit(streak) → boolean`
Returns `streak >= NO_PROGRESS_M`.

## `applyNoProgressCircuit(admin, workspaceId, ticketId)`

DB-touching wrapper that:
1. Fetches the latest 30 `ticket_messages` (asc). 30 is enough to cover the streak + the last reset point comfortably.
2. Runs the pure predicates above.
3. If tripped, writes `escalated_at = now(), escalation_reason = "no_progress_context_cap", updated_at = now()` via a **compare-and-set** guarded update: `.eq("id", ticketId).eq("workspace_id", workspaceId).is("escalated_at", null).select("id")`. This is the guard-before-mutation pattern the director coaching mandates — an async race with a human who just escalated to a real owner doesn't get overwritten.
4. Drops a `[System]` note **only when the escalation write actually landed** (one-off, not spammed on every consecutive stuck turn).
5. Returns `{ tripped, streak }`.

Even when the compare-and-set matches zero rows (someone else escalated first), the return still reports `tripped: true` so the caller still short-circuits — a stuck loop must not keep paying for Opus just because a human already owns the ticket.

## Callers

- [[../inngest/unified-ticket-handler]] `sonnet-orchestrate` block — runs BEFORE `pickOrchestratorModel`. When `{tripped: true}` the handler returns `{status: "no_progress_circuit_tripped", streak}` and never fires the orchestrator.

## Testing

Pure predicates covered in `src/lib/no-progress-guard.test.ts` (node:test). Named failing state (spec Phase-3 verification bullet): *"A no-progress ticket stops escalating context/model and is surfaced instead of silently re-charged."* Test asserts M consecutive inbound → streak=M → `shouldTripNoProgressCircuit(streak) === true`; complementary tests cover the action-note reset, the outbound reply reset, and the non-action system-note transparency (a `[System] Orchestrator model: opus (turn>=1)` breadcrumb must NOT reset the streak).

## Gotchas

- **The reset markers list must stay in sync with the convo renderer in [[sonnet-orchestrator-v2]] `buildPreContext`.** If we add a new "counts as progress" system-note phrase there, add it here too — otherwise the guard reads a "resolved" ticket as still stuck (or vice versa).
- **The guard runs on every orchestrator turn, not just merged tickets.** A non-merged ticket that goes into a stuck loop will also trip — that's intentional. The recost is loudest on merged tickets (large history) but the loop itself is the failure.

---

[[../README]] · [[../../CLAUDE]]
