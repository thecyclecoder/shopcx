# Creative Finder — Video (follow-on) ⏳

**Owner:** [[../functions/growth]] · **Parent:** [[winning-static-creative-finder]] (its video follow-on).
**Deferred:** split from [[winning-static-creative-finder]] by a board-grooming sweep (2026-06-23) — **not needed now.** The static-creative finder is fully useful on its own; video is a heavier, separable pipeline. v1 already routes videos to `status='video_pending'`, so **nothing is lost** — they're captured + queued for when this builds.

## Phase 1 — video creative deconstruction ⏳
For AdLibrary creatives with `video_duration > 0` (currently parked at `status='video_pending'`): download → ffmpeg keyframes (dense in the first ~3s) + transcribe audio → run the frames + transcript through the **same four-slot skeleton schema** as statics (the literal first-2s hook = opening frame + first spoken line). Heavier pipeline (download + transcription cost) — that's why it was deferred to its own card. Brain: [[winning-static-creative-finder]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../tables/creative_skeletons]].

## Verification
- A `video_pending` AdLibrary creative → processed into a `creative_skeletons` row with the four-slot skeleton derived from keyframes + transcript; the hook reflects the opening frame + first spoken line.
- Cost-bounded: dedup by `ad_key` (no re-processing); transcription/download spend is logged.
- Negative: a static creative is untouched by this path (statics stay on the [[winning-static-creative-finder]] pipeline).
