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

## API

- `hasAnyLf8(copyLower: string): boolean` — returns true if the lowercase copy contains **any** LF8 keyword as a substring. Used by ads-supervisor to detect drift and by `buildMetaCopy` to prefer LF8-carrying supporting benefits in the generated ad text.

## Related

[[ads-supervisor]] · [[creative-brief]] · [[../inngest/ads-supervisor-cadence]] · [[../functions/growth]] · [[../specs/growth-ads-supervisor-3h-agent]]
