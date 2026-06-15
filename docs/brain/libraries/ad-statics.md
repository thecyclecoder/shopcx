# `src/lib/ad-statics.ts` — cold-50+ "killer" static archetype system

The data + build half of the trust-first static archetypes (advertorial / testimonial / authority / big_claim / before_after). Hydrates Product Intelligence + existing ad assets, generates/reuses hero imagery, and returns composition-ready props with **fresh signed URLs** (Lambda-safe). Supersedes the legacy [[ad-static]] resolvers for cold 50+. See [[../lifecycles/ad-static]] + [[../specs/killer-statics]].

## Exports

| Export | Notes |
|---|---|
| `KILLER_ARCHETYPES` / `KillerArchetype` | `advertorial` \| `testimonial` \| `authority` \| `big_claim` \| `before_after` |
| `TRUST_ARCHETYPES` | the cold-50+ default subset (advertorial/testimonial/authority) |
| `KILLER_COMPOSITION` | archetype → Remotion composition id (registered in `remotion/Root.tsx`) |
| `KILLER_ARCHETYPE_LABELS` | UI labels |
| `KILLER_FORMATS` | both formats every time: `feed_4x5` (no inset) + `stories_9x16` (`safeTopPct` 0.08 / `safeBottomPct` 0.14) |
| `ARCHETYPE_LANDER` / `LanderKind` | archetype → default landing-page kind (`pdp` \| `advertorial` \| `before_after`) |
| `signAdToolRef(ref)` | re-sign an ad-tool ref for a fresh fetch; pass through public product-media URLs |
| `loadKillerAssets(productId)` | DB hydrate via [[ad-angles]] `loadAngleInputs` + reviews + endorsement + `product_media` slots + `ad_campaigns.hero_image_url` candidates + badges (PI certs) + review-count (real + 10,000) |
| `advertorialHeroKind(angle)` | mechanism/anti-aging → `ingredient`; else `avatar` |
| `buildKillerStatic({workspaceId, productId, archetype, assets, angle})` | async → `{ composition, props, landerKind }`. Generates copy ([[ad-statics-copy]]) for advertorial/big_claim/before_after; testimonial/authority use REAL review/endorsement text. Heroes: reuse `hero_image_url` (avatar) or generate+persist ingredient/face via [[gemini]] (reuse-if-present). |

## Image rules (hard — Dylan)
NEVER product-on-white → product images are the isolated transparent cutout (`product_variants.isolated_image_url`). Advertorial heroes are avatars or ingredient shots only. Use REAL `product_media` (`endorsement_1_avatar`, `before`/`after`) when present; generated faces are lifestyle models, never attributed.

## Callers
- `src/lib/inngest/ad-tool.ts` — `adToolStaticRequested` (killer branch).
- `src/app/dashboard/marketing/ads/[id]` — archetype labels (mirrored client-side).
- `scripts/seed-killer-statics.ts`.

## Related
[[ad-statics-copy]] · [[ad-static]] (legacy) · [[ad-angles]] · [[ad-validator]] · [[gemini]] · [[ad-render]] · [[ad-storage]] · [[../inngest/ad-tool]] · [[../integrations/remotion-lambda]] · [[../lifecycles/ad-static]]
