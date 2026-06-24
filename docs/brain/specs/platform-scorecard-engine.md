# Platform scorecard metrics engine + daily pulse

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/platform-department-scorecard]] — (a) Daily pulse

The shared aggregation substrate behind the whole [[../goals/platform-department-scorecard|Platform Department Scorecard]] goal, plus its first cadence — the **Daily pulse**. Today the data exists but nothing rolls it up: [[../libraries/director-xp]] + [[../libraries/director-recap]] compute only **per-director** gamification/EOD counts, and [[../libraries/meta__scorecards]] is the **ad** domain. This spec stands up a department-level KPI engine (`src/lib/agents/platform-scorecard.ts`) that computes each KPI over a **trailing window** with a **prior-window delta** (mirroring the [[../libraries/meta__scorecards]] window model), persists every value to a new **`platform_scorecard_snapshots`** table so KPIs **trend over time**, and writes the daily pulse on the existing director beat — so the CEO sees loop health, error backlog + MTTR, build throughput, autonomy ratio, and escalations daily with **zero hand-counting** (the goal's success metric).

## Phase 1 — the snapshot store
- ✅ shipped — `supabase/migrations/20260706120000_platform_scorecard_snapshots.sql` + `scripts/apply-platform-scorecard-snapshots-migration.ts` (await prod apply); brain page `tables/platform_scorecard_snapshots.md`.
- New table **`platform_scorecard_snapshots`** — one row per `(workspace_id, metric_key, cadence, snapshot_date)`. Columns: `metric_key text` (e.g. `loop_health`, `error_backlog`, `error_mttr_hours`, `build_throughput`, `autonomy_ratio`, `escalations`), `cadence text` ∈ `daily｜weekly｜monthly`, `snapshot_date date`, `window_days int`, `value numeric`, `prior_value numeric?`, `delta_pct numeric?`, `unit text` (`count｜ratio｜hours｜pct`), `detail jsonb` (per-metric breakdown), `created_at/updated_at`. **Unique** on `(workspace_id, metric_key, cadence, snapshot_date)` so a re-run **upserts** in place (idempotent, mirrors [[../libraries/meta__scorecards]]). Indexes `(workspace_id, cadence, snapshot_date desc)` (the read) + `(workspace_id, metric_key, snapshot_date desc)` (per-metric trend).
- Migration `supabase/migrations/YYYYMMDDNNNNNN_platform_scorecard_snapshots.sql` + `scripts/apply-platform-scorecard-snapshots-migration.ts`. RLS: authenticated SELECT (the scorecard page is owner-gated above the DB), service-role write — mirror [[../tables/director_decision_grades]] / [[../tables/agent_action_grades]].
- A [[write-brain-page|brain page]] `tables/platform_scorecard_snapshots.md`.

## Phase 2 — the metrics engine
- ✅ shipped — `src/lib/agents/platform-scorecard.ts` exports `computePlatformScorecard` + the declarative daily KPI registry; brain page `libraries/platform-scorecard.md`.
- New library `src/lib/agents/platform-scorecard.ts` (server-only — `createAdminClient` + [[../libraries/brain-roadmap]] fs reads, mirrors [[../libraries/director-xp]] / [[../libraries/director-recap]]).
- Export `computePlatformScorecard(workspaceId, { cadence, snapshotDate, windowDays }): Promise<ScorecardSnapshotRow[]>` — for each KPI in the **cadence's registry**, compute the trailing-window `value`, the prior equal-length `prior_value`, and `delta_pct`; **upsert** every row on the unique key. A KPI registry keyed by `metric_key` keeps the per-cadence metric set declarative (this spec seeds the **daily** set; [[platform-scorecard-weekly]] + [[platform-scorecard-monthly]] add their own).
- **Daily pulse metric derivations** (all from existing truth):
  - `loop_health` — open [[../tables/loop_alerts]] vs the [[../libraries/control-tower]] `MONITORED_LOOPS` registry + [[../tables/loop_heartbeats]] liveness; `value` = share of monitored loops green (no open alert, heartbeat within its `livenessWindowMs`). `detail` lists any red/amber loop.
  - `error_backlog` — count of recent [[../tables/error_events]] incidents by recency (the same last-24h / last-7h colouring `buildErrorFeedSnapshot` uses), excluding `outage_correlated` rows.
  - `error_mttr_hours` — **derived, NOT read from `error_events.status`** (that column is explicitly *reserved* and has no `resolved_at` — see [[../tables/error_events]]). MTTR = median over the window of `(resolution_ts − first_seen_at)` where `resolution_ts` is the conclusion of the correlated repair: join `error_events.signature` → [[../tables/agent_jobs]] `kind='repair'` with `spec_slug = signature` (the repair dedupe key) → its merged build / terminal time; fall back to the matching `kind='regression'` job. Errors with no correlated repair are excluded from MTTR (and surfaced in `detail` as still-open).
  - `build_throughput` — [[../tables/agent_jobs]] `kind='build'` + `status='merged'` with `updated_at` in-window (the merge flip — the exact rule [[../libraries/director-recap]] uses for `specsShipped`).
  - `autonomy_ratio` — [[../tables/approval_decisions]] `autonomous=true` ÷ all terminal decisions (`decision ∈ approved｜declined`) in-window. `decided_by`/`autonomous` are real columns (see [[../tables/approval_decisions]]).
  - `escalations` — [[../tables/approval_decisions]] `decision='escalated'` in-window **+** [[../tables/director_activity]] rows with `action_kind='escalated'` (the open vocabulary the regression-agent / Platform director already emit).
- Only attribute to the **platform** function (a stray `raised_by_function` / `director_function` that isn't a real `functions/*.md` slug is ignored — same guard as [[../libraries/director-xp]] `getDirectorXp`).

## Phase 3 — the daily snapshot beat
- ✅ shipped — `snapshot-platform-scorecard` step wired into `src/lib/inngest/platform-director-cron.ts` (once-per-UTC-day guard per workspace); brain page updated.
- Add a `snapshot-platform-scorecard` step to [[../inngest/platform-director-cron]] (`src/lib/inngest/platform-director-cron.ts`) — it already runs in the **deployed runtime** (DB access; the grade sweeps run here, not on the box) on a `*/15 * * * *` beat. Guard the step to **once per UTC day** per workspace (the upsert on `(metric_key, cadence='daily', snapshot_date)` makes a same-day re-run a no-op, so the guard is just spend-saving). For each build-console workspace, call `computePlatformScorecard(ws, { cadence:'daily', windowDays:1 })`.
- Best-effort + idempotent (mirrors the cron's existing grade sweeps); a quiet workspace writes zeros, never errors.
- Document the new step + table writes on the [[../inngest/platform-director-cron]] brain page.

## Safety / invariants
- **Display-only proxy, never an objective** ([[../operational-rules]] § North star). Every KPI is **derived + read-only** — computed from existing tables, persisted for trend, **never written back as a target** the directors/workers optimize. Mirrors the [[../libraries/director-xp]] + [[../libraries/director-recap]] invariant verbatim.
- **MTTR is derived, never read from a status column** — `error_events.status` is reserved/unmaintained; correlate to the repair that actually resolved it. Don't assume a `resolved_at`.
- **Idempotent** — re-running a day/window re-upserts the same keys; no duplicate rows.
- Reads only; the engine is the *only* writer of `platform_scorecard_snapshots`. Downstream readers ([[platform-scorecard-surface]]) read the snapshot table, never the raw tables — the "read metrics from the scorecard" invariant from [[../libraries/meta__scorecards]].

## Completion criteria
- `platform_scorecard_snapshots` exists with its unique key + indexes + RLS, and a brain page.
- `src/lib/agents/platform-scorecard.ts` exports `computePlatformScorecard` with the daily KPI registry; `npx tsc --noEmit` clean.
- The `snapshot-platform-scorecard` step is wired into `platform-director-cron` and a daily tick writes one `cadence='daily'` row per daily KPI per build-console workspace, with `prior_value` + `delta_pct` populated from the prior day.
- A same-day re-run upserts in place (no duplicates).

## Implementation note — escalations attribution
Per the "Only attribute to the platform function" guard (above), `escalations` counts only platform-raised rows: `approval_decisions.decision='escalated' AND raised_by_function='platform'` + `director_activity.action_kind='escalated' AND director_function='platform'`. The other daily KPIs are infra-global (`loop_health` / `error_backlog` / `error_mttr_hours` read the global [[../tables/loop_alerts]] / [[../tables/error_events]] tables, MTTR correlated to the workspace's repair jobs) or company-wide (`build_throughput` / `autonomy_ratio`), exactly as their bullets specify.

## Verification
- **Apply first (gated — owner runs):** `npx tsx scripts/apply-platform-scorecard-snapshots-migration.ts` → expect `✓ table present: platform_scorecard_snapshots`. Then `\d platform_scorecard_snapshots` shows the `platform_scorecard_snapshots_key_uniq` unique on `(workspace_id, metric_key, cadence, snapshot_date)` + the `_read_idx` and `_trend_idx` indexes, RLS enabled (authenticated SELECT, service-role all).
- **Types:** `npx tsc --noEmit` is clean.
- **Compute once for a workspace** (e.g. a throwaway `scripts/_probe.ts` calling `computePlatformScorecard(ws, { cadence:'daily', windowDays:1 })`) → `select metric_key, value, prior_value, delta_pct, unit from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='daily' and snapshot_date=current_date order by metric_key;` → exactly six rows, one per daily KPI (`autonomy_ratio｜build_throughput｜error_backlog｜error_mttr_hours｜escalations｜loop_health`), units `ratio｜count｜count｜hours｜count｜ratio`. `loop_health.value` ∈ [0,1]; `loop_health.detail.unhealthy` lists any red/amber loop.
- **Idempotent re-run** the same day → `select count(*) from platform_scorecard_snapshots where workspace_id='<ws>' and cadence='daily' and snapshot_date=current_date;` is unchanged at 6 (upsert in place, no duplicate rows); `updated_at` bumps.
- **MTTR is derived, not status-read:** an `error_mttr_hours` row's `detail.resolved_count` reflects errors correlated to a concluded `agent_jobs` repair (`spec_slug = signature`); uncorrelated errors appear in `detail.still_open`, never counted from `error_events.status`.
- **After a `platform-director-cron` tick** (Inngest run history) → the `snapshot-platform-scorecard` step shows `produced.scorecard.metricsWritten > 0` (or `snapshotted=0` if already done today) with no error; the rows above exist. A second tick the same UTC day is a no-op (guard skips already-snapshotted workspaces).
