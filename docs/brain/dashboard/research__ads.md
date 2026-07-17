# Research › Ads (`/dashboard/research/ads`)

Owner-facing browse of the **competitor ads** we found in the ad library for our seeded competitors — split **Static vs Video** and filterable by one of the ~6 **advertised (hero) products**. Sibling of [[research__competitors]] under the Research section ([[../libraries/control-tower-node-registry]] Rhea's research surfaces). Read-only.

## Data
- Reads [[../tables/creative_skeletons]] via `GET /api/ads/creative-finder?workspaceId=&mediaType=&productId=` — the same route Marketing › Ads › Winning statics uses, extended with two filters: `mediaType` (`static` | `video` → `.eq('media_type', …)`) and `productId` (`.eq('product_id', …)`). Owner/admin-gated (403 otherwise).
- The **product dropdown** is populated by `GET /api/ads/advertised-products?workspaceId=` → the `is_advertised=true` hero products (`{id,title}`) via [[../libraries/advertised-products]] `listAdvertisedProductIds`.

## UI
- **Static | Video** segmented toggle (default **Static** — we research static creative). `media_type` is the clean discriminator (survives the video→analyzed status transition).
- **Product** `<select>` (All products + the ~6 hero products).
- A card grid (image/keyframe + advertiser + days-running + hook/mechanism/proof/offer), reusing the Winning-statics card shape. Video cards carry a `▶ video` badge.

## Collection note (image-only)
The scout ([[../inngest/creative-scout]] → [[../libraries/creative-skeleton]] `sweepSeed`) now searches the ad library **image-only** (`adsType:["1"]`), `daysBack:90` (UI default), `pageSize:50` (API max) — founder 2026-07-17: "we aren't doing video stuff." So the Video view is effectively historical; new collection lands as Static. See [[../integrations/adlibrary]].

## Related
[[research__competitors]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../inngest/creative-scout]] · [[../tables/creative_skeletons]]
