# `storefront_levers` — the canonical chapter→component lever taxonomy + CRO priors

The GLOBAL (not workspace-scoped) hierarchy of storefront levers the optimizer agent reasons over: **chapter-level** levers (hero, pricing-table, social-proof, benefits, …) and the **component-level** levers that decompose a chapter (hero = `image · headline · benefit_chips · review_snippet · trust_badges`). Each lever carries a CRO **prior** importance; chapter-level priors reflect the real funnel-data dwell/CTA ranking (hero #1, pricing-clarity #2). The learned posteriors per `(lever × product × lander_type × audience)` live in [[storefront_lever_importance]]. Read + updated by [[../libraries/storefront-lever-memory]]. Migration `20260624120000_storefront_levers.sql`. RLS: workspace-member SELECT, service-role write. Part of the [[../goals/storefront-optimizer]] (M2). Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `parent_lever_id` | uuid → `storefront_levers` (self-FK) | null for a chapter-level lever; the parent chapter for a component-level one. `on delete cascade` |
| `lever_key` | text UNIQUE | stable key (e.g. `hero`, `image`, `headline`); matches an experiment's `lever` |
| `chapter` | text | the chapter this lever belongs to (for a chapter-level lever, `== lever_key`) |
| `kind` | text | `chapter` \| `component` (CHECK) |
| `label` / `description` | text | human label + blurb |
| `prior` | double precision | CRO prior importance in `[0,1]` (CHECK). Chapter priors reflect funnel dwell/CTA share |
| `lander_types` | text[] | which lander types this lever applies to (subset of `pdp｜listicle｜beforeafter｜advertorial`), default all four |
| `default_scope` | text | `product_specific` \| `general` (CHECK) — the scope a fresh learning inherits; only `general` transfers cross-product |
| `created_at` / `updated_at` | timestamptz | |

**Constraint:** `storefront_levers_kind_parent` — a `component` must have a `parent_lever_id`, a `chapter` must not.
**Indexes:** unique `(lever_key)`; `(parent_lever_id)`; `(chapter)`.

## Seeded taxonomy
- **Chapters** (prior): `hero` 0.90 · `pricing_table` 0.78 · `social_proof` 0.62 · `benefits` 0.58 · `cta` 0.50 · `ingredients` 0.42 · `how_it_works` 0.40 · `guarantee` 0.35 · `faq` 0.30.
- **Hero components:** `image` 0.62 · `headline` 0.58 · `benefit_chips` 0.45 · `review_snippet` 0.40 · `trust_badges` 0.32.
- **Pricing components:** `price_anchor` 0.55 · `discount_badge` 0.48 · `pack_options` 0.45 · `guarantee_line` 0.38.
- **Social-proof components:** `testimonial` 0.45 · `review_count` 0.42 · `star_rating` 0.40 · `ugc_photo` 0.35.

## Gotchas
- **Global, not per-workspace.** The taxonomy + CRO priors are canonical knowledge shared across workspaces; only the learned posteriors ([[storefront_lever_importance]]) are workspace + product scoped.
- **Priors are a starting point, not the truth.** Each experiment moves a lever's posterior away from its prior; the prior is the cold-start belief + the decay target (a written-off lever drifts back toward it for re-probing).
- **`lever_key` must match the experiment's `lever`.** [[../libraries/storefront-lever-memory]] `updatePosterior` maps `storefront_experiments.lever` → a `lever_key`; an experiment whose `lever` has no taxonomy match commits no learning (logged, not an error).
- **Chapter priors are funnel-informed.** The seed reflects the dwell/CTA ranking; `seedChapterPriorsFromFunnel` (in [[../libraries/storefront-lever-memory]]) can recompute chapter priors from live [[storefront_events]] `chapter_dwell`/`cta_click` share.
