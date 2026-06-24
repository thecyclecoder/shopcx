# Growth Director — Stage 1: Per-Product Acquisition-ROAS Spine

**Owner:** [[../functions/growth]] · **Parent:** [[../goals/ceo-mode]] › M2 — Growth Director

The measurement layer the Growth agent reasons on: **acquisition ROAS per product line** (linked-product group), across every sales channel, vs that product's paid spend. Stage 1 of the Growth agent — it productizes the manual coffee analysis (dev-ask, 2026-06-21) and surfaces the data gaps that block the diagnose/decide stages. The agent **owns the objective** (profitable new-customer acquisition); this metric is its **proxy/tool** — see [[../goals/ceo-mode]] § 'Role agents own the objective'.

> The report-contract **output** layer over this spine is split out as [[growth-acquisition-roas-spine-report-contract]] (built with the CEO synthesizer / Growth director-agent, against the final ceo-mode report-contract schema).

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

## Phase 1 — Per-product non-renewal revenue resolver (Shopify+internal)
- Library `getShopifyInternalNonRenewalRevenue({ productIds, startDate, endDate })` mirroring the Amazon resolver's shape: walk `orders` (paginated), bucket via `bucketOrder`, sum **line-item** revenue (`line_items[].price_cents × quantity`) for non-renewal orders, matching lines by `product_variants.shopify_variant_id → product_id ∈ group`. Reuse, don't re-implement, `bucketOrder`. Reproduces the $5,896 baseline. Brain page in same PR. (Only the Amazon side — `src/lib/amazon/per-product-revenue.ts` — exists today.)
- **Built with Phase 3** (the ✅ flag predated the code — an owner spec-drift flip; the resolver was missing): `src/lib/shopify-internal-revenue.ts` / [[../libraries/shopify-internal-revenue]]. Counts `new_sub`+`one_time`, line-item match via the variant→product set, Central-window→UTC, optional `metaOnlyUtm`.

## Phase 2 — Per-product Amazon sales ingestion  (delegated)
- **Shipped** as [[amazon-per-product-sales-attribution]] (#157, 2026-06-21): [[../tables/daily_amazon_product_snapshots]] (per asin/product/pack/bucket/day, backfilled Mar 23–Jun 21, conservation-checked), `pack_size` on [[../tables/amazon_asins]], and `getAmazonNonRenewalRevenue` ([[../libraries/amazon__per-product-revenue]]). This phase consumes that — **do not rebuild**.

## Phase 3 — Product ↔ ad-account mapping + the metric
- A persistent mapping (table or `workspaces` config) from linked-group → Meta ad account(s) (coffee → 'Amazing Coffee & Creamer' `d6d619a5`). Removes the hardcode.
- **Multi-product account nuance:** the 'Amazing Coffee & Creamer' account covers BOTH coffee and creamer, so charging all its spend to coffee **understates** coffee AcqROAS (denominator inflated). The mapping must support either (a) splitting an account's spend across the product lines it serves, or (b) flagging 'shared account — AcqROAS is a conservative floor' on the report. Decide per account.
- Compute `AcqROAS(product, window)` = (Phase 1 + Phase 2 non-renewal) / [[../tables/daily_meta_ad_spend]] for the mapped account(s). Surface the channel split + halo ratio (Amazon ÷ on-site) + the active assumptions.
- **Shipped:** table [[../tables/product_ad_account_mappings]] (`(group_id, meta_ad_account_id)` unique; per-row `spend_share` resolves the split nuance — option (a) via `spend_share<1`, option (b) via `is_shared_account` + the floor flag; `credit_amazon_to_meta` + `count_all_non_renewal` carry the versioned assumptions). Metric in [[../libraries/acquisition-roas]] (`getProductAdAccountMapping`, `computeAcqROAS`) — returns `acqRoas`, `channelSplit`, `haloRatio`, per-account `accounts[]`, `assumptions`, and `flags` (shared-account floor / no mapping / zero spend). Migration `supabase/migrations/20260703140000_product_ad_account_mappings.sql` — **applied to prod**.
- **⚠️ Pending operator step:** the coffee mapping ROW is not seeded yet. `scripts/seed-coffee-ad-account-mapping.ts` (`is_shared_account=true, spend_share=1.0` → the 1.69 floor) failed to auto-resolve the coffee `product_link_groups.id` and the 'Amazing Coffee & Creamer' `meta_ad_accounts.id` (the spec's `d6d619a5` is an internal `meta_ad_accounts.id` UUID prefix, not the numeric `meta_account_id`). Run it once with the real UUIDs: `SEED_GROUP_ID=<uuid> SEED_META_AD_ACCOUNT_ID=<uuid> npx tsx scripts/seed-coffee-ad-account-mapping.ts`. Until then `computeAcqROAS(coffee)` returns `acqRoas=null` with the "no ad-account mapping" flag (the metric itself is correct).

## Open data gaps (carried from #157)
- **`B0DK7RJZQY`** (Active Amazon ASIN, $23 Ashwavana variant) has no `product_id` → its non-renewal sits under `product_id=null` (conservation preserved, coffee unaffected). Must be mapped before any **Ashwavana** AcqROAS is trusted. Owner decision.
- **COGS / contribution margin** (CEO-mode M1) — needed to turn revenue-AcqROAS into profit-AcqROAS.

## Verification
- [ ] Apply the migration (`npx tsx scripts/apply-product-ad-account-mappings-migration.ts`) → expect `product_ad_account_mappings table present: true`, and the table exists with the unique `(group_id, meta_ad_account_id)` index.
- [ ] Seed the coffee mapping (`npx tsx scripts/seed-coffee-ad-account-mapping.ts`) → expect it prints the resolved account ('Amazing Coffee & Creamer') + coffee group and `✓ upserted`; re-running is idempotent (no duplicate row).
- [ ] Call `getShopifyInternalNonRenewalRevenue({ workspaceId, productIds: <coffee group>, startDate:'2026-06-07', endDate:'2026-06-20' })` → expect `grossCents ≈ 589_600` ($5,896, ±rounding) and `orderCount ≈ 53`.
- [ ] Call `computeAcqROAS({ workspaceId, groupId: <coffee>, startDate:'2026-06-07', endDate:'2026-06-20' })` → expect `acqRoas ≈ 1.69`, `channelSplit` = { onsiteCents ≈ $5,896, amazonCents ≈ $6,267, spendCents ≈ $7,179 }, `haloRatio ≈ 1.06`, `assumptions.sharedAccountFloor=true`, and `flags` contains the "shared account — conservative floor" caveat.
- [ ] `computeAcqROAS` for a group with no mapping row → `acqRoas=null`, `flags` contains "no ad-account mapping".
- [ ] Every new library/config has a `docs/brain/` page in the same PR (`shopify-internal-revenue`, `acquisition-roas`, `product_ad_account_mappings`).
