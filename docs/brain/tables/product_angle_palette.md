# product_angle_palette

The **clean, curated per-product angle palette** — the v3 creative engine's fan-out trunk: Product → Ingredient → **Theme** → **Problem-Angle**. One row per `(product, theme, problem)`. Each row carries the raw parts a headline needs (enemy / mechanism / proof / outcome), the demand signal that SELECTS it, the evidence tier (a proof STYLE, not a filter), and the coverage/freshness memory.

A headline is composed as **Angle × Pattern** — this table is the Angle half; [[ad_headline_patterns]] is the Pattern half. Replaces the polluted, unstructured `product_ad_angles` for the v3 path (legacy table untouched).

**Primary key:** `id` · **Unique:** `(workspace_id, product_id, theme, problem)`

Written/read **only** through the [[../libraries/angle-palette]] SDK — never raw `.from('product_angle_palette')`.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · `on delete cascade` |
| `product_id` | `uuid` | — | → [[products]].id · `on delete cascade` |
| `theme` | `text` | — | positioning menu + audience tag + coverage axis: `beauty`\|`longevity`\|`healthy_weight`\|`energy_performance`\|`focus`\|`gut` |
| `problem` | `text` | — | **the key** — `'wrinkles & aging skin'`. Angles are keyed on PROBLEM, not ingredient |
| `ingredients` | `text[]` | — | default `'{}'` · `{collagen,hyaluronic_acid}` — double-backed (2 ingredients → 1 problem) = stronger |
| `benefit_key` | `text` | ✓ | links [[product_benefit_selections]].`benefit_name` (grounding) |
| `enemy` | `text` | ✓ | the false-solution the audience currently buys — `'serums'`. The reframe fuel |
| `mechanism` | `text` | ✓ | `'collagen rebuilds skin from within'` |
| `desired_outcome` | `text` | ✓ | `'younger, smoother skin'` |
| `proof_text` | `text` | ✓ | `'35% wrinkle reduction at 12 weeks'` or a real customer phrase |
| `proof_kind` | `text` | ✓ | `'clinical_stat'`\|`'mechanism'`\|`'customer_review'` |
| `evidence_tier` | `text` | — | default `'customer_only'` · CHECK `science_strong`\|`science_modest`\|`customer_only`. **A proof STYLE, NOT a filter** |
| `backing_review_ids` | `uuid[]` | — | default `'{}'` · real reviews grounding the proof |
| `search_demand` | `text` | — | default `'medium'` · CHECK `high`\|`medium`\|`low`. **The SELECTOR** (proxy until a keyword-volume source) |
| `awareness_stages` | `text[]` | — | default `'{cold,warm,hot}'` · which temperatures this angle serves |
| `source` | `text` | — | default `'seeded'` · CHECK `seeded`\|`dahlia_fanned`\|`competitor_mapped` |
| `times_used` | `int4` | — | default `0` · **coverage** — bumped on every use |
| `last_used_at` | `timestamptz` | ✓ | **freshness** — drives cooldown |
| `status` | `text` | — | default `'fresh'` · CHECK `fresh`\|`testing`\|`crowned`\|`retired` |
| `is_active` | `bool` | — | default `true` |
| `display_order` | `int4` | — | default `0` |
| `notes` | `text` | ✓ |  |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`
- `product_id` → [[products]].`id`

**In (others → this):**

- [[ad_creative_combinations]].`angle_id` → this.`id` (`on delete cascade`)
- [[ad_campaigns]].`angle_palette_id` → this.`id` (the attribution stamp)

## Common queries

### List a product's fresh palette for a temperature (through the SDK)
```ts
import { listAnglePalette } from "@/lib/ads/angle-palette";
const angles = await listAnglePalette(admin, workspaceId, productId, {
  status: "fresh",
  awarenessStage: "cold",
});
```

## Gotchas

- **`evidence_tier` never excludes an angle.** Demand (`search_demand`) SELECTS the angle; scientific evidence REINFORCES it (marketing tools — CEO 2026-07-21). A high-demand + weak-science angle ("collagen → hair/nails") is GREENLIT and grounded with the customer review, not a clinical claim. A strong-science + zero-demand angle is SKIPPED. Consumed as a proof-STYLE by [[../libraries/compose-headline]] (`customer_only` → lead with the review; `science_strong` → the stat is fair game).
- **Keyed on PROBLEM, not ingredient.** One ingredient fans across many problem-lanes (collagen → skin/hair/nails/joints/muscle/gut/bone). The uniqueness key is `(theme, problem)` — that's what makes each row a distinct testable angle.
- **`product_benefit_selections.role='skip'` is NOT a hard exclusion here.** If search demand exists, the angle is viable (the creamer marked Muscle/Gut/Bone `skip`, but they're high-demand collagen lanes).
- **Coverage fields drive freshness, not this table alone.** `times_used`/`last_used_at`/`status` here track the ANGLE; the ad-grain freshness ("never ship the same ad twice") lives at the angle×pattern grain in [[ad_creative_combinations]].
- **Never write raw.** Coverage bumps go through [[../libraries/angle-palette]] `markAngleUsed`; lifecycle through `setAngleStatus`; upserts through `upsertAngle` (idempotent on the unique key).

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
