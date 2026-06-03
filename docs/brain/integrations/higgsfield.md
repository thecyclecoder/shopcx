# higgsfield

Higgsfield Cloud API (`cloud.higgsfield.ai`). The single generative-media vendor behind the ad tool — covers all four surfaces the pipeline needs:

| Surface | What | Used for |
|---|---|---|
| **Soul** | image generation | avatar-holding-product hero shot |
| **DoP** | image→video | b-roll clips (5s) |
| **Speak** | speech2video lip-sync | talking-head (max 15s/gen) |
| **Audio** | text-to-speech | script voiceover (ElevenLabs is the alt) |

## Auth

Dual-credential, **per-workspace** (no global account):

- **Headers:** `hf-api-key` + `hf-secret` (both required on every call)
- **Encrypted on `workspaces`:** `higgsfield_api_key_encrypted` + `higgsfield_secret_encrypted` (AES-256-GCM via [[../libraries/crypto]])

Resolved + signed by `getHiggsfieldCredentials` / `loggedHiggsfieldFetch` in [[../libraries/higgsfield]]. Missing creds → `higgsfield_not_connected`.

## Key endpoints we call

Base: `https://cloud.higgsfield.ai` (env `HIGGSFIELD_BASE_URL`). **These paths + payloads are the integration contract gathered from published references — verify against live Higgsfield docs when wiring real credentials.**

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/characters` | POST | mint a persistent character (40 cr) |
| `/v1/soul/generate` | POST | Soul image |
| `/v1/dop/generate` | POST | DoP image→video b-roll |
| `/v1/speak/generate` | POST | Speak talking-head |
| `/v1/audio/tts` | POST | Audio TTS |
| `/v1/job-sets/{id}` | GET | poll job status + output urls |
| `/v1/motions` | GET | motion preset catalog (also the auth probe) |
| `/v1/styles` | GET | style catalog |

## Pricing

$1 = **16 credits** (`CREDITS_PER_DOLLAR`). `creditsToCents()` converts for cost tracking.

| Op | Cost |
|---|---|
| create character | 40 cr (~$2.50) |
| Soul image | ~3 cr @ 1080p |
| DoP b-roll (5s) | ~9 cr (~$0.56) |
| Speak | ~$0.10/sec |
| TTS | ~1 cr |

## Async + polling

All mutating calls are async: they return a `job_set_id`. Poll `GET /v1/job-sets/{id}` until terminal. Normalized status enum: `queued | in_progress | completed | failed | nsfw`. `pollJobUntilDone` polls at 5s intervals up to a 240s default timeout.

## Gotchas

- **NSFW jobs return `status='nsfw'` and STILL bill** (~$0.50 eaten). Terminal — surface clearly to the operator, never silently retry.
- **Every billable call is logged to [[../tables/ad_jobs]]** for cost-audit + replay (`loggedHiggsfieldFetch`). Probe/list calls skip persistence. Request payloads are credential-redacted before storage.
- Higgsfield needs **publicly-readable inputs** — reference images/audio are handed to it as short-lived signed URLs from the private `ad-tool` bucket ([[../libraries/ad-storage]]), never as public assets.
- Connected + verified from the settings card at `/dashboard/settings/integrations` (the "verify" step calls `probeHiggsfieldAuth` → `GET /v1/motions`).

## Files

- `src/lib/higgsfield.ts` — API client ([[../libraries/higgsfield]])
- `src/lib/inngest/ad-tool.ts` — async generation pipeline ([[../inngest/ad-tool]])
- `src/lib/ad-storage.ts` — signed-URL input handling ([[../libraries/ad-storage]])

## Related

[[../tables/ad_jobs]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_avatars]] · [[../libraries/crypto]]
