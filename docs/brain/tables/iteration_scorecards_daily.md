# iteration_scorecards_daily

The deterministic daily metrics the Storefront Iteration Engine controller reads —
its **Phase 3** output. The decision engine (Phases 4/6) reads THIS table only,
never the raw session/insight tables, so every metric it acts on is traceable to a
persisted row by `id`. One row per `(workspace_id, level, object_id, snapshot_date)`,
`level` ∈ `ad | adset | campaign | variant | angle`. Written by
[[../libraries/meta__scorecards]] `computeScorecards` ([[../inngest/meta-performance]]
`meta-scorecards-refresh`). Migration `20260619230000_iteration_scorecards_daily.sql`.
RLS: workspace-member SELECT, service-role write. See
[[../specs/storefront-iteration-engine]] (Phase 3).

**Primary key:** `id`

## Grain

Each row is a **trailing-window** rollup (default 7 days) ending at `snapshot_date`,
with the prior equal-length window stored for trend + fatigue. `object_id` is the
Meta object id (ad/adset/campaign), the variant slug (`advertorial`/`beforeafter`/
`reasons`/`(unresolved)`), or the angle uuid (as text).

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `meta_ad_account_id` | `uuid` | — | → [[meta_ad_accounts]].id |
| `level` | `text` | — | `ad` \| `adset` \| `campaign` \| `variant` \| `angle` (CHECK) |
| `object_id` | `text` | — | Meta id \| variant slug \| angle uuid-as-text |
| `snapshot_date` | `date` | — | as-of day; the window ends here |
| `window_days` | `int` | — | trailing-window length (default 7) |
| `label` | `text` | ✓ | human-legible: ad/adset/campaign name · variant · benefit |
| `effective_status` | `text` | ✓ | current Meta status (ad/adset/campaign) |
| `parent_adset_id` | `text` | ✓ | ad → adset (Meta id) |
| `parent_campaign_id` | `text` | ✓ | ad/adset → campaign (Meta id) |
| `angle_id` | `uuid` | ✓ | → [[product_ad_angles]].id (angle level) |
| `advertorial_page_id` | `uuid` | ✓ | → [[advertorial_pages]].id (dominant lander, variant level) |
| `lead_benefit_anchor` | `text` | ✓ | angle: verbatim anchor string |
| `benefit_name` | `text` | ✓ | angle: resolved [[product_benefit_selections]].`benefit_name` (null when the anchor doesn't map to a qualifying lead benefit) |
| `spend_cents` | `int8` | — | window spend |
| `revenue_cents` | `int8` | — | window revenue |
| `roas` | `numeric` | — | revenue / spend |
| `impressions` | `int8` | — | insights levels |
| `clicks` | `int8` | — | insights levels |
| `ctr` | `numeric` | — | percent (clicks / impressions × 100) |
| `cpc_cents` | `int8` | — | spend / clicks |
| `frequency` | `numeric` | — | avg daily frequency in window |
| `purchases` | `int` | — | Meta-reported purchases (insights) |
| `orders` | `int` | — | attributed orders (attribution; variant/angle) |
| `sessions` | `int` | — | Meta sessions (attribution; variant/angle) |
| `atc` | `int` | — | variant: distinct sessions with an `add_to_cart` event |
| `atc_rate` | `numeric` | — | variant: `atc / sessions` (capped at 1.0) |
| `cvr` | `numeric` | — | ad/adset/campaign: purchases/clicks · variant/angle: orders/sessions |
| `days_live` | `int` | — | days since Meta `created_time` (insights levels) · active days in window (variant/angle) |
| `creatives_live` | `int` | — | adset/campaign: count of ACTIVE child ads |
| `variant_attribution_coverage` | `numeric` | ✓ | variant/angle: account-level resolved-session share for the window (named, not silent) |
| `spend_prev_cents` / `revenue_prev_cents` | `int8` | — | prior-window totals |
| `roas_prev` / `ctr_prev` / `frequency_prev` / `cvr_prev` | `numeric` | — | prior-window values |
| `sessions_prev` | `int` | — | prior-window sessions |
| `roas_delta_pct` / `ctr_delta_pct` / `spend_delta_pct` / `revenue_delta_pct` | `numeric` | ✓ | `(curr-prev)/prev`; null when prev=0 |
| `ctr_declining` | `bool` | — | CTR down >10% vs prior window |
| `frequency_rising` | `bool` | — | avg frequency up >5% vs prior window |
| `fatigue_score` | `numeric` | — | 0..1 composite (CTR decline + freq rise + ROAS decline) |
| `synced_at` / `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

**Unique:** `(workspace_id, level, object_id, snapshot_date)` — idempotent upsert key.
Indexes: `(meta_ad_account_id, snapshot_date)`, `(workspace_id, level, snapshot_date)`,
`(workspace_id, level, object_id, snapshot_date)`.

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `meta_ad_account_id` → [[meta_ad_accounts]].`id`
- `angle_id` → [[product_ad_angles]].`id` (on delete set null)
- `advertorial_page_id` → [[advertorial_pages]].`id` (on delete set null)

## Gotchas

- **The engine reads here, not the raw tables.** This is the "read metrics from
  scorecards" invariant — recommendations + policy actions (Phases 4/6) cite a
  scorecard row by `id`. Sources are [[meta_insights_daily]] (ad/adset/campaign),
  [[meta_attribution_daily]] (variant/angle), [[storefront_events]] (variant ATC),
  and the `meta_*` structure tables (label/status/days_live/creatives_live).
- **Different levels populate different columns.** Insights levels (ad/adset/campaign)
  carry impressions/clicks/ctr/cpc/frequency/purchases; variant/angle carry
  sessions/orders/atc/cvr and `variant_attribution_coverage`. Unfilled metrics are 0,
  not null (typed defaults), so the agent can read every column uniformly.
- **`cvr` basis differs by level.** Insights levels = purchases ÷ clicks; variant/angle
  = orders ÷ sessions. Read the level before comparing.
- **Variant `sessions` is the attributed-session count** ([[meta_attribution_daily]]),
  while `atc` counts lander sessions with an `add_to_cart`; `atc_rate` is capped at 1.0
  to absorb the small denominator mismatch (some lander sessions carry no `utm_content`).
- **Angle rows are filtered:** only `is_active` angles ([[product_ad_angles]]); `benefit_name`
  resolves only when the angle's `lead_benefit_anchor` matches a qualifying
  [[product_benefit_selections]] row (`role='lead' AND science_confirmed=true`).
- `frequency` is an **average of daily** frequency (Meta frequency = impressions/reach
  can't be summed across days; reach isn't stored).
- **The upsert is FK-resilient** (iteration-scorecard-upsert-resilience). `angle_id`
  and `advertorial_page_id` are real FKs (`on delete set null`), so a dangling pointer
  (an angle/page deleted after attribution stamped it) would reject the whole ~500-row
  batch — `.upsert()` is all-or-nothing. [[../libraries/meta__scorecards]] now **nulls
  any unresolved ref** before writing and falls back to per-row upsert on a batch error,
  so one bad ref can't drop its neighbors, and the run's reported `rows` is the count
  that actually persisted (never `records.length` when the write failed).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
