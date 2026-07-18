# `src/lib/ads/debrand.ts`

Strip competitor brand tokens and swap unrunnable competitor offers for grounded selling points. Pure, testable, and null-safe — the core of the offer-swap defense that keeps Dahlia's imitation rubric grounded when the winning angle comes from a rival.

## Exports

**`debrandForOurBrand(text, competitorAdvertiser, ourBrand) → string`**
Strip a competitor's brand + product tokens from a debranded slot so Dahlia can reuse the winning structure without echoing the rival's brand marks. Null-safe. Rules: (a) tokenizes competitorAdvertiser on whitespace, keeps tokens ≥3 chars, drops a hardcoded product-name allowlist (`coffee`, `tea`, `mud`, `drink`, `creamer`, `matcha`) so benign tokens in the advertiser name never over-strip; (b) each remaining token is deleted case-insensitively as a whole word (manual boundary check — handles special chars like `/` in `MUD/WTR`); (c) also strips possessive suffix (`'s` / `'s`) on the same tokens; (d) collapses whitespace, trims, and removes orphan punctuation. Returns text unchanged when empty or competitorAdvertiser is null.

**`isCompetitorOffer(text) → boolean`**
Detector for competitor-offer phrasing: free-gift/free-tote/bonus-item/giveaway or a discount (percent-off, $-off, free-shipping, BOGO, "X for $Y"). Returns true if text carries any offer-like pattern. Null-safe.

**`stripCompetitorOffer(text) → string`**
Remove every competitor-offer phrase from text, collapse orphan separators/whitespace, and trim orphan punctuation. Preserves structural words that carry the winning STRUCTURE — e.g. `"Free tote badge with product held up outdoors"` → `"with product held up outdoors"`. Null-safe; returns empty string unchanged.

**`chooseGroundedSubstitute(brief) → string | null`**
Pick the best grounded selling point to replace a competitor offer we don't run. Priority: verified proof point (from `brief.proofStack`) → retention benefit (from `brief.supportingBenefits`) → lead-proof text (from `brief.leadProof.text`) → derived product feature (from `brief.productFeatures`). Returns null when the brief carries no grounded substitute — the caller then nulls `competitorDna.offer`.

**`interface GroundedSubstituteSource`**
Minimal brief shape read by `chooseGroundedSubstitute` — kept local to avoid import cycles with `creative-brief.ts`. Fields: `proofStack?: string[]`, `supportingBenefits?: string[]`, `leadProof?: {text: string}`, `productFeatures?: string[]`.

## Why it exists

**Offer swap ([[../specs/swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand]] Phase 1):** A competitor's offer (free tote / free gift / bonus item / discount) is often an offer we don't run. Carrying it through the debrand into Dahlia's imitation rubric causes failures downstream: the firewall rejects ungrounded freebies; the cold-offer gate refuses discounts to strangers. The fix: SWAP the offer slot for one of OUR grounded selling points (a proof point, a benefit, or a product feature) so the winning STRUCTURE survives but the promise becomes grounded. The four functions form a two-stage defense:

1. **`buildCreativeBrief` (upstream)** in [[creative-brief]] runs `isCompetitorOffer` on the raw offer slot + hook when `angle.source === 'competitor'`, and swaps a match with `chooseGroundedSubstitute`. This is the primary site.
2. **`stockProduct` (defense-in-depth)** in [[creative-agent]] re-runs `isCompetitorOffer` + strip/swap at debrand time (lines where `debrandForOurBrand` is called) so an offer revealed only after brand-token stripping is still caught before Dahlia's session sees it.

The REAL offer (`brief.offer`, from our own pricing) is never touched — only the competitor's un-runnable offer is swapped.

## Pinning

- **Unit tests** in `src/lib/ads/debrand.test.ts` pin every rule: `debrandForOurBrand` null-safety, case-insensitivity, possessive stripping, orphan-punctuation collapse; `isCompetitorOffer` freebie/discount pattern matching; `stripCompetitorOffer` structure preservation; `chooseGroundedSubstitute` priority ordering.
- **Integration tests** in `src/lib/ads/creative-brief.test.ts` (`buildCreativeBrief — a 'Free tote' competitor offer is SWAPPED …`) and `src/lib/ads/creative-agent.test.ts` (debrand-time re-check) pin the two-stage defense.
