# product_customer_situations

The verifiable, compliance-checked dataset of the real life-situations our customers were in, mined from the best-reviews set. ONE source shared by the AI shopping-agent MCP server ([[../libraries/customer-situations]] · `find_products_for_situation`) and the PDP AI-answers (AEO) work — both read these rows so a situation can't drift between surfaces. Phase 1 of the AI-shopping-agent build.

**Compliance invariant (north star):** every row AND every nested quote carries its own `compliance_ok` flag. Incentivized/coupon reviews and disease/drug-term quotes are **stored** (for audit) but **never surfaced** to shoppers — the SDK returns only `compliance_ok=true` rows and strips non-compliant quotes on every shopper-facing read (default `compliantOnly=true`). Weight-loss results (pounds lost) are NOT a block reason since 2026-11-28 (CEO): a quote stored `compliance_ok=false` only for that is re-screened on read with `checkQuote` and surfaces with the results-may-vary note.

**Joins on the internal `product_id` UUID** — never `shopify_*_id`. No `customer_id` column, so no Sonnet data tool is required.

**Writes go through [[../libraries/customer-situations]] only** (service-role) — enforced by [scripts/_check-customer-situations-sdk-compliance.ts](../../../scripts/_check-customer-situations-sdk-compliance.ts), chained into `predeploy`. A raw `.from('product_customer_situations')` anywhere else fails the gate.

**Primary key:** `id` · **Unique:** `(workspace_id, product_id, slug)`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · ON DELETE CASCADE |
| `product_id` | `uuid` | — | → [[products]].id (internal UUID) · ON DELETE CASCADE |
| `slug` | `text` | — | Stable per-product situation key (e.g. `tried-everything`, `coffee-swap`) |
| `situation` | `text` | — | The situation in structure/function language |
| `who` | `text` | ✓ | Who this situation describes |
| `goal` | `text` | ✓ | What they were trying to do |
| `noticed` | `text` | ✓ | What customers noticed (experience, attributed — not a promise) |
| `timeframe` | `text` | ✓ | Typical timeframe |
| `verbatim_phrase` | `text` | ✓ | First **compliant** verbatim quote (mirror of `quotes[].verbatim_phrase`) |
| `review_ids` | `uuid[]` | — | Source [[product_reviews]] ids this situation was mined from · default `{}` |
| `quotes` | `jsonb` | — | Array of `{review_id, reviewer, rating, verified_purchase, featured, verbatim_phrase, compliance_ok, compliance_note}`. Non-compliant quotes kept for audit, never surfaced. default `[]` |
| `compliance_ok` | `bool` | — | Situation-level gate · **default `false`** (surfaceable only when explicitly true) |
| `compliance_note` | `text` | ✓ | Why / caveats |
| `source` | `text` | ✓ | Provenance, e.g. `seed:aeo-2026-11-23` |
| `active` | `bool` | — | default `true` |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` · set by the SDK on upsert |

## Indexes

- `product_customer_situations_slug_uniq` — unique `(workspace_id, product_id, slug)` (the upsert key)
- `product_customer_situations_ws_product_idx` — `(workspace_id, product_id)`
- `product_customer_situations_compliant_idx` — `(workspace_id, product_id, compliance_ok, active)` (surface-read path)

## RLS

Enabled. `authenticated` SELECT (`auth.uid() is not null`); `service_role` ALL. Mirrors [[storefront_levers]] / [[competitors]]. Application writes are service-role via the SDK.

## Seeding

Idempotent ship-time backfill `scripts/_backfill-customer-situations.ts` reads `fixtures/ai-shopping-agent/superfood-tabs-situations.json` (17 situations, 60 verbatim quotes for Superfood Tabs), resolves `product_id` → workspace (verifying the product exists), and upserts through the SDK on `(workspace_id, product_id, slug)`. Source review set = best-reviews (`status IN ('published','featured')`, `rating >= 4`, featured first — same selection as `getReviewsForProducts`). `source='seed:*'`. Tracked ship-time backfill (CLAUDE.md § Ship-time backfill-must-be-tracked).

## Mining (every advertised product)

Beyond the hand-seeded Tabs rows, situations for every `is_advertised` product are **mined** from its best reviews by the `situation-mine` box lane — see [[../libraries/situation-miner]]. A Max box session proposes situations; the deterministic `applySituationMine` verifies every quote is a verbatim substring of its cited review, compliance-screens quote + situation text via `checkClaim`, and upserts with `source='mine:<ISO date>'`. A mine **never overwrites a `seed:*` row** (seed rows win on their slug). `compliance_ok` is set per the gate: a situation with no compliant verbatim quote is stored `compliance_ok=false` (audit-only, never surfaced).

## Migration

`supabase/migrations/20270125120000_product_customer_situations.sql`

## Related

[[../libraries/customer-situations]] · [[product_reviews]] · [[products]] · [[../lifecycles/product-intelligence]] · [[../libraries/product-intelligence]]
