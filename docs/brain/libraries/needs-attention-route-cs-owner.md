# libraries/needs-attention-route-cs-owner

Routes a parked CS-owned `agent_jobs` row (`ticket-handle`, `ticket-analyze`, or any future kind whose registry owner is `cs`) to the CS Director (June) BEFORE the Platform director's backstop reaches the CEO fail-safe. **Phase 3 of [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]].**

**File:** `src/lib/agents/needs-attention-route-cs-owner.ts` · **Tests:** `src/lib/agents/needs-attention-route-cs-owner.test.ts` (12 cases — [[../specs/cs-director-call-loop-guard-and-message-only-remedy]] Phases 1–2 added loop-guard + self-routing exclusion tests)

## Overview

The generic [[needs-attention-route]] sweep runs under the **Platform** director's autonomy gate and fans a parked row through four class routers (`already_shipped` → fold, `real_blocker/tooling_failure` → child spec, `design_change` → CEO chat) then a **backstop** that, after 60 min of an `unknown` class, escalates to the CEO — with the escalation attributed to Platform (Ada). For a spec build that's fine: Platform owns build parks.

For a **`ticket-handle`** or **`ticket-analyze`** park it's not: `ownerFunctionForKind('ticket-handle')='cs'` and `ownerFunctionForKind('ticket-analyze')='cs'` (both registered in [[../libraries/control-tower]] `MONITORED_LOOPS` with `owner='cs'`), so the north-star supervisor-owns-its-layer contract ([[../operational-rules]] § North star) requires the CS Director (June) to rule on the park BEFORE the CEO fail-safe fires.

## The two-part shape

- `decideCsOwnerRoute(row)` — pure predicate returning `{ route_to: 'cs' | null, ticket_id, reason }`.
  Uses `ownerFunctionForKind(row.kind)` from [[approval-inbox]], not a hardcoded set, so a future kind whose registry `owner` flips to `cs` is picked up automatically. Reads `ticket_id` from the parked row's `instructions` JSON (the shape `unified-ticket-handler`'s `sol-first-touch-enqueue` writes). No DB access → unit-testable with a plain row.
- `applyCsOwnerRoute(admin, row, decision)` — deterministic applier that:
  1. Inflight-guards against a queued/claimed/building/needs_input `cs-director-call` on the ticket (spec_slug=ticket_id) — a second enqueue would duplicate June's work.
  2. Enqueues a fresh `cs-director-call` job (kind='cs-director-call', spec_slug=ticket_id, instructions carries `ticket_id` + `parked_from: { kind, job_id, reason, log_tail }` so June sees WHY the ticket-handle parked).
  3. Records a `director_activity` row with `director_function='cs'` — the approvals feed reads this ledger to render `raisedBy`, so the escalation is attributed to the owner function, not Platform.
  4. Compare-and-set flips the parked row to `status='completed'` + `needs_attention_class='routed_cs_owner'`, gated on `.eq('status', 'needs_attention')` (Learning #9 — re-assert the read-time predicate at the write).

## Loop guard — Phase 1 of [[../specs/cs-director-call-loop-guard-and-message-only-remedy]]

`applyCsOwnerRoute` gates on `CS_DIRECTOR_LOOP_GUARD_MAX` (default **3**, env `CS_DIRECTOR_LOOP_GUARD_MAX` to override) — the same pattern `DEPLOY_GUARDIAN_LOOP_GUARD_MAX` and `MARIO_LOOP_GUARD_MAX` use. Before enqueueing a fresh `cs-director-call` for a ticket, `countPriorCsDirectorCallsForTicket` reads the LIVE `director_activity` ledger for calls on the same ticket in the last 24h (rolling window `CS_DIRECTOR_LOOP_GUARD_WINDOW_MS`). At or above the cap:

- **No enqueue.** The fresh call is SUPPRESSED — June has been called N times on this ticket and cannot resolve it.
- **Escalate once.** `escalateDiagnosisToCeo` mints ONE idempotent founder card (dedupeKey `cs-director-loop-guard:{ticket_id}`, via `bumpOpenEscalationCard`) carrying the diagnosis: "June has been called N times on ticket {id} in the last 24h and cannot resolve it (CS_DIRECTOR_LOOP_GUARD_MAX=3). Auto-routing this ticket to another cs-director-call is now SUPPRESSED; the customer is likely still waiting and needs a human to unblock the class June kept hitting." The card includes `latestCsDirectorReasonForTicket` (first 1500 chars of June's latest reasoning, so the founder sees WHY she is stuck).
- **Ledger and terminal.** A `director_activity` row is written with `action_kind='routed_needs_attention'` (not enqueued) + `metadata.action='route_cs_owned_park'` + `metadata.loop_guard_tripped=true`, and the parked row compare-and-set flips to `status='completed'`, `needs_attention_class='routed_cs_owner'` — it's terminal, not re-routable on the next sweep tick.
- **Caller gate.** The router's caller ([[needs-attention-route]]) checks `reason === 'loop_guard_tripped'` and skips the class dispatch AND the backstop sweep (no double-page via the CEO fail-safe).

## Phase 2 — Self-routing exclusion

`decideCsOwnerRoute` calls `wouldSelfRoute(row.kind)` and returns `{route_to: null, reason: 'self_routing_excluded'}` when the parked row's `kind === CS_DIRECTOR_CALL_KIND` (`'cs-director-call'`). A parked `cs-director-call` is the CS Director's OWN box session — routing it to another `cs-director-call` is self-routing (routing a thing to itself). The signal a parked director call carries is "June ran and could not finish" — that is exactly the signal Phase 1's loop-guard and the CEO fail-safe were built to handle. Narrow: other CS-owned kinds (`ticket-handle`, `ticket-analyze`) still route to the CS Director exactly as before. The parked `cs-director-call` falls through to the generic needs-attention sweep.

## Verdict shape

| result reason                    | when                                                                                 |
|---------------------------------|--------------------------------------------------------------------------------------|
| `enqueued_cs_director_call`      | Happy path — cs-director-call enqueued, ledger stamped, parked row terminal.         |
| `already_inflight`               | A queued cs-director-call on this ticket already gives June her chance — no-op.      |
| `no_ticket_id`                   | CS-owned kind, but the parked row's `instructions` didn't carry a resolvable ticket_id — fall through to the generic sweep. |
| `enqueue_failed`                 | The insert on `agent_jobs` failed — the row stays parked for the next tick.          |
| `compare_and_set_lost`           | The row moved under us between read and write (June's runner closed it, or a manual re-open) — the cs-director-call was still enqueued (that's the durable side-effect). |
| `not_cs_owned`                   | Non-CS-owned kind (e.g. `build`) — the router never dispatched. The Platform sweep continues to own it. |
| `loop_guard_tripped`             | (Phase 1) Prior calls ≥ CS_DIRECTOR_LOOP_GUARD_MAX on the same ticket — enqueue suppressed, founder card escalated, parked row terminal. |
| `self_routing_excluded`          | (Phase 2) The parked row's kind is `'cs-director-call'` — self-routing excluded, falls through to generic sweep. |

## Wire-in

[[needs-attention-route]] `routeNeedsAttention` calls `decideCsOwnerRoute` + `applyCsOwnerRoute` inside its main loop, **before** the class dispatch and the backstop sweep, gated on the same `!inLedger && !atCap` conditions the other routers use. On a successful route the parked row `continue`s past the class dispatch AND the backstop so the 70-min invariant alarm cannot fire for a row June is already ruling on. On `already_inflight` the loop also `continue`s (letting June finish); on any other reason the row falls through to the generic dispatch — so a CS-owned kind with a malformed instructions blob still reaches SOME surface, never silently vanishes.

## Guards

1. **Owner-function attribution.** `director_activity.director_function='cs'` is the durable ledger fact the [[approvals-feed]] reads for `raisedBy` — the CEO card is attributed to June/CS, not Platform.
2. **Compare-and-set at the mutation point** (Learning #9). Every `.update()` re-asserts `.eq('status', 'needs_attention')` so an async race can't overwrite a row that already moved on.
3. **Inflight dedup.** The `.in('status', ['queued', 'queued_resume', 'claimed', 'building', 'needs_input'])` filter mirrors `enqueueSecondOpinion` — a second router pass on the same still-inflight ticket is a no-op.
4. **Autonomy inheritance.** Runs inside `routeNeedsAttention`'s `platformIsAutoApprover` gate, so no new autonomy surface is introduced. When Platform isn't autonomous the whole sweep is dormant, including this router.

## Callers

- [[needs-attention-route]] `routeNeedsAttention` main loop — the only production caller.
- Direct tests in `needs-attention-route-cs-owner.test.ts` — the four pinned invariants (routes CS-owned, doesn't hijack Platform-owned, enqueues + attributes to CS + compares-and-sets, respects inflight).

## Related

[[needs-attention-route]] · [[approval-inbox]] · [[approvals-feed]] · [[cs-director]] · [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]] · [[../functions/cs]]

---

[[../README]] · [[../../CLAUDE]]
