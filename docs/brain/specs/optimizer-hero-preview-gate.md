# Optimizer hero preview gate — see/reject-with-notes before a generated hero goes live ⏳

**Owner:** [[../functions/growth]] · **Parent:** hardens [[storefront-optimizer-agent]] + [[storefront-optimizer-proposal-cards]]. · **Owner directive 2026-06-23:** for an `image` (hero) campaign, the owner approves the *concept* today and the hero is generated **post-approval and served to live shoppers sight-unseen**. Add a **preview gate**: generate the candidate first, the owner **sees the actual image** and either approves it live or **rejects with notes** that feed a better regeneration — iterate until it's right.

## Flow (insert a generate→preview→approve loop before the experiment goes live)
1. **Approve concept → generate candidate (don't go live yet).** On approving a hero-lever campaign, the worker generates the candidate hero via Nano-Banana ([[../libraries/gemini]]) and stores it as a **pending preview** on the campaign (NOT a live variant) — the job returns to `needs_approval` with the image surfaced on the card.
2. **Owner previews the real image** on the [[storefront-optimizer-proposal-cards|proposal card]]:
   - **Approve → goes live** — `materializeCampaign` stands up the experiment with *that* image as the variant arm.
   - **Reject with notes** — a free-text box ("warmer light", "show the pouch facing forward", "less busy background"). The notes **augment the prompt**, a new candidate is generated, and it previews again. Loop until approved (or the owner cancels the campaign). Keep the rejected attempts + notes on the campaign (the gen learns within the loop; nothing serves to a shopper until the owner approves an image).
3. Only the **final owner-approved image** is ever served. Nothing reaches live traffic on a prompt alone.

## Grounding the generation (owner's explicit asks — the gen MUST know these)
- **Composite the real product from the isolated bag image.** Source the product cutout from **`product_variants.isolated_image_url`** (set for Amazing Coffee — the clean isolated pouch) and composite it into the lifestyle scene. NEVER hallucinate/redraw the packaging — use the real isolated asset so the pouch/label is exact. (Pass it as the Nano-Banana Pro *combine* reference image.)
- **Generate at the correct hero dimensions.** Target the lander's actual hero slot, not a guessed size: for the **PDP** use the variant's stored **`hero_width × hero_height`** (`product_variants` — what `HeroSection` renders); for other landers use the hero aspect of that section (advertorial `16:10` / `4:5`, before/after `3:4`). Pick the closest Nano-Banana `aspectRatio` + a high resolution so the result fits the slot with no distortion/awkward crop.
- Honor the existing **locked-hero guard** — this writes an EXPERIMENT VARIANT overlay, never the canonical/locked Amazing Coffee hero asset (the control stays the locked hero; the variant is a separate render-time overlay, reversible).

## Verification
- Approve a hero campaign → it does **NOT** go live immediately; a candidate hero is generated and shown on the card; `storefront_experiments` has no new `running` row yet.
- The generated hero **composites the real pouch** from `isolated_image_url` (the label/packaging is the actual product, not redrawn) and matches the PDP hero's `hero_width×hero_height` aspect (fits the slot, no distortion).
- **Reject with notes** → a new candidate reflecting the notes is generated + re-previewed; the prior attempt + note are retained; still nothing live.
- **Approve the image** → the experiment goes `running` with that exact image as the variant arm; the canonical locked hero is untouched (control); rollback reverts to it.
- Negative: no image is ever served to a shopper without an explicit owner image-approval; a non-hero (copy/chapter) lever skips the gate (no image to preview).

## Phase 1 — generate-on-approve + preview/reject-with-notes loop + grounded gen ⏳
Split the approval into generate-candidate (worker, Nano-Banana, compositing `isolated_image_url` at `hero_width×hero_height`/lander aspect) → re-surface for image-approval; add the image preview + reject-with-notes input to the proposal card + the regenerate path; only image-approval calls `materializeCampaign`. Brain: [[storefront-optimizer-agent]] · [[storefront-optimizer-proposal-cards]] · [[../libraries/gemini]] · [[../tables/product_variants]] · [[../dashboard/storefront__optimizer]].
