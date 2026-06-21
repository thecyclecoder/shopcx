# Growth Director — Stage 1: Per-Product Acquisition-ROAS Spine ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director

The measurement layer the Growth agent reasons on: **acquisition ROAS per product line** (linked-product group), across every sales channel, vs that product's paid spend. Stage 1 of the Growth agent — it productizes the manual coffee analysis (dev-ask, 2026-06-21) and surfaces the data gaps that block the diagnose/decide stages. The agent **owns the objective** (profitable new-customer acquisition); this metric is its **proxy/tool** — see [[../goals/ceo-mode]] § 'Role agents own the objective'.

## The metric (founder definition, 2026-06-21)

`AcqROAS(product) = Σ non-renewal sales across {Shopify, internal, Amazon} for the linked-product group  ÷  Meta spend on that product's ad account`

- **Non-renewal** = the canonical [[../libraries/order-bucketing]] `bucketOrder` checkout family (`new_sub` + `one_time`); `recurring`/`replacement` excluded. Renewals are NOT acquisition.
- **Linked group** = [[../tables/product_link_groups]] / [[../tables/product_link_members]] (e.g. Amazing Coffee + Amazing Coffee K-Cups = one unit; the Bamboo Coffee Mug accessory is NOT in the group).
- **Explicit, versioned assumptions** (Meta is the only paid acquisition channel): (a) Amazon non-renewal sales for the group are credited to Meta (saw the ad, bought on Amazon); (b) even non-renewal sales without `utm_source=meta` are Meta-derivative. Configurable, surfaced on the report — not hardcoded truths.

## Baseline established by the manual run (Jun 7–20, 2026, coffee)

- Shopify+internal coffee non-renewal: **$5,896** (53 orders) — exact, from `orders.line_items`.
- Amazon non-renewal (ALL products, not resolvable): $16,243. Coffee = 5/19 active ASINs.
- Coffee & Creamer Meta spend: **$7,179**.
- AcqROAS bound: **0.82 (on-site only) → 3.08 (all-Amazon, over-attributed)**; plausible true ≈ 1.6–2.1. The ±3x error bar IS the problem this spec fixes.

## Phase 1 — Per-product non-renewal revenue resolver (Shopify+internal) ⏳
- Library that, given a linked-group + date window, walks `orders` (paginated), buckets via `bucketOrder`, and sums **coffee line-item** revenue (`line_items[].price_cents × quantity`) for non-renewal orders, matching lines by `product_variants.shopify_variant_id → product_id ∈ group`. Reuse, do not re-implement, `bucketOrder`. Brain page in same PR.

## Phase 2 — Per-product Amazon sales ingestion (THE BLOCKER) ⏳
- **Schema change (rides this spec→build, not a db_mutation):** new `daily_amazon_product_snapshots` (workspace, amazon_connection, snapshot_date, **asin**, order_bucket, order_count, gross_revenue_cents) so Amazon sales become product-resolvable via [[../tables/amazon_asins]] (`asin → product_id`). Today only [[../tables/daily_amazon_order_snapshots]] (aggregate) exists.
- Backfill the trailing window; wire the same 5-min refresh cron that fills the aggregate table.
- Roll up to the linked group, same `recurring`-excluded bucketing as Shopify (Amazon `recurring` = SnS auto-renewals).

## Phase 3 — Product ↔ ad-account mapping + the metric ⏳
- A mapping (table or `workspaces` config) from linked-group → Meta ad account(s) (coffee → 'Amazing Coffee & Creamer' d6d619a5). Removes the hardcode.
- Compute `AcqROAS(product, window)` = (Phase 1 + Phase 2 non-renewal) / [[../tables/daily_meta_ad_spend]] for the mapped account(s). Surface the channel split + the halo ratio (Amazon ÷ on-site) and the active assumptions.

## Phase 4 — Growth report contract output ⏳
- Emit the CEO-mode director **report contract** ([[../goals/ceo-mode]]) for each product line: AcqROAS, non-renewal new-customer revenue, channel mix, week-over-week delta, and the guardrail flag (e.g. 'on-site ROAS<1 but halo-blended ≥ target — do NOT cut'). Bottom-line cut (contribution-margin ROAS) is a **declared dependency on M1 COGS** — revenue-ROAS until then.
- **North-star guard:** the report must name AcqROAS as a proxy and flag degenerate moves (cutting a proven SKU on on-site ROAS alone when the Amazon halo carries it).

## Verification
- [ ] Phase 1 resolver reproduces the manual baseline: coffee Shopify+internal non-renewal = $5,896 for Jun 7–20 (±rounding).
- [ ] `daily_amazon_product_snapshots` populated; coffee-ASIN rows sum to ≤ the aggregate `daily_amazon_order_snapshots` non-renewal total for the same days (conservation check).
- [ ] AcqROAS(coffee, Jun 7–20) returns a single number inside [0.82, 3.08] with the channel split shown.
- [ ] Report contract validates against the CEO-mode schema; assumptions + guardrail flags present.
- [ ] Every new table/library/inngest fn has a `docs/brain/` page in the same PR.
