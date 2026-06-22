# Growth Director — Stage 1: Per-Product Acquisition-ROAS Spine ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director

The measurement layer the Growth agent reasons on: **acquisition ROAS per product line** (linked-product group), across every sales channel, vs that product's paid spend. Stage 1 of the Growth agent — it productizes the manual coffee analysis (dev-ask, 2026-06-21) and surfaces the data gaps that block the diagnose/decide stages. The agent **owns the objective** (profitable new-customer acquisition); this metric is its **proxy/tool** — see [[../goals/ceo-mode]] § 'Role agents own the objective'.

## The metric (founder definition, 2026-06-21)

`AcqROAS(product) = Σ non-renewal sales across {Shopify, internal, Amazon} for the linked-product group  ÷  Meta spend on that product's ad account`

- **Non-renewal** = the canonical [[../libraries/order-bucketing]] `bucketOrder` checkout family (`new_sub` + `one_time`); `recurring`/`replacement` excluded. Renewals are NOT acquisition.
- **Linked group** = [[../tables/product_link_groups]] / [[../tables/product_link_members]] (Amazing Coffee + Amazing Coffee K-Cups = one unit; the Bamboo Coffee Mug accessory is NOT in the group).
- **Explicit, versioned assumptions** (Meta is the only paid acquisition channel): (a) Amazon non-renewal sales for the group are credited to Meta; (b) even non-renewal sales without `utm_source=meta` are Meta-derivative. Configurable, surfaced on the report — not hardcoded.

## Baseline — RESOLVED (2026-06-21, post [[amazon-per-product-sales-attribution]] #157)

The ±3x error bar is gone — Amazon is now product-resolvable. Coffee, Jun 7–20:
- Shopify+internal non-renewal: **$5,896** (53 orders, from `orders.line_items`).
- Amazon non-renewal: **$6,267** (one_time $5,923 + sns_checkout $344) = **32%** of Amazon non-renewal, from [[../tables/daily_amazon_product_snapshots]] (verified: reproduces the live SP-API pull to the dollar; conservation vs the aggregate = zero drift).
- Coffee & Creamer Meta spend: **$7,179**.
- **AcqROAS(coffee, Jun 7–20) = ($5,896 + $6,267) / $7,179 = 1.69** — and this is a CONSERVATIVE floor (see Phase 3: the account's spend also covers creamer). vs 0.82 on-site-only: the Amazon halo ~doubles measured efficiency. Profit confirmation still pends M1 COGS.

## Phase 1 — Per-product non-renewal revenue resolver (Shopify+internal) ✅
- Library `getShopifyInternalNonRenewalRevenue({ productIds, startDate, endDate })` mirroring the Amazon resolver's shape: walk `orders` (paginated), bucket via `bucketOrder`, sum **line-item** revenue (`line_items[].price_cents × quantity`) for non-renewal orders, matching lines by `product_variants.shopify_variant_id → product_id ∈ group`. Reuse, don't re-implement, `bucketOrder`. Reproduces the $5,896 baseline. Brain page in same PR. (Only the Amazon side — `src/lib/amazon/per-product-revenue.ts` — exists today.)

## Phase 2 — Per-product Amazon sales ingestion ✅ (delegated)
- **Shipped** as [[amazon-per-product-sales-attribution]] (#157, 2026-06-21): [[../tables/daily_amazon_product_snapshots]] (per asin/product/pack/bucket/day, backfilled Mar 23–Jun 21, conservation-checked), `pack_size` on [[../tables/amazon_asins]], and `getAmazonNonRenewalRevenue` ([[../libraries/amazon__per-product-revenue]]). This phase consumes that — **do not rebuild**.

## Phase 3 — Product ↔ ad-account mapping + the metric ⏳
- A persistent mapping (table or `workspaces` config) from linked-group → Meta ad account(s) (coffee → 'Amazing Coffee & Creamer' `d6d619a5`). Removes the hardcode.
- **Multi-product account nuance:** the 'Amazing Coffee & Creamer' account covers BOTH coffee and creamer, so charging all its spend to coffee **understates** coffee AcqROAS (denominator inflated). The mapping must support either (a) splitting an account's spend across the product lines it serves, or (b) flagging 'shared account — AcqROAS is a conservative floor' on the report. Decide per account.
- Compute `AcqROAS(product, window)` = (Phase 1 + Phase 2 non-renewal) / [[../tables/daily_meta_ad_spend]] for the mapped account(s). Surface the channel split + halo ratio (Amazon ÷ on-site) + the active assumptions.

## Phase 4 — Growth report contract output ⏳
- Emit the CEO-mode director **report contract** ([[../goals/ceo-mode]]) per product line: AcqROAS, non-renewal new-customer revenue, channel mix, week-over-week delta, guardrail flag ('on-site ROAS<1 but halo-blended ≥ target — do NOT cut'). Contribution-margin ROAS is a **declared dependency on M1 COGS** — revenue-ROAS until then.
- **North-star guard:** name AcqROAS as a proxy; flag degenerate moves (cutting a proven SKU on on-site ROAS alone when the Amazon halo carries it).

## Open data gaps (carried from #157)
- **`B0DK7RJZQY`** (Active Amazon ASIN, $23 Ashwavana variant) has no `product_id` → its non-renewal sits under `product_id=null` (conservation preserved, coffee unaffected). Must be mapped before any **Ashwavana** AcqROAS is trusted. Owner decision.
- **COGS / contribution margin** (CEO-mode M1) — needed to turn revenue-AcqROAS into profit-AcqROAS.

## Verification
- [ ] Phase 1 resolver reproduces the baseline: coffee Shopify+internal non-renewal = $5,896 for Jun 7–20 (±rounding).
- [ ] AcqROAS(coffee, Jun 7–20) returns **1.69** (channel split shown: Shopify+internal $5,896 / Amazon $6,267 / spend $7,179), with the shared-account caveat flagged.
- [ ] Report contract validates against the CEO-mode schema; assumptions + guardrail flags present.
- [ ] Every new library/config has a `docs/brain/` page in the same PR.
