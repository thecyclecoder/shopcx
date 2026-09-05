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
- An action-executed system note (`author_type='system'` matching the same [[sonnet-orchestrator-v2]] `Action / Applied / Refund / …` marker list the convo renderer uses — kept aligned so the two views can't disagree). The list also carries `"Automated-sender pre-filter tripped"` — the deterministic pre-filter close from [[automated-sender]] via [[../inngest/unified-ticket-handler]] § 1a2 IS a real state change (`open → auto_resolve`), so a run of pre-filter-closed inbounds must not silently accumulate into `no_progress_context_cap`.
- An outbound reply that isn't a system note (`direction='outbound' && author_type !== 'system'`) — i.e. a real customer-facing AI/agent reply, not a routing / model-picker breadcrumb.

Non-action system notes (routing, `Orchestrator model: opus (turn>=1)`, merge stubs) are **transparent** — they don't mask a genuine streak.

**Ground-truth case for the pre-filter marker:** ticket `91579acf-67ef-4cb3-be89-0c9da7dac7af` — 13 auto-merged TestFlight "AdsGPT" spam invites, every one deterministically pre-filter-closed, escalated to the CS Director as `no_progress_context_cap` with literally no remedy to hand back. The pre-filter's sysNote (`[System] Automated-sender pre-filter tripped (sender=…) — deterministically closed, no AI response, classify-bucket skipped (zero AI cost).`) carries no ACTION_MARKERS substring, so the streak counter used to skip past it and treat each spam inbound as un-answered. The marker addition closes the loop: deterministic handling IS progress.

### `shouldTripNoProgressCircuit(streak) → boolean`
Returns `streak >= NO_PROGRESS_M`.

## `applyNoProgressCircuit(admin, workspaceId, ticketId)`

DB-touching wrapper that:
1. Fetches the latest 30 `ticket_messages` (asc). 30 is enough to cover the streak + the last reset point comfortably.
2. Runs the pure predicates above.
3. **Routine-cancel in-leash re-send (ticket-`6c12a925` fix)** — if any of the streak inbounds trips [[cancel-journey-guard]] `looksLikeCancelIntent`, calls `attemptCancelJourneyResend` (see below). On a successful launch, drops an explanatory `[System]` note and returns `{tripped: true, streak, resent: true}` — escalation is **skipped** (the ticket is progressing again). The launcher's own `directToCancelTerminal` auto-detect makes sure a customer with a prior `saved_%` outcome isn't re-offered the same save.
4. Otherwise, writes `escalated_at = now(), escalation_reason = "no_progress_context_cap", updated_at = now()` via a **compare-and-set** guarded update: `.eq("id", ticketId).eq("workspace_id", workspaceId).is("escalated_at", null).select("id")`. This is the guard-before-mutation pattern the director coaching mandates — an async race with a human who just escalated to a real owner doesn't get overwritten.
5. Drops a `[System]` note **only when the escalation write actually landed** (one-off, not spammed on every consecutive stuck turn).
6. Returns `{ tripped, streak, resent }`.

Even when the compare-and-set matches zero rows (someone else escalated first), the return still reports `tripped: true` so the caller still short-circuits — a stuck loop must not keep paying for Opus just because a human already owns the ticket.

## `attemptCancelJourneyResend(admin, workspaceId, ticketId)`

Look up the active `cancel_subscription` journey for the workspace ([[../tables/journey_definitions]] `is_active=true`) and launch it via [[journey-delivery]] `launchJourneyForTicket` with `directToCancelTerminal: true`. Returns `false` (no re-send) when any of the required inputs is missing: ticket row not found, ticket has no channel or `customer_id`, no active cancel journey for the workspace. Kept exported so a future Sol cheap-execution path can invoke it directly without going through the no-progress circuit.

**The re-send is not a cancel-for-the-customer path.** It delivers a CTA the customer clicks to complete cancellation via their own confirm button on the mini-site ([[../journeys/cancel]] § "Route past remedies on re-request"). The action-executor's `directActionHandlers` still exposes no cancel action; the north-star self-service-only rule holds.

## Callers

- [[../inngest/unified-ticket-handler]] `sonnet-orchestrate` block — runs BEFORE `pickOrchestratorModel`. When `{tripped: true}` the handler returns `{status, streak}` and never fires the orchestrator; `status` is `no_progress_cancel_resent` when the routine-cancel re-send fired (in-leash progress, no escalation) or `no_progress_circuit_tripped` when the escalation path took over.

## Testing

Pure predicates covered in `src/lib/no-progress-guard.test.ts` (node:test). Named failing state (spec Phase-3 verification bullet): *"A no-progress ticket stops escalating context/model and is surfaced instead of silently re-charged."* Test asserts M consecutive inbound → streak=M → `shouldTripNoProgressCircuit(streak) === true`; complementary tests cover the action-note reset, the outbound reply reset, and the non-action system-note transparency (a `[System] Orchestrator model: opus (turn>=1)` breadcrumb must NOT reset the streak). A separate pair of tests pin the ticket-`91579acf` fix: 13 pre-filter-closed inbounds interleaved with the `Automated-sender pre-filter tripped` sysNote → streak = 0, circuit does NOT trip (deterministic handling counts as progress).

## Gotchas

- **The reset markers list must stay in sync with the convo renderer in [[sonnet-orchestrator-v2]] `buildPreContext`.** If we add a new "counts as progress" system-note phrase there, add it here too — otherwise the guard reads a "resolved" ticket as still stuck (or vice versa).
- **The guard runs on every orchestrator turn, not just merged tickets.** A non-merged ticket that goes into a stuck loop will also trip — that's intentional. The recost is loudest on merged tickets (large history) but the loop itself is the failure.

---

[[../README]] · [[../../CLAUDE]]
