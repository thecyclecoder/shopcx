# platform_scorecard_snapshots

The **Platform Department Scorecard** trend store — one row per `(workspace_id, metric_key, cadence, snapshot_date)` holding the as-of value of one department KPI for one cadence's trailing window, with the prior equal-length window's value + the % delta for the trend arrow ([[../specs/platform-scorecard-engine]] Phase 1; milestone (a) of [[../goals/platform-department-scorecard]]). The shared aggregation substrate behind the whole scorecard goal: the data already exists ([[director_activity]] · [[agent_jobs]] · [[error_events]] · [[loop_alerts]] · [[approval_decisions]] + the grade tables) but nothing rolled it up to a KPI that **trends over time** — this table is that roll-up. Mirrors the [[iteration_scorecards_daily]] window model one level up (department, not ad).

Written **only** by [[../libraries/platform-scorecard]] `computePlatformScorecard` (the engine is the sole writer); read by the scorecard page ([[../specs/platform-scorecard-surface]]) — downstream readers read **this** table, never the raw source tables ("read metrics from the scorecard" invariant from [[../libraries/meta__scorecards]]).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `metric_key` | `text` | — | the KPI — `loop_health` \| `error_backlog` \| `error_mttr_hours` \| `build_throughput` \| `autonomy_ratio` \| `escalations` (daily set; weekly/monthly add their own). Free text, **no CHECK** — a new KPI needs no migration (declarative registry in [[../libraries/platform-scorecard]]) |
| `cadence` | `text` | — | CHECK ∈ `daily` \| `weekly` \| `monthly` — which cadence's registry produced this row |
| `snapshot_date` | `date` | — | as-of day · the trailing window ends here |
| `window_days` | `int` | — | trailing-window length (daily=1, weekly=7, monthly≈30) · default 1 |
| `value` | `numeric` | — | the computed metric value over the current window · default 0 |
| `prior_value` | `numeric` | ✓ | the prior equal-length window's value (or the prior stored snapshot for a current-state metric like `loop_health`) · null when no prior |
| `delta_pct` | `numeric` | ✓ | `(value − prior_value) / prior_value` — the trend arrow · null when `prior_value` is null/0 |
| `unit` | `text` | — | CHECK ∈ `count` \| `ratio` \| `hours` \| `pct` · how to render `value` · default `count` |
| `detail` | `jsonb` | — | per-metric breakdown (red/amber loops · still-open error signatures · numerator/denominator) · default `{}` |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique** (`platform_scorecard_snapshots_key_uniq`): `(workspace_id, metric_key, cadence, snapshot_date)` — the idempotent upsert key; a same-day re-run UPSERTs in place, never a duplicate.

**Indexes:** `(workspace_id, cadence, snapshot_date desc)` (the scorecard read — every KPI for a cadence as-of the latest day); `(workspace_id, metric_key, snapshot_date desc)` (per-metric trend chart).

## Foreign keys

**Out:** `workspace_id` → [[workspaces]].id (ON DELETE CASCADE).

**In:** _none._

## RLS

Mirrors [[director_decision_grades]] / [[agent_action_grades]]: any **authenticated** user `SELECT`s (the scorecard page is owner-gated above the DB), **service role** does all writes (the engine on the deployed [[../inngest/platform-director-cron]] runtime).

## Invariants
- **Display-only proxy, never an objective** ([[../operational-rules]] § North star). Every KPI is **derived + read-only** — computed from existing tables, persisted for trend, **never** written back as a target the directors/workers optimize. Same invariant as [[../libraries/director-xp]] / [[../libraries/director-recap]].
- **MTTR is derived, never read from a status column.** [[error_events]]`.status` is reserved/unmaintained with no `resolved_at`; `error_mttr_hours` is derived by correlating each error signature to the repair job that resolved it (see [[../libraries/platform-scorecard]]).
- **Idempotent.** Re-running a day/window re-upserts the same keys — no duplicate rows.
- **One writer.** [[../libraries/platform-scorecard]] `computePlatformScorecard` is the only writer; everything else reads.

---

[[../README]] · [[../libraries/platform-scorecard]] · [[../inngest/platform-director-cron]] · [[../specs/platform-scorecard-engine]] · [[../goals/platform-department-scorecard]] · [[../../CLAUDE]]
