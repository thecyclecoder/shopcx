# Lifecycle — Ad Creative Agent (Dahlia)

End-to-end trace of how a fresh Meta static ad goes from raw product intelligence to a ready-to-test creative in [[../functions/growth|Bianca]]'s bin, with **no human gate** — because every claim is verifiable by construction and the render is vision-QA'd. Dahlia is a worker under Max, peer to Bianca ([[../functions/growth]]).

## The chain

1. **Cadence** — [[../inngest/ad-creative-cadence]] `adCreativeCadenceCron` (`0 11 * * *`) fans out per workspace; `dispatchAdCreativeCadence` measures each intelligence-backed product's bin depth ([[../libraries/ready-to-test]] `listReadyToTest`) and enqueues an [[../tables/agent_jobs]] `kind='ad-creative'` job (with the deficit) for any product below `DEFAULT_BIN_FLOOR` (4). Idempotent per UTC day.

2. **Claim + dispatch** — [[../libraries/builder-worker]] fills the `ad-creative` lane (`MAX_AD_CREATIVE`, deterministic Node) and `runAdCreativeJob` calls [[../libraries/creative-agent]] `runAdCreativeLoop`.

3. **Intelligence** — [[../libraries/product-intelligence]] `getProductIntelligence` fans out every `product_*` table for the product (benefits, ingredient research + citations, ad angles, review clusters, featured/transformation reviews, media, variants, store proof points, the computed offer).

4. **Angle** — [[../libraries/creative-brief]] `selectAngles` scores candidates on **two axes**: `acquisitionPower` (cold-scroll stopping power — a real transformation, a skeptic objection, curiosity) vs `retentionTruth` (energy-no-crash, taste). The commodity "no-crash" angle — the #1 review cluster but a converts-nobody cold hook — is **demoted** to supporting body copy. The top acquisition angle leads.

5. **Brief** — `buildCreativeBrief` assembles the hook + lead proof (a real review or ingredient citation) + a **single-reviewer transformation** (quote + name + photo, all the same person) + supporting retention truths + proof stack + the **offer as an allowed price treatment** (strikethrough→discount or per-serving-vs-latte — never bare MSRP) + image refs.

6. **Generate** — [[../libraries/creative-generate]] `generateCreative` turns the brief into a Nano Banana Pro prompt ([[../libraries/gemini]]) and renders a 4:5 static. A before/after MAY be an AI-generated **photorealistic full-body** transformation (CEO grey-area call, 2026-07-10) — but the quote+name are a real review and nothing captions the image as authentic.

7. **QA gate** — [[../libraries/creative-qa]] `qaCreative` runs an Opus vision pass: headline exact, all text legible, no bare price, no fabricated authenticity caption, transformation photorealistic (not cartoon). **Fails closed.** On fail, regenerate (up to `MAX_QA_ATTEMPTS`).

8. **Bin insertion** — `insertReadyCreative` (mirrors `/api/ads/upload-static`): [[../tables/product_ad_angles]] → [[../tables/ad_campaigns]] `status='ready'` → static [[../tables/ad_videos]] child, render uploaded to the private `ad-tool` bucket ([[../libraries/ad-storage]]), `landing_url` = the **battle-tested Shopify PDP** `{shopify_primary_domain}/products/{handle}` (policy CEO 2026-07-10; storefront / advertorial-variant landers are a later winner-only experiment).

9. **Handoff** — `listReadyToTest` now surfaces the campaign to Bianca's [[../libraries/media-buyer-agent]] test loop.

## North star
Dahlia optimizes a bounded proxy — *bin depth × brief quality* — and feeds Bianca; **Max owns the objective** (does the creative actually win in-market) and holds her leash. She never launches an ad herself; she stocks the bin, Bianca tests, the media-buyer grader scores realized ROAS. See [[../operational-rules.md]] § North star.

## Status / open work (2026-07-10)
- ✅ Shipped: SDK ([[../libraries/product-intelligence]]), brief ([[../libraries/creative-brief]]), generate ([[../libraries/creative-generate]]), QA ([[../libraries/creative-qa]]), loop + bin insertion ([[../libraries/creative-agent]]), lane ([[../libraries/builder-worker]] `runAdCreativeJob`), cadence cron ([[../inngest/ad-creative-cadence]]), persona (Dahlia 🎨). Smoke-tested end-to-end on Superfood Tabs (bin 4→5, generated the "84 lbs" creative, passed vision QA, inserted with a Shopify-PDP lander).
- ⏳ Open: the bin filling does **not** wake Bianca — she needs an active [[../tables/media_buyer_test_cohorts]] cohort + a shadow-mode [[../tables/iteration_policies]] policy for the downstream test loop to consume Dahlia's creatives.
- ⏳ Consider: a stories_9x16 variant per campaign (currently feed_4x5 only); a Slack digest of each pass up to Max (like Bianca's [[../libraries/media-buyer-director-digest]]).
