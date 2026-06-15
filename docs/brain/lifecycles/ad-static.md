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

## Cold-50+ "killer" archetype system (2026-06-15, 🚧 code-complete)

A **second, trust-first** static system layered on top of this lifecycle for the cold-50+ ad set (where statics often beat video). Five archetypes — **advertorial** (editorial serif), **testimonial** (face), **authority** (expert), **big_claim** (contrarian hook), **before_after** — each rendered in **both 4:5 + 9:16** (9:16 with Meta safe-zone insets), auto-built from PI + existing ad assets. Trust-first because loud/brutalist reads as spam to older buyers.

- **Components:** `remotion/StaticAdvertorial.tsx` (Playfair serif — must NOT look branded) + `remotion/StaticArchetypes.tsx` (Montserrat). All use the SafeImg pattern.
- **Data/build:** [[../libraries/ad-statics]] (`loadKillerAssets` + `buildKillerStatic`) + [[../libraries/ad-statics-copy]] (Opus copy for advertorial/big_claim/before_after; testimonial/authority use REAL review/endorsement text). Hero auto-selected by angle (avatar vs ingredient shot); review counts = real + 10,000; NEVER product-on-white (isolated cutout only).
- **Render:** the same `adToolStaticRequested` path branches killer vs legacy → both formats on Lambda → `ad_videos` (`media_kind='static'`).
- **Publish:** statics publish as Meta **image creatives** (see [[ad-publish]]); `ad_campaigns.landing_url` carries the per-ad destination; `scripts/seed-killer-statics.ts` seeds publish-ready campaigns.
- **Spec + remaining ops:** [[../specs/killer-statics]] (apply landing_url migration, redeploy Lambda site, verify, run seed, Dylan design pass). The legacy `review`/`offer`/`benefit_authority` archetypes below are kept for back-compat but superseded for cold 50+.

## Status / open work (2026-06-05)

**Shipped + verified:** all three archetypes render on Lambda (~1-3s each); the in-app flow (Inngest → Lambda → `ad_videos`) is verified (9/9 outputs across review/offer/benefit × 1:1/4:5/9:16). Uploads retry transient storage 502s ([[../libraries/ad-storage]]).

**⏳ TODO (Dylan) — design tweaks on the static archetypes.** The pipeline + data are done; the *visual design* is a first pass and needs Dylan's eye. Iterate purely in `remotion/StaticAds.tsx` (each archetype is one component) + the `DEFAULT_BRAND` palette in `src/lib/ad-static.ts` — no pipeline changes needed.
- Review the samples on Dylan's Desktop (`static-LAMBDA-StaticReview/Offer/BenefitAuthority.jpg`, `static-offer-WITH-backdrop.jpg`).
- Likely tweaks: brand palette/fonts, type scale + spacing, star/badge styling, product-image placement, the offer card's hierarchy, review-card avatar (initial vs real photo).
- Preview loop: edit `remotion/StaticAds.tsx` → render samples (the `loadStaticInputs` + `renderStill` pattern) → after approving, **re-run `scripts/deploy-remotion-lambda.ts`** so Lambda has the new look ([[../operational-rules]] § Remotion site deploy).

**⏳ Other open:** NBP backdrop auto-generation (plumbing in; toggle not wired), editable-copy UI before render, native/UGC AI-image archetype.

## Related

[[ad-render]] (video) · [[../integrations/remotion-lambda]] · [[../inngest/ad-tool]] · [[../tables/ad_videos]] · [[../tables/ad_segments]]
