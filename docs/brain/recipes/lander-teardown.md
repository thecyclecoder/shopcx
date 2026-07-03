# Turn a worthy lander into a structured teardown recipe

Rhea's Phase-2 same-session pass: after she classifies a captured URL as **worthy**, she REUSES the chapter shots already in context (no re-render — [[lander-capture]] ran ONCE) and reverse-engineers the funnel into a `TeardownRecipe` — the artifact **Cleo consumes** to spec a build (slice 3 — gap analysis → build blueprint). Live implementations: [[../libraries/research-urls]] `setTeardown` (the write chokepoint + validator) · [[../libraries/builder-worker]] `runResearchJob` (the driver) · `.claude/skills/research/SKILL.md` (Rhea's persona + the exact instruction). Spec: [[../specs/rhea-teardown-recipe]] · Sibling capture recipe: [[lander-capture]].

## Model

1. **Preconditions — worthy, only worthy.** The recipe pass runs only when Rhea's verdict for the URL is `worthy`. Skip entirely for `not_worthy`, `spam`, `unviewable`. Cleo has nothing to gap-analyze on a bare PDP; storing an empty recipe would just confuse the diff.
2. **One session, no re-render.** Rhea works from the SAME chapter screenshots the box worker captured (mobile Playwright + geometric overlay-kill + DOM-first `<section>` chaptering, or the vision-tile fallback — [[lander-capture]]). She does not fire a second Playwright job. The one-session invariant is what makes this cheap — the batch stays under the Max session budget.
3. **Read the ordered chapters top-to-bottom.** For each chapter, pin ONE `chapter_role` (hero, intro_proof, reasons_1..N, recap, offer, faq, testimonials, …) + a one-line `purpose`. That ordered list IS the `architecture`.
4. **Reason sequence — populate only for listicles.** If the lander is a `k`-reason listicle (or a `k`-step story), record each item as `{ order, benefit, appeal ∈ emotion|logic, mechanism }`. Emotion opens the sequence, logic carries the middle, transformation closes the CTA. For non-listicles (quiz, generic funnel), leave `reason_sequence` unset.
5. **Levers — evidence-first, vocab-locked.** For every persuasion lever you spot, emit `{ lever, evidence }`. `lever` MUST be one of the SDK's vocabulary: `authority | social_proof | ugc | urgency | price_anchor | risk_reversal | value_stack | objection_handling | specificity | bandwagon | choice_simplicity`. `evidence` is the CONCRETE beat you saw (e.g. `"'50,000+ happy customers' + testimonials chapter at the end"`), not a summary. New lever tags require a spec change — the vocab is stable on purpose so Cleo can gap-analyze.
6. **Offer — parse the offer chapter into pieces.** `discount` (`"60% off"`), `bundle` (`"product + free starter kit"`), `bonuses` (`["free starter kit", "digital routine guide"]`), `guarantee` (`"45-day money-back"`), `urgency` (`"24-hour countdown timer"`), `options` (the count of purchase paths — 1 = single option, the erthlabs default; a subscription-vs-onetime pair = 2; a bundle picker with 4 SKUs = 4). `options` is the discipline signal — a narrow offer beats a paradox-of-choice wall.
7. **`transferable_pattern` — write the product-agnostic skeleton.** One paragraph describing WHAT the funnel does, stripped of the specific product/claim, so Cleo can port it to Superfoods. E.g. `"authority-hero → mechanism proof → 8 numbered reasons (emotion → logic → transformation) → recap → narrow single-CTA offer with countdown + guarantee → FAQ → testimonials."` A one-sentence "it works" is NOT enough — the pattern is the recipe.
8. **Persist via `setTeardown`.** The worker (`runResearchJob`) calls [[../libraries/research-urls]] `setTeardown(workspace, id, recipe)` — which runs `validateTeardownRecipe` first (rejects empty `architecture`, empty `levers`, missing `transferable_pattern`, unknown lever tag, missing `funnel_type` / `strategy`, malformed `reason_sequence` entries, non-positive `offer.options`). A half-formed recipe throws before the row is touched; the classification + verdict still landed, so the row is not left inconsistent.

## Worked example — `learn.urthlabs.com/reasons` (the '8 reasons' advertorial)

The hand-run teardown of the erthlabs advertorial. This is the model recipe every automated pass is measured against.

### What Rhea saw

The [[lander-capture]] pass DOM-first-chaptered the page into 14 sections (`hero` → `intro_proof` → `reasons_1` … `reasons_8` → `recap` → `offer` → `faq` → `testimonials`). Hero cites clinical study + logo bar (Vogue, Byrdie). Founder-paragraph chapter 2 (`intro_proof`). Reasons chapters 3-10 walk the reader from emotion (`"you deserve to feel this good"`) → logic (numeric specificity, comparison to legacy option) → transformation (`"the you you've been waiting for"`) — a `50,000+ happy customers` beat lands mid-sequence. Recap consolidates the 8 reasons; the offer chapter stacks a `60% off` discount + free starter kit + digital routine guide + `45-day money-back` guarantee + a live countdown timer, funneling to a SINGLE CTA. FAQ handles objections ("is it safe for sensitive skin", "when will I see results"). Testimonials close as a wall of UGC.

### The recipe (as JSON — the exact shape `setTeardown` accepts)

```json
{
  "funnel_type": "advertorial-listicle",
  "strategy": "Reasons-list advertorial: authority hero + a founder proof beat, then 8 numbered reasons ordered emotion-first → logic → transformation, recapped and funneled to a single narrow-offer CTA with post-CTA FAQ + testimonials.",
  "architecture": [
    { "chapter_role": "hero", "purpose": "big promise + authority frame (headline claim + logo bar)" },
    { "chapter_role": "intro_proof", "purpose": "founder / mechanism paragraph establishing credibility" },
    { "chapter_role": "reasons_1", "purpose": "reason 1 (emotion opener — 'you deserve this')" },
    { "chapter_role": "reasons_2", "purpose": "reason 2 (social proof)" },
    { "chapter_role": "reasons_3", "purpose": "reason 3 (mechanism / why-it-works)" },
    { "chapter_role": "reasons_4", "purpose": "reason 4 (comparison to legacy option)" },
    { "chapter_role": "reasons_5", "purpose": "reason 5 (specificity — numbers / clinical badge)" },
    { "chapter_role": "reasons_6", "purpose": "reason 6 (UGC / before-after)" },
    { "chapter_role": "reasons_7", "purpose": "reason 7 (objection handling)" },
    { "chapter_role": "reasons_8", "purpose": "reason 8 (transformation payoff)" },
    { "chapter_role": "recap", "purpose": "one-page summary of the 8 reasons" },
    { "chapter_role": "offer", "purpose": "narrow offer stack + single CTA + live countdown" },
    { "chapter_role": "faq", "purpose": "objection-handling Q&A block" },
    { "chapter_role": "testimonials", "purpose": "closing wall of UGC social proof" }
  ],
  "reason_sequence": [
    { "order": 1, "benefit": "you deserve to feel this good", "appeal": "emotion", "mechanism": "hook via unmet-desire framing" },
    { "order": 2, "benefit": "50,000 happy customers", "appeal": "logic", "mechanism": "quantified social proof" },
    { "order": 3, "benefit": "clinically-studied active", "appeal": "logic", "mechanism": "authority + specificity" },
    { "order": 4, "benefit": "not the drugstore version", "appeal": "logic", "mechanism": "comparison / anti-competitor" },
    { "order": 5, "benefit": "3× the potency", "appeal": "logic", "mechanism": "numeric specificity" },
    { "order": 6, "benefit": "her skin cleared in 14 days", "appeal": "emotion", "mechanism": "UGC before/after" },
    { "order": 7, "benefit": "won't clog pores", "appeal": "logic", "mechanism": "objection handling" },
    { "order": 8, "benefit": "the you you've been waiting for", "appeal": "emotion", "mechanism": "transformation payoff → CTA" }
  ],
  "levers": [
    { "lever": "authority",          "evidence": "hero cites clinical study + logo bar (Vogue, Byrdie)" },
    { "lever": "social_proof",       "evidence": "'50,000+ happy customers' + testimonials chapter at the end" },
    { "lever": "ugc",                "evidence": "before/after selfies in reasons_6 + testimonials chapter" },
    { "lever": "urgency",            "evidence": "live countdown timer on the offer chapter (~24h)" },
    { "lever": "price_anchor",       "evidence": "'$120 value' struck through above the discount price on the offer chapter" },
    { "lever": "risk_reversal",      "evidence": "45-day money-back guarantee stamped above the CTA" },
    { "lever": "value_stack",        "evidence": "offer chapter lists product + free starter kit + guide bundled at one price" },
    { "lever": "objection_handling", "evidence": "FAQ chapter directly answers 'is it safe for sensitive skin' / 'when will I see results'" }
  ],
  "offer": {
    "discount": "60% off",
    "bundle": "product + free starter kit",
    "bonuses": ["free starter kit", "digital routine guide"],
    "guarantee": "45-day money-back",
    "urgency": "24-hour countdown timer",
    "options": 1
  },
  "transferable_pattern": "authority-hero → mechanism proof → 8 numbered reasons (emotion → logic → transformation) → recap → narrow single-CTA offer with countdown + guarantee → FAQ → testimonials. Port by swapping the ingredient/claim and rewriting reasons around our benefit tree; keep the single-option offer chapter (options=1) and the risk-reversal + urgency + value-stack combo intact."
}
```

Use it as a **shape reference**, not a template — every worthy lander gets its own recipe from its own chapters. The point is the STRUCTURE: architecture ordered top-to-bottom, levers each carrying concrete evidence, offer parsed into its pieces, `transferable_pattern` a real product-agnostic skeleton.

## Gotchas

- **Worthy only.** Not_worthy / spam / unviewable landers get NO recipe. Cleo's diff on an empty skeleton produces noise.
- **One session, no re-render.** The recipe MUST come from the chapters already in Rhea's context. A second Playwright pass blows the budget and duplicates the storage bill.
- **`levers[].evidence` is a beat, not a summary.** `"good social proof"` is not evidence. `"'50,000+ happy customers' + testimonials chapter at the end"` is. Cleo relies on the evidence string to know whether we have the same lever running.
- **`offer.options` is not free-text.** It's a positive integer count of purchase paths on the offer chapter. `1` for a single narrow CTA (the erthlabs default); `2` for a subscription-vs-onetime pair; more for a bundle picker.
- **Extending `TeardownLever` needs a spec change.** The vocabulary is a Cleo contract. Adding `"exclusivity"` mid-pass would break the gap-analysis diff.
- **A half-formed recipe throws in the SDK.** `setTeardown` runs `validateTeardownRecipe` first; the worker counts a rejected recipe in `log_tail` (`teardowns=<n>/rejected=<n>`) but the classification + verdict still land — the row is not left half-written on the recipe alone.
- **This recipe is Cleo's INPUT, not her output.** Slice 3 (Cleo) is the diff-vs-storefront + build-blueprint pass. The teardown is what she reads; she does not write it.

## Consumed by

- [[../functions/growth]]'s **Cleo** — slice 3 of [[../goals/acquisition-research-engine]]. Reads the `teardown` recipes for the workspace, diffs the levers + architecture + offer against our storefront, and emits a build blueprint (the specific gaps to close).
- Owner-facing Growth queue (later) — a UI over the `research_urls` rows that renders the recipe alongside the chapter shots for human review.

## Related

[[../specs/rhea-teardown-recipe]] · [[../specs/rhea-url-sensor]] · [[../goals/acquisition-research-engine]] · [[../tables/research_urls]] · [[../libraries/research-urls]] · [[lander-capture]] · [[../libraries/builder-worker]] · [[../libraries/landing-page-scout]] · [[../inngest/acquisition-research-cadence]] · [[../functions/growth]]
