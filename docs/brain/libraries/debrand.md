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
Pick the best substitute to replace a competitor offer we don't run. Priority (per the CEO's offer-for-offer fix note):
1. **`brief.offer`** — OUR real store offer (e.g. `Up to 34% off + free shipping` with disclaimer `with 3+ units on Subscribe & Save`). Rendered as `${headline}` or `${headline} (${disclaimer})` and returned as the swap-in — an **offer-for-offer swap** keeps the ad's persuasive OFFER POSITION intact without leading on a coupon. Free shipping + Subscribe & Save is a soft, retention-aligned offer, so it's the preferred substitute for an offer-based competitor angle.
2. Verified proof point (from `brief.proofStack`) — fallback #1 when there's no real offer.
3. Retention benefit (from `brief.supportingBenefits`).
4. Lead-proof text (from `brief.leadProof.text`).
5. Derived product feature (from `brief.productFeatures`).

Returns null when the brief carries no substitute at all — the caller then nulls `competitorDna.offer`.

**`interface GroundedSubstituteSource`**
Minimal brief shape read by `chooseGroundedSubstitute` — kept local to avoid import cycles with `creative-brief.ts`. Fields: `offer?: { headline?: string; disclaimer?: string }`, `proofStack?: string[]`, `supportingBenefits?: string[]`, `leadProof?: {text: string}`, `productFeatures?: string[]`.

## Why it exists

**Offer swap ([[../specs/swap-competitor-offer-slot-for-our-grounded-proof-benefit-or-feature-in-debrand]] Phase 1 + follow-on `debrand-offer-swap-prefers-our-real-offer-free-shipping-subscribe-and-save-offer-for-offer` Phase 1):** A competitor's offer (free tote / free gift / bonus item / discount) is often an offer we don't run. Carrying it through the debrand into Dahlia's imitation rubric causes failures downstream: the firewall rejects ungrounded freebies; the cold-offer gate refuses discounts to strangers. The fix: SWAP the offer slot — PREFERRING OUR real `brief.offer` (free shipping + Subscribe & Save — an offer-for-offer swap that keeps the ad's OFFER POSITION intact without leading on a coupon), and only falling back to a grounded proof / benefit / feature when there is no real offer. The winning STRUCTURE survives; the promise becomes either OUR real soft offer or a grounded selling point. The four functions form a two-stage defense:

1. **`buildCreativeBrief` (upstream)** in [[creative-brief]] runs `isCompetitorOffer` on the raw offer slot + hook when `angle.source === 'competitor'`, and swaps a match with `chooseGroundedSubstitute`. This is the primary site.
2. **`stockProduct` (defense-in-depth)** in [[creative-agent]] re-runs `isCompetitorOffer` + strip/swap at debrand time (lines where `debrandForOurBrand` is called) so an offer revealed only after brand-token stripping is still caught before Dahlia's session sees it.

The REAL offer (`brief.offer`, from our own pricing) is never MODIFIED by the swap — it's the preferred SUBSTITUTE the swap renders into the competitor's un-runnable offer slot. And the cold-offer gate ([[lf8]] `hasColdOfferLeak`) accepts `brief.offer` as an ALLOWED offer via its `allowedOffer` parameter, so the swapped-in real offer (which naturally carries `free shipping` / `off` / `save` LF8 tokens) is not itself flagged as a cold-audience leak. A DIFFERENT discount (`50% off today`) still trips the gate.

## Pinning

- **Unit tests** in `src/lib/ads/debrand.test.ts` pin every rule: `debrandForOurBrand` null-safety, case-insensitivity, possessive stripping, orphan-punctuation collapse; `isCompetitorOffer` freebie/discount pattern matching; `stripCompetitorOffer` structure preservation; `chooseGroundedSubstitute` priority ordering.
- **Integration tests** in `src/lib/ads/creative-brief.test.ts` (`buildCreativeBrief — a 'Free tote' competitor offer is SWAPPED …`) and `src/lib/ads/creative-agent.test.ts` (debrand-time re-check) pin the two-stage defense.
