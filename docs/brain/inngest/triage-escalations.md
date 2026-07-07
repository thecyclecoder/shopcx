# inngest/triage-escalations

The hourly enqueuer for the box's **June-review escalation triage** (Phase 1 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]]). The box has no internal ticker, so this cron is the trigger: every hour it inserts one **`agent_jobs` row `kind='cs-director-call'` per eligible escalated ticket**, and the box worker ([[../recipes/build-box-setup]] → `runCsDirectorCallJob`) reviews the ticket as the CS Director (💬 [[../libraries/cs-director|June]]). **This cron does NO reasoning** — it is purely the enqueue, exactly as [[portal-auto-resume]] does for paused subs.

**File:** `src/lib/inngest/triage-escalations.ts` (registered in `src/app/api/inngest/route.ts`)

## Functions

### `triage-escalations-cron`
- **Trigger:** cron `30 * * * *` (hourly, on the half-hour — offset from the other crons)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each **routine-owned escalated ticket** — `escalated_at IS NOT NULL` AND `escalated_to IS NULL` (escalated past every deterministic rule, prompt rule, and the orchestrator; see [[../lifecycles/ai-analysis]]) — it inserts one `queued` `agent_jobs` row `kind='cs-director-call'` with `spec_slug = ticket_id` and `instructions = {"ticket_id": ...}`. The box claims the row on its **concurrency-1 `cs-director-call` lane** (`MAX_CS_DIRECTOR_CALL=1`) and runs [[../libraries/cs-director|June's]] read-only review (the ticket handling, the analyzer grade + issue tags, the resolution-events ledger, customer + subs + orders) via the [`cs-director-call` skill](../../../.claude/skills/cs-director-call/SKILL.md) → one JSON verdict { `approve_remedy` | `author_spec` | `escalate_founder` }. Per-tick cap: `JUNE_REVIEW_ENQUEUE_CAP_PER_TICK` (default 20).

Prior to Phase 1 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] this cron enqueued ONE `triage-escalations` sweep job per workspace, and the box then ran a solver→skeptic→quorum loop over each eligible ticket (see [[../specs/box-escalation-triage]] — retired as the default in Phase 2 of the June-review spec). The routing is now: **every escalated ticket → June's review, directly**.

**Who produces the routine-owned state.** Every system escalation path *defaults* to the routine — `escalated_to = null` (keep `escalated_at` + `escalation_reason`): [[../libraries/ticket-analyzer]] (low-score re-open), the orchestrator `escalate` action (`src/lib/action-executor.ts`), the workflow executor's `escalate` (`src/lib/workflow-executor.ts`), and portal remediation (`src/lib/portal/remediation.ts`). A human can also pick **🤖 AI Routine** in the ticket escalate dropdown ([[../dashboard/tickets__id]]). See [[../specs/escalate-to-routine-by-default]].

## Dedupe

Two guards, applied per-ticket:

1. **Inflight guard** — skip a ticket that already has a `cs-director-call` job on `spec_slug = ticket_id` in an active status (`queued|queued_resume|claimed|building|needs_input`). No dup enqueue per hourly tick.
2. **Prior-review guard** — skip a ticket that already has a `triage_runs` row (any verdict). Phase 1 is one June-review per ticket; Phase 2 of [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] adds an on-demand second-opinion path for genuinely borderline cases (the exception, not a routine re-run).

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Tables written

- [[../tables/agent_jobs]] (inserts one `cs-director-call` job per eligible escalated ticket)

## Tables read (not written)

- [[../tables/tickets]] (escalated-ticket scan)
- [[../tables/agent_jobs]] (inflight dedupe)
- [[../tables/triage_runs]] (prior-review dedupe)

## Contrast with `portal-auto-resume`

Same pattern as [[portal-auto-resume]]'s `portal-auto-resume-cron` (hourly, concurrency-1, replaces a box-internal ticker with a cron-enqueue) — but where that cron *executes* the resume inline on Vercel, this one only **enqueues a job the box runs on Max**. The review (June's read-only investigation, $0 on Max, web search on) all happens in the box worker; the cron is the thinnest possible trigger.

---

[[../README]] · [[../integrations/inngest]] · [[../tables/agent_jobs]] · [[../tables/triage_runs]] · [[../recipes/build-box-setup]] · [[../libraries/cs-director]] · [[../specs/june-review-replaces-solver-skeptic-quorum-triage]] · [[../specs/box-escalation-triage]] · [[../lifecycles/agent-todo-system]] · [[../../CLAUDE]]
