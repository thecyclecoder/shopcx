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
Returns `{ snapshotDate, windowDays, rows, counts: {ad,adset,campaign,variant,angle}, variant_attribution_coverage }`
where **`rows` is the actually-persisted count** (see FK-resilience gotcha).

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
- **Persist is FK-resilient + never lies about `rows`** (iteration-scorecard-upsert-resilience).
  `.upsert()` is **all-or-nothing per batch**, so one dangling FK would reject all ~500
  rows. Before writing, the persist step **nulls any unresolved reference** —
  `angle_id`→[[../tables/product_ad_angles]], `advertorial_page_id`→[[../tables/advertorial_pages]]
  (the two real FKs, `on delete set null`), plus the text `parent_adset_id`/`parent_campaign_id`
  — resolved against the rows this run already fetched (a scorecard row is valid with a null
  ref; we drop the pointer, not the row). On a batch error it **falls back to per-row upsert**
  so a single bad record is isolated + logged, then **throws** with the PG `code message` and
  the `persisted/total` count. The returned `rows` is the **persisted** count, never
  `records.length` — a run can no longer report scorecards written when 0 landed (the prior bug:
  swallowed `{ error }` + `rows: records.length` → reported 7, persisted 0).
- **Persist also guards the NOT-NULL hole (PG 23502)** (scorecards-notnull-guard, follow-on to
  the FK pass). After nulling dangling refs, a second pass runs before the upsert. (1) Any row
  missing a **required key** (`workspace_id`/`meta_ad_account_id`/`level`/`object_id`/
  `snapshot_date`) can't satisfy the conflict target — it's **skipped with a logged reason +
  count**, never forced in with bad data and never silently dropped. (2) Every **NOT-NULL metric
  column** (the typed-default-0 columns + the bool fatigue flags; *not* the nullable
  deltas/`variant_attribution_coverage`) is **coalesced to its column default** if it carries a
  non-finite value — a derived metric can go `NaN`/`±Infinity`, which `JSON.stringify` serializes
  to `null` and the DB then rejects. `persisted` is measured against the **valid** (kept) count, so
  for valid rows the dropped count is 0; skips are logged, not counted as drops.
- **Backfill:** `scripts/backfill-iteration-scorecards.ts` replays the rollup for accounts with
  attribution but 0 scorecards (dry-run default; `--apply` to write).
- `frequency` is the **average** of daily frequency (it can't be summed across days).
- Variant ATC denominator is the attributed-session count; `atc_rate` is **capped at 1.0**
  to absorb the small mismatch with lander-session counts.
- Angle rows skip archived angles (`is_active=false`); `benefit_name` is null when the
  anchor doesn't map to a qualifying lead benefit (still emitted for performance).
- The `(unresolved)` variant is a real row (surfaced, not dropped); `variant_attribution_coverage`
  (account-level resolved-session share for the window) is stamped on every variant/angle row.
- **Angle→page resolution is uniform** across the pipe (advertorial-attribution-fix): the rollup
  ([[meta__attribution]] → [[../tables/meta_attribution_daily]]), the variant ATC session map here, and
  the pixel stamp all resolve a session's lander the same way — prefer the persisted
  `storefront_sessions.advertorial_page_id`, else parse `?angle={slug}` from `landing_url` and exact-match
  an [[../tables/advertorial_pages]]`.slug`. So the variant/landing-page breakdown reflects the corrected
  stamps regardless of whether the column was filled at ingest, healed on a later hit, or backfilled.

---

[[../README]] · [[../../CLAUDE]]
