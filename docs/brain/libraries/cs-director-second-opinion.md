# libraries/cs-director-second-opinion

The on-demand exception path a supervisor pulls when [[cs-director|June's]] primary review of an escalated ticket is genuinely borderline — Phase 2 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]].

**File:** `src/lib/cs-director-second-opinion.ts`

## Why it exists

The default escalation triage is a **single** June review (Phase 1 — [[../inngest/triage-escalations]] enqueues one `cs-director-call` box job per eligible escalated ticket → `runCsDirectorCallJob` writes a `triage_runs` row with `verdict='june_review'`). Phase 2 retired the legacy solver→skeptic→quorum sweep as the default (see [[../specs/box-escalation-triage]] — kept dormant, gated to `on_demand:true` in job instructions), but the trade-off of a single reviewer is that a truly borderline call has no built-in double-check. This module is the escape hatch: **exactly one** fresh June review of the same ticket, invoked on demand.

Not a routine quorum. If a supervisor is pulling second opinions on every ticket, the org has drifted back into the pattern the June-review consolidation was meant to end.

## Exports

### `enqueueJuneSecondOpinion(admin, ticketId, opts?)`

Enqueues one `cs-director-call` `agent_jobs` row for the ticket with `instructions.second_opinion_of` set to the first review's `triage_runs.id`. Returns a shaped result: never throws for a guard miss (only for a Supabase error).

**Guards** — each enforced INSIDE the function so the caller never re-derives them:

1. **Ticket exists** (`tickets.id = ticketId`).
2. **Ticket was escalated** (`escalated_at IS NOT NULL`). A never-escalated ticket has no first review to second-opine.
3. **Prior June review exists** for the ticket (`triage_runs.verdict = 'june_review'`). There is nothing to second-guess otherwise.
4. **No prior second opinion** (`triage_runs.verdict = 'second_opinion'`). The spec is **exactly one** per escalation lifecycle.
5. **No inflight `cs-director-call` job** on the ticket (`spec_slug = ticketId` AND `status` in the active set) — same shape the hourly cron dedup uses.

**Params**:
- `admin` — a `createAdminClient()` (service role) client.
- `ticketId` — the ticket to review.
- `opts.expectedWorkspaceId` — optional. When present, the ticket's `workspace_id` must match (a route caller passes the session workspace so a caller can't reach across workspaces).

**Return**:
- `{ ok: true, job_id, first_run_id }` — the new `agent_jobs.id` + the first review's `triage_runs.id`.
- `{ ok: false, reason, detail? }` — reasons: `ticket_not_found | ticket_not_escalated | no_prior_june_review | second_opinion_already_exists | already_in_flight | enqueue_failed`.

## Callers

- [[../../../scripts/request-june-second-opinion.ts|scripts/request-june-second-opinion.ts]] — CLI wrapper (`npx tsx scripts/request-june-second-opinion.ts <ticket_id>`), the initial invocation surface. A future dashboard route will call `enqueueJuneSecondOpinion` directly.

## How the runner routes the second-opinion job

`scripts/builder-worker.ts` → `runCsDirectorCallJob`:

1. Reads `instructions.second_opinion_of` — if present, sets `secondOpinionOfRunId`.
2. `loadCsDirectorCallBrief(...)` includes a **FIRST JUNE REVIEW** section built from the first `triage_runs` row (verdict + decision + reasoning + first-review transcript).
3. `csDirectorCallPrompt(brief, /*secondOpinion=*/true)` swaps the role framing: "This is an on-demand SECOND OPINION on a prior June review — do NOT rubber-stamp; refute with concrete new evidence when you can."
4. The `triage_runs` insert uses `verdict='second_opinion'` (vs. `'june_review'` on the primary). `solver_transcript.second_opinion_of` back-pointers to the first run so a reader can pair the two verdicts.
5. `director_activity.metadata.second_opinion_of` carries the same back-pointer.
6. Existing worker paths (digest / dashboard_notifications on `escalate_founder`, remedy / spec-seed audit) are the same — Phase 2 didn't rewire the materialization, only added the alternate reviewer.

## Tables read + written

- **Read:** [[../tables/tickets]], [[../tables/triage_runs]] (prior-runs guard), [[../tables/agent_jobs]] (inflight guard).
- **Written:** [[../tables/agent_jobs]] (one `cs-director-call` insert).

## Related

[[cs-director]] · [[cs-director-digest]] · [[cs-director-black-swan]] · [[../tables/triage_runs]] · [[../tables/agent_jobs]] · [[../inngest/triage-escalations]] · [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] · [[../specs/box-escalation-triage]] · [[../functions/cs]] · [[../operational-rules]]
