# ad_headline_patterns

The **SHARED, product-agnostic headline-pattern library** — ~13 reusable direct-response formulas keyed by awareness stage. A pattern is a STRUCTURE, not a claim, so it's shared across ALL products in a workspace (one seed set per workspace).

A headline is composed as **Angle × Pattern**: the [[product_angle_palette]] angle supplies the raw parts (enemy / mechanism / proof / outcome), the pattern supplies the structure, and the awareness stage gates which patterns are legal. **The 5 caption variations = 5 patterns on ONE angle.**

**Primary key:** `id` · **Unique:** `(workspace_id, slug)`

Written/read **only** through the [[../libraries/headline-patterns]] SDK — never raw `.from('ad_headline_patterns')`. Seeded idempotently by `seedHeadlinePatterns` from `HEADLINE_PATTERN_SEED`.

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id · `on delete cascade` |
| `slug` | `text` | — | stable key: `'reframe'`\|`'curiosity-gap'`\|`'social-proof'`\|… |
| `name` | `text` | — | display: `'Reframe (not-X-but-Y)'` |
| `structure` | `text` | — | the formula with `[BRACKETED]` slots: `'[SUBJECT] doesn''t need more [ENEMY]. It needs [MECHANISM].'` |
| `awareness_stages` | `text[]` | — | default `'{}'` · temperatures served: `{cold}`\|`{warm,hot}`\|… |
| `consumes` | `text[]` | — | default `'{}'` · angle-parts it needs: `{enemy,mechanism}`\|`{proof,outcome}`\|… (so the selector never picks a pattern the angle can't fill) |
| `example` | `text` | ✓ | a filled example headline |
| `is_active` | `bool` | — | default `true` |
| `display_order` | `int4` | — | default `0` |
| `created_at` | `timestamptz` | — | default `now()` |
| `updated_at` | `timestamptz` | — | default `now()` |

## Foreign keys

**Out (this → others):**

- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_creative_combinations]].`pattern_id` → this.`id` (`on delete cascade`)
- [[ad_campaigns]].`headline_pattern_id` → this.`id` (the attribution stamp)

## The seed library (~13 formulas, by awareness stage)

Grounded in [[../libraries/headline-patterns]] `HEADLINE_PATTERN_SEED`:

- **❄️ COLD** (intrigue / reframe / NO offer): `reframe` · `curiosity-gap` · `villain-callout` · `mechanism-reveal` · `problem-agitate` · `story` · `question`
- **🌤️ WARM** (proof / comparison / specificity): `social-proof` · `specificity` · `comparison` · `testimonial` (also serve hot) · `risk-reversal`
- **🔥 HOT** (offer / urgency / risk-reversal): `offer` (hot only) · `risk-reversal`

## Common queries

### List active patterns legal for a temperature (through the SDK)
```ts
import { listHeadlinePatterns } from "@/lib/ads/headline-patterns";
const cold = await listHeadlinePatterns(admin, workspaceId, { awarenessStage: "cold" });
```

## Gotchas

- **Product-agnostic by design.** No `product_id` FK — a pattern is a structure, so every product borrows the same library. Product intelligence enters only at author time (via the angle) in [[../libraries/compose-headline]].
- **Patterns are NOT verbatim templates.** They're the grounded north-star structure Dahlia flexes toward a competitor's punch — the `structure` is a shape to fill from the angle, not a string to interpolate.
- **`consumes` is a gate, not decoration.** The selector filters out any pattern whose consumed parts the chosen angle can't supply (a `testimonial` pattern needs `review`; an `offer` pattern needs `offer`, which cold angles never carry).
- **`awareness_stages` mirrors the temperature policy.** COLD patterns never carry an offer slot; `offer` is hot-only; `risk-reversal` spans warm/hot. This aligns with the temperature-keyed substitution policy in [[../libraries/compose-headline]].

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
