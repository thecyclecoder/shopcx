# libraries/fleet-cost

Fleet cost metering — records + rolls up per-job token usage for the box agent fleet (the `claude -p` lanes). Writes [[../tables/agent_job_costs]]; reads it back joined with [[../tables/ai_token_usage]]. Authored by [[../specs/fleet-cost-metering]].

**File:** `src/lib/fleet-cost.ts`

## File header

```
Fleet cost metering — per-job token usage for the box agent fleet (the `claude -p`
lanes: build / plan / fold / spec-chat / repair / regression / triage / spec-test /
migration-fix / …). These run on the Max subscription with NO ANTHROPIC_API_KEY, so
they write nothing to ai_token_usage and there is no per-token dollar bill. The honest
proxy recorded is TOKEN usage plus the MAX ACCOUNT / config-dir that burned the window.
```

## Exports

### `recordAgentJobCost` — function

```ts
async function recordAgentJobCost(p: RecordAgentJobCostParams): Promise<boolean>
```

Best-effort insert of **one** per-turn [[../tables/agent_job_costs]] row. **Never throws** — a metering failure must never block / fail / slow a lane (mirrors [[control-tower]] `emitLoopHeartbeat`). Returns `false` (and logs) on any failure or when the run emitted no token usage; `true` on a write. `$` (`usage_cost_cents` via [[ai-usage]] `usageCostCents`) is attached **only** when `apiBilled === true` AND a model is known — box Max lanes pass `apiBilled: false`, so they carry token + usage-window and **never** a fabricated dollar.

`RecordAgentJobCostParams`: `{ jobId, workspaceId?, specSlug?, kind?, ownerFunction?, usage, model?, account?, configDir?, apiBilled? }`. `usage` is the snake_case `ClaudeRunUsage` (`{ input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }`) parsed off the `claude -p` result event.

### `rollupFleetCost` — function

```ts
async function rollupFleetCost(opts?: FleetCostRollupOpts): Promise<FleetCostRollup>
```

**Read-only** aggregation over a window (default 7 days). Buckets the fleet ([[../tables/agent_job_costs]]) by `spec_slug` / `kind` / `owner_function` / day, and — unless `includeRuntimeAi: false` — folds in the API-keyed runtime AI ([[../tables/ai_token_usage]]) so a function's **total** AI spend (fleet + runtime) is one query. Each `FleetCostBucket` carries token totals plus `usd_cents` (non-null **only** where a genuine API bill contributed) and `subscription_only` (true when every contributing row is a no-`$` Max lane). `rowCounts` returns the raw fleet / runtime row counts so a caller can **reconcile** the rollup against the source rows. Never mutates, never throttles — that judgment is the [[../specs/fleet-spend-governor]]'s.

`FleetCostRollupOpts`: `{ workspaceId?, sinceDays?, includeRuntimeAi? }`.

## Callers

- **Writer:** `scripts/builder-worker.ts` — `meterAgentJob()` calls `recordAgentJobCost()` after every `claude -p` turn (`runClaude` → `extractClaudeUsage`), keyed to the job + its Max account / config-dir.
- **Reader:** the [[../specs/fleet-spend-governor]] (budget supervision — see [[fleet-spend-governor]] for the [[../tables/fleet_budgets]] config surface) + [[../specs/platform-department-scorecard]] spend KPI call `rollupFleetCost()`.

## Gotchas

- **`$` only where a real bill exists.** Max-lane buckets stay `usd_cents: null` / `subscription_only: true` — read those as a subscription proxy, never as "$0".
- **`apiBilled` is the contract other surfaces reuse — do NOT invent a parallel concept.** [[ticket-analyzer]] mirrors this exact predicate: `analyzerCostCentsForRun` (extracted for the smallest possible unit test) applies `apiBilled && model ? usageCostCents(...) : 0` and persists the flag on [[../tables/ticket_analyses]] `billing_source` ('max' | 'api' | null). A Max-lane analyzer run persists `cost_cents = 0` AND skips [[ai-usage]] `logAiUsage` so no downstream summing surface (`/api/tickets/[id]/analysis`, `stampTicketAiCost`, workspace/developer AI analytics) fabricates a dollar figure. The deployed-analyzer fallback path (`apiBilled: true`) still records real cents. Same rule everywhere: apiBilled=true → `$`; apiBilled=false → subscription proxy (token only). See `docs/brain/specs/ticket-cost-distinguishes-max-subscription-from-real-api-spend.md`.
- **Best-effort writes.** A missing cost row ≠ a build failure; the writer swallows errors by design.
- **Multiple rows per `job_id`** (resumes / multi-turn) aggregate in the rollup — never treat one row as a whole job's cost.

## Related

[[../tables/agent_job_costs]] · [[ai-usage]] · [[../tables/ai_token_usage]] · [[control-tower]] · [[fleet-spend-governor]] · [[../tables/fleet_budgets]] · [[../specs/fleet-cost-metering]] · [[../specs/fleet-spend-governor]] · [[../specs/platform-department-scorecard]]
