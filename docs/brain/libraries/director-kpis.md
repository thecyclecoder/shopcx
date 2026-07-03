# `src/lib/agents/director-kpis.ts` — the Director-KPI SDK

The single DB-derived source for every scorecard/recap metric that attributes merged builds to their **owning function**. Introduced by [[../specs/director-kpi-sdk]] Phase 1 to fix a same-day-fold undercount that hid dozens of merged builds a day.

## The bug this SDK exists to fix

[[platform-scorecard]] `specs_per_week` and [[director-recap]] `specsShipped` used to build the `spec_slug → owner` map from [[brain-roadmap]] `getRoadmap().specs` — which filters to **live** specs (folded excluded via `isBoardableStatus`). When a spec **folded the same day its build merged**, the merged-build row's `spec_slug` no longer resolved to an owner, and the merge dropped off both metrics. On a day with 34 merged builds and 108 folds, the headline read `specsShipped = 1` — the bookkeeping was actively hiding done work.

Fix: derive the map from [[specs-table]] `listSpecs(workspaceId)` (returns EVERY spec including `status='folded'`). Folded specs still map to their owner, so the count reflects the full merged-in-window population.

## North-star invariant

Display-only proxy ([[../operational-rules]] § North star / § supervisable autonomy). The SDK is a **read-only** query over [[../tables/agent_jobs]] + [[specs-table]]; nothing writes back — the counts are surfaced on the scorecard/recap for legibility, never as a target the directors/workers optimize. Mirrors the [[director-xp]] + [[director-recap]] invariant.

## Exports

### Phase 1 — shipped-spec attribution

| Symbol | Signature | Notes |
|---|---|---|
| `ShippedSpecsWindow` type | `{ startIso: string; endIso: string }` | Half-open trailing window (`.gte(startIso).lt(endIso)`) — the standard `agent_jobs.updated_at` window used by [[director-recap]]. Inclusive-end callers pass the next-day boundary. Independent from the `KpiWindow` shape below (Phase 2 uses inclusive-both). |
| `ShippedSpecsByOwnerResult` type | `{ countsByOwner: Record<string, number>; slugsByOwner: Record<string, string[]> }` | Per-owner count + slug list. Only owners with ≥1 merged spec appear; a zero-owner is elided (the caller fills it as needed). |
| `shippedSpecsByOwner` | `(workspaceId, window, owner?) → Promise<ShippedSpecsByOwnerResult>` | The main entrypoint. Merged-build population = [[../tables/agent_jobs]] `kind='build'` + `status='merged'` with `updated_at` in-window; `spec_slug` mapped via [[specs-table]] `listSpecs` (full set incl. folded). When `owner` is provided, restricts the maps to that single owner. |
| `rollupShippedSpecsByOwner` | `(specSet, mergedSpecSlugs, owner?) → ShippedSpecsByOwnerResult` | Pure roll-up (exported for unit tests + callers with the raw shapes already in hand). Folded specs are just regular rows in `specSet` — that's the whole point. |

### Phase 2 — the remaining scorecard KPIs

Same rationale (single-source-of-truth + testability), plus **parity**: each function preserves the previous inline query shape (`.gte(startIso).lte(endIso)` — inclusive both) 1:1, so the persisted values are byte-identical to what [[platform-scorecard]] used to compute inline. Each async function is a thin wrapper around a pure `rollup…` helper so the arithmetic is unit-tested without a Postgres shim.

| Symbol | Signature | Notes |
|---|---|---|
| `KpiWindow` type | `{ startIso: string; endIso: string }` | Inclusive-both trailing window (`.gte(startIso).lte(endIso)`) — matches [[platform-scorecard]]'s `MetricWindow.curr` convention (`endIso = day + T23:59:59.999Z`). Independent from `ShippedSpecsWindow` (which is half-open). |
| `FAILED_BUILD_STATUSES` const | `readonly string[]` = `['failed', 'needs_attention']` | The [[../tables/agent_jobs]] statuses that count as a build FAILURE — the denominator's failure side for `buildSuccessRate`. |
| `buildSuccessRate` | `(workspaceId, window) → Promise<{rate, merged, failed, total}>` | `merged ÷ (merged + failed)` over the window on [[../tables/agent_jobs]] `kind='build'` terminal-flip rows. Success = `merged`, failure = `status ∈ FAILED_BUILD_STATUSES`. Two `HEAD` counts, no data fetch. |
| `rollupBuildSuccessRate` | `(merged, failed) → {rate, merged, failed, total}` | Pure arithmetic. |
| `autonomyRatio` | `(workspaceId, window) → Promise<{ratio, autonomous, terminal, approved, declined}>` | `autonomous ÷ terminal` over [[../tables/approval_decisions]] where `decision ∈ approved｜declined` in-window on `created_at`. Escalated rows excluded from denominator. |
| `rollupAutonomyRatio` | `(rows) → AutonomyRatioResult` | Pure roll-up over the terminal-decision rows. |
| `humanTouchPerBuild` | `(workspaceId, window) → Promise<{ratio, touched, builds}>` | The Platform monthly headline. `touched / builds`: numerator = every `approval_decisions.decided_by ∈ ceo｜human` in-window (`created_at`); denominator = every merged build in-window (`updated_at`). Lower is better. |
| `rollupHumanTouchPerBuild` | `(touched, builds) → HumanTouchPerBuildResult` | Pure arithmetic. |
| `goalsEscortedUnbabysat` | `(workspaceId, window, {directorFunction?}) → Promise<{count, goals: [{goal, milestones[]}]}>` | Goals whose milestones advanced in-window WITHOUT CEO/human touch. Reads `director_activity action_kind='escorted_goal'` for the director → intersect with `getGoals()` shipped-milestone candidates → drop any candidate whose milestone spec slugs match a CEO-touched `agent_job.spec_slug`. Defaults `directorFunction='platform'`. |
| `rollupGoalsEscortedUnbabysat` | `(candidates, touchedSpecSlugs) → GoalsEscortedUnbabysatResult` | Pure roll-up over the resolved shipped-milestone candidates + touched-spec set. |

## Callers

- [[platform-scorecard]] `specs_per_week.compute` — `shippedSpecsByOwner(ws, {startIso, endIso}, 'platform')` per current + prior window. Replaced the local `getRoadmap()` owner map. `specs_per_week` is **no longer flagged** [[platform-scorecard#liveSpecSetDependent|`liveSpecSetDependent`]] — the full spec set is stable across snapshot/audit re-reads.
- [[platform-scorecard]] `build_success_rate.compute` — `sdkBuildSuccessRate(ws, {startIso, endIso})` per current + prior window (Phase 2). No inline `agent_jobs` count query remains in the metric-def.
- [[platform-scorecard]] `autonomy_ratio.compute` — `sdkAutonomyRatio(ws, {startIso, endIso})` per current + prior window (Phase 2). No inline `approval_decisions` fetch remains.
- [[platform-scorecard]] `human_touch_per_build.compute` — `sdkHumanTouchPerBuild(ws, {startIso, endIso})` per current + prior window (Phase 2). No inline count queries remain.
- [[platform-scorecard]] `goals_escorted_unbabysat.compute` — `sdkGoalsEscortedUnbabysat(ws, {startIso, endIso}, {directorFunction: 'platform'})` per current + prior window (Phase 2). No inline `director_activity`/`getGoals`/touch-check remains.
- [[director-recap]] `generateDirectorRecap` — one `shippedSpecsByOwner(ws, {startIso, endIso})` call per day, then walks `countsByOwner` to populate each active director's `DirectorDayStats.specsShipped`. Replaced the local `getRoadmap()` owner map.

## What this SDK does NOT own

- [[platform-scorecard]] `regression_coverage_pct` — the coverage half of regression health. Denominator is the **LIVE shipped-spec set** by design (a folded/archived spec is not expected to be re-tested), so it deliberately reads [[brain-roadmap]] `getRoadmap()` and stays [[platform-scorecard#liveSpecSetDependent|`liveSpecSetDependent: true`]]. Different question, different population — leaving this one alone is intentional.
- [[director-xp]] `specsShipped` — same shape (merged builds owned by function), but its counter is a lifetime cumulative (not a window), so it doesn't map onto this SDK's window signature. Folding the XP counter into the SDK is future work (out of scope for [[../specs/director-kpi-sdk]] Phase 1).

## Gotchas

- **Window bounds are half-open** (`.gte(startIso).lt(endIso)`) — a caller with an inclusive-end window (`YYYY-MM-DDT23:59:59.999Z`) should pass the exclusive next-day boundary (`YYYY-MM-DDT00:00:00.000Z` for the following day) to match. The 1ms delta at day-boundary is not observable at row-write cadences.
- **A `spec_slug` that doesn't resolve is dropped** — an orphan merged build (spec deleted, never authored, or slug typo) has no owner to attribute to and is silently skipped. This mirrors the old behavior. If we ever need to surface those, add a `orphanSlugs: string[]` field to the result.

## Related

[[../specs/director-kpi-sdk]] · [[platform-scorecard]] · [[director-recap]] · [[specs-table]] · [[brain-roadmap]] · [[director-xp]] · [[../tables/agent_jobs]] · [[../tables/specs]] · [[../goals/platform-department-scorecard]] · [[../operational-rules]]

---

[[../README]] · [[../../CLAUDE]]
