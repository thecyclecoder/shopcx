# libraries/ad-angles

Ad tool — Phase 0.5 angle generator. Turns a product's **structured** Product Intelligence Engine data (tiers 1-5) into direct-response ad angles anchored to PROVEN leading benefits, validates each against the anchoring contract, and persists the survivors to [[../tables/product_ad_angles]].

**File:** `src/lib/ad-angles.ts` · Model: `OPUS_MODEL` from [[ai-models]] · See [[../inngest/ad-tool]], [[ad-validator]], [[ad-tool-config]].

## Exports

### `loadAngleInputs` — function

```ts
function loadAngleInputs(productId: string): Promise<AngleGeneratorInput>
```

Hydrates every tier of the data-source contract in one parallelized pass:

| Tier | Source table | Filter |
|---|---|---|
| 1 — leading promise | `product_page_content` | latest `status='published'` by `version desc` |
| 2 — lead benefits | `product_benefit_selections` | `role='lead'` AND `science_confirmed=true` |
| 3 — ingredient science | `product_ingredient_research` joined to `product_ingredients` names | `ai_confidence >= 0.6` |
| 4 — proof quotes | `product_reviews` | `rating >= 4`, featured first |
| 5 — credibility | `product_reviews` aggregate (count + avg, published), `products` certs/awards/allergen_free, `workspaces.social_brand_proof_points` | — |
| — | isolated image + dims | `product_variants.isolated_image_url`/`physical_dimensions` (variant wins) else `products.physical_dimensions` |

### `generateAngles` — function

```ts
function generateAngles(productId: string, count = 12): Promise<GenerateAnglesResult>
// GenerateAnglesResult = { ok, inserted: ProductAdAngle[], rejected: {angle,reasons}[], reason? }
```

One Opus call with a strict JSON schema → `coerceAngle` (defensive truncation to META_CAPS) → `validateAngle` each + banned-word scan → on a non-empty survivor set, archives prior `is_active=true` rows (`is_active=false`) then inserts the fresh batch. Logs usage via `logAiUsage` (purpose `ad_angle_generation`). Banned words from `workspaces.ad_tool_settings` via `resolveAdToolSettings`, falling back to `DEFAULT_BANNED_WORDS`.

**Hero-product advertising gate ([[advertised-products]]):** the FIRST check is `isAdvertisedProduct(admin, productId)`; an attachment SKU returns `{ok:false, reason:"not_advertised"}` before the Opus call fires — 0 tokens spent on a Tumbler / Sleep-Gummies angle. This closes the upstream feeder to the Dahlia cadence (a stray `product_ad_angles` row is what would have leaked an attachment SKU into the ready-to-test bin).

## Callers

- `src/app/api/ads/angles/route.ts` — generate/list angles for a product
- `src/lib/ad-avatar-proposals.ts` — reads active angles to brief avatars
- `src/lib/inngest/ad-tool.ts` — `loadAngleInputs` reused at render time

## Gotchas

- **HARD RULE: reads ONLY structured Engine tables — NEVER `product_intelligence.content` markdown.** The whole point of the tier contract is that angles trace to validated fields, not free-form prose.
- `lead_benefit_anchor` must be **verbatim** from `benefit_bar[].text` or `lead_benefits[].name` — `validateAngle` rejects anything else (`anchor_not_verbatim`).
- Re-running archives the prior active set rather than deleting — angle history is preserved.
- Meta caps are enforced twice: client-side truncation in `coerceAngle` AND a DB CHECK backstop.

---

[[../README]] · [[../../CLAUDE]]
