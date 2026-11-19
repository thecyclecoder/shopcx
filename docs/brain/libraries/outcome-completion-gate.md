# outcome-completion-gate

`src/lib/outcome-completion-gate.ts` — Phase 4 of the **message-is-last** pipeline. The **resolution completion gate**: a ticket cannot auto-resolve while any [[../tables/ticket_required_outcomes]] row is not `status='verified'`. When the gate blocks, the ticket is escalated (not closed) with `escalation_reason` naming every unfinished item verbatim. See [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]].

Judy's ticket 0a9e4d7f is the named failing state — the reply promised bag+credit, both failed to run, yet the ticket auto-resolved anyway because auto-close keyed off "reply sent", not "DB items done". This gate makes the invariant enforced: the session doesn't end until the DB items complete and verify.

## Exports

| Symbol | Signature | Purpose |
|---|---|---|
| `UnfinishedOutcome` | interface | `{outcome_id, kind, description, status, failed_reason?}` — one flagged item. `status` is narrowed to `Exclude<RequiredOutcomeStatus, "verified">` so a compiler diff would catch it if the definition of "unfinished" ever drifted. |
| `OutcomeCompletionVerdict` | union: `{ok:true} \| {ok:false, unfinished_items, total_count}` | Verdict shape mirrors the Phase-3 send guard so callers that compose the two gates get consistent handling. |
| `assessOutcomeCompletion(outcomes)` | pure | Strict single-line invariant: every row's `status` must be terminal-**closed** (`verified` OR `waived`). `pending`, `done`, and `failed` are unfinished (a `done` row means the executor fired but `verifyActionInDB` hasn't confirmed the DB predicate). Empty outcomes list → `ok=true` (backward-compatible). |
| `buildEscalationReason(verdict)` | pure | Human-readable `tickets.escalation_reason`. Names count + count-by-status breakdown + each item's kind + description + status inline. **Truncates to 500 chars** with a `+N more` tail so the write never overflows the column. Returns `""` on an OK verdict. |
| `assertOutcomesCompleteBeforeClose({admin, workspace_id, ticket_id})` | wire-in read | Load outcomes, call the predicate, return the verdict. Isolated from the escalate helper so callers can inspect the verdict without firing a mutation. |
| `escalateTicketOnIncompleteOutcomes({admin, workspace_id, ticket_id, verdict, from_status?})` | wire-in write | CAS-set `tickets.status='open'` + `escalated_at=now()` + `escalation_reason=<named unfinished items>`, scoped to `workspace_id` + optional `from_status`. Returns `false` on CAS-lost (racing writer already progressed the ticket — the caller falls through to its normal path). |
| `waivePolicyForbiddenOutcomes({admin, workspace_id, ticket_id})` | wire-in write | **WAIVE half** of the uncompletable-policy-forbidden fix (ticket aaf00047). Walks OPEN (`pending`/`failed`) rows and CAS-moves any whose completion is policy-forbidden against live state → `waived`. Bounded + fail-closed: only `COUPON_APPLY_KINDS` rows, only when the live sub is positively non-active (via [[required-outcome-policy]] `assessPolicyForbidden`); missing `contract_id` / unreadable sub leaves the row open. Idempotent. Returns `{waived[]}`. |

## Invariants

- **`verified` and `waived` are the closed statuses** (the shared `CLOSED_OUTCOME_STATUSES` set in [[ticket-required-outcomes]]). A `done` row (executor fired, DB verify pending) leaves the gate CLOSED-against-open — same shape as the Phase-2 `replyGateBlocked` and Phase-3 `assessOutcomeClaims`. A `waived` row is a correctly-NOT-done, policy-forbidden outcome — it opens the gate (nothing more will ever happen on it) and `replyGateBlocked` skips it.
- **WAIVE runs BEFORE the gate assessment, never inside it.** `assertOutcomesCompleteBeforeClose` stays a pure read (callers can inspect without mutating); the mutating `waivePolicyForbiddenOutcomes` is a separate call the caller fires first. This keeps the loop-breaker explicit at the wire-in site.
- **CAS on every mutation.** `escalateTicketOnIncompleteOutcomes` re-asserts `workspace_id` on the update and `.select("id")` confirms exactly one row transitioned (learning #5). A racing writer that closed the ticket first cannot be silently overwritten.
- **Empty outcomes list passes.** Legacy tickets predating Phase 1, and tickets with a naked reply-only turn ("thanks", chatter), are NOT held up. The gate only enforces the invariant where there IS something to enforce.
- **Escalation reason is 500-char capped.** `tickets.escalation_reason` is bounded; a 40-item ticket's reason is trimmed with `+N more`. The test suite pins this.

## Wire-in sites

- **`src/lib/inngest/unified-ticket-handler.ts`** — sonnet-orchestrator's `case "message_sent"` branch. First `waivePolicyForbiddenOutcomes` runs (closing any un-completable policy-forbidden coupon-apply row + a sysNote naming what was waived), THEN the gate is checked: on `ok`, we close normally; on `!ok`, `escalateTicketOnIncompleteOutcomes` fires and a sysNote records the unfinished items (the assigned agent sees the exact kinds and statuses). On CAS-lost, the caller falls through to the normal close — the other writer's state is authoritative.
- Future wire-ins (still deferred to their own follow-up work):
  - Every other `setStatus(admin, tid, cfg.auto_resolve)` call site in `unified-ticket-handler.ts` (playbook advance, workflow return, positive-close, ep-pb — 15 sites total). All should route through the gate; the Phase 4 wire-in seeds the pattern at the primary sonnet-orchestrator path.
  - `scripts/builder-worker.ts` `runTicketHandleJob` post-close path (currently doesn't setStatus itself; leaves the ticket to the next unified-ticket-handler tick).

## Tests

`src/lib/outcome-completion-gate.test.ts`:
- Judy failing state (pending bag + failed credit → BLOCKED, both named on the reason — test-first, learning #8)
- All-verified → OK (auto-resolve allowed)
- Empty outcomes → OK (backward compatible)
- Any pending / done / failed → BLOCKED (each isolated)
- Mixed statuses → all non-verified named
- `buildEscalationReason` shape + empty-string on OK verdict + 500-char cap on 40-item overflow.
- **WAIVE (ticket aaf00047):** a `waived` row → gate OK; a lone `failed` coupon row still BLOCKS until waived; `assessPolicyForbidden` truth table; `waivePolicyForbiddenOutcomes` closes a failed coupon-apply on a paused sub (+ idempotent), leaves an active-sub failure open, and fail-closed when `contract_id` is absent.

Run: `npx tsx --test src/lib/outcome-completion-gate.test.ts`

---

[[../README]] · [[../tables/ticket_required_outcomes]] · [[../tables/ticket_resolution_events]] · [[../tables/tickets]] · [[ticket-required-outcomes]] · [[honor-required-outcomes]] · [[required-outcome-policy]] · [[required-outcomes-validator]] · [[sol-outcome-claim-guard]] · [[../inngest/unified-ticket-handler]] · [[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]] · [[../goals/guaranteed-ticket-handling]] · [[../functions/cs]] · [[../../CLAUDE]]
