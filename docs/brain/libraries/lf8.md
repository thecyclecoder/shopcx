# `src/lib/ads/lf8.ts`

The **single source of truth** for the Life-Force-8 keyword list + membership check, shared by two critical surfaces so they cannot drift:

- [[ads-supervisor]] **live-ad QA** (`live_ad_lf8_thin` finding — detects a live creative whose headline / primary text carries none of these terms)
- [[creative-brief]] **`buildMetaCopy`** (biases the generated caption toward an LF8-adjacent benefit so Dahlia's creatives satisfy the ads-supervisor gate **by construction**, not repair)

Kept in ONE place so the gate and the generator can't diverge — a divergence would let Dahlia publish copy the supervisor immediately re-flags as thin.

## The keyword set

**Life-Force-8** (Dr. Whitman): eight broad categories of human motivation. One-token lowercase forms so a substring scan hits without a natural-language pass. Broadly-appealing terms only; the point is to catch a live ad whose copy has NONE of these (i.e. reads like a feature dump rather than a benefit-driven acquisition ad). For Amazing Coffee specifically, the top acquisition angles are transformation / weight / objection / curiosity; a live ad with zero LF8 language reads as a missed opportunity.

Exported as `LF8_KEYWORDS: readonly string[]`:

1. **Survival / enjoyment of life / life extension** — energy, sleep, health, life, years, longevity, vitality, focus, clarity, wake
2. **Enjoyment of food/drink** — delicious, taste, flavor, coffee, morning, drink
3. **Freedom from fear/pain/danger** — crash, safe, protect, calm, relief, stress, anxiety, worry
4. **Sexual companionship** — (largely off-brand for the coffee vertical; kept out)
5. **Comfortable living** — easy, smooth, effortless, comfortable
6. **To be superior / win** — boost, beat, power, better, unlock, peak, sharper
7. **Care and protection of loved ones** — family, kids, loved, share
8. **Social approval** — trust, proven, loved by, customers, reviews

### Broadened desire clusters (added after the four false-flagged live ads)

The original vocabulary was coffee/energy-centric and omitted whole Life-Force-8 desire clusters, so weight-loss transformation copy ("i lost 40+ pounds") and beauty/health copy ("skin, hair, and joints") scored zero — the ads-supervisor false-flagged four live winners in a single 3h pass (adsets `120252355815780184`, `120252360719940184`, `120252360719970184`, `120252363256660184`). These clusters are now part of the shared list; the gate and the generator both pick them up automatically:

- **Weight-loss / body-transformation** (#1 / #5 / #6 / #8) — weight, pounds, lbs, lost, slim, lean, shed, appetite, craving, transformation, fit
- **Beauty / appearance** (#1 / #8) — skin, hair, nails, glow, collagen, youthful, radiant
- **Immunity / digestion** (#1 / #3) — immune, immunity, gut, digestion, bloat, gut health
- **Mood / wellness** (#1 / #3) — mood, happy, balance, wellness, thrive
- **Offer / urgency** (#5 / #6) — save, off, deal, today  *(`free shipping` removed CEO 2026-07-21 — a cold-allowed trust/risk-reversal element, not a deal-chase; also removed from `COLD_OFFER_TOKENS`. NB: these tokens gate NOTHING on the cold path as of CEO 2026-08-17 — see the retirement note below.)*

Pinned by `src/lib/ads/lf8.test.ts` (`npm run test:ads-lf8`), which asserts `hasAnyLf8` returns true for each of the four previously false-flagged creatives.

## API

- `hasAnyLf8(copyLower: string): boolean` — returns true if the lowercase copy contains **any** LF8 keyword as a substring. Used by ads-supervisor to detect drift and by `buildMetaCopy` to prefer LF8-carrying supporting benefits in the generated ad text.
- `coldOfferLeakMatch(copy, allowedOffer?): ColdOfferLeakMatch | null` — the TWO MECHANICAL cold rails, and nothing else. Returns the first match as `{ pattern: 'discount_percent' | 'bare_price', excerpt }` — the literal offending text — or `null` when clean. Only a printed price (`$29`) and a discount percentage (`50% off`, `save 40%`) qualify, because those are deal-chase in every context and need no judgement. The optional `allowedOffer: { headline?, disclaimer? }` — OUR real `brief.offer` — allowlists our own store offer: those exact phrases are stripped from the scan text BEFORE the rails run, so an offer-for-offer swap (see [[debrand]] `chooseGroundedSubstitute`) that renders our real offer verbatim isn't flagged. A DIFFERENT discount still trips. The `excerpt` is what makes the ONE sanctioned revise actionable — see [[creative-agent]] `runCopyAuthorSession`, which quotes it back to Dahlia instead of the old bare `cold_offer_leak`. Pin: `src/lib/ads/lf8.test.ts`, `src/lib/ads/cold-offer-gate.test.ts`.
- `hasColdOfferLeak(copy, allowedOffer?): boolean` — boolean form of `coldOfferLeakMatch`, kept for callers that only branch ([[copy-validator]] `checkColdOfferGate`, `insertReadyCreative`). Prefer `coldOfferLeakMatch` anywhere the reason reaches an author or an operator.

### ⚠️ The whole-word token ban is RETIRED (CEO 2026-08-17)

`COLD_OFFER_TOKENS` is **advisory only** — a hint list handed to the reasoning layer. It gates nothing, and re-wiring it into a predicate is a regression (pinned by the "COLD_OFFER_TOKENS is ADVISORY" test in `cold-offer-gate.test.ts`, which asserts every token individually fails to block).

**Why.** The gate used to hard-fail any cold caption containing `save · off · deal · today · sale · discount · coupon · promo · clearance · bogo` as a whole word. That rejected ordinary English — "takes the edge **off** around 3pm", "**deal** with the afternoon crash", "you won't feel it **today**", "**save** your energy for what matters" — while the author prompt simultaneously requires SIX long-form three-paragraph captions per emit (canonical + five framework variations), so a clean pass was unlikely. Worse, the revise reason was the bare string `cold_offer_leak`, which never named the offending word, so Dahlia's single sanctioned revise was a guess. Same class as the 2026-07-17 `"coffee".includes("off")` bug: word boundaries fixed false SUBSTRINGS but not false MEANINGS.

**Who decides now.** Whether a sentence *pitches an offer* is semantic, so it belongs to the AI session that exists to make that call: Max's `no_cold_offer` hard gate in [[../../../.claude/skills/max-copy-qc/SKILL]], which already bounced Dahlia to a copy-only revise on a fail — the token ban was both redundant with it and stricter. Trust / risk-reversal elements remain explicitly allowed on cold (CEO 2026-07-21): `free shipping`, `money-back guarantee`, `risk-free`, proof points. This is the north-star shape — a bounded mechanical rail under an objective-owner's judgement, not a proxy pretending to be one.

## Related

[[ads-supervisor]] · [[creative-brief]] · [[../inngest/ads-supervisor-cadence]] · [[../functions/growth]] · [[../specs/growth-ads-supervisor-3h-agent]]
