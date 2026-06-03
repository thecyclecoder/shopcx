# ad_jobs

Audit/replay log of every Higgsfield API call made while rendering an ad. One row per job-set; polled until terminal. Written by `loggedHiggsfieldFetch()` in `src/lib/higgsfield.ts`.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `workspace_id` | `uuid` | — | → [[workspaces]].id |
| `campaign_id` | `uuid` | ✓ | → [[ad_campaigns]].id |
| `video_id` | `uuid` | ✓ | → [[ad_videos]].id |
| `job_type` | `text` | — | `create_character` \| `soul_image` \| `dop_video` \| `speak_video` \| `tts_audio` |
| `higgsfield_job_set_id` | `text` | ✓ | poll key |
| `status` | `text` | — | default: `'queued'` · `queued` \| `in_progress` \| `completed` \| `failed` \| `nsfw` |
| `request_payload` | `jsonb` | ✓ | credentials redacted |
| `response_payload` | `jsonb` | ✓ |  |
| `output_url` | `text` | ✓ |  |
| `cost_credits` | `int4` | — | default: `0` |
| `error` | `text` | ✓ |  |
| `polled_at` | `timestamptz` | ✓ |  |
| `completed_at` | `timestamptz` | ✓ |  |
| `created_at` | `timestamptz` | — | default: `now()` |

## Foreign keys

**Out (this → others):**

- `campaign_id` → [[ad_campaigns]].`id`
- `video_id` → [[ad_videos]].`id`
- `workspace_id` → [[workspaces]].`id`

**In (others → this):**

_None._

## Common queries

### Poll a job by Higgsfield job-set id
```ts
const { data } = await admin.from("ad_jobs")
  .select("id, job_type, status, output_url, error, polled_at, completed_at")
  .eq("workspace_id", workspaceId)
  .eq("higgsfield_job_set_id", jobSetId)
  .maybeSingle();
```

### Bucket by status (probe actual values first)
```ts
const { data } = await admin.from("ad_jobs")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

## Gotchas

- Enum values are **lowercase** (`job_type`, `status`). `nsfw` is a distinct terminal status separate from `failed`.
- `request_payload` **redacts credentials** before persisting — never expects API keys to land in this table.
- Every Higgsfield call gets a row here for audit/replay — written by `loggedHiggsfieldFetch()` in `src/lib/higgsfield.ts`.
- `higgsfield_job_set_id` is the poll key; `polled_at` advances each poll, `completed_at` is set once terminal.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
