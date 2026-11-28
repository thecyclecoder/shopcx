# src/lib/social/nugget-generator.ts

AI-drafts educational **nugget carousels** for the organic library ([[../tables/organic_content]], format=`carousel`). Added in organic-nugget-engine Phase 3. Supervisable autonomy: it DRAFTS (status=`draft`); a human approves in Marketing › Social before anything posts (nuggets make health statements).

## What it does

1. **Draft** — one Claude call ([`draftNugget`], `SONNET_MODEL`) returns `{title, hook, slides[5–7]:{headline,body}, dinner_line, study_citation}` grounded in the CEO content rules (2026-11-27): three pillars (`body` / `food_first` / `superfoods`), ONE real + accurately-described study, "supports" language (no cure/treat/prevent-disease), never implying Superfood Tabs itself was studied, kid-simple words, ≤~20 words/slide, soft brand sign-off only on the last slide.
2. **Render** — two NON-illustrated styles that rotate per slide (the gouache illustrated style is forbidden for slideshows — reserved for animated videos):
   - **PHOTO** — a realistic photographic background from Nano Banana Pro ([[gemini]] `generateNanoBananaProCombine`, 4:5, NO text baked in) with the headline composited over a pillar-colored band.
   - **TEXT** — a bold solid-color typographic slide.
   - In BOTH the headline (and body) is composited in code so the wording is **exact** — never drawn by the image model. Text is drawn as **vector paths** from the bundled OFL Montserrat TTFs in `src/lib/social/fonts/` via `opentype.js` (`textSlideSvg` / `photoOverlaySvg`, width-based wrap + auto-shrink), then rasterized by `sharp`. Output 1080×1350 JPEGs to the private bucket.
3. **Insert** — `insertOrganicContentDraft` (format=`carousel`, status=`draft`, created_by=`nugget_generator`). Dedupes against existing carousel titles via [[organic-content]] `listQueuedOrganicContent`.

## Gotchas

- **Never use SVG `<text>` here.** librsvg resolves fonts through the host's fontconfig and the Vercel function has no system fonts, so the first live drafts (2026-11-28) rendered every glyph as a tofu box. The fonts are traced into `/api/inngest` via `outputFileTracingIncludes` in `next.config.ts`; keep that entry if the path moves.
- **One-study rule is code-checked.** `hasSingleStudyCitation` rejects a draft whose `study_citation` has more than one publication year or a `;` (an early draft cited a 1998 book plus a 2015 paper). A rejected draft ends that run's top-up; the next daily run tries again.
- The system prompt carries three reference nuggets (walk after dinner, sugar taste recalibration, sleep and hunger) as the quality bar, and bans bland "Meet X" hooks.

## Exports

| Symbol | Notes |
|---|---|
| `generateNugget(workspaceId, pillar)` | draft → render → upload → insert ONE carousel; returns the row or null |
| `topUpNuggetQueue(workspaceId, target=7)` | generate across pillars until ≥target draft-or-approved carousels queued (≤3/run) |
| `draftNugget(workspaceId, pillar, avoidTitles)` | the raw Claude draft call |
| `hasSingleStudyCitation(citation)` | one-study guard used by `draftNugget` |
| `textSlideSvg` / `photoOverlaySvg` | slide SVGs with text as font paths |
| `PILLARS` | `["body","food_first","superfoods"]` |

## Caller

[[../inngest/organic-nugget-generate]] (the daily `organicNuggetGenerate` cron) → `topUpNuggetQueue`.

## Related

[[../tables/organic_content]] · [[organic-content]] · [[../inngest/organic-nugget-generate]] · [[gemini]] · [[../lifecycles/social-scheduler]] · [[../functions/cmo]]
