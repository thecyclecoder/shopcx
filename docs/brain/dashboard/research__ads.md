# Research › Ads (`/dashboard/research/ads`)

Owner-facing browse of the **competitor ads** we found in the ad library for our seeded competitors — split **Static vs Video** and filterable by one of the ~6 **advertised (hero) products**. Sibling of [[research__competitors]] under the Research section ([[../libraries/control-tower-node-registry]] Rhea's research surfaces). Read-only.

## Data
- **List** reads [[../tables/creative_skeletons]] via `GET /api/ads/creative-finder?workspaceId=&mediaType=&productId=` — the same route Marketing › Ads › Winning statics uses, extended with `mediaType` (`static` | `video` → `.eq('media_type', …)`) and `productId` (`.eq('product_id', …)`). Owner/admin-gated (403 otherwise).
- **Detail** reads ONE ad via `GET /api/ads/creative-finder?workspaceId=&skeletonId=` — a single-row branch that returns the ad regardless of status/media_type (the owner clicked into it), `404` when the id doesn't resolve in the workspace.
- The **product dropdown** is populated by `GET /api/ads/advertised-products?workspaceId=` → the `is_advertised=true` hero products (`{id,title}`) via [[../libraries/advertised-products]] `listAdvertisedProductIds`.

## UI — list (`/dashboard/research/ads`)
- **Static | Video** segmented toggle (default **Static** — we research static creative). `media_type` is the clean discriminator (survives the video→analyzed status transition).
- **Product** `<select>` (All products + the ~6 hero products).
- A **clean, clickable card grid** (image/keyframe + advertiser + days-running + hook). **No action buttons on the list** — the founder's "don't cram the list view" (CEO 2026-07-20): each card is a `next/link` to the detail page, where the actions live. A `do_not_use` ad renders **dimmed + grayscale** with a red **"don't use"** badge. Video cards carry a `▶ video` badge.

## UI — detail (`/dashboard/research/ads/[id]`)
The per-ad detail page: the full creative (large) + hook / mechanism / proof / offer / seed + the **two actions**:

### "Generate ad like this" (self-service Dahlia/Max — "make one like THIS ad")
- **Audience** temperature segmented control (**cold** / warm / hot, default cold).
- **Product** `<select>` (the ~6 hero products, defaulting to THIS ad's `product_id`).
- **"Imitate this exact ad"** checkbox (**default ON** — the reason you're on this ad's page). Checked → THIS ad's `creative_skeletons.id` is passed as `competitorSkeletonId` and becomes the EXACT imitation base; unchecked → Dahlia ranks the product's whole competitor shelf and picks the base herself.
- **Generate** POSTs `POST /api/ads/generate { workspaceId, productId, temperature, competitorSkeletonId? }` (owner/admin-gated, hero-product-gated via [[../libraries/advertised-products]] `listAdvertisedProductIds`; a pinned id is validated to exist in the workspace → 400 otherwise) which calls [[../libraries/ad-creative-trigger]] `triggerAdGeneration`. That SDK ONLY ever enqueues `kind='ad-creative-copy-author'` — the box-session path that runs the **5 psychological treatments** (LF8 / Schwartz / Cialdini / Hopkins / Sugarman) **+ Max copy-QC** — never the deterministic `buildMetaCopyPack` node path. A `✓ Launched Dahlia/Max · <temp> · imitating this ad|shelf-ranked · job <id>` line shows on success.

**How the pin lands:** the SDK writes `competitor_skeleton_id` onto the job instructions → `runAdCreativeCopyAuthorJob` threads it into `runAdCreativeLoop` (`pinnedCompetitorSkeletonId`) → [[../libraries/creative-agent]] `stockProduct` loads that exact skeleton via [[../libraries/creative-sourcing]] `getCompetitorAngleBySkeletonId` and makes it the SOLE competitor angle — bypassing the shelf ranking, the cold/warm temperature exclusion, and the do_not_use/retired filters (an explicit human pick overrides the auto-selection guards). The unchanged downstream pipeline then does **composition transfer** (reuse that ad's winning layout, swap in our product) + **riff** (blend the product's lead benefit onto the hook), so "imitate this ad" means imitate its layout/structure adapted to our brand — not copy it verbatim. A missing packshot still skips (`planCompositionTransfer`) + escalates. Temperature still shapes the COPY (offer stripping etc.). Trace the produced ad with [[../libraries/ads-read-sdk]] `traceAdOrigin`.

### "Don't use" toggle ([[../specs/flag-a-competitor-ad-do-not-use-manual-ceo-then-max-graded]] Phase 2)
A **"Don't use" / "Use again"** button flips [[../tables/creative_skeletons]] `do_not_use` through `PATCH /api/ads/competitors/[id]` (under PATCH the `[id]` is a `creative_skeletons.id`, verb-scoped by design — POST on the same route addresses a competitor brand). The route calls the sole write chokepoint [[../libraries/creative-skeleton]] `setSkeletonDoNotUse` ({ workspaceId, skeletonId, doNotUse, reason, by: 'ceo' }) which compare-and-sets on `(workspace_id, id)` and stamps the audit trio (reason='ceo_manual' by default, by='ceo', at=now). Optimistic write (rolls back if the server rejects). Flagged rows are invisible to Dahlia: [[../libraries/creative-sourcing]] `queryProvenAngles` filters `.eq('do_not_use', false)` (Phase 1) so a weak imitation base never becomes an angle (Magic Mind display-box packshot vs. Onnit "Lock in when it matters most" — same tier, only one worth imitating). (A pinned generate deliberately bypasses this — an explicit "imitate THIS ad" overrides the flag.)

## Collection note (image-only)
The scout ([[../inngest/creative-scout]] → [[../libraries/creative-skeleton]] `sweepSeed`) now searches the ad library **image-only** (`adsType:["1"]`), `daysBack:90` (UI default), `pageSize:50` (API max) — founder 2026-07-17: "we aren't doing video stuff." So the Video view is effectively historical; new collection lands as Static. See [[../integrations/adlibrary]].

## Related
[[research__competitors]] · [[../integrations/adlibrary]] · [[../libraries/creative-skeleton]] · [[../libraries/ad-creative-trigger]] · [[../inngest/creative-scout]] · [[../tables/creative_skeletons]]
