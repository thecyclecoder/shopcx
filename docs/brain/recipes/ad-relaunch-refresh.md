# Recipe: re-launch an ad by refreshing one beat

> "This ad is doing well but fatiguing — refresh the hook and re-launch. We just need one segment re-done, then re-stitch."

The creative library ([[../tables/ad_segments]] + `ad_campaigns.composition`) keeps every piece of an ad plus the assembly recipe, so you don't rebuild the whole thing. You swap one talking beat and re-stitch — every other clip, the b-roll, the music, and the timing are reused. One Veo call, not a fresh render of everything.

## From the dashboard

1. Open the campaign: `/dashboard/marketing/ads/{campaign_id}`.
2. **Creative library** section lists each piece: talking beats (with their script), b-roll, music.
3. On the fatigued beat (usually beat #1, the hook), click **Refresh this hook**, type the new words, **Regenerate & re-stitch**.
4. That fires `ad-tool/segment-regenerate` → regenerates just that beat with Veo 3.1 Fast → bumps its version → re-renders from the recipe. Other pieces untouched.

## What happens under the hood

- `POST /api/ads/campaigns/{id}/segments/regenerate` `{ seq, new_script }` → `inngest.send("ad-tool/segment-regenerate")`.
- [[../inngest/ad-tool]] `adToolSegmentRegenerate`:
  1. `regenerateTalkingSegment` — deactivate the active row at `(campaign, talking_head, seq)`, insert a new `generating` row at `version+1` with the new script.
  2. Veo 3.1 Fast generates the clip from the holding-product hero; Whisper sets the trim.
  3. `completeSegment` marks it ready, then fires `ad-tool/render-requested`.
  4. Render `assemble` step: `loadActiveSegments` picks up the NEW beat (old version inactive), `buildComposition` re-times the spine, captions re-proofread, renders all formats.

## Notes

- **Only talking beats are refreshable** via the UI today (the hook/body/CTA words). B-roll and music are reused as-is; regenerate them by re-running their stage if needed.
- **Veo 3.1 Fast daily cap** applies (separate quota from non-fast). A refresh is one Veo call.
- **Old versions are retained** in `ad_segments` (history) — `is_active=false`. Nothing is deleted.
- The composition re-times automatically: if the new beat's trim differs, downstream segment `startSec` shift and the music/b-roll offsets recompute.

## Related

[[../tables/ad_segments]] · [[../lifecycles/ad-render]] · [[../inngest/ad-tool]] · [[../libraries/ad-segments]]
