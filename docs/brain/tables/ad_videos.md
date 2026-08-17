# ad_videos

Rendered media outputs for an [[ad_campaigns|ad campaign]]. One ad = N sibling rows joined via `format_variant_of_id` — the canonical row plus a placement-sized variant per format (video: Reels MP4 + Feed-4:5 MP4 + Stories JPG + Feed-4:5 JPG; the finished static "placement pack" = feed 4:5 + stories/reels 9:16 + right-column 1:1, one per placement family).

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `campaign_id` | `uuid` | — | → [[ad_campaigns]].id |
| `format` | `text` | — | default: `'reels_9x16'` · `reels_9x16` \| `feed_4x5` \| `stories_9x16` \| `right_column_1x1` (static-only, 1:1 placement pack sibling) |
| `media_kind` | `text` | — | default: `'video'` · `video` \| `static` |
| `format_variant_of_id` | `uuid` | ✓ | → [[ad_videos]].id (SELF) — siblings link to canonical row |
| `final_mp4_url` | `text` | ✓ |  |
| `static_jpg_url` | `text` | ✓ | **designed static-ad creative** (for `media_kind='static'` rows from the static-ad process) — signed URL; re-sign `meta.storage_path` (`finals/{ws}/{video_id}.jpg`) for a fresh link |
| `static_variants` | `jsonb` | — | default: `'[]'` · legacy `[{template_slug, image_url, format}]` (unused by the new static process) |
| `meta` | `jsonb` | — | static rows carry `{ archetype, storage_path, render? }` — `archetype` ∈ `review` (testimonial) \| `offer` \| `benefit_authority` \| `imitation` \| a treatment name (`before_after` \| `testimonial` \| `big_claim` \| `authority` \| `advertorial`, 2026-08-17). **`meta.render` envelope (2026-08-17 — dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 4):** per-placement render provenance so diagnosing the next divergence is a single row-read: `{ prompt, prompt_truncated, pinned_skeleton_id, composition_transfer, treatment, had_source_wireframe, author_notes_present }`. `prompt` is the exact Nano Banana Pro prompt this placement was rendered from (capped at [[../libraries/creative-agent]] `RENDER_PROMPT_STORE_CAP = 16000` chars — a runaway prompt cannot bloat the row; a truncated capture flips `prompt_truncated:true` rather than silently cut). `pinned_skeleton_id` is the [[creative_skeletons]] row the owner pinned, or null when the angle came off the auto-ranked shelf. `composition_transfer` = did the render reuse a design reference's composition? `treatment` = the archetype the PROMPT was steered toward, or null on an imitation path (Phase 2 strips TREATMENT_STEER when the source ad supplies the archetype). `had_source_wireframe` = did `brief.sourceWireframe` (Phase 3) reach the prompt? `author_notes_present` = did the owner's free-text directions ride in? Absent on pre-Phase-4 rows and on the CEO revise-format path ([[../libraries/regenerate-existing-format]]) where the caller doesn't build one — readers must tolerate the absent shape. |
| `talking_head_url` | `text` | ✓ |  |
| `talking_head_segments_url` | `text[]` | ✓ | 30s ads = 2 clips |
| `audio_url` | `text` | ✓ |  |
| `b_roll_urls` | `jsonb` | — | default: `'[]'` · `[{image_url, video_url, motion_id}]` |
| `transcript_json` | `jsonb` | ✓ | Whisper word timestamps |
| `caption_style` | `text` | ✓ |  |
| `duration_sec` | `int4` | ✓ |  |
| `cost_cents` | `int4` | — | default: `0` |
| `meta` | `jsonb` | — | default: `'{}'` |
| `status` | `text` | — | default: `'pending'` |
| `created_at` | `timestamptz` | — | default: `now()` |

Indexed by `campaign_id` and `workspace_id`.

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[ad_campaigns]].`id`
- `format_variant_of_id` → [[ad_videos]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_videos]].`format_variant_of_id`
- [[ad_jobs]].`video_id`

## Common queries

### Load the 4 sibling rows for a campaign (canonical + variants)
```ts
const { data } = await admin.from("ad_videos")
  .select("id, format, media_kind, format_variant_of_id, final_mp4_url, static_jpg_url, status")
  .eq("workspace_id", workspaceId)
  .eq("campaign_id", campaignId)
  .order("created_at", { ascending: true });
// canonical = format_variant_of_id IS NULL; siblings point at it
```

### Count since a given time
```ts
const { count } = await admin.from("ad_videos")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
```

## Gotchas

- Enum values are **lowercase** (`format`, `media_kind`, `status`).
- `format_variant_of_id` is **self-referential**: the canonical row has it `NULL`, the format siblings point back at the canonical row. One ad = N rows — video ads render 4 sibling formats, and Dahlia's finished static "placement pack" ([[../specs/dahlia-produces-3-placement-multi-copy-creative-pack]]) renders 3: `feed_4x5` + `stories_9x16` (or `reels_9x16`) + `right_column_1x1`.
- **Finding static ads by archetype** (review = testimonial, offer, benefit_authority): query `ad_videos` where `media_kind='static'` AND `meta->>'archetype'='review'` (filter by `workspace_id`/`campaign_id`); the image is `static_jpg_url` or re-sign `meta.storage_path` → `finals/{ws}/{video_id}.jpg`. See [[../lifecycles/ad-static]]. (Legacy `media_kind='static'` rows from old video renders may have a null archetype + be frame extracts — filter on `meta->>'archetype'`.)
- **Archetype used to lie (2026-08-17 fix — dahlia-imitates-the-pinned-ad-structure-instead-of-redesigning-it Phase 4):** [[../libraries/creative-agent]] `insertReadyCreative` used to hardcode `meta.archetype = 'before_after'` on every static row regardless of what was actually rendered — a constant that described every ad identically was a lie in the audit trail. The value is now derived at insert time from the pack-wide `renderProvenance`: `composition_transfer=true` (imitation branch — Phase 2's gate strips TREATMENT_STEER so the source ad supplies the archetype) → `'imitation'`; otherwise the treatment the prompt was steered toward (`before_after` | `testimonial` | `big_claim` | `authority` | `advertorial`); fallback `'before_after'` when neither the treatment nor the composition_transfer flag is threaded (pre-Phase-4 caller). Pre-Phase-4 rows still carry the constant `'before_after'` and cannot be un-lied retroactively — a filter on archetype must scope to `created_at >= '2026-08-17'` when the read depends on truth.
- 30s ads split talking-head footage into two clips in `talking_head_segments_url[]`.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
