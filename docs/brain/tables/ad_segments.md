# `ad_segments` — the creative library (per-piece persistence)

Every generated piece of an ad — each talking-head Veo clip (with the exact script that made it), each b-roll cutaway, the music bed — is one row here. This is what makes the **re-launch refresh** possible: regenerate ONE beat and re-stitch, reusing every other piece. Before this table the intermediate clips were uploaded to storage but orphaned (no DB record, no per-segment script), so partial refresh was impossible.

Migration: `20260604180000_ad_creative_library.sql`. Written by [[../inngest/ad-tool]] via [[../libraries/ad-segments]] (`createSegment` → `completeSegment`/`failSegment`). RLS: workspace-member SELECT, service-role write (mirrors [[ad_videos]]).

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `workspace_id` | uuid → workspaces | cascade |
| `campaign_id` | uuid → [[ad_campaigns]] | cascade |
| `kind` | text | `talking_head` \| `broll` \| `music` |
| `seq` | int | order within its kind / timeline position |
| `version` | int | bumped on regeneration (default 1) |
| `is_active` | bool | the version currently in the cut; regen flips the old row false |
| `script_text` | text | **talking_head**: the exact words spoken in this clip (the re-stitch unit) |
| `prompt` | text | full generation prompt sent to the model |
| `model` | text | `veo-3.1-fast-generate-preview` (default) \| `veo-3.1-generate-preview` (HQ) \| `lyria-3-clip-preview` … |
| `storage_path` | text | private `ad-tool` bucket path (no signed URL stored) |
| `source_url` | text | input image for image-to-video — **broll**: the product-media still it animates (stable CDN URL), reused for HQ regenerate. Migration `20260605120000`. |
| `duration_sec` | numeric | raw clip length as generated |
| `trim_sec` | numeric | trimmed length used in the stitch (last Whisper word + 0.15s pad) |
| `transcript_json` | jsonb | talking_head: per-segment Whisper words `{ words: [{word,start,end}] }` |
| `status` | text | `generating` \| `ready` \| `failed` |
| `error` | text | failure reason |
| `created_at` | timestamptz | |

## Versioning / partial refresh

The active row at each `(campaign_id, kind, seq)` is the one in the current cut (`is_active = true`, latest `version`). `regenerateTalkingSegment` deactivates the current active row and inserts a fresh `generating` row at `version+1` with the new script. Old versions are retained (history / rollback). Re-render after the new row is `ready` to re-stitch.

## The stitch recipe

The assembly lives on **`ad_campaigns.composition`** (jsonb), NOT here — see [[ad_campaigns]] and [[../lifecycles/ad-render]]. `ad_segments` holds the pieces; `composition` holds how they're arranged. Render reads both.

## Gotchas

- **Active + ready only** for assembly: `loadActiveSegments` filters `is_active AND status='ready'`. A `generating`/`failed` segment is excluded from the cut.
- **Music is optional**: if Lyria fails, the row is marked `failed` and the ad renders without a bed (talking VO + b-roll still play).
- **Trim falls back to clip length** if Whisper fails on a talking segment (no dead-air trim, but the clip still plays).

## Related

[[ad_campaigns]] · [[ad_videos]] · [[../libraries/ad-segments]] · [[../inngest/ad-tool]] · [[../lifecycles/ad-render]] · [[../recipes/ad-relaunch-refresh]]
