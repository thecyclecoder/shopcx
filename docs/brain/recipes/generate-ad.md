# Generate an ad

How to produce a finished paid-social ad — four format outputs (Reels MP4, Feed-4:5 MP4, Stories JPG, Feed-4:5 JPG) — from the in-app studio. Full narrative in [[../lifecycles/ad-render]].

## Prerequisites

- **Phase 0 assets:** the chosen variant has an `isolated_image_url` and the product (or variant) has `physical_dimensions`. Set these on `/dashboard/storefront/products/{id}` (see [[../dashboard/products]]). The builder **hard-blocks Generate Hero** without an isolated image.
- **An avatar** exists ([[create-avatar]]).
- **Higgsfield connected** (Settings → Integrations) and `workspaces.ad_tool_enabled=true`.
- **Remotion installed** before any render: `npm i remotion @remotion/bundler @remotion/renderer @remotion/cli` — `renderAdFormat` throws `remotion_not_installed` otherwise.

## Steps

1. **Generate angles.** On `/dashboard/marketing/ads/angles/{productId}` (or "Generate fresh angles" in the builder), run `generateAngles(productId)` (`src/lib/ad-angles.ts`). Opus produces a spread anchored to verbatim tier-1/tier-2 benefits; the validator rejects unanchored / banned-word / meta-cap-overflow angles; survivors land in [[../tables/product_ad_angles]].

2. **Open the builder** at `/dashboard/marketing/ads/new`.

3. **Pick avatar → product/variant → angle → length** (15s / 30s).

4. **Review the script.** Auto-populated from the angle via `generateScript` (`src/lib/ad-script.ts`), validated by the DR validator ([[../libraries/ad-validator]]) — up to 3 retries on fatal violations. Edits re-validate live (`POST /api/ads/validate`). The script is also re-validated as a hard gate before render.

5. **Generate hero + audio.** Hero = Soul with the avatar's `character_id` + the signed isolated image + dims + vibe tags baked into the prompt. Audio = Higgsfield TTS over the script.

6. **Generate talking-head + b-roll.** Speak lip-syncs the hero to the audio (1 clip @15s, 2 @30s). DoP turns product images into jarring-motion b-roll clips.

7. **Render 4 formats.** `POST /api/ads/campaigns/{id}/render` fires `ad-tool/render-requested`: Whisper transcribes, `composeCredibility` builds the always-on row, and Remotion renders each format inside its Meta safe core. Four [[../tables/ad_videos]] rows, siblings linked by `format_variant_of_id`. Campaign status → `ready`.

8. **Download from the library.** `/dashboard/marketing/ads` grid → per-ad detail → download the MP4s + JPGs.

## Gotchas

- Every claim must trace to a tier-1/tier-2 benefit — the validator refuses "safe"/feature-led/review-led scripts. There is no override.
- Captions, badges, faces, CTA, and key product must land inside the safe core (Reels 35% bottom is the strictest). The renderer asserts this pre-encode.
- ~$3.50 marginal cost per ad after the character; default cost cap $10 (`ad_tool_settings.cost_cap_cents`). Every Higgsfield call logs to [[../tables/ad_jobs]].
- NSFW Higgsfield jobs bill but surface; the campaign won't silently fail.

## Related

[[../lifecycles/ad-render]] · [[../libraries/ad-angles]] · [[../libraries/ad-validator]] · [[../libraries/ad-render]] · [[../inngest/ad-tool]] · [[../tables/ad_videos]] · [[../dashboard/marketing__ads__new]] · [[create-avatar]]
