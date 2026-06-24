# `pricing_rule_offers` — dynamic, time-boxed persist-to-renewal offers

One row per **scoped, time-boxed offer that persists to renewal** — the gated, highest-stakes lever of the [[../goals/storefront-optimizer]] (M6). A base [[pricing_rules]] row is static-per-product (one rule joined via [[product_pricing_rule]], read live by the renewal/portal engine). This **child table overlays** that rule with an offer that overrides the resolved S&S % (or pins a fixed renewal unit price) for an in-scope `(product × lander_type × audience)` / experiment arm, inside an explicit `[starts_at, ends_at]` window. The offer **bleeds margin on every renewal** (not just first order), so it is **never autonomous** — `status` walks `proposed → approved → active → expired` and only the owner promotes it to `active`. Read at renewal by [[../libraries/pricing]] `resolveSubscriptionPricing` via [[subscriptions]]`.pricing_offer_id`. Migration `20260624000000_pricing_rule_offers.sql`. RLS: workspace-member SELECT, service-role write. Spec: `docs/brain/specs/storefront-dynamic-renewal-offers.md` (this spec ships the offer **model**; the activation lever + margin-floor / expiry / rollback guardrails are deferred to `storefront-renewal-offer-lever.md`).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | the value carried in [[subscriptions]]`.pricing_offer_id` |
| `workspace_id` | uuid → workspaces | cascade |
| `pricing_rule_id` | uuid → [[pricing_rules]] | cascade — the base rule this offer overlays (does not replace it) |
| `product_id` | uuid → products | cascade, **nullable** — scope dimension. NULL = any product; else narrows **which lines** on an in-scope sub get the delta |
| `lander_type` | text | nullable, `pdp` \| `listicle` \| `beforeafter` \| `advertorial` (CHECK, mirrors [[storefront_experiments]]). NULL = any |
| `audience` | text | nullable audience key. NULL = any |
| `experiment_variant_id` | uuid → [[storefront_experiment_variants]] | nullable, `on delete set null` — the experiment arm this offer is scoped to (the M4 optimizer proposes offers per arm) |
| `subscribe_discount_pct` | int | nullable, `[0,100]` (CHECK) — an **override** of the rule's S&S % for in-scope lines |
| `renewal_price_cents` | int | nullable, `>=0` (CHECK) — a **fixed** renewal unit price (cents) that pins the per-unit charge outright |
| `starts_at` / `ends_at` | timestamptz | nullable effective window; `ends_at > starts_at` when both present (CHECK) |
| `status` | text | `proposed` \| `approved` \| `active` \| `expired` (CHECK), default `proposed`. Only `active` is applied |
| `label` | text | honest customer-facing offer label (renders as a `renewal_offer` discount pill) |
| `proposed_by` / `approved_by` | uuid | supervisability — who drafted / signed off (nullable) |
| `rationale` | text | the agent's surfaced reasoning |
| `created_at` / `updated_at` | timestamptz | |

**CHECK — exactly one delta:** `pricing_rule_offers_one_delta` enforces exactly one of `subscribe_discount_pct` / `renewal_price_cents` is set.

**Indexes:** `(workspace_id, status, product_id)` — the renewal-time active-offer lookup; `(pricing_rule_id)`; `(experiment_variant_id)`.

## Lifecycle (status)
- `proposed` — agent drafted the offer (with `rationale`); not applied. `approved` — owner signed off (`approved_by`); not yet live. `active` — live; `resolveSubscriptionPricing` applies it at renewal for subs whose `pricing_offer_id` points here and whose `now()` is in-window. `expired` — window passed / rolled back; reverts in-scope subs to base pricing.
- **The agent proposes; the owner disposes.** Promotion to `active` is always an owner action — never autonomous (it bleeds margin on every renewal).

## How an offer reaches a renewal
1. A sub records which offer it was acquired under in [[subscriptions]]`.pricing_offer_id` (a **reference, not a baked price** — set by the deferred activation lever, gated by owner approval).
2. At renewal, [[../libraries/pricing]] loads that offer and applies its delta **only when** `status='active'` and `now() ∈ [starts_at, ends_at]`.
3. `product_id` scopes **which lines** get it: NULL = every product line; else only that product's lines. `renewal_price_cents` pins the unit price; otherwise `subscribe_discount_pct` overrides the resolved S&S %.

## Gotchas
- **Reference, not baked.** The sub stores `pricing_offer_id`, never a baked offer price. Expiring the offer (`status='expired'`) or nulling the column reverts the sub to base pricing automatically — reversible-on-real-renewals, no row rewrite.
- **First-order coupons do NOT live here.** A first-order-only discount stays on the autonomous [[coupons]] path (`applied_discounts`). Only offers that **persist to renewal** become `pricing_rule_offers` rows and hit the owner-approval gate.
- **Margin-floor / expiry / rollback guardrails are deferred.** This table is the *model*. The lever that proposes/approves/expires/rolls-back offers (+ the margin-floor hard rail) is `storefront-renewal-offer-lever.md` — not yet built. Until then nothing populates `pricing_offer_id`, so the renewal read is dormant.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
