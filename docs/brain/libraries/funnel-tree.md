# libraries/funnel-tree

The **single source of truth** for the rebuilt storefront funnel — one computation that powers both the Growth Director (Max) and the funnel-page card, so the number Max acts on and the number Dylan sees are identical. Replaces the per-route inline aggregation that let the funnel, the chapter table, and Max's reads silently drift.

**File:** `src/lib/storefront/funnel-tree.ts` · Reads [[../tables/storefront_events]] (funnel-step events in window) + [[../tables/storefront_sessions]] (`landing_url` first-touch + exclusion flags) + [[../tables/products]] (handle→title, the slice key) + [[../tables/advertorial_pages]] (slug→headline, **enrichment only**) + [[../tables/customers]] (`is_internal` set). Read-only — never writes. Takes UTC instants, so it runs unchanged in a Next.js route handler AND in Max's agent runtime.

## The tree (per product, variable depth)

```
Amazing Coffee                ← PRODUCT  (rollup of PDP + All Landers)
├── Product Page (bare PDP)       ← leaf
└── All Landers                   ← rollup of every variant  (PDP-vs-targeted comparison)
    ├── Advertorial                   ← VARIANT (rollup of its angles)
    │   └── {angle} …                     ← angle (leaf — atomic)
    ├── Listicle / Reasons            ← VARIANT
    └── Before/After                  ← VARIANT
```

When no product slice is applied the top level is a **forest** of product nodes; slicing to one product returns just that subtree.

## Bucketing keys (URL-param-first; locked 2026-06-30)

- **PRODUCT** ← the `products.handle` segment of `landing_url`'s path (first segment matching a known handle). Universal — resolves PDP and lander alike, first-touch. Robust to path shape (`/amazing-coffee`, `/store/superfoods/amazing-coffee`).
- **PDP vs LANDER** ← presence of the **`?variant=` param** in `landing_url`. Absent = bare PDP; present = lander. Keyed on the PARAM, **not `advertorial_page_id`** — the param captures intent and survives angle-resolution misses that would otherwise leak a lander into PDP. (Validated 2026-06-30: this also correctly flips ~14/30d cookie-/heal-stamped paid-PDP sessions back to PDP.)
- **VARIANT** ← the VALUE of `?variant=` (`reasons` → "Listicle / Reasons", `advertorial`, `beforeafter`). No join.
- **ANGLE** ← the VALUE of `?angle=` — the atomic leaf. `advertorial_pages` join (by slug) is **pure enrichment** (headline / hero_kind / page id for display), never bucketing.

## Exports

### `computeFunnelTree({ admin, workspaceId, startIso, endIso, productHandle?, utmSource?, referrer? })` → `FunnelTreeResult`
`utmSource` (a `utm_source` value, or `DIRECT_UTM` = `"(direct)"`) and `referrer` (a `referrerGroup()` key — Facebook / Instagram / Google Search / Blog / Direct-in-app / …) are optional slices that **compose** with `productHandle` and each other — a session must pass all set slices. Omit/null = All.
1. Pull **ALL** events in `[startIso,endIso]`, paginated → the **visit universe** (every session that fired any event = the page loaded) + the per-session reached-step set (engaged/pack/checkout/order/atc).
2. Fetch the visit-universe sessions (chunked `.in("id")`, 300/page); drop `is_internal`, `is_bot`, internal-customer-stitched — same real-traffic exclusion as the legacy funnel.
3. Bucket each session into one leaf via the keys above; **force `visit`** for every universe session, accumulate deeper-step counts from the events it fired.
4. Roll up **bottom-up by summation** (leaf session sets are mutually exclusive — first-touch), **recomputing rates at every node** from summed counts (never averaging child %).

**Visit definition:** top-of-funnel `visit` = a session that fired ANY event in the window, **not** strictly a `pdp_view` event. pdp_view's first-flush delivery drops ~17% ([[../specs/pixel-pdp-view-delivery]]), so counting it undercounts visits and inflates every downstream rate. This intentionally makes `visit` EXCEED the legacy funnel's pdp_view top line by the dropped ~17%.
- Returns `products` (forest), `unattributedEntry` (non-product landings e.g. `/checkout` — surfaced separately but **included in `grandTotal`** so it reconciles), and `grandTotal` (all sessions combined). Each node carries `FunnelNodeMetrics`: the 5 step counts + `add_to_cart`, plus `engagement_rate` (engaged/visit), `conversion_rate` (order/visit), `atc_rate`, **`revenue_per_visit_cents`** and **`ltv_per_visit_cents`**.

Each node also carries the full **rate set** (for period-over-period drift): `engagement_rate`, `pack_rate`, `checkout_rate`, `conversion_rate` (all ÷ visit), `atc_rate`, and **`sub_attach_rate`** (`sub_orders` ÷ `order_placed` — % of orders that attach a subscription; e.g. PDP ~89% vs landers ~67%).

**LTV/visit (Max's north-star metric):** per node, `revenue_cents` = Σ order `total_cents` (immediate), `ltv_cents` = Σ `total_cents × (sub ? 1/churn : 1)` (predicted lifetime). **Revenue comes from the `order_placed` EVENT (`meta.total_cents`)** — reliably session-linked — NOT `orders.session_id` (sparse / backfilled late, which zeroed fresh orders). The sub flag joins `order_id → orders.subscription_id` (best-effort; a not-yet-written order falls back to one-time so revenue still shows).

### `computeBottlenecks({ admin, workspaceId, startIso, endIso, productHandle?, utmSource?, referrer? })` → `BottlenecksResult`
A **Max decision signal** (not a card-first metric). Per destination (PDP + variants), benchmarks the two conversion levers — **carry-to-pricing** vs **close** — against best-in-class and classifies the binding constraint (`carry` | `close` | `balanced` | `insufficient_data`) with the gap, a recommendation, confidence, and a traffic-weighted `priority`. Page-accurate (lander_variant). Surfaced compactly on the funnel page for oversight; primarily read by the Growth director. The sub multiplier comes from [[ltv]] `getMonthlyChurn` (default **trailing-6mo** churn — responsive to retention; `churnTrailingMonths: null` for all-history). The window/churn used is returned as `ltvBasis` (surfaced on the card for auditability). Real signal it exposes: bare PDP can out-earn landers on LTV/visit even at equal rev/visit when its orders skew more subscription-heavy.

### `listFunnelProducts({ admin, workspaceId, startIso, endIso })` → `{ handle, title, sessions }[]`
The product slice-dropdown source: products with real sessions in the window (resolution-based, so dead SKUs never appear), ordered by volume. Dynamic + self-pruning.

### `listUtmSources({ admin, workspaceId, startIso, endIso })` → `{ source, label, sessions }[]`
The traffic-source slice-dropdown source: distinct `utm_source` values present in real sessions, ordered by volume. Sessions with no source collapse into one `DIRECT_UTM` row (label "Direct / none"). Dynamic — a new or stray source (e.g. `facebook` alongside `meta`) appears on its own, never hidden.

### `listReferrers({ admin, workspaceId, startIso, endIso })` → `{ referrer, label, sessions }[]`
The referrer slice-dropdown source: real sessions grouped by `referrerGroup()`. The group key IS the slice value. Dynamic + self-pruning.

### `listSliceOptions({ admin, workspaceId, startIso, endIso, product?, utmSource?, referrer? })` → `{ productOptions, utmSourceOptions, referrerOptions }`
**Faceted / chained** dropdown options in one pass: each list is cross-filtered by the OTHER selected slices but NOT its own — so Source=meta narrows the Referrer list to referrers *seen in Meta traffic*, while the Source list still shows every source. "All" (null) on a slice = no constraint from it. This is what the route serves to the page (superseding the single-facet `list*` helpers, which remain exported for programmatic use). The page keeps a 0-count placeholder so a narrowed-out current selection stays visible in its `<select>`.

### `computeChapterDiagnostics({ admin, workspaceId, startIso, endIso, productHandle?, utmSource?, referrer?, destination? })` → `ChapterDiagnosticsResult`
The **"why"** to the tree's "what". For one **destination** (`'pdp'` | a variant | an angle slug; null → top-volume), the chapter sequence **in page order** (`chapter_index`): per-chapter `reach_pct`, `avg_dwell_ms`, **`cta_origin_pct`** (share of the destination's pricing-jumps that fired from this chapter — the persuasion signal), `view_to_pricing_pct`, `view_to_pack_pct`; plus a summary of the **two levers** — `carry_to_pricing_pct` + `close_pct` (pricing→pack) — and the jump/scroll split. Also returns **`funnelSteps`** — the 5-step waterfall (visit→engaged→pack→checkout→order, with conv-from-prev/from-top + drop) for the selected destination, powering the SDK-driven vertical-bar **Funnel** card (replaced the legacy horizontal-bar funnel). Inherits the Product × Source × Referrer slices; `availableDestinations` powers the card-local destination dropdown (angles nest under their parent variant). Interpretation rules: [[../recipes/growth-funnel-reading]].

**Durable page attribution (`lander_variant`):** `StorefrontChapterTracker` stamps the page's variant (`pdp` | `reasons` | `advertorial` | `beforeafter`) onto every `chapter_view` / `chapter_dwell` / `cta_click` / `scroll_depth` event (passed from `render-page.tsx`). The SDK keeps only events whose stamp matches the destination's page — so a session that cross-navigates doesn't drag a foreign page's chapters in, and it stays correct when **chapters are reordered** (the highest-value CRO lever). `DESTINATION_CHAPTERS` (the per-variant section list mirrored from `render-page.tsx`) is now only a **fallback for pre-stamp historical events**. `carry`/`close` are page-accurate (pricing views on THIS page).

**Hero labels** are destination-aware: the shared `AdvertorialHero` component emits `advertorial-hero` on both landers, so the SDK relabels it **"Listicle Hero"** on `reasons` vs **"Advertorial Hero"** on `advertorial` (and `beforeafter-hero` → "Before/After Hero") via the variant — no component change, no historical break. This subsumes the old [[../specs/chapter-performance-variant-dimension]] concern for this card.

### `computeBreakdowns({ admin, workspaceId, startIso, endIso, productHandle?, utmSource?, referrer? })` → `{ device, country }`
Per `device_type` / `ip_country`: visits + **CVR + LTV/visit** (slice-aware), so a high-traffic non-converting segment is visible. Surfaced PR = 0% CVR / $0 LTV at ~35% of US volume. Source is NOT a breakdown (it's a slice). Folded into the funnel-tree route.

### `computeCartAnalytics({ admin, workspaceId, startIso, endIso, productHandle?, utmSource?, referrer?, destination? })` → `CartAnalyticsResult`
Abandoned-cart + lead-capture **summary** (no per-cart logs), slice + destination aware (joined via `cart_drafts.anonymous_id` / `storefront_leads.anonymous_id` → session). **Corrected recovery:** a reminded cart counts as recovered if its customer orders AFTER the reminder, **even via a new cart** (the old `converted_order_id`-only check read 0% when the true rate was 6.3%). The post-reminder-purchase aggregation now uses the server-side `public.order_times_by_email` RPC ([[../libraries/order-aggregation-rpcs]], Phase 3) instead of chunking customers and paging the orders table (which silently truncated >1000-order chunks). Also returns `followups_sent` (the 2-step sequence's step 2 — both = 16, so the 2-step IS firing), `misfired_reminders` (sent to already-purchased customers — a real bug, 4 found), and `fast_converted_in_session` (converted <30min, never reminded). Route: `GET /api/workspaces/[id]/cart-analytics`. Replaced the per-cart-log AbandonedCartsPanel.

### `computePopupFunnel(...)` / `computeSurveyFunnel(...)` → popup + survey funnels
Lead-capture popup (per Offer/Survey variant: shown→engaged→email→phone) and the survey chapter (shown→q1/q2/q3/result→completed→email + **answer distributions** cups_per_day/health_goal/coffee_style). Both slice + destination aware (session_id join); served by `/api/workspaces/[id]/cart-analytics`. **Bug fixed 2026-06-30:** `survey_shown/step/completed/discount_applied` were NOT in the pixel route's `ALLOWED_EVENT_TYPES` → silently dropped → the survey card read 0 even though the survey rendered (the `chapter_view` for `survey` WAS allowlisted, so it showed in chapters). Added to the allowlist; the survey funnel + step answers populate going forward.

### `computeRunningExperiments({ admin, workspaceId })` → `RunningExperiment[]`
Cross-variant A/B rollup for the funnel page's **Running experiments** card — reads `storefront_experiments` (status `running`/`promoted`) + their `storefront_experiment_variants` rollup (the session-stamped attribution persisted by [[../libraries/storefront-experiments]] `refreshExperimentAttribution`). Per arm: `sessions`, `conversions`, `cvr`, `sub_attach`, and `win_prob` (Thompson `winProbabilityVsControl` from [[bandit]], `null` for control). **Not slice-aware** — the rollup is inherently cross-variant, so the card has no PDP/variant/angle selector. Folded into the funnel-tree route (`runningExperiments`). Replaced the legacy `buildRunningExperiments` payload on the `storefront-funnel` route.

### `referrerGroup(referrer)` → group key
Exported helper. Normalizes a raw `referrer` to a platform/origin: in-app webview app ids + hosts → Facebook / Instagram / Google Search / Bing / TikTok; **the Blog is on the STORE host (`shop.superfoodscompany.com/blog`)** so it's keyed on the `/blog` PATH, with same-host non-blog referrers → "Internal / on-site"; empty → "Direct / in-app"; unknown → bare host. The referrer slice adds resolution `utm_source` lacks — it splits `utm_source=meta` into Facebook vs Instagram.

### `parseLanding(landingUrl)` → `{ segments, variant, angle }`
Exported helper — tolerant URL parse (absolute / relative / malformed).

## Invariants & gotchas
- **Pack-selected ↔ Checkout-started are 1:1 by design** (the customize page is optional). The 100% step is structural, not a tracking gap. `checkout_view` is the reliable "reached checkout" signal.
- **`grandTotal` intentionally exceeds the legacy `GET /api/workspaces/[id]/storefront-funnel` top line** (which counts pdp_view) by the dropped ~17% — the SDK is the corrected number. `grandTotal` self-reconciles with an independent any-event count (verified via `scripts/_probe-funnel-tree-verify.ts`); deeper steps still match the legacy event-based counts exactly.
- **No silent drops:** an unknown `variant` value gets its own visible row; a variant present without an `angle` becomes a visible `(no angle)` leaf.
- **Caller owns Central-time boundary math** (`centralBoundary`) — the SDK takes UTC instants so it stays presentation-agnostic.

## Consumers
- `GET /api/workspaces/[id]/funnel-tree` (auth + Central-time boundaries) → the funnel page's top card ("Funnel by product & concept") + the page-level universal slice filters (**Product × Source × Referrer**, all composing) — [[../dashboard/storefront__funnel]].
- `GET /api/workspaces/[id]/chapter-diagnostics` → the funnel page's **"Chapter diagnostics — the why"** card (inherits the page slices + a card-local destination dropdown). Replaced the old blended "Chapter performance" card, which was removed. The card carries two pills (⚡ SDK-powered · ◫ Slice-aware) marking it as rebuilt onto this SDK; legacy cards on that page are NOT yet reworked (one-at-a-time migration). The route also returns the three dropdown lists from `listSliceOptions` (faceted/chained — each reflects the other selected slices), computed over a wide launch→today window so the dropdowns stay stable across date ranges.
- (planned) Max's performance-data assembly — the Growth Director reads the same tree he directs agents on.

## Related
- Fixes the same un-segmented-by-variant root issue logged in [[../specs/chapter-performance-variant-dimension]].
- Distinct from [[storefront-experiment-funnel]] (per-experiment-arm rollup, bandit-keyed) — this is the product/page-type/variant/angle hierarchy keyed on first-touch landing.
