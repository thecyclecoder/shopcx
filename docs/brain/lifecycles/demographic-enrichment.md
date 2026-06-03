# Demographic enrichment lifecycle

How a new customer goes from "just a name + email" to a row in [[../tables/customer_demographics]] with inferred age, gender, life stage, ZIP-derived income, and order-derived buyer type. Single source of truth for "how does ShopCX know who its customers are?"

## Three tracks per customer

Each enrichment run does three things in parallel:

| Track | Input | Output | Source |
|---|---|---|---|
| **1. Name inference** | `first_name + last_name` | `inferred_gender`, `inferred_age_range` (+ confidences) | Claude Haiku, batched |
| **2. ZIP demographics** | `default_address.zip` | `zip_median_income`, `zip_income_bracket`, `zip_urban_classification`, `zip_owner_pct`, `zip_college_pct` | US Census ACS 5-year (cached in [[../tables/zip_code_demographics]]) |
| **3. Order analysis** | `orders` + `subscriptions` rows | `buyer_type`, `health_priorities[]`, `total_orders`, `total_spend_cents`, `subscription_tenure_days` | Pure logic in `src/lib/customer-demographics.ts` |

A fourth track (Versium B2C lookup → income/net-worth/marital/children) exists in code but is **gated on `workspaces.versium_api_key_encrypted`**. Superfoods workspace doesn't set it, so it's effectively dead. The Versium columns on [[../tables/customer_demographics]] (`versium_*`) stay NULL.

## Flow

```
new customer row
   │
   │  (a) batch cron — nightly demographics/enrich-batch
   │  (b) event — demographics/enrich-single (~1h after profile insert)
   ▼
demographics-enrich-* in src/lib/inngest/customer-demographics.ts
   │
   ├── Track 1: Haiku batched (up to 50 names/call) → gender + age_range
   ├── Track 2: Census lookup → cached in zip_code_demographics; pulls + classifies
   └── Track 3: analyzeOrderHistory(orders, subs) → buyer_type + priorities
   │
   ▼
INSERT INTO customer_demographics (workspace_id, customer_id, ...)
   ├── inferred_gender / inferred_age_range / inferred_life_stage
   ├── zip_* (income, bracket, urban_classification, owner_pct, college_pct)
   ├── buyer_type / health_priorities / total_orders / total_spend_cents
   └── enriched_at = now(); enrichment_version = 1
   │
   ▼
demographics-snapshot-builder (event: demographics/rebuild-snapshots)
   │
   ├── All-customers snapshot (workspace-level)
   └── Per-product snapshot (one per active product)
   │
   ▼
demographics_snapshots row: gender / age / income / urban /
buyer-type distributions + top_health_priorities + suggested_target_customer
   │
   ▼
/dashboard/demographics reads snapshots for fast paint
```

## Tracks in detail

### Track 1 — Name inference (Haiku)

`src/lib/inngest/customer-demographics.ts` → `inferNamesBatch()` batches up to 50 customers per Haiku call. System prompt asks for `{gender, gender_confidence, age_range, age_confidence, notes}` per name.

- `gender` ∈ `{female, male, unknown}`. If `gender_confidence < 0.6` (the `CONFIDENCE_FLOOR_FOR_GENDER` constant) we keep the raw value but flag low confidence on the row.
- `age_range` ∈ `{under_25, 25-34, 35-44, 45-54, 55-64, 65+}`. The model is asked to guess from generational name patterns (Karen ≠ Brittany ≠ Aiden).
- `inferred_life_stage` is derived purely from `age_range` via `lifeStageFromAgeRange()` in [[../libraries/customer-demographics]]: under_25 → `young_adult`, 25-44 → `family`, 45-64 → `empty_nester`, 65+ → `retirement_age`.

Cost: ~$0.0001 per customer at batch=50. The 15K Amazing Coffee cohort cost roughly $1.50 to enrich end-to-end.

### Track 2 — ZIP demographics (Census)

[[../libraries/census]] pulls ACS 5-year estimates for a given ZIP:
- `median_income`, `median_age`, `population`, `population_density`
- `owner_pct`, `college_pct`
- Derives `income_bracket` ∈ `{under_40k, 40-60k, 60-80k, 80-100k, 100-125k, 125-150k, 150k+}` via `incomeToBracket()`
- Derives `urban_classification` ∈ `{rural, suburban, urban, dense_urban}` via `classifyUrban()` (uses population density)

First call to a new ZIP hits the Census API and writes to [[../tables/zip_code_demographics]]. Every subsequent customer in that ZIP reads from cache. Tiny table (~40K rows once warm — every US ZIP).

Census public endpoint works without an API key but is rate-limited. Per-workspace key via `workspaces.census_api_key_encrypted` raises the limit.

### Track 3 — Order analysis (pure)

`analyzeOrderHistory()` in [[../libraries/customer-demographics]] reads the customer's orders + subscriptions and derives:

- **`buyer_type`** ∈ `{one_time_buyer, value_buyer, cautious_buyer, committed_subscriber, new_subscriber, lapsed_subscriber}`. Derived from order count + subscription state + tenure. A "lapsed_subscriber" has a non-active subscription with positive past tenure — the classic win-back target.
- **`health_priorities[]`** — keyword matches against product titles + descriptions in their order history. Keywords table is `HEALTH_PRIORITY_KEYWORDS` in the library: `energy`, `inflammation`, `cognitive`, `stress`, `sleep`, `joint_health`, `gut`, etc. Multi-tag.
- **`total_orders`**, **`total_spend_cents`**, **`subscription_tenure_days`**.

No AI here — runs in milliseconds.

## When the cron fires

| Trigger | When | Throughput |
|---|---|---|
| `demographics/enrich-batch` | Nightly + on-demand | Up to 500 customers per invocation, self-continues until queue is empty |
| `demographics/enrich-single` | ~1h after a customer is created/updated | Single customer; concurrency = 10 per workspace |
| `demographics/rebuild-snapshots` | After a batch run, or on-demand | All workspaces; one all-customers snapshot + one per active product |

The single-customer event is intentionally **delayed ~1h** so the customer has time to place their first order before we analyze them (otherwise the order-history track always returns "0 orders, one_time_buyer").

## Snapshots

`demographics-snapshot-builder` writes one [[../tables/demographics_snapshots]] row per cohort:

- **All-customers**: `product_id = NULL`. Distributions over the whole workspace's enriched customers.
- **Per-product**: one row per active product. Customers are joined to products via `orders.line_items[].title` (text match — `line_items` JSONB has no product_id reference). The snapshot freezes the cohort's gender/age/income/urban/buyer_type distributions + `top_health_priorities` + a derived `suggested_target_customer` blurb.

The dashboard reads snapshots, not the underlying `customer_demographics`. This is a deliberate cache — rebuilding distributions over 100K+ customers on every page load would be brutal. Snapshots rebuild after every batch enrichment so they trail by at most a night.

## Querying the cohort behind a product

Because the brain reference path is non-trivial, here's the canonical pattern (used in `scripts/_amazing-coffee-demographics.ts`):

```sql
-- 1. Get unique customers from line_items.title
SELECT DISTINCT o.customer_id
FROM orders o, jsonb_array_elements(o.line_items) li
WHERE o.workspace_id = $1::uuid
  AND o.customer_id IS NOT NULL
  AND li->>'title' ILIKE '%amazing coffee%';

-- 2. Join to customer_demographics for those customer_ids
SELECT inferred_gender, inferred_age_range, zip_income_bracket,
       zip_median_income, inferred_life_stage, buyer_type, health_priorities
FROM customer_demographics
WHERE workspace_id = $1::uuid
  AND customer_id = ANY($customer_ids::uuid[]);
```

Note: `line_items` JSONB has no `product_id` — title-text matching is the only available join key. The same product can have multiple titles over time (e.g. "Amazing Coffee K-Cups" vs "Amazing Coffee (K-Cups)" vs the long-tail SEO titles); match on `ILIKE '%amazing coffee%'` not exact title.

## Key design choices

### Cost model: Haiku not Sonnet
Name → demographics is a low-stakes guess. Sonnet would be 10x the cost for marginal accuracy gains on names like "Karen Smith." Haiku batched at 50/call keeps full-workspace enrichment under $5.

### Versium gated, not removed
The code path exists for workspaces that want to pay for the lookup. Superfoods doesn't, so all `versium_*` columns stay NULL. Don't write reports or dashboards that assume those fields are populated.

### ZIP-level income, not household-level
We use the median income of the customer's ZIP code as their income signal. This is intentional — household income from name + ZIP would be a wild guess; ZIP-level income is a real (if blurry) signal. The income brackets on `customer_demographics.zip_income_bracket` are the canonical ones used in dashboards.

### Snapshots > live aggregation
For dashboards that show "X% of Amazing Coffee customers are 45-54", computing that live across 15K customers is too slow. Snapshot tables hold the pre-computed distribution and rebuild nightly.

## Files touched

| File | Purpose |
|---|---|
| `src/lib/inngest/customer-demographics.ts` | Three Inngest functions (batch, single, snapshot-builder) |
| `src/lib/customer-demographics.ts` | Pure-logic order analysis + life-stage mapping |
| `src/lib/census.ts` | ACS API client + bracket/urban classifiers |
| `src/lib/versium.ts` | Versium client (dead unless workspace key is set) |
| `src/app/dashboard/demographics/page.tsx` | The dashboard |
| `supabase/migrations/*demographics*.sql` | Table migrations |

## Status / open work

**Shipped:** Three-track enrichment (Haiku name + Census ZIP + order analysis) for all workspaces. Snapshot builder + dashboard wired. Superfoods workspace 99%+ enriched.

**Known gaps / not yet shipped:**
- Versium track stays NULL on Superfoods (no API key configured). Not a bug — by design — but every chart that fans through `versium_*` columns silently shows "no data."
- `line_items` JSONB has no `product_id`, so per-product cohort joins go through `title ILIKE`. A future variant_id → product_id lookup table would let us join cleanly.
- `enrichment_version = 1` is the only version that exists. Bumping it would let us mass-re-enrich without deleting rows.
- Snapshot rebuild has no incremental mode — it recomputes from scratch every time. Fine at current data volumes; will need attention beyond ~500K customers per workspace.

**Open questions:**
- Should `health_priorities` carry weights instead of being a flat array? Right now "energy" tags every Amazing Coffee buyer at 100% but that's overwhelming the long tail.
- Should we promote a richer life-stage taxonomy (e.g. distinguish young-family-with-kids from young-no-kids)? Currently 25-44 → `family` regardless.

## Related

[[../tables/customer_demographics]] · [[../tables/zip_code_demographics]] · [[../tables/demographics_snapshots]] · [[../inngest/customer-demographics]] · [[../libraries/customer-demographics]] · [[../libraries/census]] · [[../libraries/versium]] · [[../dashboard/demographics]]
