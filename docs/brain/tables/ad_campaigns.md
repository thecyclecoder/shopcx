# ad_campaigns

A single ad concept: product × variant × [[product_ad_angles|angle]] × [[ad_avatars|avatar]], plus script and render settings. Each campaign fans out into 4 [[ad_videos]] sibling rows.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `name` | `text` | ✓ |  |
| `product_id` | `uuid` | — | → [[products]].id |
| `avatar_id` | `uuid` | ✓ | → [[ad_avatars]].id · ON DELETE SET NULL |
| `variant_id` | `uuid` | ✓ | → [[product_variants]].id |
| `angle_id` | `uuid` | ✓ | → [[product_ad_angles]].id |
| `script_text` | `text` | ✓ |  |
| `length_sec` | `int4` | — | default: `15` · `15` \| `30` |
| `voice_id` | `text` | ✓ |  |
| `caption_style` | `text` | — | default: `'hormozi_yellow'` |
| `vibe_tags` | `text[]` | ✓ |  |
| `scene_style` | `text` | — | default: `'outdoor_selfie'` · the shot's setting + action (kitchen counter, walk & talk, couch, car selfie, desk…). Drives the hero image + Veo talking-head prompts. Values in [[../libraries/ad-tool-config]] `AD_SCENE_STYLES` (plain text, not an enum). See [[../lifecycles/ad-render]]. |
| `hero_image_url` | `text` | ✓ | holding-product shot (Nano Banana Pro) |
| `audio_url` | `text` | ✓ | legacy TTS (vestigial in the Veo stack) |
| `composition` | `jsonb` | ✓ | the **stitch recipe**: ordered [[ad_segments]] refs + b-roll overlays + music mix. Render reads it; re-launch refresh swaps one segment + re-renders. See [[../libraries/ad-segments]], [[../lifecycles/ad-render]]. |
| `landing_url` | `text` | ✓ | default click-through destination for this ad (migration `20260615120000`). Set from the archetype→lander map at seed time; pre-fills the Meta publish panel; operator-overridable. See [[../lifecycles/ad-publish]], [[../specs/killer-statics]]. |
| `status` | `text` | — | default: `'draft'` · live values: `draft` \| `ready` \| `archived` (probe 2026-07-13). `archived` is the retire state — set when an ad's landing URL is removed (retiring/URL-removed). The [[../libraries/ready-to-test]] reader `.neq('status','archived')`s + guards the row-loop so retired creatives never count toward Dahlia's bin depth or media-buyer replenish. Historical values `rendering` \| `failed` appear in older pipeline records but are no longer produced. |
| `created_by` | `uuid` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |
| `updated_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `angle_id` → [[product_ad_angles]].`id`
- `avatar_id` → [[ad_avatars]].`id`
- `product_id` → [[products]].`id`
- `variant_id` → [[product_variants]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

- [[ad_videos]].`campaign_id`
- [[ad_jobs]].`campaign_id`
- [[storefront_sessions]].`ad_campaign_id` (Phase 2b)
- [[orders]].`ad_campaign_id` (Phase 2b)

## Common queries

### List rows for a workspace
```ts
const { data } = await admin.from("ad_campaigns")
  .select("id, name, status, created_at, updated_at")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ad_campaigns")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

## Gotchas

- Enum values are **lowercase** (`status`).
- `avatar_id` is `ON DELETE SET NULL` — archiving/deleting an [[ad_avatars]] row leaves the campaign intact but avatar-less.
- `length_sec` is `15` or `30`. 30s ads render as **two** talking-head clips — see [[ad_videos]].`talking_head_segments_url`.
- Internal joins use UUIDs (`variant_id` → [[product_variants]].id, not `shopify_variant_id`).
- **`name` becomes the published Meta ad name** ([[../lifecycles/ad-publish]]) — keep **demographic/ethnicity terms out of it** (e.g. "(Black)", "(Latina)") or Meta may flag the ad. To tag which avatar a campaign uses, use the avatar's ID-prefix code instead: `(av-<first 4 of avatar_id>)`. The default name `${product} — ${hook_slug}` is already clean; ethnicity only creeps in via manual naming.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
