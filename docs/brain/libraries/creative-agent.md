# `src/lib/ads/creative-agent.ts`

The deterministic loop behind **Dahlia**, the Ad Creative Agent — a box lane, peer to [[media-buyer-agent|Bianca]] under Max ([[../functions/growth]]). She keeps Bianca's ready-to-test bin stocked with fresh, fully-backed static ads so the media-buyer test loop never starves for angles.

## The pipeline (per creative)
```
getProductIntelligence  →  selectAngles + buildCreativeBrief  →  generateCreative  →  qaCreative  →  insert into bin
   [[product-intelligence]]     [[creative-brief]]              [[creative-generate]]  [[creative-qa]]
```
Every step is grounded so the creative can auto-publish with **no human gate**: the brief's claims trace to product-intelligence, the price is an allowed treatment (never bare MSRP), and the render passes a vision QA. On a QA fail it regenerates (up to `MAX_QA_ATTEMPTS`).

## `runAdCreativeLoop(admin, { workspaceId, productId?, count?, binFloor? }) → AdCreativeRunResult`
- With `productId` + `count`: tops that product up by `count` (capped at `MAX_PER_JOB`) — the shape the cadence cron sends.
- With no `productId`: finds every product with ad intelligence (a [[../tables/product_ad_angles]] row), measures each one's bin depth via [[ready-to-test]] `listReadyToTest`, and tops up any below `DEFAULT_BIN_FLOOR` (4).

**Angle selection** cycles the top-ranked angles from `selectAngles`, skipping hooks already represented by an existing campaign for that product (variety, not dupes). Transformation stories (the "I lost 84 lbs" reviews) are scanned directly from [[../tables/product_reviews]] since the SDK only surfaces featured/recent/withPhotos.

## Bin insertion (mirrors `/api/ads/upload-static`)
`insertReadyCreative` writes: a [[../tables/product_ad_angles]] row (`generated_by:'ad-creative-agent'`, with Meta copy from the brief) → an [[../tables/ad_campaigns]] row `status:'ready'` → a static [[../tables/ad_videos]] child (`media_kind:'static'`, `format:'feed_4x5'`), uploads the render to the private `ad-tool` bucket at `finals/{ws}/{video_id}.jpg` ([[ad-storage]]), stamps `static_jpg_url` + `status:'ready'`, and sets the campaign's `landing_url` to the **battle-tested Shopify PDP** `{shopify_primary_domain}/products/{handle}` (e.g. `superfoodscompany.com/products/superfood-tabs`; policy CEO 2026-07-10 — the in-house storefront / advertorial-variant landers are a LATER experiment tested only once a creative wins). Never the unreliable `shopify_domain` field. `listReadyToTest` then surfaces it to Bianca automatically.

## Runtime
A **deterministic Node lane** (mirrors [[media-buyer-agent]]) dispatched by [[builder-worker]] `runAdCreativeJob` on `kind='ad-creative'` — no Max session; the only metered calls are image gen + one vision-QA per creative. Enqueued daily by [[../inngest/ad-creative-cadence]]. Full trace: [[../lifecycles/ad-creative]].
