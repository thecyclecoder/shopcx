# libraries/platform-scorecard

The **department-level KPI aggregation engine** behind the [[../goals/platform-department-scorecard|Platform Department Scorecard]] ([[../specs/platform-scorecard-engine]] Phases 1–2; milestone (a) Daily pulse). Where [[director-xp]] / [[director-recap]] compute **per-director** gamification/EOD counts and [[meta__scorecards]] is the **ad** domain, this engine rolls the platform's own truth up to a **department KPI that trends over time**: each KPI computed over a **trailing window** with a **prior equal-length window delta** (mirroring the [[meta__scorecards]] window model), upserted into [[../tables/platform_scorecard_snapshots]].

**File:** `src/lib/agents/platform-scorecard.ts` (server-only — `createAdminClient` + [[brain-roadmap]] fs reads, like [[director-xp]] / [[director-recap]]).

**North-star invariant** ([[../operational-rules]] § supervisable autonomy): every KPI is **derived + read-only** — computed from existing tables, persisted for trend, **never** written back as a target the directors/workers optimize. This engine is the **only writer** of [[../tables/platform_scorecard_snapshots]]; downstream readers read the snapshot table, never the raw tables.

## Exports

- **`type Cadence = 'daily' | 'weekly' | 'monthly'`** · **`type MetricUnit = 'count' | 'ratio' | 'hours' | 'pct'`**
- **`interface ScorecardSnapshotRow`** — one persisted row (`workspace_id, metric_key, cadence, snapshot_date, window_days, value, prior_value, delta_pct, unit, detail, updated_at`).
- **`interface ComputeOptions { cadence; snapshotDate?; windowDays? }`** — `snapshotDate` defaults to today (UTC), `windowDays` to the cadence default (daily=1).
- **`computePlatformScorecard(workspaceId, opts): Promise<ScorecardSnapshotRow[]>`** — for each KPI in the cadence's registry, compute the trailing-window `value`, the prior equal-length `prior_value`, and `delta_pct`, then **upsert** every row on `(workspace_id, metric_key, cadence, snapshot_date)`. Idempotent (a same-day re-run upserts in place). A quiet workspace writes zeros, never errors; a single metric's read failing writes a zero row + logs (the rest still land).

## The daily KPI registry

A declarative registry keyed by `metric_key` keeps the per-cadence metric set extensible. The **weekly** cadence is still an empty registry here ([[../specs/platform-scorecard-weekly]] fills it); the **monthly** cadence is seeded by [[../specs/platform-scorecard-monthly]] (see below). The **daily** set:

| `metric_key` | unit | Derivation |
|---|---|---|
| `loop_health` | ratio | Share of [[../libraries/control-tower]] `MONITORED_LOOPS` green = **no open [[../tables/loop_alerts]]** AND (for a `cron`) a [[../tables/loop_heartbeats]] beat within its `livenessWindowMs` (latest beat per loop via the `control_tower_loop_beats` RPC). Worker/agent-kind/reactive/inline loops are idle-green (judged on the open-alert signal). `detail` lists every unhealthy loop. Current-state metric → prior comes from the prior stored snapshot. |
| `error_backlog` | count | Recent [[../tables/error_events]] incidents (by `last_seen_at` in-window), **excluding `outage_correlated`** symptoms. `detail` carries the last-1h/last-24h/by-source recency colouring `buildErrorFeedSnapshot` uses. |
| `error_mttr_hours` | hours | **Derived, NOT from `error_events.status`** (reserved/unmaintained, no `resolved_at`). Median over the window of `(resolution_ts − first_seen_at)`, where `resolution_ts` = the **concluded** terminal time of the correlated [[../tables/agent_jobs]] repair (`kind='repair'`, `spec_slug = signature` — the repair dedupe key; `kind='regression'` is the documented fallback). Errors with no concluded correlated repair are excluded + surfaced in `detail.still_open`. |
| `build_throughput` | count | [[../tables/agent_jobs]] `kind='build'` + `status='merged'` with `updated_at` (the merge flip) in-window — the exact rule [[director-recap]] uses for `specsShipped`. |
| `lane_utilization` | ratio | **Build-pool saturation NOW** ([[../specs/director-initiation-throughput]] Phase 4): build/plan [[../tables/agent_jobs]] OCCUPYING a lane (`claimed｜building｜needs_input｜needs_approval｜queued_resume` — a plain `queued` job is backlog WAITING for a lane, not occupying one) ÷ `BUILD_POOL_CAPACITY` (8, the [[platform-director]] lane count). Capped at 1. The headline saturation KPI — the curve should trend toward full. Current-state metric → prior from the prior snapshot. |
| `build_enqueue_rate` | count | The pool FEED-rate ([[../specs/director-initiation-throughput]] Phase 4): [[../tables/agent_jobs]] `kind='build'` with `created_at` (the enqueue) in-window — paired with `lane_utilization` it shows whether the director keeps the pool topped up. |
| `autonomy_ratio` | ratio | [[../tables/approval_decisions]] `autonomous=true` ÷ all terminal decisions (`decision ∈ approved｜declined`) in-window (escalated rows excluded from the denominator). |
| `escalations` | count | [[../tables/approval_decisions]] `decision='escalated'` + [[../tables/director_activity]] `action_kind='escalated'`, **attributed to the platform function** (`raised_by_function` / `director_function = 'platform'`) in-window. Only a real `functions/*.md` slug counts (a stray slug is ignored — [[director-xp]]'s guard). |
| `needs_attention` | count | **Open parked work the director triages** ([[../specs/needs-attention-triage-and-verdict-robustness]] Phase 3): [[../tables/agent_jobs]] `status='needs_attention'` EXCLUDING the kinds another lane owns (`build` → the build loop-guard; `repair` → the repair-dismissal lane; `platform-director` → the director's own jobs). The count is the headline value; `detail` carries the **OLDEST** open item's age (`oldest_hours`) + a `by_kind` breakdown — so a rotting parked item is a tracked, trending KPI, not just a transient board line. Current-state metric → prior from the prior snapshot. Same scope `reconcileNeedsAttention` ([[platform-director]] Phase 1) triages + the daily board-watch reports ("N items need attention, oldest Xh"). |

**Window model** (mirrors [[meta__scorecards]]): `curr = [snapshotDate − (windowDays−1), snapshotDate]`, `prev = [snapshotDate − (2·windowDays−1), snapshotDate − windowDays]`. `loop_health` is current-state, so its prior is read from the snapshot `windowDays` ago rather than recomputed.

## The monthly KPI registry

The **monthly leading curve** ([[../specs/platform-scorecard-monthly]]; milestone (c)) — the slow-moving indicators that prove autonomy is **compounding**, `cadence='monthly'`, `windowDays=30`, prior = the prior 30-day window. Headlined by `human_touch_per_build`.

| `metric_key` | unit | Derivation |
|---|---|---|
| `human_touch_per_build` | ratio | **The goal's headline.** (CEO/human-decided [[../tables/approval_decisions]] `decided_by ∈ ceo｜human` in the month) ÷ ([[../tables/agent_jobs]] `kind='build'` + `status='merged'`, `updated_at` in the month). **Lower is better** — the prior-month `delta_pct` is the "declining MoM" signal. `detail` carries the numerator/denominator (+ prior). Builds=0 → value 0. |
| `goals_escorted_unbabysat` | count | Goals whose milestones advanced **without** a CEO/human touch: [[../tables/director_activity]] `action_kind='escorted_goal'`, `director_function='platform'` (the escort rows, `metadata.goal_slug`) cross-checked against [[brain-roadmap]] `getGoals()[].milestones` SHIPPED milestones, counting only goals with **no** `decided_by ∈ ceo｜human` [[../tables/approval_decisions]] tying to the goal's specs (`agent_job_id → agent_jobs.spec_slug → the owning goal`) in the month. `detail` lists the counted goals + their shipped milestones. |
| `time_to_approve_hours` | hours | Median over the month of `(approval_decisions.created_at − request_raised_at)` for terminal (`approved｜declined`) decisions. **No stored needs_approval-transition ts exists**, so `request_raised_at` is APPROXIMATED by the raising [[../tables/agent_jobs]] row's `updated_at`; non-positive deltas (the job already advanced) are excluded + surfaced in `detail`. `detail` carries p50/p90 + sample/excluded. The "mean time-to-approve down" metric ([[../goals/devops-director]]). |
| `deploy_reliability` | ratio | From the [[../specs/deploy-health-rollback-guardian|Deploy Guardian]] verdicts: [[../tables/director_activity]] `action_kind='deploy_healthy'` ÷ (`deploy_healthy` + `deploy_rolled_back`), `director_function='platform'`, in the month. **HONEST about missing data** — with NO verdicts in-window the metric writes **no row** (the `value` column is NOT NULL, so absence is the only truthful "no data yet"; never a fabricated 100%). `detail` carries the healthy/rolled-back counts. |
| `director_call_grade` | ratio | The CEO's grade of the Platform director's calls: blended mean of [[../tables/director_decision_grades]] `grade` (1–10) over the month, split by `dimension ∈ auto-approval｜goal-escort` (the shape [[director-leash-recommendations]] `computeDirectorGradeReport` reads). `value` = blended mean; `detail` = per-dimension means + counts (`scale: '1-10'`). Populated by [[../specs/director-loop-grading]] (✅). |

**North-star invariant** ([[../operational-rules]] § North star): `human_touch_per_build` + `director_call_grade` are **measured, never targeted** — the directors must not learn to suppress escalations to game the curve. Read-only, persisted for trend, never written back.

## Caller

The daily snapshot beat on [[../inngest/platform-director-cron]] (`snapshot-platform-scorecard` step) — once per UTC day per build-console workspace, `computePlatformScorecard(ws, { cadence:'daily', windowDays:1 })`. The **monthly** snapshot beat (`snapshot-platform-scorecard-monthly` step) on the same cron — once per **calendar month** per workspace, `computePlatformScorecard(ws, { cadence:'monthly', windowDays:30 })`. Both run in the deployed runtime (DB access), best-effort + idempotent. [[../specs/platform-scorecard-surface]] reads the snapshot table for the scorecard page.

## Related

[[../specs/platform-scorecard-engine]] · [[../goals/platform-department-scorecard]] · [[../tables/platform_scorecard_snapshots]] · [[../inngest/platform-director-cron]] · [[meta__scorecards]] · [[director-xp]] · [[director-recap]] · [[control-tower]] · [[../operational-rules]]
