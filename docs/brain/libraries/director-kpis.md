# `src/lib/agents/director-kpis.ts` — the Director-KPI SDK

The single DB-derived source for every scorecard/recap metric that attributes merged builds to their **owning function**. Introduced by [[../specs/director-kpi-sdk]] Phase 1 to fix a same-day-fold undercount that hid dozens of merged builds a day.

## The bug this SDK exists to fix

[[platform-scorecard]] `specs_per_week` and [[director-recap]] `specsShipped` used to build the `spec_slug → owner` map from [[brain-roadmap]] `getRoadmap().specs` — which filters to **live** specs (folded excluded via `isBoardableStatus`). When a spec **folded the same day its build merged**, the merged-build row's `spec_slug` no longer resolved to an owner, and the merge dropped off both metrics. On a day with 34 merged builds and 108 folds, the headline read `specsShipped = 1` — the bookkeeping was actively hiding done work.

Fix: derive the map from [[specs-table]] `listSpecs(workspaceId)` (returns EVERY spec including `status='folded'`). Folded specs still map to their owner, so the count reflects the full merged-in-window population.

## North-star invariant

Display-only proxy ([[../operational-rules]] § North star / § supervisable autonomy). The SDK is a **read-only** query over [[../tables/agent_jobs]] + [[specs-table]]; nothing writes back — the counts are surfaced on the scorecard/recap for legibility, never as a target the directors/workers optimize. Mirrors the [[director-xp]] + [[director-recap]] invariant.

## Exports

| Symbol | Signature | Notes |
|---|---|---|
| `ShippedSpecsWindow` type | `{ startIso: string; endIso: string }` | Half-open trailing window (`.gte(startIso).lt(endIso)`) — the standard `agent_jobs.updated_at` window used by [[director-recap]]. Inclusive-end callers pass the next-day boundary. |
| `ShippedSpecsByOwnerResult` type | `{ countsByOwner: Record<string, number>; slugsByOwner: Record<string, string[]> }` | Per-owner count + slug list. Only owners with ≥1 merged spec appear; a zero-owner is elided (the caller fills it as needed). |
| `shippedSpecsByOwner` | `(workspaceId, window, owner?) → Promise<ShippedSpecsByOwnerResult>` | The main entrypoint. Merged-build population = [[../tables/agent_jobs]] `kind='build'` + `status='merged'` with `updated_at` in-window; `spec_slug` mapped via [[specs-table]] `listSpecs` (full set incl. folded). When `owner` is provided, restricts the maps to that single owner. |
| `rollupShippedSpecsByOwner` | `(specSet, mergedSpecSlugs, owner?) → ShippedSpecsByOwnerResult` | Pure roll-up (exported for unit tests + callers with the raw shapes already in hand). Folded specs are just regular rows in `specSet` — that's the whole point. |

## Callers

- [[platform-scorecard]] `specs_per_week.compute` — `shippedSpecsByOwner(ws, {startIso, endIso}, 'platform')` per current + prior window. Replaced the local `getRoadmap()` owner map. `specs_per_week` is **no longer flagged** [[platform-scorecard#liveSpecSetDependent|`liveSpecSetDependent`]] — the full spec set is stable across snapshot/audit re-reads.
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
