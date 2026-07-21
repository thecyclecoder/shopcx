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
- **Offer / urgency** (#5 / #6) — save, off, deal, today  *(`free shipping` removed CEO 2026-07-21 — it's a cold-allowed trust/risk-reversal element, not a deal-chase; also removed from `COLD_OFFER_TOKENS`)*

Pinned by `src/lib/ads/lf8.test.ts` (`npm run test:ads-lf8`), which asserts `hasAnyLf8` returns true for each of the four previously false-flagged creatives.

## API

- `hasAnyLf8(copyLower: string): boolean` — returns true if the lowercase copy contains **any** LF8 keyword as a substring. Used by ads-supervisor to detect drift and by `buildMetaCopy` to prefer LF8-carrying supporting benefits in the generated ad text.
- `hasColdOfferLeak(copy, allowedOffer?): boolean` — DETERMINISTIC gate the persister chokepoint (`insertReadyCreative`) runs before writing a status='ready' row. True iff the joined copy carries any `COLD_OFFER_TOKENS` whole-word hit, a discount-percent hit (`%` adjacent to an offer word), or a bare-currency hit. The optional `allowedOffer: { headline?, disclaimer? }` — OUR real `brief.offer` — allowlists our own store offer: those exact phrases are stripped from the scan text BEFORE the predicate runs, so an offer-for-offer swap (see [[debrand]] `chooseGroundedSubstitute`) that renders our real offer verbatim isn't flagged. A DIFFERENT discount (`50% off today`) still trips the gate. Absent / null → today's byte-for-byte behavior (no allowance). **Trust / risk-reversal elements are allowed on cold** (CEO 2026-07-21): `free shipping`, `money-back guarantee`, `risk-free`, and proof points never trip the gate — when Dahlia imitates an offer-led ad on cold, the [[../../../.claude/skills/dahlia-copy-author/SKILL]] rule #4 tells her to SWAP the offer slot for one of these rather than kill the ad; only a deal-chase discount (% off / $ off / save / sale / coupon / BOGO) leaks. Pin: `src/lib/ads/cold-offer-gate.test.ts`.

## Related

[[ads-supervisor]] · [[creative-brief]] · [[../inngest/ads-supervisor-cadence]] · [[../functions/growth]] · [[../specs/growth-ads-supervisor-3h-agent]]
