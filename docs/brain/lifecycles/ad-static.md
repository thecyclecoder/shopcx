# Lifecycle: static ads (a separate process from video)

Static ads are single, design-led, scroll-stopping **stills** — not frozen video frames. Entirely separate from the video pipeline ([[ad-render]]): no talking head, b-roll, music, captions, or timeline. Three designed archetypes, each a Remotion still template populated from product intelligence, rendered on Remotion Lambda across **1:1 / 4:5 / 9:16**.

**Code:** `src/lib/ad-static.ts` (resolvers) · `remotion/StaticAds.tsx` (templates) · `src/lib/inngest/ad-tool.ts` (`adToolStaticRequested`) · `src/lib/ad-render.ts` (`renderStillCompositionTo`). **Trigger:** `POST /api/ads/campaigns/[id]/static {archetype}`.

## Archetypes

| Archetype | Composition | Looks like | Data source |
|---|---|---|---|
| `review` | `StaticReview` | a premium 5★ testimonial card | `product_reviews` (best featured 5★: reviewer, rating, body/smart_quote, verified) |
| `offer` | `StaticOffer` | bold promo — big discount + product + urgency + CTA | offer copy (default "40% OFF + FREE SHIPPING", editable) + product isolated image |
| `benefit_authority` | `StaticBenefitAuthority` | editorial: nutritionist endorsement (+ credentials) OR numbered benefits | `product_page_content.endorsements` (name/title/quote/bullets) or `product_benefit_selections` |

## Flow

1. Operator clicks an archetype in the campaign page **Static ads** section → `POST /api/ads/campaigns/[id]/static {archetype}` → `inngest.send("ad-tool/static-requested")`.
2. `adToolStaticRequested`:
   - `loadStaticInputs(product_id)` — reviews, endorsement, benefits, product image (from product intelligence).
   - PURE `buildReviewProps` / `buildOfferProps` / `buildBenefitAuthorityProps` → composition props (+ operator copy overrides).
   - For each of **3 formats** (`feed_1x1` 1080², `feed_4x5` 1080×1350, `stories_9x16` 1080×1920): `renderStillCompositionTo(<composition>, {width,height,...props})` → upload → `ad_videos` row (`media_kind='static'`, `meta.archetype`, `static_jpg_url`).
3. The campaign page groups static outputs by `meta.archetype` with previews + download.

## Design / engine

- **Hybrid, designed-first**: precise Remotion templates (brand palette, Anton + Inter, stars/badges/cards) — not AI-generated layout. `StaticOffer` supports an optional **Nano Banana Pro backdrop** (`backdropUrl`) with crisp overlaid text (plumbing in `buildOfferProps`; auto-gen is a future toggle).
- **`SafeImg`**: a Remotion `<Img>` that hides on load error instead of crashing the still (Lambda otherwise hard-fails with "Error loading image"). Pass fresh signed URLs.
- Native/UGC AI-image archetype intentionally deferred.

## Render runtime

Runs on **Remotion Lambda** (`renderStillCompositionTo` → `renderStillOnLambda`) — see [[../integrations/remotion-lambda]]. Local dev renders in-process. **Re-run `scripts/deploy-remotion-lambda.ts` after editing `remotion/StaticAds.tsx`** so the Lambda site has the latest templates ([[../operational-rules]] § Remotion site deploy).

## Status / verified (2026-06-05)

- All three archetypes render on Lambda (~1-3s each), and the in-app flow (Inngest → Lambda → `ad_videos`) is verified. Uploads retry transient storage 502s ([[../libraries/ad-storage]]).
- Open: NBP backdrop auto-generation (toggle), editable-copy UI before render, native/UGC archetype.

## Related

[[ad-render]] (video) · [[../integrations/remotion-lambda]] · [[../inngest/ad-tool]] · [[../tables/ad_videos]] · [[../tables/ad_segments]]
