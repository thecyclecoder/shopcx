# `pricing_rule_offers` — dynamic, time-boxed persist-to-renewal offers

One row per **scoped, time-boxed offer that persists to renewal** — the gated, highest-stakes lever of the [[../goals/storefront-optimizer]] (M6). A base [[pricing_rules]] row is static-per-product (one rule joined via [[product_pricing_rule]], read live by the renewal/portal engine). This **child table overlays** that rule with an offer that overrides the resolved S&S % (or pins a fixed renewal unit price) for an in-scope `(product × lander_type × audience)` / experiment arm, inside an explicit `[starts_at, ends_at]` window. The offer **bleeds margin on every renewal** (not just first order), so it is **never autonomous** — `status` walks `proposed → approved → active → expired` and only the owner promotes it to `active`. Read at renewal by [[../libraries/pricing]] `resolveSubscriptionPricing` via [[subscriptions]]`.pricing_offer_id`. Migration `20260624000000_pricing_rule_offers.sql`. RLS: workspace-member SELECT, service-role write. Spec: `docs/brain/specs/storefront-dynamic-renewal-offers.md` (this spec ships the offer **model**; the activation lever + margin-floor / expiry / rollback guardrails are deferred to `storefront-renewal-offer-lever.md`).

## Columns

The live table carries the **full guardrail shape** (built ahead of the spec by closed PR #281; reconciled into the migration 2026-06-24). The renewal *read* ([[../libraries/pricing]]) uses only `product_id` + the delta + window + `status`; the margin/lifecycle columns are populated by the deferred activation lever ([[../specs/storefront-renewal-offer-lever]]).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | the value carried in [[subscriptions]]`.pricing_offer_id` |
| `workspace_id` | uuid → workspaces | cascade |
| `product_id` | uuid → products | cascade, **NOT NULL** — the product the offer targets; narrows **which lines** on an in-scope sub get the delta |
| `pricing_rule_id` | uuid → [[pricing_rules]] | nullable, `on delete set null` — the base rule this offer overlays (does not replace it) |
| `experiment_id` | uuid → [[storefront_experiments]] | nullable, `on delete set null` — the experiment this offer is scoped to |
| `variant_id` | uuid → [[storefront_experiment_variants]] | nullable, `on delete set null` — the experiment arm (the M4 optimizer proposes offers per arm) |
| `lander_type` | text | nullable, `pdp` \| `listicle` \| `beforeafter` \| `advertorial` (CHECK). NULL = any |
| `audience` | text | NOT NULL, default `all` — audience scope key |
| `offer_type` | text | NOT NULL, `subscribe_discount_pct` \| `fixed_renewal_price` (CHECK) — which delta column applies |
| `subscribe_discount_pct` | int | nullable, `[0,100]` (CHECK) — an **override** of the rule's S&S % for in-scope lines |
| `renewal_price_cents` | int | nullable, `>=0` (CHECK) — a **fixed** renewal unit price (cents) that pins the per-unit charge outright |
| `starts_at` / `ends_at` | timestamptz | NOT NULL window (`starts_at` default `now()`); `ends_at > starts_at` (CHECK) |
| `status` | text | `proposed` \| `approved` \| `active` \| `expired` (CHECK), default `proposed`. Only `active` is applied |
| `modeled_renewal_margin_pct` / `margin_floor_pct` / `margin_floor_ok` | numeric / numeric / bool | margin guardrails (populated by the lever) |
| `cogs_source_missing` | bool | NOT NULL, default `true` — COGS basis present for the margin model? |
| `hypothesis` / `rationale` | text | supervisability — the agent's surfaced reasoning |
| `created_by` / `approved_by` | uuid | who drafted / signed off (nullable) |
| `approved_at` / `activated_at` / `expired_at` | timestamptz | lifecycle timestamps (set by the lever) |
| `deactivation_reason` | text | why an offer was expired / rolled back |
| `created_at` / `updated_at` | timestamptz | |

**CHECK — delta matches offer_type:** `pricing_rule_offers_value_present` enforces `offer_type='subscribe_discount_pct' → subscribe_discount_pct` set, else `offer_type='fixed_renewal_price' → renewal_price_cents` set.

**Indexes:** `(workspace_id, status)` + `(workspace_id, product_id, status)` — the renewal-time active-offer lookup; `(experiment_id)`. Plus [[subscriptions]]`(pricing_offer_id) where not null` for the reverse lookup.

## Lifecycle (status)
- `proposed` — agent drafted the offer (with `rationale`); not applied. `approved` — owner signed off (`approved_by`); not yet live. `active` — live; `resolveSubscriptionPricing` applies it at renewal for subs whose `pricing_offer_id` points here and whose `now()` is in-window. `expired` — window passed / rolled back; reverts in-scope subs to base pricing.
- **The agent proposes; the owner disposes.** Promotion to `active` is always an owner action — never autonomous (it bleeds margin on every renewal).

## How an offer reaches a renewal
1. A sub records which offer it was acquired under in [[subscriptions]]`.pricing_offer_id` (a **reference, not a baked price** — set by the deferred activation lever, gated by owner approval).
2. At renewal, [[../libraries/pricing]] loads that offer and applies its delta **only when** `status='active'` and `now() ∈ [starts_at, ends_at]`.
3. `product_id` scopes **which lines** get it — only that product's lines on the sub. `renewal_price_cents` (when `offer_type='fixed_renewal_price'`) pins the unit price; otherwise `subscribe_discount_pct` overrides the resolved S&S %.

## Gotchas
- **Reference, not baked.** The sub stores `pricing_offer_id`, never a baked offer price. Expiring the offer (`status='expired'`) or nulling the column reverts the sub to base pricing automatically — reversible-on-real-renewals, no row rewrite.
- **First-order coupons do NOT live here.** A first-order-only discount stays on the autonomous [[coupons]] path (`applied_discounts`). Only offers that **persist to renewal** become `pricing_rule_offers` rows and hit the owner-approval gate.
- **Margin-floor / expiry / rollback guardrails are deferred.** This table is the *model*. The lever that proposes/approves/expires/rolls-back offers (+ the margin-floor hard rail) is `storefront-renewal-offer-lever.md` — not yet built. Until then nothing populates `pricing_offer_id`, so the renewal read is dormant.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
