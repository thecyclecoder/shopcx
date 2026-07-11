# libraries/needs-attention-route-cs-owner

Routes a parked CS-owned `agent_jobs` row (`ticket-handle`, `ticket-analyze`, or any future kind whose registry owner is `cs`) to the CS Director (June) BEFORE the Platform director's backstop reaches the CEO fail-safe. **Phase 3 of [[../specs/account-linking-address-aware-confidence-graded-and-cs-searchable]].**

**File:** `src/lib/agents/needs-attention-route-cs-owner.ts` · **Tests:** `src/lib/agents/needs-attention-route-cs-owner.test.ts` (8 cases)

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

## Verdict shape

| result reason                    | when                                                                                 |
|---------------------------------|--------------------------------------------------------------------------------------|
| `enqueued_cs_director_call`      | Happy path — cs-director-call enqueued, ledger stamped, parked row terminal.         |
| `already_inflight`               | A queued cs-director-call on this ticket already gives June her chance — no-op.      |
| `no_ticket_id`                   | CS-owned kind, but the parked row's `instructions` didn't carry a resolvable ticket_id — fall through to the generic sweep. |
| `enqueue_failed`                 | The insert on `agent_jobs` failed — the row stays parked for the next tick.          |
| `compare_and_set_lost`           | The row moved under us between read and write (June's runner closed it, or a manual re-open) — the cs-director-call was still enqueued (that's the durable side-effect). |
| `not_cs_owned`                   | Non-CS-owned kind (e.g. `build`) — the router never dispatched. The Platform sweep continues to own it. |

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
