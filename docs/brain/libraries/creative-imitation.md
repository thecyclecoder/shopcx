# `src/lib/ads/creative-imitation.ts`

The **verify-then-reword** surface for Dahlia's competitor-ad adaptation loop
(dahlia-competitor-ad-adaptation-overlay-render Phase 2). The [[never-fabricate]] firewall stops
fabrication (rail 1); this module adds the **positive-adaptation instinct** — for each benefit in
the competitor's proven angle, VERIFY the analogous benefit exists on OUR product with
`customer_confirmed=true` and REWORD it from a real `customer_phrase` (never reinvent, never
invent). Substitute a genuinely-lacked benefit with a DIFFERENT confirmed one. See
[[../reference/competitor-ad-adaptation]] Part 1 (Copy adaptation) for the worked SpoiledChild →
Amazing Creamer trace this module generalizes.

Pure + deterministic — no I/O. Consumed by:

- [[creative-brief]] `buildCreativeBrief` — populates `brief.confirmedBenefits` from `pi.benefits` via `selectConfirmedBenefits(pi)`; appends a `verify-then-reword` guardrail line when the angle is a competitor imitation and the catalog is non-empty.
- [[../../../.claude/skills/dahlia-copy-author/SKILL.md]] IMITATE-DEBRANDED § **VERIFY-THEN-REWORD** — reads `brief.confirmedBenefits` as the source of truth for the keep-vs-substitute decision and picks a reword from the row's `softPhrasings` (verbatim `customer_phrases`).

## Exports

- **`ConfirmedBenefit`** — `{ benefitName, softPhrasings, role }`. `role` is `'lead'` or `'supporting'` (from `product_benefit_selections.role`); `softPhrasings` are the row's real `customer_phrases`, so Dahlia's reword is grounded by construction.
- **`selectConfirmedBenefits(pi) → ConfirmedBenefit[]`** — filters `pi.benefits` where `customer_confirmed === true` AND role ∈ {lead, supporting}. Preserves the display order.
- **`benefitDimensionOf(text) → Dimension | null`** — pure classifier over the deterministic dimension lexicon (`skin · hair · weight · appetite · digestion · sleep · focus · energy · immunity · mood · joint`). Unknown text returns `null` (each unknown gets its own bucket in `hasDiverseBenefitStack` — no silent collapse). The lexicon covers the SpoiledChild worked example verbatim (`smooth wrinkles` / `plump skin` → `skin`; `your pants size might shrink` / `feel lighter` → `weight`; `curb cravings` → `appetite`; `reduce bloating` → `digestion`).
- **`hasDiverseBenefitStack(benefits) → boolean`** — pure predicate for Part 1 § "Diverse benefit stack" rule: two beats on the same dimension (`skin × 2`) collapse and fail. Amazing Creamer's `[Skin Health, Hair Health, Weight Management, Digestive Health]` passes; SpoiledChild's `[skin, skin, appetite, digestion]` fails.
- **`matchConfirmedBenefit(competitorClaim, confirmed) → ConfirmedBenefit | null`** — the analogous-benefit matcher. Pass 1 = shared dimension via `benefitDimensionOf` (prefers a `role='lead'` hit on a tie); Pass 2 = substring / token overlap on the confirmed benefit name or a customer phrase (catches novel-dimension matches the lexicon doesn't know). Returns `null` when nothing is analogous — the SKILL then knows to **SUBSTITUTE** a different confirmed benefit rather than carry the competitor's claim over unverified.
- **`OFFER_SUBSTITUTE_RISK_FREE`** — the verbatim sanctioned CTA when a competitor offer is substituted: `"Try It Risk-Free — 30-day money-back guarantee"`. Company-wide `proofStack` fact; `try it risk-free` is sanctioned verbiage in the SKILL.
- **`enforceOfferFidelity(competitorCta) → { needsSubstitute, reason, substitute }`** — pure check. Fires on `try before you buy` / `free trial` / `free sample` / `no-payment trial` / `bogo` / `get one free` / `free tote` / `free gift` / `bonus item` / `GWP` / `giveaway` — any offer we don't run. Substitute string is always `OFFER_SUBSTITUTE_RISK_FREE`; reason names which offer tripped it so the SKILL can cite it in the revise reason.

## Callers

- [[creative-brief]] `buildCreativeBrief` — the `confirmedBenefits` field lands on every brief; the `verify-then-reword` guardrail lands on competitor-source briefs.
- [[../../../.claude/skills/dahlia-copy-author/SKILL.md]] IMITATE-DEBRANDED §§ **VERIFY-THEN-REWORD · DIVERSE BENEFIT STACK · OFFER FIDELITY · ANCHOR TO CORE VALIDATED BENEFITS**.

## Tests

`src/lib/ads/creative-imitation.test.ts` pins the four pure surfaces:

- `selectConfirmedBenefits` keeps only `customer_confirmed=true` rows in the eligible roles, drops empty benefit names, and handles missing `customer_phrases`.
- `benefitDimensionOf` classifies every worked-example token from Part 1 into its dimension; unknown text returns `null`.
- `hasDiverseBenefitStack` passes on Amazing Creamer's four-distinct stack and fails on SpoiledChild's `skin × 2` collapse.
- `matchConfirmedBenefit` maps SpoiledChild's four benefits onto Amazing Creamer's confirmed catalog 1:1; prefers a `role='lead'` hit on a tie; returns `null` when the competitor's benefit has no analogous confirmed one (SUBSTITUTE signal).
- `enforceOfferFidelity` fires on every offer-we-don't-run pattern and passes through a benign `Shop Now` unchanged.

## Related

- [[../reference/competitor-ad-adaptation]] Part 1 (the copy-adaptation methodology this module generalizes)
- [[creative-brief]] (where `confirmedBenefits` lands + the `verify-then-reword` guardrail)
- [[../../../.claude/skills/dahlia-copy-author/SKILL.md]] IMITATE-DEBRANDED (the consumer)
- [[never-fabricate]] (the DON'T-fabricate firewall this module's DO-keep-the-winning-structure rule pairs with)
