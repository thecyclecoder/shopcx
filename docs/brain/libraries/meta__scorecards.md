# libraries/meta/scorecards

Iteration scorecards — Storefront Iteration Engine **Phase 3**. Rolls the Phase 1/2
outputs into the deterministic daily metrics the controller reads, persisted to
[[../tables/iteration_scorecards_daily]] (one row per `(level, object_id, snapshot_date)`,
`level` ∈ `ad | adset | campaign | variant | angle`). The decision engine reads this
table, never the raw session/insight tables.

**File:** `src/lib/meta/scorecards.ts`

## Window model

Each run computes a **trailing window** (default 7 days) ending at `snapshot_date`,
plus the **prior** equal-length window for trend (`*_delta_pct`) and fatigue
(`ctr_declining`, `frequency_rising`, `fatigue_score`).

## Sources per level

- **ad / adset / campaign** → [[../tables/meta_insights_daily]] (authoritative Meta
  spend/impr/clicks/ctr/cpc/frequency/purchases/revenue/roas) + the `meta_*` structure
  tables for label/status/`days_live`/`creatives_live` (ACTIVE child-ad count).
- **variant / angle** → [[../tables/meta_attribution_daily]] (attributed spend + revenue
  + sessions + orders); variant **ATC** from [[../tables/storefront_events]] (`add_to_cart`)
  joined to [[../tables/storefront_sessions]] → variant. Angle aggregates attribution rows by
  `angle_id`; benefit resolved via `angle_id` → [[../tables/product_ad_angles]]`.lead_benefit_anchor`
  → [[../tables/product_benefit_selections]] (`role='lead' AND science_confirmed=true`).

## Exports

### `computeScorecards` — function

```ts
async function computeScorecards(p: ScorecardParams, snapshotDate: string, windowDays = 7): Promise<ScorecardResult>
```
Aggregates all five levels for the window and upserts on
`(workspace_id, level, object_id, snapshot_date)`. `ScorecardParams = { workspaceId, adAccountId (our uuid) }`.
Returns `{ snapshotDate, windowDays, rows, counts: {ad,adset,campaign,variant,angle}, variant_attribution_coverage }`.

### `refreshScorecards` — function

```ts
async function refreshScorecards(p: ScorecardParams, opts?: { snapshotDate?: string; windowDays?: number }): Promise<ScorecardResult>
```
Thin wrapper: defaults `snapshotDate` to today and `windowDays` to 7, delegates to
`computeScorecards`.

### `ScorecardLevel` — type (`"ad" | "adset" | "campaign" | "variant" | "angle"`)

## Callers

- `src/lib/inngest/meta-performance.ts` (`meta-scorecards-refresh`, fired after each
  `meta-attribution-refresh`)

## Gotchas

- **Reads raw tables here** (insights/attribution/sessions/events/structure/angles/benefits);
  the engine reads only [[../tables/iteration_scorecards_daily]], per the "read metrics from
  scorecards" invariant.
- **Idempotent** — re-running a day re-upserts the same keys; no duplicate rows.
- `frequency` is the **average** of daily frequency (it can't be summed across days).
- Variant ATC denominator is the attributed-session count; `atc_rate` is **capped at 1.0**
  to absorb the small mismatch with lander-session counts.
- Angle rows skip archived angles (`is_active=false`); `benefit_name` is null when the
  anchor doesn't map to a qualifying lead benefit (still emitted for performance).
- The `(unresolved)` variant is a real row (surfaced, not dropped); `variant_attribution_coverage`
  (account-level resolved-session share for the window) is stamped on every variant/angle row.

---

[[../README]] · [[../../CLAUDE]]
