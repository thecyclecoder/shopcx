# `src/lib/ads/creative-brief.ts`

The **brain of the Ad Creative Agent** (the tool that keeps [[media-buyer-agent|Bianca]]'s ready-to-test bin stocked). Grounded entirely in the [[product-intelligence]] SDK, so every claim is verifiable by construction — the reason generated creatives can **auto-feed** the bin with no human gate. See [[../reference/meta-scaling-methodology]] (angle model + price-on-static rule).

## The two-axis angle model (the anti-commodity engine)

`selectAngles(pi, transformationStories)` scores every candidate angle on **two independent axes** and ranks for a COLD/prospecting creative:

- **acquisitionPower (0–10)** — does it stop a stranger's scroll + earn the first buy? Boosted by: a specific **transformation** ("I lost 30 lbs"), an **objection/skeptic** frame (the format that won 2026-07-09), **curiosity/pattern-interrupt** ("the diet industry doesn't want you to know"), a **differentiated high-intent** benefit (weight, brain fog, cravings).
- **retentionTruth (0–10)** — does the product deliver it so well it *keeps* them? High for the loved experience benefits (energy-no-crash, taste) and high-frequency review clusters.

**The trap it exists to avoid:** *"energy without jitters / no 2pm crash"* is the **#1 review cluster** (retentionTruth ~10) but a **commodity** acquisition angle — every coffee claims it, so it converts no stranger. `COMMODITY`-matched angles are **demoted** (acquisitionPower −3) and never lead; they surface as **supporting body copy** instead. Verified 2026-07-10: for Amazing Coffee the top angles rank transformation/weight/objection/curiosity; no-crash sinks out of the top 12 and reappears only in `supportingBenefits`.

Candidates come from `product_ad_angles` (ready hooks), the biggest real transformation reviews, and review clusters (whose frequency feeds `retentionTruth`). Deduped by hook, ranked `acquisitionPower desc`.

## The fully-backed brief

`buildCreativeBrief(pi, angle, transformationStories)` → `CreativeBrief`: the hook + **leadProof** (a real review via `byClaim`, or the transformation story itself for a weight angle, or an ingredient citation) + **transformation** (real reviewer + their before/after photo) + **supportingBenefits** (the retention truths for body copy) + **proofStack** (award/certs + store selling points) + **offer** (rendered as an *allowed* price treatment — strikethrough+disclaimer or per-serving-vs-latte, **never bare MSRP**) + **imageRefs** (before/after · hero · packshot) + **guardrails** (attestations that nothing is fabricated).

## Next

The generation step (Nano Banana Pro from the brief) + QA + bin insertion + the cadence lane + the agent's persona (peer to Bianca under Max) build on this. [[../functions/growth]] · [[product-intelligence]] · [[gemini]] · [[winning-creative-detect]].
