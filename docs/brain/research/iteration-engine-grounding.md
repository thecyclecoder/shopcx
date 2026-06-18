# Storefront Iteration Engine — Phase 0 grounding

Discovery doc for [[../specs/storefront-iteration-engine]]. Grounds Phases 1–6 in **confirmed** Brain tables/columns and the existing ad-build → Meta publish path. Produced by the Phase 0 schema-discovery pass; no production code written. All facts below were read from `docs/brain/` (and two `src/` files spot-checked where Phase 6 depends on exact behavior).

Status of Phase 0 checklist:
- ✅ Build agent can read `docs/brain/` at execution time (this doc was authored from it).
- ✅ Four anchor areas located + recorded (below) with exact file paths and key columns.
- ✅ Existing ad-build → Meta publish path documented; the publish function is identified.
- ✅ Schema-gaps list produced (feeds the Opus refinement of Phases 1–6).

> **Probe-before-trust caveat.** These columns come from the Brain pages, which can drift from the live DB. Two drift flags surfaced during discovery (see [Known doc-drift](#known-doc-drift--probe-before-relying)). The database is the spec — re-probe any column before writing `.eq()`/inserts in Phases 1–3.

---

## Anchor area 1 — Product intelligence (benefits, angles, claims, ingredients)

Used by Phase 3 (per-angle scorecards) and Phase 4 (LLM persona grounding + `test_benefit_angle`).

Brain pages:
- `docs/brain/tables/product_benefit_selections.md`
- `docs/brain/tables/product_benefit_angles.md`
- `docs/brain/tables/product_ad_angles.md`
- `docs/brain/tables/product_ingredients.md`
- `docs/brain/tables/product_ingredient_research.md`
- `docs/brain/tables/product_how_it_works.md`
- `docs/brain/tables/product_seo_keywords.md`
- `docs/brain/tables/product_page_content.md`
- `docs/brain/lifecycles/product-intelligence.md`
- `docs/brain/inngest/product-intelligence.md`

Key tables/columns (all FK to `products` via UUID `product_id`, workspace-scoped):

| Table | Key columns | Role for the engine |
|---|---|---|
| `product_benefit_selections` | `benefit_name` (text — the lead benefit string), `role` (`lead`/`supporting`), `science_confirmed` (bool), `customer_phrases` (text[]), `ingredient_research_ids` (uuid[]) | **Canonical "benefit angle" string.** Qualifying rows: `role='lead' AND science_confirmed=true`. |
| `product_ad_angles` | `lead_benefit_anchor` (text, **verbatim** from `product_benefit_selections.benefit_name` or `product_page_content.benefit_bar[].text`), `hook_slug` (12-value enum), `lf8_slot` (1–8), `proof_anchor` (jsonb `{type:review\|science\|award\|stat,...}`), `meta_headline`/`meta_primary_text`/`meta_description` (length-capped), `times_used`, `last_performance` (jsonb), `is_active` | **The ad ↔ benefit-angle bridge.** An ad's angle maps to a benefit via `lead_benefit_anchor`. `last_performance` jsonb already exists as a perf sink. |
| `product_benefit_angles` | `benefit_key`, `hero_headline`, `hero_subheadline`, `featured_ingredient_ids` (uuid[]), `is_active` | Positioning variants per benefit (for PDP/lander testing). |
| `product_ingredients` | `name`, `dosage_mg`, `dosage_display` | Ingredient list. |
| `product_ingredient_research` | `benefit_headline`, `mechanism_explanation`, `clinically_studied_benefits` (text[]), `citations` (jsonb), `ai_confidence` | Science/claims proof source. |

**Critical fact for Phase 3 (per-angle scorecard):** the canonical benefit-angle string is `product_benefit_selections.benefit_name`; ads attach to it through `product_ad_angles.lead_benefit_anchor` (verbatim contract). So the ads→angle map is: ad → `ad_campaigns.angle_id` → `product_ad_angles.lead_benefit_anchor` → benefit.

Gotchas: enum values are lowercase; `product_ad_angles` re-runs **archive** (flip `is_active=false`) rather than overwrite — always filter `WHERE is_active`; `meta_*` columns have DB CHECK length caps (40/125/30). Legacy `product_intelligence` table is unused — ignore it.

---

## Anchor area 2 — Sessions / engagement model and grain

Used by Phase 2 (attribution rollup) and Phase 3 (per-variant scorecard). The engine must **not** read these raw tables at recommendation time (Phase 4) — only via Phase 3 scorecards.

Brain pages:
- `docs/brain/tables/storefront_sessions.md`
- `docs/brain/tables/storefront_events.md`
- `docs/brain/tables/storefront_leads.md`
- `docs/brain/tables/cart_drafts.md`
- `docs/brain/lifecycles/storefront-checkout.md`
- `docs/brain/lifecycles/advertorial-landers.md`
- `docs/brain/dashboard/storefront__ad-scorecard.md`

| Table | Grain | Retention | Key columns |
|---|---|---|---|
| `storefront_sessions` | one row per `anonymous_id` (device) | indefinite | `anonymous_id`, `customer_id` (backfilled), `landing_url` (carries `?variant=…&angle={slug}` for landers), UTMs, click ids (see area 3) |
| `storefront_events` | one row per event (append-only) | **90 days** | `id` (client-gen, CAPI dedup key), `session_id` → sessions, `anonymous_id`, `customer_id`, `event_type`, `product_id` (uuid → products), `url`, `meta` (jsonb) |
| `storefront_leads` | one row per lead capture | indefinite | `session_id`, `email`, `phone`, `source`, `coupon_code_issued` |
| `cart_drafts` | one row per cart | indefinite | `token`, `anonymous_id`, `status` (`pending`/`converted`/`abandoned`), `line_items` (jsonb — variant inside, not a join), `converted_order_id` → orders |

`event_type` values (from `storefront-checkout.md`): `pdp_view`, `pdp_engaged`, `pack_selected`, `add_to_cart`, `chapter_view`, `chapter_dwell`, `scroll_depth`, `cta_click`, `survey_step`, `customize_view`, `upsell_added`/`upsell_skipped`, `checkout_view`, `order_placed` (server-side, canonical), `lead_captured`.

**Per-variant grain — the key finding for Phase 2/3:** there is **no first-class `variant_id`/`lander_variant` column** on sessions or events. The PDP/lander variant is encoded in the URL query string `?variant=advertorial|beforeafter&angle={slug}` (and `-ba` suffix for before/after) and must be **parsed from `storefront_sessions.landing_url`** (or the event `url`). Persisted lander metadata lives in `advertorial_pages` (`slug`, `variant`, `campaign_id` → ad_campaigns, `angle_id` → product_ad_angles) keyed `(workspace_id, product_id, slug)`.

So per-variant sessions/ATC/CVR **are derivable** (parse `landing_url`, join events on `session_id`) but require URL parsing — there is precedent in `dashboard/storefront__ad-scorecard.md`. The 90-day events retention bounds historical variant performance.

---

## Anchor area 3 — Attribution model (session/order → ad/campaign and → variant)

Used by Phase 2 (the core rollup join). This is the **riskiest** anchor area; read carefully.

Brain pages:
- `docs/brain/tables/storefront_sessions.md` (UTM + click-id columns)
- `docs/brain/tables/orders.md` (`attributed_utm_*`)
- `docs/brain/tables/ad_publish_jobs.md` (meta ids back-reference)
- `docs/brain/lifecycles/storefront-checkout.md` (first-touch backfill)
- `docs/brain/lifecycles/advertorial-landers.md` (variant via URL)
- `docs/brain/inngest/meta-capi-dispatch.md` (click-id recovery)
- `docs/brain/dashboard/storefront__ad-scorecard.md` (session→ad join precedent)
- `docs/brain/tables/klaviyo_events.md` (UTM parsing precedent)

What **exists**:
- **UTMs on sessions:** `storefront_sessions.utm_source/utm_medium/utm_campaign/utm_content/utm_term`.
- **Click ids on sessions:** `fbclid`, `gclid`, `ttclid`, plus Meta cookies `fbp` (`_fbp`), `fbc` (`_fbc`, derived from `fbclid`). Captured by the pixel on first PDP view.
- **UTMs on orders (first-touch):** `orders.attributed_utm_source/medium/campaign/content/term`. Native storefront orders (`source_name='storefront'`) backfill first-touch from the visitor's earliest `storefront_sessions` row with a `utm_source` (by `customer_id` post identity-stitch). Shopify-webhook orders parse `landing_site`.
- **Session → ad join (by convention):** `storefront_sessions.utm_campaign` ≈ `ad_campaigns.name`, and **`storefront_sessions.utm_content` is set to the Meta ad id at publish time** (from `ad_publish_jobs.meta_ad_id`). This is the practical ad→session link the dashboard ad-scorecard already uses.
- **Variant link:** parsed from `landing_url` query params (`?variant=…&angle={slug}`) → `advertorial_pages` (which carries `campaign_id` + `angle_id`).
- **CAPI first-touch recovery:** `meta-capi-dispatch` recovers the visitor's earliest `fbc`/`fbclid` when a later event lacks one.

What is **missing / weak** (feeds Phase 2 "if attribution missing, define capture"):
- **No Meta campaign/adset/ad id columns on sessions or orders.** The only link is `utm_campaign` (a *name*, collision-prone) and `utm_content` (= meta_ad_id by convention, not enforced). To reach `meta_campaign_id`/`meta_adset_id` you must join `utm_campaign`/`utm_content` → `ad_campaigns` → `ad_publish_jobs`.
- **No lander variant persisted on `orders`** (or `advertorial_page_id` on sessions/orders). Variant must be re-parsed from `landing_url`; coupon-return or cross-session conversions can lose the variant/UTM context.
- **No click-id columns on `orders`** (recover via earliest session by `customer_id`).
- Attribution is **not** cross-device stitched for pure-anonymous first touch — a Meta click converting in a later direct session attributes `(direct)`.

**Implication for Phase 2:** the `(ad, variant, date)` grain is *achievable today* for ShopCX-published ads via `utm_content → ad_publish_jobs.meta_ad_id` + `landing_url` variant parse, but it is convention-based and lossy. Opus refinement should decide whether to (a) harden capture (write `ad_campaigns.id`/`advertorial_page_id` onto the session/order at publish/checkout) — possibly its own spec — or (b) accept the join-by-convention for v1 and flag coverage gaps.

---

## Anchor area 4 — Meta connection structure

Used by Phase 1 (credentials for the Insights pull) and Phase 6 (publish auth).

Brain pages:
- `docs/brain/tables/meta_connections.md`
- `docs/brain/tables/meta_ad_accounts.md`
- `docs/brain/tables/daily_meta_ad_spend.md`
- `docs/brain/tables/meta_pages.md`
- `docs/brain/integrations/meta-marketing.md`
- `docs/brain/integrations/meta-graph.md`

| Table | Role | Key columns |
|---|---|---|
| `meta_connections` | per-workspace OAuth state | `access_token_encrypted` (AES-256-GCM, scopes incl. `ads_read`/`ads_management`), `expires_at`, `meta_user_id`, `meta_user_name` |
| `meta_ad_accounts` | connected ad accounts | `meta_account_id` (text, **bare** id — client prefixes `act_`), `meta_connection_id` → meta_connections, `is_active`, `last_sync_at` |
| `daily_meta_ad_spend` | per-(workspace, account, day) spend rollup | `meta_ad_account_id`, `snapshot_date` (date), `spend_cents`, `impressions`, `clicks`, `purchases`, `purchase_value_cents`, `currency` |
| `meta_pages` | organic page tokens | `access_token_encrypted` (Page token) — organic only, **not** sufficient for ads |

- **Token decryption:** `decrypt()` in `src/lib/crypto.ts` (format `{iv}:{tag}:{ciphertext}` hex, AES-256-GCM, `ENCRYPTION_KEY` env). Use the admin token from `meta_connections.access_token_encrypted` for Insights.
- **Token refresh:** only partially handled — `workspaces.meta_user_access_token_encrypted` was added retroactively for refresh-on-demand; older workspaces may lack it. Phase 1 must handle a missing/expired token (this is the spec's open item on refresh handling).
- **Insights API:** `GET /{ad-account-id}/insights?level=[account|campaign|adset|ad]&fields=spend,impressions,clicks,actions,...`. Rate limits via `X-Business-Use-Case-Usage` header; back off when `estimated_time_to_regain_access > 0`.

**Critical fact for Phase 1:** there are **no `meta_campaigns` / `meta_adsets` / `meta_ads` tables today.** The only stored performance data is the account-level `daily_meta_ad_spend` rollup (no per-campaign/adset/ad structure, no daily insights at object grain). Phase 1's new tables are genuinely net-new. `ad_publish_jobs` stores the Meta ids for ShopCX-published ads but is not a structure mirror.

---

## Anchor area 5 — Existing ad-build → Meta publish path (for Phase 6)

The spec needs the internal function that publishes to Meta so Phase 6 can invoke a **drafts-only** variant. **Confirmed: a drafts-only (PAUSED) publish path already exists** — no new Meta-side logic is required, only invocation with the existing flag.

Brain pages:
- `docs/brain/tables/ad_publish_jobs.md`
- `docs/brain/lifecycles/ad-publish.md`
- `docs/brain/inngest/ad-tool.md`
- `docs/brain/tables/ad_campaigns.md` · `ad_videos.md` · `ad_segments.md`
- `docs/brain/tables/advertorial_pages.md`
- `docs/brain/integrations/meta-marketing.md`

The chain (UI → publish), with the exact internal entry points:

1. **AI copy generation** — `generateMetaCopy(workspaceId, campaignId)` in `src/lib/ad-meta-copy.ts` (4 headlines + 4 primary texts + 1 description via Claude). Invoked by `POST /api/ads/campaigns/[id]/meta-copy`.
2. **Publish job creation** — `POST /api/ads/campaigns/[id]/publish` (`src/app/api/ads/campaigns/[id]/publish/route.ts`): resolves destination URL (campaign `landing_url` → advertorial lander → provided URL), inserts an `ad_publish_jobs` row with `publish_status='queued'` and the **`publish_active` flag**, then fires Inngest `ad-tool/publish-to-meta`.
3. **Publish executor** — `adToolPublishToMeta` in `src/lib/inngest/ad-tool.ts` (status lifecycle `queued → uploading → creating → published|failed`): uploads media, creates the creative, then creates the ad.
4. **Meta Graph wrappers** — `src/lib/meta-ads.ts`: `uploadAdVideo`, `uploadAdImage`, `waitForVideoReady`, `createAdCreative`, `createDualAssetCreative`, and **`createAd(token, accountId, {name, adsetId, creativeId, status?})`**.

**The drafts-only lever (verified in source):**
- `createAd()` **defaults `status` to `"PAUSED"`** (`src/lib/meta-ads.ts` — "Defaults to PAUSED so nothing spends until reviewed.").
- The executor passes `status: j.publish_active ? "ACTIVE" : "PAUSED"`; `ad_publish_jobs.publish_active` defaults **false → ad created PAUSED** (confirmed in `ad_publish_jobs.md` Gotchas).
- **Therefore Phase 6 `new_static_adset`/`new_video_adset` adapters create drafts by inserting an `ad_publish_jobs` row with `publish_active=false`** (or a publish route variant that hard-codes it). No new pause logic needed; this satisfies the "never active" invariant on the ad object itself.
- Open: campaign/adset creation in PAUSED/draft state, audience + budget settings — confirm whether the current path creates the campaign/adset or only the ad within an existing adset (the executor takes `meta_adset_id` as input, implying the adset pre-exists). Phase 6 / Opus must resolve whether the engine creates campaigns/adsets or reuses existing ones.

**Lander-variant creation system** (for `new_lander_variant` / `test_benefit_angle`):
- `src/lib/advertorial-pages.ts` — `generateAdvertorialPagesForCampaign()`, variants `advertorial | beforeafter | reasons`; route `/api/ads/landers`; Inngest trigger `ad-tool/advertorial-page-requested`; produces `advertorial_pages` rows + URLs `?variant={variant}&angle={angleSlug}`.
- Ad creative/angle generation: `src/lib/ad-angles.ts` (writes `product_ad_angles`).

---

## Schema gaps — exists vs. must be built (feeds Opus refinement of Phases 1–6)

| # | Need | Status | Where it lands |
|---|---|---|---|
| 1 | Meta campaign/adset/ad **structure** stored locally | ❌ Missing (only `daily_meta_ad_spend` account rollup) | Phase 1 — new `meta_campaigns` / `meta_adsets` / `meta_ads` |
| 2 | Daily **insights at object grain** (spend/impr/clicks/CTR/CPC/purchases/revenue/ROAS/frequency by object_id+date) | ❌ Missing | Phase 1 — new `meta_insights_daily`, idempotent upsert on `(object_id, date)` |
| 3 | Map ShopCX-built ads → Meta ad ids | ⚠️ Partial — `ad_publish_jobs.meta_ad_id/meta_campaign_id/meta_adset_id` exist | Phase 1 — reuse `ad_publish_jobs`; possibly add index/FK to new `meta_ads` |
| 4 | Meta credentials / ad-account ids | ✅ Exists (`meta_connections`, `meta_ad_accounts`, `crypto.decrypt`) | Phase 1 — read-only; handle token refresh/expiry gap |
| 5 | Session UTMs + click ids | ✅ Exists on `storefront_sessions` | Phase 2 |
| 6 | Order first-touch UTMs | ✅ Exists (`orders.attributed_utm_*`) | Phase 2 |
| 7 | Session/order → **Meta object id** link | ⚠️ Convention only (`utm_content`≈meta_ad_id, `utm_campaign`≈name); no real keys; collision-prone | Phase 2 — join via `ad_publish_jobs`; Opus decides whether to harden capture (own spec?) |
| 8 | PDP/lander **variant** on session/order | ⚠️ Parse from `landing_url`; not persisted on orders; `advertorial_pages` holds metadata | Phase 2 — variant parse + `advertorial_pages` join; consider persisting `advertorial_page_id` |
| 9 | Per-variant engagement (sessions/ATC/CVR) | ⚠️ Derivable via URL parse + `session_id` join; 90d events retention | Phase 3 — `iteration_scorecards_daily` |
| 10 | Per-ad / per-angle scorecards | ❌ Missing (no rollup table) | Phase 3 — new `iteration_scorecards_daily`; angle via `ad_campaigns.angle_id → product_ad_angles.lead_benefit_anchor` |
| 11 | Typed recommendations store | ❌ Missing | Phase 4 — new `iteration_recommendations` (status enum) |
| 12 | Daily cron run records | ❌ Missing | Phase 5 — new run-records table |
| 13 | Drafts-only Meta publish | ✅ Exists (`ad_publish_jobs.publish_active=false` → `createAd` PAUSED) | Phase 6 — invoke with flag false |
| 14 | Lander/angle creation systems | ✅ Exists (`advertorial-pages.ts`, `ad-angles.ts`, `ad-tool` publish) | Phase 6 adapters |
| 15 | Campaign/adset **creation** in draft state (vs. ad-only into existing adset) | ❓ Unconfirmed — executor takes `meta_adset_id` as input | Phase 6 / Opus — confirm whether engine creates or reuses campaigns/adsets |

### Known doc-drift — probe before relying
- `storefront_events.identity_source` appears in the page's Gotchas but **not** in its Columns table — probe before use.
- `storefront_sessions` Meta cookie columns are documented as `fbp`/`fbc` (mapping `_fbp`/`_fbc`) — confirm exact column names before querying.
- `storefront_sessions.utm_content = meta_ad_id` is a **publish-time convention**, not a DB constraint — verify population/coverage on real Amazing Coffee sessions before relying on it for attribution.

---

## Open product decisions for the Opus refinement pass (not Phase 0 scope)
1. **Attribution hardening vs. join-by-convention** (gap #7/#8): persist real `ad_campaigns.id`/`advertorial_page_id` onto sessions/orders at publish/checkout, or accept lossy convention for v1? May warrant its own capture spec.
2. **Campaign/adset creation** (gap #15): does the engine create new Meta campaigns/adsets in draft, or only ads into operator-selected existing adsets?
3. **`scale_ad` budget change** — the spec flags that a budget change may count as an "active" change; needs Dylan's call before Phase 6 enables it.

## Related
[[../specs/storefront-iteration-engine]] · [[../lifecycles/storefront-checkout]] · [[../lifecycles/advertorial-landers]] · [[../lifecycles/ad-publish]] · [[../lifecycles/product-intelligence]] · [[../integrations/meta-marketing]] · [[../tables/ad_publish_jobs]] · [[../tables/daily_meta_ad_spend]]
