# higgsfield

Higgsfield Platform API (`platform.higgsfield.ai`). The single generative-media vendor behind the ad tool — covers all surfaces the pipeline needs:

| Surface | Endpoint | Used for |
|---|---|---|
| **Soul** (text2image) | `/v1/text2image/soul` | avatar face candidates + hero shot |
| **DoP** (image2video) | `/v1/image2video/dop` | b-roll clips |
| **Speak** (speech2video) | `/v1/speak/higgsfield` | talking-head lip-sync |
| **Audio** (TTS) | `/v1/audio/tts` (unverified) | script voiceover (ElevenLabs is the alt) |

**Verified working against the live API 2026-06-03** (avatar face generation). Earlier placeholder paths (`cloud.higgsfield.ai`, `/v1/soul/generate`, `hf-api-key` headers) were wrong and 404'd — the table below is the real contract.

## Auth

Per-workspace (no global account). **Single header**, NOT two:

```
Authorization: Key {KEY_ID}:{KEY_SECRET}
```

- Stored AES-256-GCM on `workspaces`: `higgsfield_api_key_encrypted` (= KEY_ID) + `higgsfield_secret_encrypted` (= KEY_SECRET), via [[../libraries/crypto]].
- Resolved by `getHiggsfieldCredentials`; every call signs through `loggedHiggsfieldFetch` in [[../libraries/higgsfield]]. Missing creds → `higgsfield_not_connected`.

## Base + endpoints

Base: `https://platform.higgsfield.ai` (env `HIGGSFIELD_BASE_URL`).

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/text2image/soul` | POST | Soul image (text2image; image-to-image via `custom_reference_id`) |
| `/v1/image2video/dop` | POST | DoP image→video b-roll |
| `/v1/speak/higgsfield` | POST | Speak talking-head |
| `/v1/audio/tts` | POST | Audio TTS (**unverified** — endpoint guessed) |
| `/requests/{request_id}/status` | GET | poll status + output urls |

### Request body — **wrap every POST in `{ "params": { … } }`**

The platform endpoints reject a flat body with `422 {"loc":["body","params"],"msg":"Field required"}`. The real fields go **inside `params`**:

```jsonc
// POST /v1/text2image/soul
{ "params": {
    "prompt": "Photorealistic portrait of a woman, late 40s, fit, looking at camera, daylight.",
    "width_and_height": "1152x2048",   // enum, see below
    "quality": "1080p",                 // "720p" | "1080p"
    "seed": 1234                        // optional, 1–1000000
} }
```

`width_and_height` enum (subset, `SOUL_SIZES`): `1152x2048` (9:16 portrait — used for faces), `1536x2048` (3:4), `1536x1536` (square), `2048x1152` (16:9). Optional `style_id` (80 styles) + `style_strength` (0–1).

DoP body params: `{ model, prompt, input_images: [{ type:"image_url", image_url }], motions? }`.
Speak body params: `{ input_image:{type:"image_url",image_url}, input_audio:{type:"audio_url",audio_url}, prompt, quality, duration }`.

### Response shape

```jsonc
{ "status": "completed|queued|in_progress|failed|nsfw",
  "request_id": "uuid",
  "images": [{ "url": "https://…cloudfront.net/…" }],   // text2image
  "video":  { "url": "…" }                                // dop / speak
}
```

Generation is async: the POST returns `request_id` (sometimes images immediately). `pollJobUntilDone(request_id)` polls `GET /requests/{id}/status` (4s interval, 240s default timeout) until `completed` → output url(s). `extractUrls()` reads `images[].url` / `video.url`.

## Pricing

$1 = **16 credits** (`CREDITS_PER_DOLLAR`). `creditsToCents()` converts for cost tracking.

| Op | Cost |
|---|---|
| Soul image / face | ~3 cr @ 1080p |
| DoP b-roll | ~9 cr (~$0.56) |
| Speak | ~$0.10/sec |
| TTS | ~1 cr |

## Gotchas

- **Body MUST be wrapped in `{ params: {...} }`** on every POST — a flat body 422s.
- **No simple "create character"**: Higgsfield's Soul ID needs 20+ training photos. With a single generated face we don't mint a Soul ID — `createCharacter` is a no-op returning `characterId=null`; the avatar stores the chosen face image and reuses it as a Soul `custom_reference` for hero generation. Full Soul-ID training + product/avatar reference-locking is **open work** (see [[../lifecycles/ad-render]] Status).
- **NSFW jobs return `status='nsfw'` and STILL bill** (~$0.50 eaten). Terminal — surface clearly, never silently retry.
- **Every billable call is logged to [[../tables/ad_jobs]]** (`loggedHiggsfieldFetch`) with credential-redacted request + full response, for cost-audit + replay. Probe/status calls skip persistence.
- Higgsfield needs **publicly-readable inputs** — reference images/audio are handed over as short-lived signed URLs from the private `ad-tool` bucket ([[../libraries/ad-storage]]).
- Verify from the settings card at `/dashboard/settings/integrations`: `probeHiggsfieldAuth` GETs the POST-only `/v1/text2image/soul` → `405` means creds accepted; `401/403` means bad creds.

## Files

- `src/lib/higgsfield.ts` — API client ([[../libraries/higgsfield]])
- `src/lib/inngest/ad-tool.ts` — async generation pipeline ([[../inngest/ad-tool]])
- `src/lib/ad-storage.ts` — signed-URL input handling ([[../libraries/ad-storage]])

## Related

[[../tables/ad_jobs]] · [[../tables/ad_campaigns]] · [[../tables/ad_videos]] · [[../tables/ad_avatars]] · [[../libraries/crypto]]
