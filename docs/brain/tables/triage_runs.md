# triage_runs

Per-sweep-per-ticket audit log for the **box-hosted escalation triage** ([[../specs/box-escalation-triage]]). One row per escalated ticket processed in one hourly `triage-escalations` sweep — it captures the solver→skeptic→quorum verdict and **both transcripts** so every triage decision (materialized or not) is replayable. The box worker (`scripts/builder-worker.ts` → `runEscalationTriageJob`) writes it; the cron ([[../inngest/triage-escalations]]) only enqueues the job.

**Nothing here is the customer artifact** — when the run materializes, the actual fix lands in [[agent_todos]] / `sonnet_prompts` / a committed spec, and `group_id` points at the materialized [[agent_todos]] group (if any). This table is the reasoning trail behind that.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `job_id` | `uuid` | ✓ | → [[agent_jobs]].id — the `kind='triage-escalations'` sweep that produced this run |
| `ticket_id` | `uuid` | ✓ | → [[tickets]].id — the escalated ticket triaged |
| `decision` | `text` | ✓ | the Solver's branch: `customer_fix｜escalation_false_positive｜analysis_gap｜system_gap｜no_action` |
| `verdict` | `text` | — | quorum outcome: `agree｜revise｜reject｜no_quorum` · default `no_quorum` |
| `materialized` | `bool` | — | did this run produce an artifact (todo / proposed prompt / spec)? `true` only on `agree` |
| `outcome` | `text` | ✓ | plain-English result / the skeptic critique on a no-quorum run |
| `solver_transcript` | `jsonb` | ✓ | the SOLVER Max session transcript |
| `skeptic_transcript` | `jsonb` | ✓ | the SKEPTIC Max session transcript (fresh-eyes adversarial pass) |
| `group_id` | `uuid` | ✓ | the materialized [[agent_todos]] `group_id` when the outcome was a customer fix |
| `created_at` | `timestamptz` | — | default: `now()` |

## Verdict ↔ materialization

| `verdict` | Meaning | `materialized` | Ticket state |
|---|---|---|---|
| `agree` | solver + skeptic agree (quorum) | `true` | resolution materialized — customer todo / proposed `sonnet_prompts` / committed spec |
| `revise` | skeptic asked for one bounded re-loop and they still disagreed | `false` | stays escalated |
| `reject` | skeptic refuted the proposal | `false` | stays escalated |
| `no_quorum` | unparseable / no agreement reached | `false` | stays escalated |

Only `verdict='agree'` materializes. Everything else logs the disagreement (in `outcome`) and **leaves the ticket escalated** for the next sweep — after **3 no-quorum runs** a ticket is deferred for a human.

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

[[../specs/box-escalation-triage]] · [[agent_jobs]] · [[agent_todos]] · [[sonnet_prompts]] · [[../inngest/triage-escalations]] · [[../lifecycles/agent-todo-system]] · [[../functions/cs]]
