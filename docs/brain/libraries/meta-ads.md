# `src/lib/meta-ads.ts` — Meta Marketing API ad publishing

The WRITE half of the Meta integration (Graph **v21.0**): list targets + upload video → creative → ad. Reads the per-workspace `ads_management` user token from `meta_connections`. POSTs are **form-encoded** (`metaPost` — `URLSearchParams`, nested objects JSON-stringified; the Marketing API rejects JSON bodies). Replicates the working publisher in the sibling `shopgrowth` repo. See [[../lifecycles/ad-publish]].

## Exports

| Export | Notes |
|---|---|
| `getMetaUserToken(workspaceId)` | decrypt active `meta_connections.access_token_encrypted` (fallback `workspaces.meta_user_access_token_encrypted`) |
| `listAdAccounts(token)` | `/me/adaccounts` |
| `listCampaigns(token, accountId)` | `act_{id}/campaigns` (ACTIVE+PAUSED) |
| `listAdSets(token, accountId, campaignId?)` | `act_{id}/adsets` (filtered by campaign) |
| `listAdsForCampaignWithCreative(token, campaignId)` | **[[../specs/graduate-crowned-winners-into-the-cold-scaler-mint-campaign-and-duplicate]] Phase 2** — `GET /{campaignId}/ads?fields=id,creative{id}&effective_status=["ACTIVE","PAUSED","DELETED","ARCHIVED"]`. Idempotency source behind [[media-buyer-graduate-scaler]] `graduateCrownedWinnerToScaler`'s Gate-4 (never double-mint the same creative under the scaler campaign). Returns `Array<{ adId, creativeId }>` — ads whose `creative.id` is missing are dropped; the wide `effective_status` (incl. DELETED + ARCHIVED) prevents a manually-archived prior graduate from silently unblocking a re-mint. |
| `getAdSetTargetingAndPixel(token, adsetId)` | **[[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]] Phase 1** — `GET /{adsetId}?fields=targeting,promoted_object`. The graduate flow ([[media-buyer-graduate-scaler]] `graduateCrownedWinnerToScaler`) needs the winning ad set's `targeting` spec + `promoted_object.pixel_id` to duplicate its adset into the scaler campaign; Meta stores both per-adset, not in our DB. Returns `{ targeting, pixelId }` or `null` when either is missing (a manually-crafted adset without a promoted_object) — the caller then skips the graduate silently rather than propagating a partial payload. |
| `listPages(token)` | `/me/accounts` + linked IG → `instagram_user_id` |
| `uploadAdVideo(token, accountId, fileUrl, name)` | `act_{id}/advideos` (`file_url`; Meta downloads) → video_id |
| `waitForVideoReady(token, videoId)` | poll `GET /{video_id}?fields=status` until `video_status='ready'` |
| `uploadAdImage(token, accountId, bytes)` | `act_{id}/adimages` (multipart) → image hash (thumbnails) |
| `getVideoThumbnail(token, videoId)` | `GET /{video_id}/thumbnails` → preferred auto-thumbnail URI |
| `createAdCreative(token, args)` | `act_{id}/adcreatives` → creative_id. **Two shapes by media:** <br>• **Static image = a LINK AD → `object_story_spec.link_data`** (`image_hash`,`link`,`message`=body,`name`=headline,`call_to_action.type`). ⚠️ `image_data` REJECTS the destination link with `meta_400 "The link field is required"` (subcode 2061015) even when `link` is set — verified against Graph v21.0 2026-07-12; this silently broke every static ad. `link_data` carries ONE copy set (no `asset_feed_spec` — it also fails the link check for image link ads), which is exactly the per-test model (one hook per creative). <br>• **Video** — `object_story_spec.video_data` (`video_id`,`image_hash` thumb,`call_to_action.value.link`) + multi-text variations in `asset_feed_spec` (`titles[]`/`bodies[]`, `optimization_type:DEGREES_OF_FREEDOM`, NO `videos`/`ad_formats`/`link_urls`) + `degrees_of_freedom_spec` text-opt OPT_OUT. <br>Both: top-level `url_tags`. |
| `createAdCreativeFromPost(token, args)` | `act_{id}/adcreatives` with **`object_story_id`** → creative_id. Ads Manager's **"Use existing post"**: the new ad inherits that post's likes / comments / shares instead of starting at zero. `object_story_id` and `object_story_spec` are **mutually exclusive** — this is the sibling of `createAdCreative`, never a variant of it. Only `url_tags` may be added; the post owns its link, headline, body and CTA. |
| `createPlacementCreative(token, args)` | **Battle-tested 2026-07-16 (creative `780957111743379`)** — 3-bucket PLACEMENT-customized STATIC creative: one **portable** (NOT Dynamic Creative) ad that serves feed 4:5, stories/reels 9:16, and right-column 1:1, carrying N titles + N bodies rotated across every placement. Shape: `object_story_spec:{page_id,instagram_user_id}` (page identity only — no `link_data`/`image_data`); `asset_feed_spec.ad_formats:["AUTOMATIC_FORMAT"]` (pinning `SINGLE_IMAGE` flips it to Dynamic Creative → rejected outside a DCO adset); `optimization_type:"PLACEMENT"`; **3 `images`** each `adlabels`-tagged (feed image ALSO carries the `default` label so the priority-4 rule has an asset); `titles`/`bodies` each `adlabels`-tagged to ALL FOUR placement labels so Meta rotates every headline+body per placement; `link_urls:[{website_url,display_url?,adlabels:all}]`; `call_to_action_types:[ctaType]`; **4 `asset_customization_rules`** — feed (p1) FB feed/profile_feed/marketplace + IG stream/explore_home/profile_feed · stories (p2) FB story/facebook_reels/video_feeds + IG story/reels · rightcol (p3) FB `right_hand_column`+search · default (p4) empty spec; `degrees_of_freedom_spec.creative_features_spec.text_optimizations.enroll_status:"OPT_OUT"` (Meta must NOT rewrite our copy). Top-level `url_tags` preserved. Verified by `meta-ads.placement.test.ts`. |
| `createDualAssetCreative(token, args)` | **2-bucket PLACEMENT-customized creative** — serves feed 4:5 + stories/reels 9:16 with an optional 3rd right-column 1:1 asset. Same `AUTOMATIC_FORMAT` + `PLACEMENT` shape as `createPlacementCreative` (portable, NOT Dynamic Creative), just narrower coverage: used by the 2-bucket static fallback path in [[../inngest/ad-tool]] `adToolPublishToMeta` when the full 3-bucket `createPlacementCreative` gate is skipped, AND by the video branch (a dual video ad is image-free by shape — the right-column placement is image-only for this creative kind). **[[../specs/bianca-static-publish-uses-all-5-copy-variations-and-correct-right-column-placement]] Phase 2** — when the caller opts in with a `rightColumnImageHash` (image branch only), the builder switches to a 3-image / 4-rule shape: 3 `images` with the feed 4:5 image ALSO carrying the `default` adlabel (feed 4:5 is the safe default fallback per spec Phase 2 — story 9:16 no longer doubles as default), a stories-only image, and a rightcol image; 4 `asset_customization_rules` — feed (p1) FB feed/profile_feed/marketplace + IG stream/explore_home/profile_feed · stories (p2) FB story/facebook_reels/video_feeds + IG story/reels · rightcol (p3) FB `right_hand_column`+search · default (p4) empty spec; feed rule loses `search` (rightcol rule now owns it). When `rightColumnImageHash` is absent (a legacy caller or the video branch), the pre-Phase-2 2-bucket shape is preserved byte-identically: 2 images (feed + stories) with the STORY 9:16 image carrying `stories`+`default`, 3 rules (feed / stories / default) with feed rule including `search` — every existing test path and caller stays unchanged. The pre-Phase-2 defect the CEO caught on Meta ad `120250417578580326` ('Steady Energy') was the right-column placement rendering the 9:16 story via the default rule; Phase 2's opt-in rule set gives that placement the 1:1 asset. Verified by `meta-ads.dual.rightcol.test.ts` (Phase 2 opt-in, legacy 2-bucket compat, video-branch never-carries-rightcol pins). |
| `createAd(token, accountId, {name,adsetId,creativeId,status})` | `act_{id}/ads` (default PAUSED) → ad_id |
| `updateObjectStatus(token, objectId, status)` | **Iteration Engine 6a** — `POST /{object_id}` `status=ACTIVE\|PAUSED` (ad/adset/campaign); pause/unpause an existing live object |
| `updateObjectBudget(token, objectId, {dailyBudgetCents?,lifetimeBudgetCents?})` | **Iteration Engine 6a** — `POST /{object_id}` `daily_budget`/`lifetime_budget` (cents → integer minor units); scale an adset/campaign on its existing budget field |
| `updateAdSetTargeting(token, adsetId, targeting)` | **CEO 2026-08-25** — replace an ad set's `targeting` spec (`POST /{adsetId}`, spec JSON-ENCODED). ⚠️ **REPLACE, not merge** — Meta overwrites the whole spec, so callers MUST read the current targeting via `getAdSetTargetingAndPixel` and spread it, or they silently drop geo / age / audience exclusions. Added to repair legacy adsets minted before the existing-customer exclusions existed (see [[../tables/meta_adsets]] § `clean_signal_since`). A mid-flight targeting edit also resets Meta's learning phase — a non-issue here, since we are permanently learning-limited (2-8 conversions/adset/week vs the ~50 exit threshold). |
| `createCampaign(token, accountId, {name, objective?, abo?, specialAdCategories?, buyingType?, status?, dailyBudgetCents?, lifetimeBudgetCents?, newCustomerBudgetPercentage?, smartPromotionType?})` | **Media-buyer loop** — `act_{id}/campaigns`. Defaults: PAUSED, `OUTCOME_SALES`, `AUCTION`, `special_ad_categories=[]`, ABO (`is_adset_budget_sharing_enabled=false`, no campaign budget — Meta REQUIRES this flag on a budget-less campaign, 2026-07-07). CBO branch (`abo=false`) sets `daily_budget`/`lifetime_budget` in minor units. **Advantage+ Sales knobs (Bianca M4 cold-scaler, 2026-07-17)**: `newCustomerBudgetPercentage=0` sends `existing_customer_budget_percentage=0` = new-customer-only; `smartPromotionType="AUTOMATED_SHOPPING_ADS"` sends `smart_promotion_type` for Advantage+ Sales. Both are pass-through nulls by default so existing test-campaign creation is unchanged → campaign_id |
| `getOrCreateTestingCampaign(token, accountId)` | **Media-buyer loop** — find-or-create the shared `"MB — Testing (ABO)"` PAUSED ABO campaign by exact name (via `listCampaigns`). Idempotent — the loop parks every new test ad set under this one shared campaign. Exposes `MB_TESTING_CAMPAIGN_NAME` for callers → campaign_id |
| `getOrCreateColdScalerCampaign(token, accountId, {cohortId, dailyCeilingCents, name?})` | **[[../specs/bianca-cold-scaler-graduate-crowned-winners-to-advantage-plus-new-customers]] Phase 1** — find-or-create the ONE consolidated cold-scaler CBO/Advantage+ Sales campaign per `media_buyer_cold_scaler_cohorts` row. Idempotent by exact name match (`coldScalerCampaignName(cohortId)` → `"MB — Cold Scaler (<cohortId 8 chars>)"`) via `listCampaigns`. Otherwise mints a PAUSED `OUTCOME_SALES` **ABO** campaign (**CEO 2026-08-25** — was CBO/Advantage+; a CBO scaler hands ALLOCATION to Meta and the CEO observed ~95% of spend going behind a single ad, so the portfolio of graduated winners never got funded. Per-adset budgets keep allocation ours). `dailyCeilingCents` is therefore **governance only** — it stays on the cohort row and does NOT become a campaign budget. No `bid_strategy` on the campaign either: on ABO Meta owns it at the ad-set level and `createAdSet` already defaults `LOWEST_COST_WITHOUT_CAP`. Returns the bare Meta campaign id; the caller ([[media-buyer-cold-scaler-cohort]] `mintAndProvisionColdScalerCampaign`, in turn invoked from [[media-buyer-agent]] `runGraduateForCrownedWinners` per **[[../specs/bianca-actually-graduates-crowned-winners-and-a-dead-meta-verb-cannot-fail-silently]] Phase 1**) then compare-and-set-stamps it onto `media_buyer_cold_scaler_cohorts.scaler_meta_campaign_id` via `setColdScalerCampaignId` so a race can't double-mint → campaign_id |
| `coldScalerCampaignName(cohortId)` | Stable name builder for a cohort's cold-scaler campaign (`"MB — Cold Scaler (<first 8 chars of cohort UUID>)"`) — exported so callers can compute the expected name without drift. |
| `createAdSet(token, accountId, {name, campaignId, dailyBudgetCents\|lifetimeBudgetCents, pixelId, targeting, optimizationGoal?, billingEvent?, bidStrategy?, bidAmountCents?, customEventType?, startTime?, endTime?, status?})` | **Media-buyer loop** — `act_{id}/adsets`. Purchase-optimized defaults (docs/brain/reference/meta-scaling-methodology.md): PAUSED, `optimization_goal=OFFSITE_CONVERSIONS`, `billing_event=IMPRESSIONS`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `promoted_object={pixel_id, custom_event_type:"PURCHASE"}`. Placements are Advantage+ by default — the ad-set body does NOT force `publisher_platforms`/`*_positions`; pass them via `targeting` only to opt out of automatic placements → adset_id |
| `MB_TESTING_CAMPAIGN_NAME` | Stable name (`"MB — Testing (ABO)"`) for the shared media-buyer testing campaign — export so downstream code doesn't drift on the string |
| `listCustomAudiences(token, accountId)` | **[[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 1** — `GET /act_{id}/customaudiences?fields=id,name,subtype,retention_days&limit=200`. Find-first idempotency source behind `getOrCreateRecentPurchaserAudience` → `Array<{ id, name, subtype, retention_days }>` |
| `getOrCreateRecentPurchaserAudience(token, accountId, pixelId, opts?)` | **[[../specs/bianca-cold-test-recent-purchaser-exclusion]] Phase 1** — find-or-create the pixel-side "last-180d purchasers" website custom audience (`subtype='WEBSITE'`, `pixel_id`, rule matching the `Purchase` pixel event across `retention_seconds = retentionDays * 86400`). Idempotent by exact name (`MB — Purchasers (${retentionDays}d) — pixel ${pixelId}`). Default `retentionDays=180` (Meta's max, per the founder refinement 2026-07-15). Returns the BARE Meta customaudience id (not our uuid) — the id Bianca composes into every per-test ad set's `targeting.excluded_custom_audiences` so existing buyers cannot see the cold ad and contaminate the read → `string` |
| `getOrCreateAllCustomersAudience(token, accountId, opts?)` | **[[../specs/bianca-full-order-history-customer-list-exclusion-audience]] Phase 1** — find-or-create the upload-based CUSTOMER_LIST custom audience the cohort uses to exclude our entire existing-customer base across all three order sources (`subtype='CUSTOMER_LIST'`, `customer_file_source='USER_PROVIDED_ONLY'`, no rule — populated via `addUsersToCustomAudience`). Idempotent by exact name (`MB — All customers (all sources) — hashed`). Returns the BARE Meta customaudience id (not our uuid) — the second id Bianca composes into every per-test ad set's `targeting.excluded_custom_audiences` alongside `getOrCreateRecentPurchaserAudience`'s id, giving complete existing-customer coverage the 180d pixel audience misses (>180d, Amazon, pixel-untracked) → `string` |
| `addUsersToCustomAudience(token, audienceId, rows, opts?)` | **[[../specs/bianca-full-order-history-customer-list-exclusion-audience]] Phase 1** — chunk-upload SHA256-hashed users to a CUSTOMER_LIST audience via `POST /{audience_id}/users` with `schema=['EMAIL_SHA256','PHONE_SHA256']`. Normalizes email (lowercase + trim) and phone (E.164 digits only, 10-digit numbers assumed US) before hashing, skips rows whose email AND phone are both empty, and chunks at ≤ `META_CUSTOMAUDIENCE_USERS_CHUNK` (10,000) rows per POST. Only SHA256 hex leaves the box — plaintext PII is never uploaded and never logged. Returns per-chunk `{audience_id, num_received}` for observability → `Array<{ audience_id: string; num_received: number }>` |
| `normalizeEmailForHash(email)` / `normalizePhoneForHash(phone)` | **[[../specs/bianca-full-order-history-customer-list-exclusion-audience]] Phase 1** — exported normalization helpers used by `addUsersToCustomAudience` before SHA256. Email → lowercase-trimmed or `null` if empty; phone → digit-only E.164 (10-digit → `1`-prefixed) or `null` if empty. |
| `META_CUSTOMAUDIENCE_USERS_CHUNK` | Meta's upper bound (10,000) on rows per `POST /{audience_id}/users` payload — exported so callers can size their own batching against the same constant. |

`META_CTA_TYPES` + `generateMetaCopy` live in `src/lib/ad-meta-copy.ts` (Opus copy gen). Errors throw `meta_{status}: {graph message}`.

`updateObjectStatus`/`updateObjectBudget` are the raw Graph writes behind the autonomous adapters in [[meta__execution]] (Phase 6a) — manage EXISTING live objects only; the engine never sets ACTIVE on a draft/new object.

## Caller

[[../inngest/ad-tool]] `adToolPublishToMeta`; the API routes `/api/ads/meta` + `/api/ads/campaigns/[id]/{meta-copy,publish}`; [[meta__execution]] (`updateObjectStatus`/`updateObjectBudget`, Iteration Engine 6a).

## Gotchas

- **Post reuse (`createAdCreativeFromPost`) inherits a destination you cannot see or change.**
  The post owns its link; the ads API does NOT return it back off the creative, and reading the
  post directly needs `pages_read_engagement`, which the platform token does not carry. A post
  pointing at a retired lander produces an ad pointing at a retired lander — **verify the
  destination in the ad preview before spending.** Only `url_tags` can be added.
- **Post ids are `{pageId}_{postId}`, and the page number in a Facebook URL is often wrong.**
  `facebook.com/{n}/posts/{id}` frequently shows the page's LINKED-PROFILE id (`1000…`), which the
  ads API rejects. Build the id from the page id in `listPages`, or read `effective_object_story_id`
  off the original ad (which is also the only way to resolve a DCO ad — one may have no single
  reusable post at all).
- **A creator-page (branded-content) post needs that grant still in force.** Meta rejects with
  `(#200)` / `(#1487472)` when it has lapsed. Attempting the creative is the ONLY reliable test —
  the same `pages_read_engagement` gap blocks any pre-check.
- **The ads-management throttle is account-wide** (`code 80004` / subcode `2446079`, and
  `code 4` / `1504022` at the app level). A wide scan — paging every ad plus multi-window
  ad-level insights — trips it for the whole ad account, blocking WRITES as well as reads, and
  each further call extends it. Back off rather than retry tightly; it typically clears in
  30–60 min.

- `metaGet`/`metaPost` route through [[meta__graph-retry]] `graphFetchJson` —
  transient Meta errors (code 1/2, `is_transient`, 429, 5xx) retry with bounded
  backoff; fatal errors (token/permission/validation) fail fast with
  `error_user_title`/`msg` detail. **The multipart `adimages` upload now routes through `graphFetchJson` as well** — `uploadAdImage` rebuilds a fresh FormData body inside the request thunk on each retry attempt (FormData-backed Blob cannot be reused across fetches) and applies the same bounded transient retry policy ([[../specs/meta-adimage-multipart-retry]] P1).

## Related

[[../lifecycles/ad-publish]] · [[ads__placement-publish]] · [[ads__creative-pack-gate]] · [[../integrations/meta-marketing]] · [[../tables/ad_publish_jobs]] · [[crypto]] · [[meta__graph-retry]]

---

## ⭐ The cold scaler is ABO, not CBO (CEO 2026-08-25)

`coldScalerCampaignName(cohortId, productTitle?)` → `MB — {Product} Scaler (ABO)`, pairing with
`mbTestingCampaignName`'s `MB — {Product} Testing (ABO)` so a human scanning Ads Manager sees the
pair. Falls back to `MB — Cold Scaler (<cohort 8>)` when the product cannot be resolved.

**Why ABO.** A CBO / Advantage+ Sales scaler gives Meta control of allocation across the ads inside
it. The CEO moved crowned winners into one and Meta put **~95% of spend behind a single ad** — the
portfolio of proven creatives never got funded, and the one ad Meta picked saturated its best
audience fast. That is a delivery-concentration problem, independent of (and additive to) the
winner's-curse problem the crown bound fixes. Per-adset budgets keep allocation OURS: each graduated
winner keeps its own funding.

Consequences worth knowing:

- `dailyCeilingCents` is **governance only** on ABO. It stays on
  [[../tables/media_buyer_cold_scaler_cohorts]]`.daily_scaler_ceiling_cents` as the cap the graduate
  sizes per-adset budgets against — it is NOT sent as a campaign budget.
- **No `bid_strategy` on the campaign.** `createCampaign` deliberately omits it on ABO (Meta rejects
  a campaign-level strategy with no campaign budget). The "no bid limit" guarantee (CEO 2026-07-27)
  is preserved one level down by `createAdSet`'s `LOWEST_COST_WITHOUT_CAP` default.
- Campaigns mint **PAUSED**, always.

Live set (provisioned 2026-08-25 via `scripts/_provision-abo-scalers.ts`, one per product, each in
the account resolved from that product's OWN test cohort — never inferred from the name):

| product | account | campaign |
|---|---|---|
| Superfood Tabs | Superfood Tabs | `120251359520370326` |
| Amazing Coffee K-Cups | Amazing Coffee & Creamer | `120253322361760184` |
| Amazing Creamer | Amazing Coffee & Creamer | `120253322362100184` |
| Amazing Coffee *(paused permanently — out of stock)* | Amazing Coffee & Creamer | `120253322362230184` |
| Ashwavana Zen Relax | Ashwavana | `120250601021690682` |
| Ashwavana Guru Focus | Ashwavana | `120250601022170682` |
| Creatine Prime+ | creatineproduct | `120249761338970378` |

The two legacy CBO scalers (`120249609991450682`, `120250620926360326`) are paused and left as
history. The Zen Relax one had been **ACTIVE with a $300/day CBO budget and zero ad sets** — an empty
campaign that would have started spending the moment anything landed in it.

Pinned in `src/lib/meta-ads.create.test.ts` (no campaign budget, `is_adset_budget_sharing_enabled=false`,
no `bid_strategy`, no ASC knobs, idempotent by name) and verifiable any time with
`scripts/_verify-abo-scalers.ts`.


---

## ⭐ Advantage+ caps `age_min` at 25 — the K-Cups silent stall (CEO 2026-08-28)

With `targeting_automation.advantage_audience = 1`, Meta REFUSES an ad set whose `age_min` exceeds
**25**. Verbatim:

> *"With ad sets that use Advantage+ audience, the minimum age audience control can't be set to
> higher than 25: You can add a higher minimum age as a suggestion instead."*

The Amazing Coffee K-Cups cohort carried a legacy **50-65** older-buyer profile (Amazing Coffee's
audience skews 55-64) alongside `advantage_audience=1`. Meta refused **every** mint — ten-plus
attempts across Aug 26-27, each a `meta_400` that left `meta_adset_id` null and the publish job
`failed`. K-Cups had been unblocked on 08-25 (`is_advertised` + 12 angles), Dahlia produced a
creative, Bianca kept picking it up on schedule — and it could never launch.

**The lesson is where the failure hid.** The cohort read correct at every layer that got checked:
active, campaign ACTIVE + ABO, pixel set, both exclusion audiences present, slots open, creative in
the bin. The break was one call further down than anyone was looking, in a field nobody thought to
compare across cohorts. K-Cups was the only one of six not on 18-65.

`sanitizeAdvantageAgeTargeting(targeting)` (pure, exported) clamps the floor to
`ADVANTAGE_AUDIENCE_MAX_AGE_MIN = 25` when Advantage+ is on, and `createAdSet` applies it as the last
step before the wire. It **clamps rather than throws** on purpose: a throw reproduces the silent
stall this rail exists to remove. The clamp `console.warn`s what it changed, so the correction is
auditable and the source targeting still gets fixed.

Deliberately does NOT clamp when `advantage_audience` is absent or 0 — a high floor is legitimate on
a manually-targeted ad set, and clamping there would silently destroy a real older-demographic test.

Pinned in `src/lib/advantage-age-targeting.test.ts`. Audit any time with
`scripts/_age-targeting-probe.ts` (live adsets + every cohort template, side by side).

### ⚠️ The system had already self-healed this — read the timeline before adding a fix

The autonomous repair loop caught it first and shipped two fixes:

| when | what |
|---|---|
| 2026-08-26 | `provision-cohort` drops hard age/gender defaults from `DEFAULT_TEST_TARGETING`, so NEW cohorts carry no age floor |
| 2026-08-27 12:25 | `normalizeLegacyAdvantageAudienceTargeting` (`agent.ts:3702`) strips age/genders from `create_adset_spec` at replenish-enqueue |

Measured: the last failed mint was **2026-08-27 12:00**; the very next replenish at **13:00 published
successfully**. Zero failures since. *The loop diagnosed, specced, built, merged and verified its own
fix in about a day.*

What was still left, and why this rail exists anyway:

1. **The stale cohort row.** The Aug-27 fix STRIPS age downstream; it does not correct the source. The
   K-Cups template still read 50-65 — a row that lies about what we target. Fixed to 18-65 to match
   the other five (CEO: *"it should be the same as the rest"*).
2. **Paths that skip replenish-enqueue.** `normalizeLegacyAdvantageAudienceTargeting` guards ONE
   call site. `sanitizeAdvantageAgeTargeting` sits in `createAdSet`, so a scaler mint from
   `graduateCrownedWinnerToScaler` or a manual publish is covered too.

`META_ADVANTAGE_AUDIENCE_MAX_AGE_MIN` (provision-cohort) is now an alias of
`ADVANTAGE_AUDIENCE_MAX_AGE_MIN` here — one definition, two names. A second literal `25` in another
module is precisely how a platform limit drifts out of sync.

