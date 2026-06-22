# inngest/triage-escalations

The hourly enqueuer for the **box-hosted escalation triage** ([[../specs/box-escalation-triage]]). The box has no internal ticker, so this cron is the trigger: every hour it inserts **one `agent_jobs` row `kind='triage-escalations'`** per workspace that has a routine-owned escalated ticket, and the box worker ([[../recipes/build-box-setup]] → `runEscalationTriageJob`) does the actual sweep. **This cron does NO reasoning** — it is purely enqueue, exactly as [[portal-auto-resume]] does for paused subs.

**File:** `src/lib/inngest/triage-escalations.ts` (registered in `src/app/api/inngest/route.ts`)

## Functions

### `triage-escalations-cron`
- **Trigger:** cron `30 * * * *` (hourly, on the half-hour — offset from the other crons)
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each workspace with at least one **routine-owned escalated ticket** — `escalated_at IS NOT NULL` AND `escalated_to IS NULL` (escalated past every deterministic rule, prompt rule, and the orchestrator; see [[../lifecycles/ai-analysis]]) — it inserts one `queued` `agent_jobs` row `kind='triage-escalations'`. One job per workspace per tick processes the batch; the box claims it on its **concurrency-1 `triage-escalations` lane** (`MAX_TRIAGE=1`) and sweeps up to `TRIAGE_CAP` (default 5, env `AGENT_TODO_TRIAGE_CAP`) tickets, running the solver→skeptic→quorum loop and writing a [[../tables/triage_runs]] row per ticket.

**Who produces the routine-owned state.** Every system escalation path now *defaults* to the routine — `escalated_to = null` (keep `escalated_at` + `escalation_reason`): [[../libraries/ticket-analyzer]] (low-score re-open), the orchestrator `escalate` action (`src/lib/action-executor.ts`), the workflow executor's `escalate` (`src/lib/workflow-executor.ts`), and portal remediation (`src/lib/portal/remediation.ts`). A human can also pick **🤖 AI Routine** in the ticket escalate dropdown ([[../dashboard/tickets__id]]). Before this, every path round-robined to a human, so the routine state was never produced and this cron found 0 work. See [[../specs/escalate-to-routine-by-default]].

**No-quorum hand-up.** When the box worker (`runEscalationTriageJob`) calls `handUpExhaustedTriage` (in `src/lib/agent-todos/triage.ts`) at the start of a sweep, any routine-owned ticket that has hit `MAX_NO_QUORUM_ATTEMPTS` (3) no-quorum runs without materializing is escalated **up to a real human** (`escalated_to` → workspace owner). That removes it from the routine pool (`escalated_to IS NULL` no longer matches) and surfaces it in the human escalation queue — unresolved cases still reach a person.

## Dedupe

It does **not** enqueue a second job for a workspace that already has an in-flight `triage-escalations` job (`status` ∈ active) — one sweep per workspace at a time. (Per-ticket dedupe — the one-active-group-per-ticket guard — lives in the worker's `selectEscalatedForTriage`, not here.)

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box (it only reaches out — [[../recipes/build-box-setup]]).

## Tables written

- [[../tables/agent_jobs]] (inserts the `triage-escalations` job)

## Tables read (not written)

- [[../tables/tickets]] (escalated-ticket scan)
- [[../tables/workspaces]]

## Contrast with `portal-auto-resume`

Same pattern as [[portal-auto-resume]]'s `portal-auto-resume-cron` (hourly, concurrency-1, replaces a box-internal ticker with a cron-enqueue) — but where that cron *executes* the resume inline on Vercel, this one only **enqueues a job the box runs on Max**. The reasoning (solver/skeptic, $0 on Max, web search on) all happens in the box worker; the cron is the thinnest possible trigger.

---

[[../README]] · [[../integrations/inngest]] · [[../tables/agent_jobs]] · [[../tables/triage_runs]] · [[../recipes/build-box-setup]] · [[../specs/box-escalation-triage]] · [[../lifecycles/agent-todo-system]] · [[../../CLAUDE]]
