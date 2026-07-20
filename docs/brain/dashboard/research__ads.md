# Research › Ads (`/dashboard/research/ads`)

Owner-facing browse of the **competitor ads** we found in the ad library for our seeded competitors — split **Static vs Video** and filterable by one of the ~6 **advertised (hero) products**. Sibling of [[research__competitors]] under the Research section ([[../libraries/control-tower-node-registry]] Rhea's research surfaces). Read-only.

## Data
- Reads [[../tables/creative_skeletons]] via `GET /api/ads/creative-finder?workspaceId=&mediaType=&productId=` — the same route Marketing › Ads › Winning statics uses, extended with two filters: `mediaType` (`static` | `video` → `.eq('media_type', …)`) and `productId` (`.eq('product_id', …)`). Owner/admin-gated (403 otherwise).
- The **product dropdown** is populated by `GET /api/ads/advertised-products?workspaceId=` → the `is_advertised=true` hero products (`{id,title}`) via [[../libraries/advertised-products]] `listAdvertisedProductIds`.

## UI
- **Static | Video** segmented toggle (default **Static** — we research static creative). `media_type` is the clean discriminator (survives the video→analyzed status transition).
- **Product** `<select>` (All products + the ~6 hero products).
- A card grid (image/keyframe + advertiser + days-running + hook/mechanism/proof/offer), reusing the Winning-statics card shape. Video cards carry a `▶ video` badge.

## Per-AD "Don't use" toggle ([[../specs/flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded]] Phase 2)
Each card carries a **"Don't use" / "Use again"** button (owner-only surface — the API 403s non-owners) that flips [[../tables/creative_skeletons]] `do_not_use` for THAT ad through `PATCH /api/ads/competitors/[id]` (under PATCH the `[id]` is a `creative_skeletons.id`, verb-scoped by design — POST on the same route addresses a competitor brand). The route calls the sole write chokepoint [[../libraries/creative-skeleton]] `setSkeletonDoNotUse` ({ workspaceId, skeletonId, doNotUse, reason, by: 'ceo' }) which compare-and-sets on `(workspace_id, id)` and stamps the audit trio (reason='ceo_manual' by default, by='ceo', at=now). A flagged card renders **dimmed + grayscale** with a red **"don't use"** badge in the corner (the reason/by/at surface as the hover title). The write is optimistic — the UI paints the flag before the PATCH lands, and rolls back the state if the server rejects. Flagged rows are then invisible to Dahlia: [[../libraries/creative-sourcing]] `queryProvenAngles` filters `.eq('do_not_use', false)` (Phase 1) so an ad the CEO marked as a weak imitation base never becomes an angle even if it's a proven long-runner (Magic Mind display-box packshot vs. Onnit "Lock in when it matters most" — same tier, only one worth imitating).

## Per-card "Generate ad" (self-service Dahlia/Max)
Each card carries a **"Generate ad"** button that opens an inline panel: a **temperature** segmented control (**cold** / warm / hot, default cold) + a **target product** `<select>` (the ~6 hero products, defaulting to THIS card's `product_id`). Hitting **Generate** POSTs `POST /api/ads/generate { workspaceId, productId, temperature }` (owner/admin-gated, hero-product-gated via [[../libraries/advertised-products]] `listAdvertisedProductIds`) which calls [[../libraries/ad-creative-trigger]] `triggerAdGeneration`. That SDK ONLY ever enqueues `kind='ad-creative-copy-author'` — the box-session path that runs the **5 psychological treatments** (LF8 / Schwartz / Cialdini / Hopkins / Sugarman) **+ Max copy-QC** — never the deterministic `buildMetaCopyPack` node path. So a self-service generate can only ever produce a real Dahlia/Max creative. The card shows a `✓ Launched Dahlia/Max · <temp> · job <id>` line on success (or a red error). This is the "stop coming to the CLI to ask for an ad" surface (CEO 2026-07-20). Trace the produced ad with [[../libraries/ads-read-sdk]] `traceAdOrigin` (author self-score present, Max graded, treatments applied). Not yet wired: pinning THIS specific competitor ad as the imitation base (`competitorSkeletonId`) — a fast follow-up; today the box session ranks the product's whole shelf itself.

## Collection note (image-only)
The scout ([[../inngest/creative-scout]] → [[../libraries/creative-skeleton]] `sweepSeed`) now searches the ad library **image-only** (`adsType:["1"]`), `daysBack:90` (UI default), `pageSize:50` (API max) — founder 2026-07-17: "we aren't doing video stuff." So the Video view is effectively historical; new collection lands as Static. See [[../integrations/adlibrary]].

## Related
[[research__competitors]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../libraries/ad-creative-trigger]] · [[../inngest/creative-scout]] · [[../tables/creative_skeletons]]
