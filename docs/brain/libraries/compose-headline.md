# `src/lib/ads/compose-headline.ts`

The v3 **authoring core**: **Angle × Pattern → Headline.** Fills a headline pattern's STRUCTURE (from [[headline-patterns]]) with an angle's raw parts (from [[angle-palette]]) via an inline Claude (Opus) call, honoring the temperature, the evidence tier, the offer-substitution policy, our voice, and Meta's 40-char cap — never fabricating.

**The 5 caption variations = call this once per pattern on the same angle.** The inline Claude call uses the standard messages-endpoint pattern (`OPUS_MODEL` + `withAnthropicRetry` + `logAiUsage`).

## What it honors (the four rails in the prompt)

- **Temperature (awareness stage) gates the offer.** `cold` → NO offers, discounts, prices, "free", or urgency — a stranger ignores a discount; build intrigue + value + proof, and if the pattern implies an offer slot, fill it with risk-reversal (guarantee) or a value/proof point instead. `warm`/`hot` → MAY use our REAL offer (`realOffer`, from `getProductIntelligence.offer`) or a money-back/value framing. **Never invent an offer or number.** This is the temperature-keyed substitution policy.
- **`evidenceTier` as a proof STYLE, never a filter.** `customer_only` → lead with the customer review/experience, do NOT state a clinical claim as fact. `science_modest` → may reference the mechanism/a directional result, keep claims measured (a real customer phrase is stronger). `science_strong` → the stat/proof is fair to cite plainly.
- **Voice.** Plain text, contractions, NO em-dashes, no markdown, mirror how a real customer talks.
- **No fabrication.** Only what THE ANGLE gives — enemy / mechanism / outcome / proof — plus up to 4 `brandProofPoints`. The Meta headline cap is 40 chars (`META_HEADLINE_CAP`).

## Types

- `ComposeHeadlineInput` = `{ workspaceId, productTitle, angle: ProductAngle, pattern: HeadlinePattern, temperature: AwarenessStage, brandProofPoints: string[], realOffer?: string | null }`.
- `ComposedHeadline` = `{ headline, primaryText, usedParts: string[] }` — `usedParts` is a light provenance trace of which angle-parts the model reported using.

## Exports

- **`composeHeadline(input: ComposeHeadlineInput)` → `Promise<ComposedHeadline | null>`** — builds the prompt (`buildPrompt`, private), calls Opus once, parses the JSON `{headline, primary_text, used_parts}`. Returns `null` when `ANTHROPIC_API_KEY` is absent or the model returns no parseable headline. Logs usage under `purpose: "compose_headline"`. The returned `headline` is soft-clamped to `META_HEADLINE_CAP + 20`; the **hard** 40-char cap is enforced downstream by the [[media-buyer-publish-gate]] / bin-insert gate.

## Callers / purpose

- The v3 authoring step: for a selected `(angle, pattern, temperature)`, `composeHeadline` produces the headline + primary text; call it once per pattern to fan the 5 variations on one angle.
- `angle` comes from [[angle-palette]] `listAnglePalette`; `pattern` from [[headline-patterns]] `listHeadlinePatterns`; `brandProofPoints` + `realOffer` from the [[product-intelligence]] chokepoint (`store.brandProofPoints`, `.offer`).
- Downstream: the composed copy feeds the render + the [[media-buyer-publish-gate]], which enforces the hard char cap and the cold-offer-leak rail before the ad reaches Meta; the posted [[../tables/ad_campaigns]] row is stamped with `{theme, angle_id, pattern_id, combination_id}` for the attribution rollup.

## The v3 model (where this sits)

Full closed loop: **SEED** (manual, once per hero product — [[angle-palette]]) → **SELECT** (theme-spread + demand-weighted gap-fill + fresh legal pattern, filtering [[../tables/ad_creative_combinations]] on cooldown) → **AUTHOR** (`composeHeadline`) → **MAX** (substitution supervisor) → **POST** (stamped) → **MEASURE** → **ATTRIBUTE** (factor rollup by theme/angle/pattern/combination with a significance gate) → **RE-WEIGHT** → SELECT. Demand seeds the priors; performance updates them.

## Gotchas

- **`composeHeadline` returns `null`, doesn't throw, when the API key is absent** — callers must handle the null (no key on some box lanes). It also returns `null` on an unparseable model response, so treat null as "no headline this pass," not an error.
- **The 40-char cap here is soft.** `composeHeadline` clamps to `+20` as a guard; the real ceiling is enforced by the publish gate. Don't assume the returned string is already Meta-legal.
- **`realOffer` is ignored on cold.** Passing an offer for a cold temperature does nothing — the prompt hard-strips it. Keep the offer for warm/hot, and make sure it's the REAL Max-verified offer, never a fabricated one.
- **Provenance, not enforcement.** `usedParts` is what the MODEL reported; it's a trace for debugging/attribution, not a validated grounding proof. The firewall/QC gates downstream do the real grounding checks.

[[angle-palette]] · [[headline-patterns]] · [[../tables/product_angle_palette]] · [[../tables/ad_headline_patterns]] · [[../tables/ad_creative_combinations]] · [[product-intelligence]] · [[creative-brief]] · [[media-buyer-publish-gate]] · [[../README]] · [[../../CLAUDE]]
