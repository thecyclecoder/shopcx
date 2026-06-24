# inngest/platform-director-cron

The **standing cadence** for the box-hosted **Platform/DevOps Director** ([[../specs/platform-director-agent]], M5 [[../specs/director-loop-grading]] Phase 1 + 3). The director already runs **event-driven** — a `platform-director` [[../tables/agent_jobs]] row is enqueued when a Platform approval is routed to it ([[../specs/approval-routing-engine]]). What this adds: a **reliable beat** so escorting approved goals through their milestones + watching the platform happen even when no approval happens to arrive. The box has no internal ticker, so (exactly like [[triage-escalations]] / [[spec-test-cron]]) an Inngest cron is the trigger. Mirrors [[daily-analysis-report-cron]]'s daily cron shape.

Four halves: (1) the **enqueue** — purely the box-job insert, no reasoning. (2) the **director grading loop** ([[../specs/director-loop-grading]] Phase 3, `grade-concluded-director-calls` step) — on the same beat it grades every recently-CONCLUDED director call (each autonomous auto-approval + each escorted milestone that landed) 1–10 into [[../tables/director_decision_grades]] via [[../libraries/director-grader]] `gradeConcludedDirectorCalls`. (3) the **worker grading + coaching loop** ([[../specs/worker-grading-and-director-management]] Phase 2, `grade-and-coach-workers` step) — one level DOWN the cascade: it grades every recently-CONCLUDED worker action into [[../tables/agent_action_grades]] via [[../libraries/agent-grader]] `gradeConcludedAgentActions`, then coaches any worker whose rollup slipped (`detectGradeDropCoaching` → `coachAgent`). **Batched** — a workspace is graded only when `agentGradingBatchReady` (≥5 ungraded concluded jobs OR the oldest >~3h) so the LLM spend stays one session per batch. (4) the **Platform Scorecard daily pulse** ([[../specs/platform-scorecard-engine]] Phase 3, `snapshot-platform-scorecard` step) — on the same beat it snapshots the daily KPI set (loop health · error backlog + derived MTTR · build throughput · **lane utilization + enqueue rate** (the build-pool saturation KPIs, [[../specs/director-initiation-throughput]] Phase 4) · autonomy ratio · escalations) into [[../tables/platform_scorecard_snapshots]] via [[../libraries/platform-scorecard]] `computePlatformScorecard(ws, { cadence:'daily', windowDays:1 })`, **guarded to once per UTC day per workspace** (spend-saving — the upsert already makes a same-day re-run a no-op). On the same beat the **monthly leading curve** ([[../specs/platform-scorecard-monthly]] Phase 2, `snapshot-platform-scorecard-monthly` step) snapshots the monthly KPI set (human-touch-per-build · goals escorted unbabysat · time-to-approve · deploy reliability · director-call grade) via `computePlatformScorecard(ws, { cadence:'monthly', windowDays:30 })`, **guarded to once per calendar month per workspace** (skip a workspace with a `cadence='monthly'` row already this month; the upsert on `(metric_key, cadence='monthly', snapshot_date)` is the idempotent backstop). The grade sweeps + the scorecards run HERE (the deployed runtime has DB access + `ANTHROPIC_API_KEY`), not on the box; the grade sweeps mirror [[acquisition-research-cadence]]'s. Best-effort + idempotent; a no-op / zeros while nothing is ungraded or the workspace is quiet.

**File:** `src/lib/inngest/platform-director-cron.ts` (registered in `src/lib/inngest/registered-functions.ts` → served by `src/app/api/inngest/route.ts`)

## Functions

### `platform-director-cron`
- **Trigger:** cron `*/5 * * * *` (every 5 min — a TIGHT standing beat so the build pool stays saturated, [[../specs/director-initiation-throughput]] Phase 3 tightened it 15→5; the in-flight dedupe below prevents pileup). This cron is now the **BACKSTOP** heartbeat — the **event-driven top-up** ([[../libraries/agent-jobs]] `enqueueDirectorTopUp`, fired from `applyMergedBuildEffects` on a build merge) refills a freed lane within seconds, so the pool re-saturates between beats too.
- **Retries:** 1
- **Concurrency:** `concurrency: [{ limit: 1 }]`

## What it enqueues

For each **build-console workspace** — any workspace that uses the agent-jobs queue (has at least one [[../tables/agent_jobs]] row, mirrors [[spec-test-cron]]) — it inserts one `queued` `agent_jobs` row `kind='platform-director'` with **no `target_job_id`**. The box claims it on its platform-director lane (`scripts/builder-worker.ts` → `runPlatformDirectorJob`); a target-less job runs the **standing pass** (`runPlatformDirectorStandingPass`): `escortApprovedGoals` (escort each approved goal's unblocked specs through their milestones, Phase 2), `groomBoard` (board-grooming, [[../specs/board-grooming]] — assess each partially-shipped spec and **continue / split / escalate** its leftover phases via a per-candidate Max investigation), **and** `postPlatformWatchUpdate` (read [[../dashboard/control-tower]] health via its snapshot library + post the daily human-readable watch update as 🛠️ Ada to the [[../tables/director_messages]] board, Phase 4). All are no-ops unless Platform is `live + autonomous` ([[../tables/function_autonomy]]).

## Dedupe

It does **not** enqueue a second job for a workspace that already has an in-flight `platform-director` job (`status` ∈ `queued｜queued_resume｜building｜claimed`) — one standing pass per workspace at a time, never a daily pileup.

## Monitored

Registered in `MONITORED_LOOPS` (`src/lib/control-tower/registry.ts`, `owner: platform`, `livenessWindowMs: 26h`, `registeredAt` for the first-tick grace) so a dead cadence is visible on `/dashboard/developer/control-tower` and can't silently die — the [[../specs/coverage-auto-register-agent]] contract. Emits a `loop_heartbeats` beat (`loop_id='platform-director-cron'`) at end-of-run via `emitCronHeartbeat`.

## Downstream events sent

_None._ The box polls [[../tables/agent_jobs]] and claims the row; there is no HTTP call into the box.

## Tables written

- [[../tables/agent_jobs]] (inserts the `platform-director` job)
- [[../tables/director_decision_grades]] (the director grading loop — one grade per concluded director call, via [[../libraries/director-grader]])
- [[../tables/agent_action_grades]] (the worker grading loop — one grade per concluded worker action, via [[../libraries/agent-grader]])
- [[../tables/agent_instructions]] · [[../tables/agent_coaching_log]] (a grade-drop coaching amendment via `coachAgent`)
- [[../tables/platform_scorecard_snapshots]] (the daily scorecard pulse — one upserted row per daily KPI per workspace, via [[../libraries/platform-scorecard]])
- [[../tables/loop_heartbeats]] (end-of-run heartbeat)

## Tables read (not written)

- [[../tables/agent_jobs]] (build-console workspace scan + in-flight dedupe; target-build conclusion for the auto-approval grade; the concluded worker actions to grade; **scorecard**: merged builds for throughput + repair/regression jobs for derived MTTR; **monthly scorecard**: merged builds for human-touch-per-build, `spec_slug` to tie a touched approval to its goal, `updated_at` as the time-to-approve raise proxy)
- [[../tables/approval_decisions]] (the autonomous director approvals to grade; **scorecard**: autonomy ratio + escalations; **monthly scorecard**: CEO/human touches for human-touch-per-build + the babysat signal, terminal decisions for time-to-approve)
- [[../tables/director_activity]] (the `escorted_goal` rows that flag a goal the director escorted; **scorecard**: `escalated` rows; **monthly scorecard**: `escorted_goal` for goals-escorted-unbabysat, `deploy_healthy｜deploy_rolled_back` for deploy reliability)
- [[../tables/director_decision_grades]] (**monthly scorecard**: the CEO's director-call grades for director-call-grade, split by `dimension`)
- [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../tables/loop_heartbeats]] (**scorecard**: error backlog + MTTR + loop health)
- [[../tables/director_grader_prompts]] · [[../tables/agent_grader_prompts]] (approved calibration rules injected into the grader prompts)

---

[[../README]] · [[../integrations/inngest]] · [[../libraries/director-grader]] · [[../specs/director-loop-grading]] · [[../../CLAUDE]]
