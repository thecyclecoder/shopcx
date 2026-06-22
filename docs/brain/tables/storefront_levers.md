# `storefront_levers` — the canonical chapter→component lever taxonomy

The hierarchical map of every storefront lever the [[../goals/storefront-optimizer]] agent can test, with a CRO **prior** importance per lever. **Global** (not per-workspace): the taxonomy + CRO principles are universal. A **chapter** row (hero, pricing_table, social_proof, …) has `parent_lever_id` NULL; a **component** row (hero = `image · headline · benefit_chips · review_snippet · trust_badges`, …) points at its chapter via the self-FK. The *learned* posterior per cohort lives in [[storefront_lever_importance]]; this table holds only the canonical structure + cold priors. Seeded in the migration. Written/read by [[../libraries/lever-memory]]. Migration `20260624120000_storefront_lever_memory.sql`. RLS: any authenticated user SELECT, service-role write. Part of [[../goals/storefront-optimizer]] (M2). Spec `docs/brain/specs/storefront-lever-importance-memory.md`.

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `parent_lever_id` | uuid → storefront_levers (self-FK) | NULL on a chapter; the chapter id on a component. `on delete cascade` |
| `lever_key` | text UNIQUE | stable machine key (`hero`, `image`, `headline`, `pricing_table`, …). An M1 experiment's free-text `lever` resolves to exactly one row via this (see [[../libraries/lever-memory]] `resolveLever`) |
| `chapter` | text | the chapter this lever belongs to; for a chapter row, `chapter == lever_key` |
| `level` | text | `chapter` \| `component` (CHECK) |
| `label` | text | human label |
| `description` | text | optional |
| `prior` | float8 | CRO prior importance `[0,1]` (CHECK). Hero dominant (#1), pricing-clarity #2 — the goal's § CRO principles; chapter ordering reflects the real funnel dwell + CTA-click share we already have ([[../dashboard/storefront__funnel]]) |
| `lander_types` | text[] | which lander types this lever applies to (default all four: `pdp,listicle,beforeafter,advertorial`) |
| `default_scope` | text | `product_specific` \| `general` (CHECK). Structural CRO levers (hero/pricing/social_proof/cta/guarantee/faq) seed as `general` (transfer cross-product); content levers (benefits/ingredients) as `product_specific`. Seeds the posterior row's `scope` |
| `created_at` / `updated_at` | timestamptz | |

**Indexes:** `(parent_lever_id)`; `(chapter, level)`.

## Seeded hierarchy (priors, desc)

- **hero** 0.95 → image 0.80 · headline 0.78 · benefit_chips 0.55 · review_snippet 0.50 · trust_badges 0.45
- **pricing_table** 0.85 → price_anchor 0.65 · discount_framing 0.60 · pack_options 0.55 · subscription_toggle 0.50
- **cta** 0.70 → button_copy 0.50 · cta_placement 0.45
- **social_proof** 0.65 → testimonial_quote 0.50 · review_count 0.45 · star_rating 0.45 · ugc_photo 0.40
- **benefits** 0.60 → benefit_headline 0.60 · pain_point 0.58
- **ingredients** 0.45 → sourcing_story 0.42 · ingredient_list 0.40 · supplement_facts 0.30
- **guarantee** 0.40 → guarantee_copy 0.38
- **faq** 0.30 → objection_list 0.30

## Gotchas

- **Canonical, not per-workspace.** The taxonomy is the same for everyone; only the learned posterior ([[storefront_lever_importance]]) is per `(lever × product × lander × audience)`.
- **`lever_key` is the join key.** An experiment's free-text `lever` (e.g. `"Hero Image"`) is normalized (snake_case) and matched to `lever_key`/`label`/`chapter`; an unresolvable lever logs a warning and the learning is *not* committed (never mis-attributed).
- **Priors never move; posteriors do.** `prior` is the fixed CRO seed. Decay drifts a posterior back *toward* this prior — it never rewrites it here.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
