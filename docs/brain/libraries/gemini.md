# `src/lib/gemini.ts` — Google AI Studio (Gemini) client

The ad-tool's **holding-product** + **talking-head/b-roll** engine. Per-workspace API key, AES-256-GCM encrypted ([[crypto]]). Part of the proven ad pipeline — see [[../lifecycles/ad-render]] § Proven model stack.

- **Base:** `GEMINI_BASE_URL` or `https://generativelanguage.googleapis.com/v1beta`
- **Auth:** header `x-goog-api-key: {API_KEY}` — **NOT** `Authorization: Bearer`.
- **Billing must be enabled** on the Google Cloud project or the Pro image model 429s "prepayment credits depleted".
- **Veo tier limits:** billing → Tier 1 = **Veo 3.1 preview capped at 10 requests/day**. **Veo 3.1 Fast has separate quota** (the unblock). Tier 2 needs $100 spend + 3 days.

## Credentials

`getGeminiCredentials(workspaceId) → { apiKey } | null`
- Reads `workspaces.gemini_api_key_encrypted` (migration `20260604170000_gemini_integration.sql`), decrypts.
- Falls back to `process.env.GEMINI_API_KEY` if the column is empty (so it runs before the settings card ships).
- Returns `null` (→ callers throw `gemini_not_connected`) if neither is set.

## Exports

| Export | Shape | Notes |
|---|---|---|
| `generateNanoBananaProCombine({workspaceId, prompt, imageUrls[], model?})` | `→ { buffer, mimeType }` | **Synchronous** multi-image fusion (`:generateContent`, `responseModalities:["IMAGE"]`). Image returns inline (~10-30s), no polling. Caller uploads the buffer. Used for the holding-product hero: `imageUrls = [face, product isolated]`, referenced in the prompt as "the first/second image". |
| `generateVeoVideo({workspaceId, prompt, imageUrl?, aspectRatio?, resolution?, model?, intervalMs?, timeoutMs?})` | `→ { buffer, mimeType }` | **Long-running.** `:predictLongRunning` → poll `GET /v1beta/{opName}` until `done` → download MP4 (signed URI needs the same `x-goog-api-key`). `imageUrl` set = image-to-video (first frame), else text-to-video. ~8s clips, native baked-in audio. Defaults: `9:16`, `720p`, 8s poll, 300s timeout. |
| `generateLyriaMusic({workspaceId, prompt, model?})` | `→ { buffer, mimeType }` | **Synchronous** (`:generateContent`, inline audio like Nano Banana Pro). The ONE low music bed under the ad (b-roll stays muted/ASMR; VO = talking segments' audio). ~25-30s. |
| `probeGeminiAuth(workspaceId)` | `→ { ok, status }` | Cheap `GET /models` for the settings "Verify" button (Settings → Ad tool → Google AI Studio card). |

## Constants

| Const | Value |
|---|---|
| `NANO_BANANA_PRO_MODEL` | `gemini-3-pro-image` (the holding-product model — sharp text, correct anatomy) |
| `NANO_BANANA_MODEL` | `gemini-2.5-flash-image` (cheaper fallback) |
| `VEO_MODEL` | `veo-3.1-generate-preview` (10/day on Tier 1) |
| `VEO_FAST_MODEL` | `veo-3.1-fast-generate-preview` (**use this** — separate quota, proven "perfect") |
| `LYRIA_MODEL` | `lyria-3-clip-preview` (music bed) |

## Errors

`gemini_not_connected` · `gemini_{status}:{msg}` · `gemini_no_image` · `image_fetch_{status}` · `veo_{status}:{msg}` · `veo_no_operation` · `veo_op:{msg}` · `veo_no_video` · `veo_download_{status}` · `veo_timeout`.

## Callers

- `src/lib/inngest/ad-tool.ts` — hero step (`generateNanoBananaProCombine`), talking-head (`generateVeoVideo` Veo 3.1 Fast, multi-segment), render `assemble` (`generateLyriaMusic`), segment-regenerate (`generateVeoVideo`). All wired.
- `src/app/api/workspaces/[id]/gemini/route.ts` — `probeGeminiAuth` for the settings Verify button.

## Related

- [[higgsfield]] — Soul (faces) + DoP (b-roll); the other half of the model stack.
- [[../lifecycles/ad-render]] · [[../inngest/ad-tool]] · [[../integrations/higgsfield]]
