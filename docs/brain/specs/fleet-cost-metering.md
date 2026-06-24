# Fleet Cost Metering 🚧

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/grow-surface-platform-agent-team]] · M4 — Cost / Spend governor

The goal's success metric requires "fleet spend is budgeted + visible" and "per-spec cost" — but **nothing meters the fleet today**. [[../libraries/ai-usage]] (`logAiUsage` → [[../tables/ai_token_usage]]) captures only **SDK Claude API calls** (its callers are the runtime AI surfaces — `unified-ticket-handler`, `sonnet-orchestrator-v2`, `ticket-analyzer`, `translate`…), and `ai_token_usage` is ticket-scoped. The **agent fleet** — the box `claude -p` lanes (build/plan/repair/regression/security/…) — runs on the **Max subscription with no `ANTHROPIC_API_KEY`**, so it writes nothing to `ai_token_usage`, and [[../tables/agent_jobs]] has **no cost/token column**. Fleet spend is unmetered. This spec captures it — the metric foundation the [[fleet-spend-governor]] and the [[platform-department-scorecard]] spend KPI read.

## North star — meter the proxy honestly
A budget governor can only supervise spend it can measure. On the Max subscription there is **no per-token dollar bill** for the box lanes, so the honest proxy is **token usage** (the `claude -p` stream reports it) plus **Max-account usage-window consumption** (the 5-hour wall the box already tracks). Dollar cost (`usageCostCents`) applies only to the API-keyed paths. This spec records all three, labeled for what they are — never a fake "$" on subscription work.

## Phase 1 — capture per-job token usage from the `claude -p` stream 🚧
- 🚧 built — pending migration apply + on-box verification
- The box worker (`scripts/builder-worker.ts`) already parses the `claude -p` stream for `claude_session_id` ([[../tables/agent_jobs]]`.claude_session_id`). Extend the stream parse to also read the **usage/result** events (`input_tokens`, `output_tokens`, `cache_creation`, `cache_read`) and record them per job. → `extractClaudeUsage()` reads the result event's `usage` / `modelUsage` in `runClaude`, returned alongside the session id.
- Persist per-job cost in a new `agent_job_costs` table (`job_id` → `agent_jobs.id`, `spec_slug`, `kind`, `owner_function`, the token counts, `model`, `created_at`) rather than widening `agent_jobs` (one job can span resumes / multiple turns → multiple cost rows that aggregate). Brain: new `tables/agent_job_costs` + `libraries/fleet-cost`. → migration `20260705170000_agent_job_costs.sql`; written by `meterAgentJob()` → [[../libraries/fleet-cost]] `recordAgentJobCost()` at every `runClaude` call site (build / plan / fold / spec-chat).
- Best-effort, mirroring [[../libraries/control-tower]] `emitLoopHeartbeat` — a metering write **never** blocks or fails a build. → `meterAgentJob` + `recordAgentJobCost` both swallow all errors.

### Verification — Phase 1
- A completed `build` job → ≥1 `agent_job_costs` row keyed to its `job_id` + `spec_slug` with non-zero token counts; a metering write failure leaves the build itself unaffected.

## Phase 2 — Max-account usage-window consumption 🚧
- 🚧 built — pending migration apply + on-box verification
- Reuse the [[box-multi-account-failover]] machinery — the box [[../tables/worker_heartbeats]] `accounts` payload, `agent_jobs.claude_session_config_dir` (the Max account that ran the job), and the `blocked_on_usage` parking signal — to attribute each job to its **Max account** and record usage-window consumption (the subscription proxy for the no-`ANTHROPIC_API_KEY` lanes). Stamp `account` / `config_dir` onto the `agent_job_costs` row. → `meterAgentJob` resolves the account label via `accountLabel(configDir)` and stamps `account` + `config_dir` on every row.
- This makes "which account is burning the 5-hour window, on what work" answerable per kind / per function — the thing a flat token count alone can't show on a capped subscription.

### Verification — Phase 2
- After a run, the job's `agent_job_costs` row carries its Max account; aggregating by account over a window matches the `worker_heartbeats` `accounts` load the Control Tower box tile shows.

## Phase 3 — rollup + reuse `usageCostCents` for API-keyed paths 🚧
- 🚧 built — pending on-box verification (rollup reconciliation needs live rows)
- Provide a read-only rollup (`libraries/fleet-cost` — per `spec_slug` / per `kind` / per `owner_function` / per day) over `agent_job_costs`, joining the existing [[../tables/ai_token_usage]] rows for the API-keyed runtime AI so a function's **total** AI spend (fleet + runtime) is one query. → `rollupFleetCost()` in [[../libraries/fleet-cost]]; `rowCounts` lets a caller reconcile against the raw rows.
- Reuse [[../libraries/ai-usage]] `usageCostCents(model, row)` to attach a **dollar** figure only where a real API bill exists; Max-lane rows carry token + usage-window, explicitly **not** a `$` (labeled "subscription, no per-token bill"). → buckets expose `usd_cents` (null for Max lanes) + `subscription_only`.

### Verification — Phase 3
- The rollup returns per-spec / per-kind / per-function token totals (and `$` only for API-keyed rows) for a chosen window; the numbers reconcile against the raw `agent_job_costs` + `ai_token_usage` rows.

## Safety / invariants
- Metering is **best-effort and never on the critical path** — a failed cost write must never block, fail, or slow a build (mirror `emitLoopHeartbeat`).
- The rollup is **read-only**; this spec records and reports cost, it never throttles, parks, or kills a lane (that judgment is the [[fleet-spend-governor]]'s, and even there it escalates).
- Token / usage-window figures for Max lanes are labeled as a **subscription proxy, not a dollar bill** — `$` appears only for genuinely API-billed rows (`usageCostCents`). No fabricated cost.

## Completion criteria
- Every box `agent_jobs` run records ≥1 `agent_job_costs` row with token usage + its Max account / usage-window, keyed to `spec_slug` / `kind` / `owner_function`.
- A read-only rollup returns per-spec / per-kind / per-function cost (token + usage-window, plus `$` for API-keyed paths), reconciling against the raw rows.
- No path in the build/worker loop can fail on a metering error.

## Verification
- On the box, run a `build` job to completion → query `agent_job_costs` for that `job_id` → expect a row with non-zero token counts, the `spec_slug`, `kind`, and Max account stamped.
- Call the `libraries/fleet-cost` rollup for the last 7 days → expect per-kind + per-function token totals that sum to the raw `agent_job_costs` rows, with `$` only on API-keyed entries.
- Force a metering write to error locally → expect the build still completes and opens its PR (metering is best-effort).

## Related
[[../libraries/ai-usage]] · [[../tables/ai_token_usage]] · [[../tables/agent_jobs]] · [[../tables/worker_heartbeats]] · [[box-multi-account-failover]] · [[fleet-spend-governor]] · [[platform-department-scorecard]] · [[../goals/grow-surface-platform-agent-team]]
