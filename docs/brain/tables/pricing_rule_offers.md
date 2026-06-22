# pricing_rule_offers

Dynamic, **time-boxed persist-to-renewal offers** — the gated, highest-stakes optimizer lever (M6, [[../specs/storefront-dynamic-renewal-offers]]). A CHILD of [[pricing_rules]]: the base rule stays static per product; an offer is a **scoped, time-boxed renewal-price override** (a `subscribe_discount_pct` override OR a fixed renewal price) that persists to **every renewal**, not just the first order. It bleeds margin on every renewal, so it is **always owner-approved**, never autonomous (first-order discounts stay coupons — [[coupons]]).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `product_id` | `uuid` | — | → [[products]].id — the scope (engine resolves per product line) |
| `pricing_rule_id` | `uuid` | ✓ | → [[pricing_rules]].id (the base rule it overrides; null = resolve live) |
| `experiment_id` | `uuid` | ✓ | → [[storefront_experiments]].id — the M1 experiment it runs as an arm of |
| `variant_id` | `uuid` | ✓ | → [[storefront_experiment_variants]].id — the offer arm |
| `lander_type` | `text` | ✓ | CHECK ∈ pdp｜listicle｜beforeafter｜advertorial · null = all |
| `audience` | `text` | — | default `'all'` |
| `offer_type` | `text` | — | CHECK ∈ `subscribe_discount_pct`｜`fixed_renewal_price` |
| `subscribe_discount_pct` | `int4` | ✓ | [0,100] — override S&S percent at renewal (stacks with the quantity break) |
| `renewal_price_cents` | `int4` | ✓ | ≥0 — fixed per-unit renewal price (overrides break + S&S) |
| `starts_at` | `timestamptz` | — | default `now()` |
| `ends_at` | `timestamptz` | — | CHECK `ends_at > starts_at` — the time-box (auto-expires here) |
| `status` | `text` | — | CHECK ∈ `proposed`｜`approved`｜`active`｜`expired` · default `proposed` |
| `modeled_renewal_margin_pct` | `numeric` | ✓ | modeled gross margin at proposal time (Phase 3 floor) |
| `margin_floor_pct` | `numeric` | ✓ | the floor it was checked against |
| `margin_floor_ok` | `bool` | ✓ | did it clear the floor (a `false` row was blocked + escalated) |
| `cogs_source_missing` | `bool` | — | default `true` — flagged placeholder economics (no COGS source, M3) |
| `hypothesis` / `rationale` | `text` | ✓ | surfaced reasoning (the north star) |
| `created_by` / `approved_by` | `uuid` | ✓ | the agent / the approving owner |
| `approved_at` / `activated_at` / `expired_at` | `timestamptz` | ✓ | lifecycle stamps |
| `deactivation_reason` | `text` | ✓ | `auto_expired`｜`experiment_rolled_back`｜`experiment_killed` … |
| `created_at` / `updated_at` | `timestamptz` | — | default `now()` |

CHECK `pricing_rule_offers_value_present`: the value column matching `offer_type` must be set.

## Lifecycle

`proposed` (created inactive, margin-checked) → owner approval → `active` (persists to renewal) → `expired` (auto at `ends_at`, or on M1 rollback/kill). The pricing engine ([[../libraries/pricing]]) applies the offer **only while `status='active'` and within `[starts_at, ends_at)`** — so deactivation reverts every bound sub to base renewal pricing with **nothing baked to un-bake** (reversible on real renewals).

## Binding

A subscription that converts on the offer arm carries a **reference** ([[subscriptions]].`pricing_rule_offer_id`), set at checkout by `bindOfferOnConversion` ([[../libraries/storefront-renewal-offers]]) — never a baked price. [[../inngest/internal-subscription-renewals]] selects the column so the renewal engine resolves the offer live.

## Foreign keys

**Out:** `workspace_id` → [[workspaces]] · `product_id` → [[products]] · `pricing_rule_id` → [[pricing_rules]] · `experiment_id` → [[storefront_experiments]] · `variant_id` → [[storefront_experiment_variants]]

**In:** [[subscriptions]].`pricing_rule_offer_id` · [[pricing_rule_offer_events]].`offer_id`

## Gotchas

- Owned end-to-end by [[../libraries/storefront-renewal-offers]] — never write this table freehand. `proposeOffer` margin-checks + creates `proposed`; `activateOffer` flips to `active` on approval; `deactivateOffer`/`expireDueOffers`/`deactivateOffersForExperiment` expire it. Every state change writes a [[pricing_rule_offer_events]] audit row.
- A `margin_floor_ok=false` row is recorded for supervisability but is **never** surfaced for approval — it escalated to Growth + CFO.

---

[[../README]] · [[../specs/storefront-dynamic-renewal-offers]] · [[../../CLAUDE]]
