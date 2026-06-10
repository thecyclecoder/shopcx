# `src/lib/ad-segments.ts` — creative library + stitch recipe

PURE planning (script→segments, segments→composition; testable) + DB helpers for [[../tables/ad_segments]]. The backbone of the [[../recipes/ad-relaunch-refresh]] flow.

## Pure functions

| Export | Notes |
|---|---|
| `splitScriptIntoSegments(script)` | Split the campaign script into per-Veo-clip beats by packing whole sentences up to a **word budget** (`MAX_WORDS_PER_CLIP = 24` ≈ 8s). Caps each clip's length so no segment is overloaded (the failure mode: leftover sentences dumped into one clip → the avatar talks way too fast). Each beat → one talking-head segment. (`lengthSec` arg is now ignored.) |
| `buildComposition(talking, broll, music, fps=30)` | Assemble the stitch recipe: talking segments back-to-back (each cut at `trim_sec`) = the VO spine; b-roll laid over the tail of successive talking segments as ducked cutaways (skips beat 1 / the CTA tail); music spans all. Returns `Composition`. |

## `Composition` (stored on `ad_campaigns.composition`)

```
{ segments:[{segment_id,startSec,trimSec}],          // base VO talking layer, in order
  broll:[{segment_id,fromSec,durSec,volume}],         // muted/ASMR overlays
  music:{segment_id,volume}|null, durationSec, fps }
```

## DB helpers (admin client)

| Export | Notes |
|---|---|
| `createSegment({workspaceId,campaignId,kind,seq,scriptText?,prompt?,model?})` | Insert a `generating` row → id. |
| `completeSegment(id, {storagePath,durationSec?,trimSec?,transcript?})` | Mark ready with output + timing. |
| `failSegment(id, error)` | Mark failed. |
| `loadActiveSegments(campaignId)` | `{talking,broll,music}` — active + ready, ordered by seq. Used by render's `assemble`. |
| `regenerateTalkingSegment({workspaceId,campaignId,seq,newScript,prompt?,model?})` | Deactivate the active beat at `seq`, insert a fresh `generating` row at `version+1` with the new script → id. The re-launch primitive. |
| `saveComposition(campaignId, composition)` | Persist the recipe on the campaign. |

## Callers

- [[../inngest/ad-tool]] — talking-head (create/complete per Veo clip), b-roll (create/complete per DoP clip), render `assemble` (loadActive → buildComposition → saveComposition), segment-regenerate.

## Related

[[../tables/ad_segments]] · [[gemini]] · [[ad-render]] · [[../lifecycles/ad-render]] · [[../recipes/ad-relaunch-refresh]]
