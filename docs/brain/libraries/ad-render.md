# libraries/ad-render

Ad tool — Phase 5 render orchestration. Two halves: **pure planning** (caption groups, credibility row, cut plan, safe-zone-validated composition props — fully typed, no deps) and **render invocation** (hand props to the Remotion composition in `/remotion` via dynamic import).

**File:** `src/lib/ad-render.ts` · See [[ad-tool-config]], [[ad-transcribe]], [[ad-storage]], [[../inngest/ad-tool]].

## Exports (planning — pure)

| Export | Purpose |
|---|---|
| `groupCaptions(words, style, loud)` | 1-3 word Hormozi caption beats, never splitting a phrasal verb; color-flip rhythm (flips every 2 when `loud`, else 4); ALL-CAPS words become yellow emphasis |
| `composeCredibility(input)` | Tier-5 always-on stack: badges (operator's pinned order first, ≤5), social-proof stats, guarantee CTA. **No hardcoded badge text** — all derived from product certs/awards/reviews |
| `cutPlan(15 | 30)` | canonical talking-head / b-roll / cta timeline (Feed-4:5 inherits Reels) |
| `validateSafeZone(elements, format, kind)` | **hard pre-encode gate** — every caption/badge/key element must land inside the format-specific safe core (`safeCore` from config) |
| `buildIngredientPops(words, ingredientImages)` | word-timestamp triggers: schedules an image pop when a transcript word matches an ingredient name (word duration + 200ms tail) |
| `buildCompositionProps(args)` | assembles the fully-resolved `AdCompositionProps` for one format |
| `renderAdFormat(props, outPath)` | dynamically imports `@remotion/bundler` + `@remotion/renderer`, bundles `/remotion/index.ts`, renders one format (still for static, h264 for video) |

## Callers

- `src/lib/inngest/ad-tool.ts` — `adToolRenderRequested` builds props + renders all 4 formats
- **CEO-review re-drive** — the [[../tables/ad_review_feedback]] router (see [[ads/ad-review-feedback-router]]) enqueues an `agent_jobs.kind='ad-creative'` re-drive per `render-format`-target packet entry, carrying `{ ad_review_feedback_id, ad_campaign_id, format, revise_reason }`. Phase 2 wires the router + the queued job; consuming that instruction to actually regenerate ONLY the named format (rather than re-running the whole `stockProduct` pass) is the follow-up on `runAdCreativeJob`.

## Gotchas

- **Renders ONCE per format → 4 `ad_videos` rows** (Reels MP4, Feed-4:5 MP4, Stories JPG, Feed-4:5 JPG), siblings linked via `format_variant_of_id` to the canonical (first) row.
- **`@remotion/*` is NOT a normal dependency.** `renderAdFormat` imports it dynamically so the app typechecks/builds without it; throws `remotion_not_installed` (run `npm i remotion @remotion/bundler @remotion/renderer @remotion/cli`) if missing. The composition lives in `/remotion`, excluded from the app tsc.
- Safe zones differ by format AND media kind (statics get a less aggressive bottom zone) — always pass both to `safeCore`/`validateSafeZone`.

## Sibling files

These ship with the render pipeline and have their own pages:

- [[ad-storage]] — private `ad-tool` bucket, signed 1h URLs for Higgsfield inputs + previews
- [[ad-transcribe]] — OpenAI Whisper `verbose_json` word-level timestamps (caption source)
- [[ad-tool-config]] — single source of truth: LIFE_FORCE_8, 12 HOOK_FORMULAS, FORMAT_SPECS + safeCore, CAPTION_SPEC, vibe motion presets, META_CAPS, DEFAULT_AD_TOOL_SETTINGS, resolveAdToolSettings

---

[[../README]] · [[../../CLAUDE]] · [[../tables/ad_videos]]
