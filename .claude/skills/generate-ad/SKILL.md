---
name: generate-ad
description: Use to produce a finished paid-social video ad in ShopCX — the avatar→angle→script→hero→talking-head→b-roll→render-4-formats pipeline, or refresh one fatigued beat and re-stitch. Mostly driven from the in-app studio (/dashboard/marketing/ads/new); this skill is the procedure + invariants behind it (benefit-traceability, Meta safe-core, $10 cost cap). Triggered by "generate/build an ad for {product}", "re-launch the fatigued ad", or driving the ad pipeline from a script.
---

# generate-ad

Turn the Product Intelligence Engine's structured data into a direct-response paid-social ad — an avatar holding the product, talking to camera with lip-sync, intercut with b-roll, Hormozi word-level captions, an always-on credibility row — rendered in **four formats** (Reels MP4, Feed-4:5 MP4, Stories JPG, Feed-4:5 JPG). ~$3.50 marginal cost per ad after the one-time character, minutes not days. Full narrative in docs/brain/lifecycles/ad-render.md; the how-to is docs/brain/recipes/generate-ad.md.

This is **mostly UI-driven** today (`/dashboard/marketing/ads/new` wizard). Use this skill to drive or understand the pipeline from code, or when a build touches it — the staged routes under `src/app/api/ads/**` and the async functions in `src/lib/inngest/ad-tool.ts` are the same path the wizard fires.

## Prerequisites (the hero is only as good as these)

- **Phase 0 assets:** the chosen `product_variants.isolated_image_url` (transparent/white bg, no shadow) + `physical_dimensions` on the product/variant. The builder **hard-blocks Generate Hero** without an isolated image. Set on `/dashboard/storefront/products/{id}`.
- **An avatar** exists (docs/brain/recipes/create-avatar.md) — demographic-driven, photo-free face → minted Higgsfield character. Cap 10/workspace.
- **Gemini + Higgsfield connected** (Settings → Ad tool) and `workspaces.ad_tool_enabled=true` (default false — user-initiated only, no cron).
- **Remotion installed** before any local render: `npm i remotion @remotion/bundler @remotion/renderer @remotion/cli` — else `remotion_not_installed`. Prod renders on Lambda (docs/brain/integrations/remotion-lambda.md).

## The staged pipeline

1. **Angles** — `generateAngles(productId)` (`src/lib/ad-angles.ts`): Opus spreads angles anchored to **verbatim** tier-1/tier-2 benefits; the validator rejects unanchored / banned-word / meta-cap-overflow candidates → docs/brain/tables/product_ad_angles.md. Re-runs archive prior active rows.
2. **Script** — `generateScript` (`src/lib/ad-script.ts`) → HOOK/BODY/CTA, validated by the DR validator (docs/brain/libraries/ad-validator.md) with ≤3 retries on fatal violations. Re-validated as a hard gate before render (`POST /api/ads/validate`).
3. **Hero + audio** — Hero = Nano Banana Pro combine (avatar face + isolated image → identity-locked holding-product shot); VO = Veo native audio (no separate TTS track).
4. **Talking-head + b-roll** — Veo 3.1 **Fast** lip-syncs the hero per ~8s beat (each persisted as an `ad_segments` row with its script); DoP / Veo b-roll from `product_media`, muted/ASMR-ducked.
5. **Render 4 formats** — `POST /api/ads/campaigns/{id}/render` fires `ad-tool/render-requested`: Whisper transcribes once, `composeCredibility` builds the always-on row, `renderVoSpineVideoTo` renders each format inside its Meta safe core. Four `ad_videos` rows linked by `format_variant_of_id`; status → `ready`.
6. **Download** from `/dashboard/marketing/ads` → per-ad detail.

## Re-launch / refresh (swap one beat, don't rebuild)

A fatiguing ad: refresh **one** talking beat and re-stitch — every other clip, b-roll, music, and timing is reused (one Veo call, not a fresh render). `POST /api/ads/campaigns/{id}/segments/regenerate {seq, new_script}` → `ad-tool/segment-regenerate` deactivates the active beat, inserts `version+1`, Veo regenerates, Whisper re-trims, render re-times the spine. Only talking beats are UI-refreshable; b-roll/music are reused as-is. See docs/brain/recipes/ad-relaunch-refresh.md.

## Guardrails

- **Benefit-traceability is a hard rule.** Every claim traces to a tier-1/tier-2 benefit; the validator refuses "safe"/feature-led/review-led scripts — reviews can CITE a benefit, never BE the angle. No override.
- **Meta safe-core.** Captions, badges, faces, CTA, and key product must land inside the safe core (Reels 35% bottom is strictest — passing Reels passes all). The renderer asserts this pre-encode.
- **Cost cap.** ~$3.50 marginal/ad after the character; default cap **$10** (`ad_tool_settings.cost_cap_cents`). Every Higgsfield/Gemini call logs to `ad_jobs` for cost-audit/replay.
- **NSFW jobs bill but surface** (`status='nsfw'`) — the campaign won't silently fail.
- **Per-workspace encrypted creds** (`higgsfield_*_encrypted`, `gemini_api_key_encrypted`); no global account. No public buckets — finals private, vendors get 1h signed URLs.
- **Internal joins use UUIDs**, never `shopify_*_id`. DB writes via `createAdminClient()`.
- **Redeploy Lambda after editing `remotion/`** (compositions/`ExampleAd`) — `npx tsx scripts/deploy-remotion-lambda.ts`, else Lambda renders a stale bundle ([[deploy]] § Remotion site deploy).

## Related
docs/brain/recipes/generate-ad.md · docs/brain/recipes/ad-relaunch-refresh.md · docs/brain/lifecycles/ad-render.md · docs/brain/libraries/ad-angles.md · docs/brain/libraries/ad-validator.md · docs/brain/libraries/ad-render.md · docs/brain/inngest/ad-tool.md · docs/brain/integrations/remotion-lambda.md · skills: `render-static`, `deploy`, `probe-db`
