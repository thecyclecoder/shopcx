# Competitor-ad adaptation — how to turn a proven competitor ad into ours

**The job:** take a proven competitor ad (a [[../tables/creative_skeletons|creative_skeleton]]) and produce OUR version that **matches or surpasses** what made it convert — same psychological engine, same design energy, our product + our substantiated claims. NOT a from-scratch "inspired by" ad, and NOT a verbatim clone.

Worked reference throughout: **SpoiledChild "SORRY IN ADVANCE"** (E27 Liquid Collagen, a mock-apology template) → **Amazing Creamer (Cinnamon Roll)**. Founder-authored 2026-07-24.

---

## The prime directive: the side-by-side is the anchor

**Adapt against a live side-by-side of the competitor ad, never in isolation.** Left = competitor, right = ours, same size, every iteration. Without it you drift toward *your* graphic and quietly lose the very things that made theirs convert (the layout hierarchy, the edge-to-edge type, the energy). Render → compare → judge → adjust → re-compare. It is a shockingly powerful analysis tool: essentially every refinement below was invisible until the two were beside each other.

**Rules are hard *suggestions*, not laws.** They get you 90% there fast. The side-by-side is where *judgment* closes the last 10% — "line 2 looks more like theirs if I drop the font a notch / add a little air by the packaging." Override any rule when matching the source's choice reads better. Comparison-driven judgment beats dogmatic rule-following.

**Ship only when ours ties or wins** on: (a) visual energy, and (b) psychological structure preserved.

---

## Part 1 — Copy adaptation

### Keep the proven *device* verbatim; reword the payload
The winning ad's **structure is the asset** — the mock-apology frame ("We regret to inform you that…", "We take full responsibility for…") is what makes it work. Keep the frame. Only the specifics inside it change to fit our product.

### Verify-then-reword benefits — never reinvent, never invent
The competitor's benefits are **validated by the ad's performance**. Do NOT swap them for our favorites. Instead:
1. Read the competitor's claim (e.g. "your skincare routine AND your pants size might shrink" = skin benefit + weight benefit; "smooth wrinkles, plump skin, curb cravings, reduce bloating").
2. **Verify we have the analogous benefit** in [[../tables/product_benefit_selections]] — check the `benefit_name` AND `customer_confirmed = true` AND lift from `customer_phrases`. (Amazing Creamer: Skin Health, Weight Management, Digestive Health — all `customer_confirmed` with real phrases like "no more bloating", "helps with appetite", "skin is smoother". It's a Collagen + Hyaluronic Acid + MCT product, so the collagen-benefit stack maps ~1:1.)
3. If we have it → **keep the benefit, reword to our product's language**. If we genuinely lack it → substitute a different confirmed benefit.
4. This is a tighter check than matching category names — ground each claim in `customer_confirmed` + the real phrase.

**Anti-pattern (the #1 miss):** reinventing benefits you happen to like (energy/taste) when the proven ad already told you which benefits convert (skin/weight). The current markdown-era Dahlia has the *firewall* (strip competitor brand/attributes, no fabrication) but LACKS this *positive adaptation* instinct — "DO keep the winning structure + the applicable benefits." That gap produces boring generic copy.

### Even applicable lines get reworded, not lifted verbatim
Keep the recognizable frame; reword the specific ending into our own words. "the compliments you are about to receive" → "the double-takes headed your way." Same meaning, our words — never a word-for-word copy.

### Diverse benefit stack
Don't spend two of four beats on the same dimension. Competitor had skin·skin·appetite·digestion; ours is stronger as skin·hair·appetite·digestion — four distinct payoffs, each `customer_confirmed`.

### Offer fidelity (the flip side)
Verify the competitor's CTA/offer against what we *actually* offer. If we have it → keep + reword. If we **don't** (their "Try Before You Buy" implies a no-payment trial we don't do) → **substitute our real equivalent** (30-day money-back guarantee → **"Try It Risk-Free"**), never carry an offer we can't honor. (Dahlia already knows the 30-day guarantee — it's a company-wide `proofStack` fact, and "try it risk-free" is sanctioned verbiage in her skill.)

### The final locked copy (worked example)
> **SORRY IN ADVANCE** · We regret to inform you that your skincare shelf AND your jeans size, might shrink. · Amazing Creamer tends to ***smooth skin, thicken hair, curb cravings, and reduce bloating.*** · We take full responsibility for the double-takes headed your way. · **[ TRY IT RISK-FREE ]**

---

## Part 2 — Visual / render (the three-layer overlay = "option A")

**Never let the image model draw the headline/body copy.** Image models (Nano Banana Pro included) garble text ("relaxant" → "relaxan"), and no prompt makes a diffusion model reliably text-accurate. Instead, three deterministic layers:

1. **Text-free scene** — [[../libraries/gemini|generateNanoBananaProCombine]] with `imageUrls: [competitor reference, our product]` (order = [reference, product]). Reproduce the competitor's composition, lighting, mood — but with OUR product, and **zero added text** (only the product's own printed label). Prompt hard for it: "absolutely ZERO added text, no captions, no flavor names floating in the scene" (Nano Banana will sneak in e.g. "CINNAMON LATTE" otherwise — QC for it).
2. **(Optional) isolated product** — composite the clean product cutout for a pixel-perfect pack. In practice the model renders the pack label fine when it's fully in frame, so this is polish, not required.
3. **Copy** — composite with a real font engine (SVG → `sharp`), so spelling is guaranteed exact, every ratio.

### Product / scene rules
- **Swap product + drink + props to OUR flavor's real variant.** The variant image lives in `products.variants[].image_url` (Amazing Creamer Cinnamon Roll = `SC-CREAMER-CINNAROLL`). Swap their drink for what fits ours (their cold mocktail → a **hot cinnamon latte** with heart art + steam) and their garnish for our ingredient/flavor props (coconut = MCT, cinnamon rolls + cinnamon sticks = flavor). Never fabricate a flavor pack you don't have a real image for.
- **Re-light the product to match the scene.** A bright, flat, evenly-lit product on a moody scene reads as photoshopped-in. Prompt for warm rim light + deep shadow falloff + cast shadow + reflection so it looks *photographed in* the environment. **QC rule:** too-bright/flat product on a dark scene → regenerate.
- **Lead packaging fully in frame** — no clipping at any edge, clear margin. A half-cropped hero pack reads noob. **QC rule:** cropped hero pack → regenerate. (A clipped pack often *looks* like garbled label text — check framing before blaming the render.)
- **Composition leaves the text zone clean.** Cluster the product to one side so there's an L-shaped clean dark zone (top band + a side column) for the copy overlay. Positioning via prompt is stochastic — be explicit about quadrants and expect a couple of tries; the isolated-product layer gives exact control when needed.

---

## Part 3 — Compositor / typography (match the source, don't invent)

Everything here is calibrated **on the side-by-side against the source**, not by formula.

- **Area first, then font-to-fit.** Define each text block's *area* (tight gutter to the product, generous margin at the frame edges), then size the font so its lines run edge-to-edge in that area. Don't pick a font size and hope it fills — that leaves dead space.
- **Safe-space asymmetry.** The gap between the copy and the packaging should be *smaller* than the margin at the frame edge. Generous air at the edges, tight gutter to the product. A big dead band between text and product is the noob tell.
- **Match the source's type treatment exactly:**
  - Hook: heavy/bold, top (centered here), big.
  - Sub-headline (the regret line): **light weight**, and sized to run **near-full-width** in as **few lines as the source** (2, not 3 — a small font bump gets it to 2 edge-to-edge lines). Give it **clear separation from the headline** (don't crowd the first body line under the hook).
  - Benefit stack: **bold italic**, the one high-contrast block.
  - Payoff: light weight.
  - Non-bold copy is **light weight** (Helvetica Neue 300), not regular — regular reads heavier/cheaper than the source.
- **Match the source's vertical rhythm** — generous space *between* paragraph blocks, not just within them.
- **No orphans** — hard-break intro lines so a 2-letter word ("to") never dangles alone.
- **Legibility is ours to guarantee** — a subtle scrim/plate behind the copy keeps it readable regardless of the scene; don't depend on the model leaving a perfectly clean area.

---

## Part 4 — Ratios

Produce all three Meta placements: **4:5** (feed), **9:16** (stories/reels), **1:1** (right-column). **Regenerate the scene *natively* per ratio — never crop the 4:5** (cropping clips the product or kills the copy zone). Then re-flow the same copy with the same treatment onto each canvas: 9:16 = text top / product bottom (lots of headroom); 1:1 = left-column copy / product right (tightest). Note: the competitor reference is one ratio (usually 4:5), so 9:16/1:1 apply the *rules* learned on 4:5 rather than a per-ratio side-by-side.

- **The text-box shape follows the scene's actual clear zone — don't force a fixed shape.** Read what the regenerated background gives you: a full-width open top → **full-width** text blocks (don't jam them into a left column); a side clear column → left-aligned column. On 9:16 the scene tends to open a wide full-width top with the product centered-low, so the copy should span full-width, centered hook + full-width body, product below.
- **9:16 must respect platform safe zones** (Meta unified 2026): keep all text + CTA within **14% top / 20% bottom** (up to 35% bottom for Reels) and **6% sides** — the scene image bleeds full-frame, but nothing readable sits under the Stories/Reels chrome (username bar up top, reply/like/share + caption down bottom). Headline drops below the top-14% line; CTA sits above the bottom-20% line.

---

## Status / open work

The full loop above was hand-run once (SpoiledChild → Amazing Creamer, all three ratios, 2026-07-24) to author this methodology. **Wiring it into Dahlia's live pipeline is unbuilt** — today's [[../lifecycles/ad-render]] path has the model draw the copy into the image (the garble problem). The build is the "option A" three-layer render (text-free scene → optional isolated product → font-engine copy overlay) + the copy-adaptation instincts in Part 1 + a side-by-side QC gate. See [[ad-render]], [[../../.claude/skills/dahlia-copy-author/SKILL.md]], [[meta-scaling-methodology]].
