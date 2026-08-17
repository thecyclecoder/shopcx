# libraries/escalation-retirement-sweep

Phase 2 of [[../specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]]: a standing pass that re-evaluates each OPEN, retirable CEO escalation against its `metadata.retire_when` descriptor and DISMISSES the ones whose condition is provably healed — with the evidence recorded, never a bare clear.

**File:** `src/lib/escalation-retirement-sweep.ts`

## The problem it solves

Escalation cards capture the moment they're raised, but they keep claiming that moment is still true forever — even when the underlying condition has long since healed. This sweep re-asks the original question on each pass and retires the cards whose condition no longer holds, leaving a full audit trail so a human can verify what left and why.

## Core invariants

1. **Evaluates the SAME feed the founder sees** — filters [[../agents/approvals-feed]] `buildApprovalsFeed` to `source==='pending' && escalated` so if the sweep and the inbox diverge, it's a visible bug, not silent divergence.

2. **Skip non-retirable + absent descriptors** — a card with no descriptor or an explicit `non_retirable` shape (e.g., a founder yes/no decision waiting for an answer) is NEVER touched. This is the fail-closed contract from Phase 1: an escalation that cannot be safely re-checked stays in the inbox until a human clears it.

3. **Retire ONLY on positive proof of healing** — a DB error, a timeout, an unreadable row is treated as "cannot re-check" and the card stays exactly where it is. Wrong-conservative (a card sits a little longer) is always preferable to wrong-aggressive (a card retires while the underlying condition is still true).

4. **Dismiss + record evidence, never a bare clear** — a retirement writes `dismissed=true` + patches `metadata.retire_reason`, `metadata.retire_evidence`, `metadata.retired_at` on the row, AND writes ONE [[../tables/director_activity]] row under the raising director's function so the founder can audit "what did it retire, and was it right?" from the ledger alone.

5. **Never DECIDES the underlying action** — dismiss clears the card; it does not approve or decline anything. Enforced twice: (1) the descriptor gate at raise time (a raiser with a still-actionable pending action must not set `retire_when`), and (2) a defense-in-depth guard IN this sweep that skips any card whose enriched approvals feed reports `actions.length > 0`. Belt-and-suspenders so a raiser bug can never let the sweep silently discard a decision.

6. **Rate-limited per pass** — bounded by `RETIREMENT_SWEEP_CAP_PER_PASS` (50) so a sudden burst is visible in the standing-pass notes rather than discovered later. The count of retired cards flows into the pass summary.

## Exports

- **`retireHealedEscalations(admin, workspaceId)`** → `Promise<RetirementSweepResult>` — the Phase 2 sweep entrypoint. Reads the pending+escalated feed the founder sees, evaluates each retirable card against its `retire_when` descriptor, and dismisses the ones whose condition is provably healed. Best-effort; idempotent (a card dismissed between feed build and sweep is skipped). Called once per pass from `runPlatformDirectorStandingPass` in `scripts/builder-worker.ts`, alongside `reconcileSwallowedEscalations` and the rest of the standing-pass family.

- **`decideRetirement(descriptor, state)`** → `RetireDecision` — pure decision helper. Given a `EscalationRecheckDescriptor` and the current DB state it needs, decides whether to retire. Returns `{ retire: true, evidenceReason, evidence }` or `{ retire: false, reason }`. Unit-tested in `escalation-retirement-sweep.test.ts` (7 tests exercising each descriptor shape + the fail-closed contract) so the "positive proof of healing" invariant is exercised without a Supabase seam.

- **`CurrentStateForRetireCheck`** — interface capturing the DB state a descriptor's decision needs: `ticketStatus?` (ticket.status for ticket_terminal), `jobStatus?` (agent_jobs.status for job_terminal), `activeSubscriptionId?` (any active subscription for action_satisfied → subscription_exists), `orderId?` (any order for action_satisfied → order_exists). Undefined fields mean the reader couldn't fetch that state; `decideRetirement` treats them as "cannot re-check" and fails closed.

- **`RetirementSweepResult`** — interface returned by `retireHealedEscalations`: `scanned` (how many pending+escalated cards were considered), `retired` (notification.id + evidence line per retirement), `unreadable` (any card the sweep couldn't re-check — left in place).

- **`RETIREMENT_SWEEP_CAP_PER_PASS`** — per-pass ceiling (50). A legitimate healed-card backlog is small; a large one means the raise side is emitting cards that heal instantly (a bug the founder should see, not a silent auto-clear).

## Flow

1. Build the founder's current approvals feed via [[../agents/approvals-feed]] `buildApprovalsFeed`, filter to `source==='pending' && escalated`.

2. Re-fetch the raw notification rows' metadata (buildApprovalsFeed enriches it into typed fields, but the sweep needs the original `metadata` blob to read the `retire_when` descriptor). Idempotent: if a row got dismissed between feed build and re-read, skip it.

3. For each card:
   - Skip if `actions.length > 0` (defense-in-depth: a card with pending decisions is by definition not healed).
   - Read the descriptor from `metadata.retire_when` via [[escalation-recheck]] `readEscalationRecheckDescriptor`.
   - Skip if the descriptor is absent, malformed, or `non_retirable` (fail-closed).
   - Read the current DB state the descriptor needs (`ticket_terminal` reads ticket.status; `job_terminal` reads agent_jobs.status; `action_satisfied` reads subscriptions or orders).
   - Call pure `decideRetirement(descriptor, state)`.
   - If it returns `retire: false`, continue to the next card.

4. For each card that should retire:
   - Compose a metadata patch keeping the original body + adding `retire_reason`, `retire_evidence`, `retired_at`.
   - Update the notification: `dismissed=true`, patch the metadata (compare-and-set on `dismissed=false` for idempotency).
   - Write one [[../tables/director_activity]] row with `action_kind='retired_escalation'` under the raising director's function (read from `metadata.escalated_by_director`, defaulting to `platform`).
   - Append the notification ID + evidence line to the result.

5. Return the sweep result so `runPlatformDirectorStandingPass` can include the retired count + evidence in the standing-pass notes.

## The descriptor shapes

Defined in [[escalation-recheck]]:

- **`ticket_terminal`** — `{ ticket_id }`. Retire when `tickets.status === 'closed'`. The 2026-08-14 ground-truth pair (`a5376176` + `6c8ef178`) and the [[cs-director-escalate-founder-card]] class both use this.

- **`job_terminal`** — `{ agent_job_id }`. Retire when the `agent_jobs` row is no longer in a live / needs-attention status (`!ACTIVE_STATUSES.includes(status) && status !== 'needs_attention'`).

- **`action_satisfied`** — `{ action, customer_id }` where `action ∈ { 'subscription_exists', 'order_exists' }`. Retire when the thing the failed action was trying to create now exists. The [[assisted-purchase-failure-card]] class carries this — the 2026-08-14 Susan pair is this shape.

- **`non_retirable`** — `{ reason }`. Never retire. Decision-class escalations (a founder yes/no) explicitly opt out.

## Test case — the ground truth

2026-08-14 17:40: Cards `a5376176` + `6c8ef178` raised (`create_subscription — no_vaulted_payment_method`) against ticket `2c49bc7e`.

- 22:51 — system linked customer's two accounts.
- 23:34 — system changed subscription cadence.
- 05:57 on 08-15 — system corrected next billing date, closed the ticket resolved.
- First sweep after 05:57:41 — both cards should have retired with evidence (ticket closed, subscription now active).
- 08-17 16:1x (67 hours later) — cards were cleared by hand (the sweep didn't exist yet).

## Gotcha: the ticket.escalated_at contract

The tickets brain page pins that `escalated_at` is cleared to null on transition to `closed`, so a closed ticket is by construction "not escalated" — one check suffices and cannot false-positive on a re-escalated live ticket. The `ticket_terminal` decision relies on this invariant; if the contract breaks, the sweep could leave a healed card that's been re-escalated.

## Related

- [[../specs/an-escalation-retires-itself-when-the-condition-it-reported-self-heals]] — the full spec (Phase 1 SDK + Phase 2 sweep).
- [[escalation-recheck]] — Phase 1 SDK defining the descriptor union and validation.
- [[../agents/approvals-feed]] — the approvals feed builder this sweep filters.
- [[../tables/dashboard_notifications]] — the escalation cards.
- [[../tables/director_activity]] — the audit ledger where retirements are recorded.
