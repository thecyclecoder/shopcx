# triage_runs

Per-review-per-ticket audit log for the box's escalation triage. Three writers land rows here:

- **June-review** (Phase 1 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] — the current default): one row per escalated ticket [[../libraries/cs-director|June]] reviewed, written by `scripts/builder-worker.ts` → `runCsDirectorCallJob`. `verdict='june_review'`; `decision` is the June-review taxonomy (`approve_remedy｜author_spec｜escalate_founder`); `solver_transcript` carries June's structured verdict; `skeptic_transcript` is null.
- **Second-opinion** (Phase 2 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] — on-demand exception): one row per second-opinion pull, written by `scripts/builder-worker.ts` → `runCsDirectorCallJob` when the job's `instructions.second_opinion_of` is set. `verdict='second_opinion'`; `decision` uses the same June-review taxonomy; `solver_transcript.second_opinion_of` back-pointers to the first review's `triage_runs.id`. Enqueued via [[../libraries/cs-director-second-opinion]] (exactly one per escalation lifecycle — the guards are enforced there). Not routine — a supervisor pulls it when a first verdict is genuinely borderline.
- **Solver→skeptic→quorum sweep** (legacy — pre-June-review; retired as the default in Phase 2 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]], see [[../specs/box-escalation-triage]]): one row per escalated ticket processed in one on-demand `triage-escalations` sweep, written by `scripts/builder-worker.ts` → `runEscalationTriageJob`. Gated — the runner refuses to fire unless `instructions.on_demand=true`. `verdict∈{agree|revise|reject|no_quorum}`; `decision` is the solver taxonomy; both transcripts populated.

The cron ([[../inngest/triage-escalations]]) only enqueues June-review jobs — no reasoning happens there.

**Nothing here is the customer artifact** — when the run materializes, the actual fix lands in [[agent_todos]] / `sonnet_prompts` / a committed spec, and `group_id` points at the materialized [[agent_todos]] group (if any). This table is the reasoning trail behind that.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `job_id` | `uuid` | ✓ | → [[agent_jobs]].id — the `kind='cs-director-call'` (June-review) OR legacy `kind='triage-escalations'` (solver-skeptic sweep) job that produced this run |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id — the escalated ticket triaged |
| `decision` | `text` | ✓ | June-review: `approve_remedy｜author_spec｜escalate_founder`. Legacy solver taxonomy: `customer_fix｜escalation_false_positive｜analysis_gap｜system_gap｜no_action` |
| `verdict` | `text` | — | `june_review` (default primary), `second_opinion` (Phase 2 on-demand exception), or legacy quorum outcome (`agree｜revise｜reject｜no_quorum`) · default `no_quorum` |
| `materialized` | `bool` | — | did this run land an artifact (todo / proposed prompt / spec / audit)? June-review rows record `true` (the audit + the existing worker path); legacy sweep sets `true` only on `agree` |
| `outcome` | `text` | ✓ | June-review: the reviewer's `reasoning`. Legacy: plain-English result / the skeptic critique on a no-quorum run |
| `solver_transcript` | `jsonb` | ✓ | June-review: `{reviewer:'cs_director', decision, reasoning, remedy?, spec_seed?}`. Legacy: the SOLVER Max session transcript |
| `skeptic_transcript` | `jsonb` | ✓ | June-review: `null` (no adversarial pass by default). Legacy: the SKEPTIC Max session transcript (fresh-eyes adversarial pass) |
| `group_id` | `uuid` | ✓ | the materialized [[agent_todos]] `group_id` when the outcome was a customer fix |
| `created_at` | `timestamptz` | — | default: `now()` |

## Verdict ↔ materialization

**June-review path** (Phase 1 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]]):

| `verdict` | `decision` | `materialized` | Ticket state |
|---|---|---|---|
| `june_review` | `approve_remedy` / `author_spec` | `true` | audit landed on [[director_activity]] + `triage_runs`; the third-rung mutator (a follow-on spec) applies remedy/spec-seed |
| `june_review` | `escalate_founder` | `true` | routed via the existing worker path — [[cs_director_digests]] `per_ticket_escalation` storyline (non-black-swan) or [[dashboard_notifications]] real-time page (black-swan) |

**Second-opinion path** (Phase 2 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] — on-demand exception):

| `verdict` | `decision` | `materialized` | Ticket state |
|---|---|---|---|
| `second_opinion` | any of the June-review taxonomy | `true` | same materialization as the primary June-review — this row is the SECOND verdict on the same ticket, paired to the first via `solver_transcript.second_opinion_of`. Exactly one per escalation lifecycle (guard: [[../libraries/cs-director-second-opinion]]) |

**Legacy solver→skeptic→quorum sweep** ([[../specs/box-escalation-triage]] — retired as the default in Phase 2 of the June-review spec):

| `verdict` | Meaning | `materialized` | Ticket state |
|---|---|---|---|
| `agree` | solver + skeptic agree (quorum) | `true` | resolution materialized — customer todo / proposed `sonnet_prompts` / committed spec |
| `revise` | skeptic asked for one bounded re-loop and they still disagreed | `false` | stays escalated |
| `reject` | skeptic refuted the proposal | `false` | stays escalated |
| `no_quorum` | unparseable / no agreement reached | `false` | stays escalated |

Legacy: only `verdict='agree'` materialized; everything else logged the disagreement and left the ticket escalated for the next sweep. After 3 no-quorum runs a ticket was deferred for a human.

## Indexes

- `triage_runs_ticket_idx (ticket_id, created_at desc)` — a ticket's triage history (the no-quorum-count check).
- `triage_runs_ws_idx (workspace_id, created_at desc)` — workspace audit feed.
- `triage_runs_job_idx (job_id)` — all runs in one sweep.

## RLS

- `triage_runs_select` — workspace members read their workspace rows.
- `triage_runs_service` — service role full access (the box worker writes via the service role).

## Gotchas

- **No-quorum rows have `materialized=false` and the ticket stays escalated** — they are the disagreement trail, not a failure to record. Don't treat a `triage_runs` row as proof a ticket was resolved; check `materialized` + `verdict`.
- **One row per ticket per sweep**, not per loop iteration — the bounded solver-resume re-loop on a `revise` collapses into the single final row (both transcripts reflect the last state).
- `group_id` is only set for materialized customer fixes; analyzer-fix specs and proposed prompts don't share a todo group.

## Migration

`supabase/migrations/20260620160000_triage_runs.sql`

## Related

[[../specs/june-review-replaces-solver-skeptic-quorum-triage]] · [[../specs/box-escalation-triage]] · [[../libraries/cs-director]] · [[director_activity]] · [[cs_director_digests]] · [[dashboard_notifications]] · [[agent_jobs]] · [[agent_todos]] · [[sonnet_prompts]] · [[../inngest/triage-escalations]] · [[../lifecycles/agent-todo-system]] · [[../functions/cs]]
