# recipes/growth-funnel-reading — the Growth Director's funnel-reading playbook

**What this is:** Max's **interpretation playbook** — how to read the two storefront-funnel SDKs and what to act on. NOT a [[../functions/growth]] *mandate* (a mandate is the standing objective — "Storefront CRO"); this *operationalizes* that mandate. It is the runtime decision-guidance the **Growth Director** (and its sub-agents) follows, destined to bake into the [[../libraries/growth-director]] agent. Lives under Growth's **Storefront CRO** mandate.

> Status: v1 (2026-06-30) — seeded from the funnel-tree + chapter-diagnostics build. Tells Max **how to interpret results + what to look for**. Grows as the SDKs grow.

## The two SDKs ([[../libraries/funnel-tree]])

- **`computeFunnelTree` — the "WHAT".** Per **product → PDP vs All Landers → variant → angle**, sliceable by **Product × Source × Referrer**. Metrics per node: visits, engagement %, pack/checkout, **CVR** (order/visit). Answers *which destination/traffic performs*.
- **`computeChapterDiagnostics` — the "WHY".** Per **destination**, the chapter sequence in page order: **carry-to-pricing %**, **close % (pricing→pack)**, reach-by-placement, **CTA-origin** (which chapter earns the pricing click), dwell, view→pack. Answers *why a destination converts or doesn't*.

## How to interpret (the mental model)

1. **Conversion is TWO independent levers, not one.** Diagnose which is weak:
   - **Carry-to-pricing %** (engagement) — does the sequence get people to the decision?
   - **Close % (pricing→pack)** (offer) — do pricing-reachers actually buy?
   A destination can be great at one and poor at the other. *(Real example: the Listicle carries ~2× the bare PDP to pricing but closes at ~half the rate — more engaging, fewer packs.)*
2. **Reaching pricing is the gate.** Pack-rate is ~0.2% without it, ~11% with it (~70×). The destination's job is to *carry people to pricing*; the offer's job is to *close them there*.
3. **Most pricing arrivals are CTA jumps (~72%), not full reads.** Jumpers and scroll-readers close at ~the same rate (≈11% vs ≈10%). So "reached pricing" ≈ "earned the CTA click."
4. **Pack vs chapters-read is U-shaped, NOT linear.** Shallow hero→pricing jumpers (~13%) and deep readers (~18%) both convert well; the **3–4-chapter middle is the trough (~7%)**. Do **not** treat "more chapters read" as a virtue.
5. **CTA-origin = persuasion attribution.** The chapter the pricing-click fires *from* is what did the selling (the hero is usually the workhorse, ~60%). A chapter viewed a lot but originating ~0 clicks is filler.
6. **Dwell = attention, never a goal on its own.** Read it *with* progression: high dwell + low onward-progression = holds attention but doesn't move people (rewrite); low dwell + high CTA-origin = punchy (protect).

## What to look for → the directive it implies

| Pattern in the data | What it means | Directive (Max → agent; Ada builds) |
|---|---|---|
| Destination with **low carry-to-pricing** | the sequence leaks before pricing | find the chapter where **reach craters** (reach-by-placement) → fix or move that chapter |
| **High carry, low close** | content works, the **offer/pricing** doesn't | rework the pricing/offer chapter for *this* traffic |
| Chapter with **high reach, ~0 CTA-origin, low dwell** | filler | cut it or push it down the page |
| Chapter with **high CTA-origin sitting late** (high index) | persuader buried | move it **earlier** in the sequence |
| The **3–4-chapter middle** that reaches pricing but doesn't pack | the recoverable lukewarm segment | tighten the path from mid-page to pricing/offer |

## Guardrails (what NOT to conclude)

- **Engagement ≠ closing.** Never rank destinations by carry/engagement alone — judge on **CVR / pack**.
- **Don't penalize shallow jumps.** hero→pricing jumps convert fine; they're decisive buyers, not low quality.
- **Don't read pack↔checkout 100% as a win** — it's structural (the customize page is optional; checkout_view is the reliable signal).
- **Mind small cells.** Pack counts are in the tens; treat single-destination/angle gaps under ~2σ as **directional**, and lean on bigger windows before acting on an angle.
- **Hit a rail → escalate, don't silently optimize a proxy** ([[../operational-rules.md]] § North star). Carry %/close % are bounded proxies; the objective is profitable conversion.

## The loop (how Max uses this)

**Read the WHAT** (funnel-tree: which destination underperforms on CVR) → **read the WHY** (chapter-diagnostics: which lever — carry vs close — and which chapter) → **author the directive/spec** for the fix (Growth authors, [[platform]]/Ada builds) → **re-measure** the same slice next window. The destination's weak lever is the trigger for Max's highest-value work.

## Related
- SDKs + card: [[../libraries/funnel-tree]] · funnel page [[../dashboard/storefront__funnel]] (the SDK-powered "what" card + this "why" card; the old blended Chapter Performance card was removed).
- Mandate this serves: [[../functions/growth]] § Storefront CRO.
