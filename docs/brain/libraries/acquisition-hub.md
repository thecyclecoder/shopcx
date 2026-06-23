# `src/lib/acquisition-hub.ts` — Acquisition Research Hub

The aggregation + routing layer behind one owner surface — [[../specs/acquisition-research-hub]] (M4 of [[../goals/acquisition-research-engine]]). Houses the competitor sets ([[../tables/competitors]]), both scouts' findings ([[../libraries/ad-gap]] + [[../libraries/landing-page-scout]]), and a **unified gap queue** where the owner approves → a gap routes to **Build** or the **storefront optimizer**, tracked through to **shipped / won**. North-star: the scouts PROPOSE gaps with evidence; nothing here auto-routes.

## The two gap sources, unified

- **Lander gaps** already persist in [[../tables/lander_recommendations]] (written by the Landing Page Scout) — approved via the existing `/api/ads/lander-recommendations/[id]`.
- **Ad gaps** are computed deterministically on demand by `buildAdGapReport` and were never persisted — so this module **materializes** them into [[../tables/ad_gap_recommendations]] (idempotent on `dedup_key`, always `proposed`), approved via `/api/ads/acquisition/gaps/[id]`.
- The hub **merges** both into one normalized `GapQueueItem[]`; **throughput** is DERIVED by joining each approved gap's route artifact — no extra status columns to drift.

## Exports

| Export | Notes |
|---|---|
| `loadHubData(workspaceId, productId?)` | → `HubData` — materializes ad gaps, then aggregates products + competitors + `adFindings` (the `AdGapReport`) + `landerSnapshots` + the merged `gapQueue` + `throughput` + the M5 `gradeSignal` + `suppressedTypes`. Each `GapQueueItem` carries its `grade` ([[../tables/acquisition_gap_grades]]). Read-only apart from the idempotent ad-gap materialization. |
| `materializeAdGaps(workspaceId, opts?)` | `buildAdGapReport` → insert NEW dedup_keys into [[../tables/ad_gap_recommendations]] as `proposed` (`ignoreDuplicates` — never clobbers a settled row). **Skips materializing when the `ad_angle` type is suppressed** by the M5 grade loop ([[acquisition-gap-grader]] `loadSuppressedGapTypes`). Returns the live report. |
| `enactAdGapRoute(rec, userId)` | Called by the ad-gap approve action: route=`build` → an [[../tables/agent_jobs]] build for an ad-creative iteration. Mirrors [[../libraries/landing-page-scout]] `enactRecommendationRoute`. → `{ ok, route_result, error? }`. |
| `GapQueueItem` / `GapThroughput` / `HubData` / `CompetitorRow` / `LanderSnapshotRow` / `HubProduct` | types |

## Throughput derivation (the goal's success metric)

`proposed` / `approved` = queue row counts by `status`. `shipped` / `won` are **derived** from each approved gap's `route_result`:
- `agent_job_id` → [[../tables/agent_jobs]]: **shipped** when `status='completed'` (the Build delivered a PR).
- `experiment_id` → [[../tables/storefront_experiments]]: **shipped** when past `draft` (launched); **won** when `status='promoted'` (the bandit validated it).

## Gotchas
- **Ad gaps are workspace-level** (angle clusters), so they show regardless of the product selector; competitors + lander gaps + lander snapshots scope to the selected product.
- **Owner-only.** Both the read (`/api/ads/acquisition`) and the ad-gap approve route gate `role === 'owner'` (the negative test). Lander/competitor approve endpoints keep their own owner/admin gates.
- Materialization runs on every hub GET — cheap + idempotent (the ad-gap report is deterministic).
- **M5 grading loop visibility** — `loadHubData` attaches each acted-on gap's `grade` + a `gradeSignal` (per-gap_type avg) + `suppressedTypes` so the Growth-director feedback is visible; the standing re-scan + grading runs in [[../inngest/acquisition-research-cadence]]. See [[acquisition-gap-grader]] + [[../specs/acquisition-research-loop-grading]].

See [[../specs/acquisition-research-hub]] · [[../tables/ad_gap_recommendations]] · [[../dashboard/marketing__acquisition]].
