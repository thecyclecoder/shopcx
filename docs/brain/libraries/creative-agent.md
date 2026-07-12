# `src/lib/ads/creative-agent.ts`

The deterministic loop behind **Dahlia**, the Ad Creative Agent — a box lane, peer to [[media-buyer-agent|Bianca]] under Max ([[../functions/growth]]). She keeps Bianca's ready-to-test bin stocked with fresh, fully-backed static ads so the media-buyer test loop never starves for angles.

## The pipeline (per creative)
```
getProductIntelligence  →  selectAngles + buildCreativeBrief  →  generateCreative  →  QC gate  →  insert into bin
   [[product-intelligence]]     [[creative-brief]]              [[creative-generate]]  [[creative-qa]]
```
Every step is grounded so the creative can auto-publish with **no human gate**: the brief's claims trace to product-intelligence, the price is an allowed treatment (never bare MSRP), and the render passes a vision QC. On a QC fail it regenerates (up to `MAX_QA_ATTEMPTS`).

The QC gate has two paths (dahlia-creative-qc-via-box-session): the DEFAULT is `qaCreativeViaBoxSession` — a top-level `claude -p` on Max via the [[creative-qc|creative-qc]] skill, so the lane never needs an `ANTHROPIC_API_KEY`; the `DAHLIA_QC_MODE=direct` env kill-switch falls back to the legacy `qaCreative` Opus API call unchanged. Both paths **fail closed** — any session error / cap / timeout / undecodable image / unparseable verdict resolves to `pass:false` so nothing unchecked reaches the bin.

## `runAdCreativeLoop(admin, { workspaceId, productId?, count?, binFloor?, qcDispatcher? }) → AdCreativeRunResult`
- With `productId` + `count`: tops that product up by `count` (capped at `MAX_PER_JOB`) — the shape the cadence cron sends. **Hero-product advertising gate ([[advertised-products]]):** the single `productId` is checked with `isAdvertisedProduct` first — an attachment-SKU target (stray job / manual trigger) yields ZERO creatives (empty `targets`).
- With no `productId`: finds every product with ad intelligence (a [[../tables/product_ad_angles]] row), **intersects with `listAdvertisedProductIds`** ([[advertised-products]]) so attachment SKUs (Tumbler, Sleep Gummies, Handheld Drink Mixer, Bamboo Coffee Mug) never earn Dahlia work, then measures each one's bin depth via [[ready-to-test]] `listReadyToTest` and tops up any below `DEFAULT_BIN_FLOOR` (4). Empty gate ⇒ zero targets, no fallback.
- `qcDispatcher?: QcSessionDispatcher` — when set, each per-creative QC pass runs as a `claude -p` box session on Max via the caller's dispatcher ([[creative-qa]] `qaCreativeViaBoxSession`); when unset, `stockProduct` falls back to the direct-API `qaCreative`. [[builder-worker]] `runAdCreativeJob` reads `DAHLIA_QC_MODE` and injects the dispatcher iff mode `= "box"` (default) — mode `= "direct"` passes `undefined` so the legacy path runs unchanged.

**Selection = explore/exploit slot allocation** ([[creative-learning]]): the bin is stocked as a **2 exploit / 2 explore** mix so Bianca always has both to launch. **Exploit** = a fresh *combination* (new treatment) of a proven WINNING concept — double down on what converts without re-running the fatiguing ad. **Explore** = a fresh unproven concept — find the next winner before the current fatigues. Self-adjusts: with no winners yet it's all explore. A concept is only dropped once **retired** (3 distinct combinations lost with none won) — never after one loss. Transformation stories are scanned directly from [[../tables/product_reviews]].

## Bin insertion (mirrors `/api/ads/upload-static`)
`insertReadyCreative` writes: a [[../tables/product_ad_angles]] row (`generated_by:'ad-creative-agent'`, with Meta copy from the brief) → an [[../tables/ad_campaigns]] row `status:'ready'` → a static [[../tables/ad_videos]] child (`media_kind:'static'`, `format:'feed_4x5'`), uploads the render to the private `ad-tool` bucket at `finals/{ws}/{video_id}.jpg` ([[ad-storage]]), stamps `static_jpg_url` + `status:'ready'`, and sets the campaign's `landing_url` to the **battle-tested Shopify PDP** `{shopify_primary_domain}/products/{handle}` (e.g. `superfoodscompany.com/products/superfood-tabs`; policy CEO 2026-07-10 — the in-house storefront / advertorial-variant landers are a LATER experiment tested only once a creative wins). Never the unreliable `shopify_domain` field. `listReadyToTest` then surfaces it to Bianca automatically.

## Runtime
A **deterministic Node lane** (mirrors [[media-buyer-agent]]) dispatched by [[builder-worker]] `runAdCreativeJob` on `kind='ad-creative'` — no outer Max session for the lane itself; the metered calls are image gen (Nano Banana Pro, [[gemini]]) + one QC pass per creative. Under `DAHLIA_QC_MODE=box` (default) each QC is a Max-billed `claude -p` sub-session via the [[creative-qc|creative-qc]] skill (no `ANTHROPIC_API_KEY` needed); under `DAHLIA_QC_MODE=direct` each QC is a direct Opus API call ([[creative-qa]] `qaCreative`) so a bad rollout of the box path is one env flag away from revert. Enqueued daily by [[../inngest/ad-creative-cadence]]. Full trace: [[../lifecycles/ad-creative]].
