# agent_job_costs

Per-job, per-turn **token metering** for the box agent fleet — the `claude -p` lanes ([[agent_jobs]]: `build` / `plan` / `fold` / `spec-chat` / `repair` / `regression` / `triage-escalations` / `spec-test` / `migration-fix` / …). Authored by [[../specs/fleet-cost-metering]] (M4 of [[../goals/grow-surface-platform-agent-team]]).

**Why a table at all:** the fleet runs on the **Max subscription with no `ANTHROPIC_API_KEY`**, so it writes **nothing** to [[ai_token_usage]] (which captures only the API-keyed runtime AI), and `agent_jobs` has no cost column. Fleet spend was **unmetered**. This is the metric foundation the [[../specs/fleet-spend-governor]] and the [[../specs/platform-department-scorecard]] spend KPI read.

**Honest proxy (north star — meter the proxy honestly):** on Max there is **no per-token dollar bill** for these lanes, so the proxy recorded is **token usage** (the `claude -p` result event reports it) plus the **Max account / config-dir** that burned the 5-hour usage window. A `$` (`usage_cost_cents`) is attached **only** to genuinely API-billed rows — Max-lane rows carry token + usage-window and are explicitly **not** a dollar figure. No fabricated cost.

**One job → many rows.** A job that resumes / spans multiple turns writes **one row per turn**, all keyed to the same `job_id`; the [[../libraries/fleet-cost]] rollup aggregates them. The write is **best-effort** (mirrors [[../libraries/control-tower]] `emitLoopHeartbeat`) — a metering failure **never** blocks, fails, or slows a build.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `job_id` | `uuid` | → [[agent_jobs]].id · ON DELETE CASCADE — the job this turn ran for |
| `workspace_id` | `uuid?` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text?` | copied from the job at write time (the spec / goal / thread / signature it ran for) |
| `kind` | `text?` | the [[agent_jobs]] `kind` lane (`build` ｜ `plan` ｜ `fold` ｜ `spec-chat` ｜ …) |
| `owner_function` | `text?` | org-chart function that owns the lane (`ownerFunctionForKind(kind)`, [[../libraries/approval-inbox]]) — best-effort; `null` for an unmapped kind |
| `input_tokens` | `int` | default 0 |
| `output_tokens` | `int` | default 0 |
| `cache_creation_tokens` | `int` | default 0 |
| `cache_read_tokens` | `int` | default 0 |
| `model` | `text?` | dominant model id off the run's `modelUsage` (e.g. `claude-opus-4-8`) |
| `account` | `text?` | Phase 2 — Max account label that ran this turn (`accountLabel`, e.g. `account 1 · default`) |
| `config_dir` | `text?` | Phase 2 — the `CLAUDE_CONFIG_DIR` that ran this turn ([[../specs/box-multi-account-failover]]) |
| `usage_cost_cents` | `numeric?` | `$` in cents — **only** for genuinely API-billed rows (`usageCostCents`, [[../libraries/ai-usage]]); **NULL** for Max lanes (no per-token bill) |
| `resumed_session` | `bool` | default `false` — [[../specs/chained-phase-session-resume]] Phase 2 · **true** when this turn started as a **RESUME** of a prior `claude -p` session (chained-phase carry-forward, or a `needs_input` / `needs_approval` → `queued_resume` flip); **false** when it started **FRESH**. A resumed turn should show `cache_read_tokens` materially exceeding `input_tokens` (the prior transcript served from cache ~0.1x). |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

`agent_job_costs_job_idx (job_id)` · `agent_job_costs_ws_created_idx (workspace_id, created_at desc)` · `agent_job_costs_slug_idx (spec_slug, created_at desc)` · `agent_job_costs_kind_idx (kind, created_at desc)` · `agent_job_costs_owner_idx (owner_function, created_at desc)` · `agent_job_costs_resumed_idx (resumed_session, created_at desc)`.

## Who writes / reads

- **Writer:** the box worker (`scripts/builder-worker.ts`), once per finished `claude -p` turn, via `meterAgentJob()` → [[../libraries/fleet-cost]] `recordAgentJobCost()`. `runClaude` parses the result event's `usage` / `modelUsage` (`extractClaudeUsage`) alongside the `claude_session_id` it already captured. Service role. **Best-effort** — wrapped so any error is swallowed; the build is unaffected.
- **Reader:** [[../libraries/fleet-cost]] `rollupFleetCost()` — a **read-only** per-`spec_slug` / per-`kind` / per-`owner_function` / per-day aggregation that also folds in the API-keyed [[ai_token_usage]] rows so a function's **total** AI spend (fleet + runtime) is one query. The [[../specs/fleet-spend-governor]] + [[../specs/platform-department-scorecard]] read this.

## Gotchas

- **`$` only where a real bill exists.** Max-lane rows leave `usage_cost_cents` NULL on purpose — never read a 0/NULL as "free", read it as "subscription proxy, no per-token bill". The token columns are the real signal there.
- **Multiple rows per job is normal**, not a dup — resumes / multi-turn lanes each write a row. Always aggregate by `job_id` (or higher) before reporting a per-job cost.
- **A missing row is not a billing error.** Metering is best-effort: a `claude -p` run that emitted no parseable usage event, or whose write failed, simply has no row — the build still completed.
- **Read-only downstream.** This table records + reports cost; it never throttles, parks, or kills a lane (that judgment is the [[../specs/fleet-spend-governor]]'s — its budget config lives in [[fleet_budgets]] via [[../libraries/fleet-spend-governor]]).

## Migration

`supabase/migrations/20260705170000_agent_job_costs.sql` — apply with `npx tsx scripts/apply-agent-job-costs-migration.ts`. RLS: service-role full access + workspace-member SELECT (same shape as [[ai_token_usage]] / [[agent_jobs]]).

`supabase/migrations/20260702130000_agent_job_costs_resumed_session.sql` — adds `resumed_session bool default false` + `agent_job_costs_resumed_idx` ([[../specs/chained-phase-session-resume]] Phase 2). Apply with `npx tsx scripts/apply-agent-job-costs-resumed-session-migration.ts`. Idempotent (`ADD COLUMN IF NOT EXISTS`).

## Related

[[agent_jobs]] · [[ai_token_usage]] · [[worker_heartbeats]] · [[fleet_budgets]] · [[../libraries/fleet-cost]] · [[../libraries/fleet-spend-governor]] · [[../libraries/ai-usage]] · [[../specs/fleet-cost-metering]] · [[../specs/fleet-spend-governor]] · [[../specs/box-multi-account-failover]]
