# CMO (function)

The permanent owner of **owned + organic marketing** — email, SMS, organic social, blog/content, and website content. (Paid acquisition + landing-page CRO is [[growth]]'s; CMO owns the channels we don't buy.) One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **CMO director-agent's CEO-mode charter** and the **home that owns every CMO mandate + spec**.

> **Operate + author, never build (CEO directive 2026-06-29).** The CMO director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs — it is the requester/operator. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A CMO-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's. CMO going live+autonomous does not move build-driving onto it.

## Scope + owned metrics

- **Owns:** email marketing (⚠️ **no platform** — Klaviyo is retired, see [[../integrations/klaviyo]]; nothing sends marketing email today), SMS marketing (Twilio), organic social (FB/IG posts/reels/stories), blog + content/SEO, website editorial content, product reviews (⚠️ **no collection** — the Klaviyo review-request flow died 2026-07-01).
- **North-star metrics:** owned-channel revenue + engagement, email/SMS list growth + revenue-per-send, organic reach/engagement, blog-driven sessions + rank.
- **Data we have:** Twilio, Meta organic, [[../lifecycles/product-intelligence]] (content grounding), [[../tables/product_reviews]] (10.7k rows, frozen). Klaviyo's engagement + campaign data is frozen at the sunset and no longer refreshes.

## Mandates (perpetual)

### Organic content & SEO
A standing engine of genuinely useful, human-voiced content (blog + resources) that ranks, gives value to buyers, and reinforces value for considerers.
- **Metric:** ranked keywords, blog-driven sessions, content→assisted-revenue.
- **Specs:** **auto-blog-generation** ✅ (verified + archived → [[../lifecycles/auto-blog-generation]]) · **blog-resources** ✅ (verified + archived → [[../lifecycles/blog-resources]])

### Organic social
Always-on organic posts/reels/stories to FB + IG for engagement, sourced from existing assets + PI-grounded copy.
- **Metric:** posting cadence kept full, organic reach/engagement.
- **Specs:** [[../specs/automated-social-scheduler]] ✅

### Review collection
Keep a live supply of first-party product reviews. Reviews are load-bearing across the business — storefront PDPs, the Shopify theme's star ratings and Google rich snippets, the ad tool's tier-4 proof anchors, [[../lifecycles/product-intelligence]] grounding, cancel-journey social proof, and review cards. They were collected by Klaviyo until that vendor was retired; the last review landed **2026-07-01** and nothing has collected one since.
- **Objective (Iris owns it):** a steady, honest supply of reviews with enough coverage per product that no PDP reads thin. **Bounded proxy:** reviews collected per month, per product — never "positive reviews," which is the Goodhart failure this mandate must not optimize into.
- **The asset:** [[../tables/product_reviews]] (10,745 rows, frozen). [[../libraries/shopify-review-metafields]] publishes the aggregates to Shopify daily so the stars survive Klaviyo's removal.
- **Rails:** an incentive is never conditional on sentiment; a 1–3★ review routes to CS as a save opportunity rather than being buried; a request is never sent to someone who explicitly opted out.
- **Status:** ⏳ collection dark since 2026-07-01. Display side rebuilt ([[../integrations/klaviyo]] § Replacement widgets).

### SMS marketing agent (Margo)
Autonomous owned-channel SMS promos — the CMO-side mirror of Growth's storefront optimizer. **Margo** (worker persona under Iris) runs a cadence engine ([[../inngest/sms-marketing]]) that, on a valid send window, picks a sale theme (VIP / Weekend), tailors the per-segment copy from the DB-driven [[../tables/sms_campaign_templates]] library, and schedules 1-2 promotional sends/week over the [[marketing-text]] pipeline — all within a bounded proxy.
- **Objective (Iris owns it):** owned-channel SMS revenue. **Bounded proxy (Margo optimizes it):** attributed **revenue-per-send** ([[../sms-segment-performance]]) within the policy's weekly cap + segment scope + send windows.
- **The leash — [[../tables/sms_marketing_policy]]:** `active` on-switch (default false), `weekly_send_cap`, `send_windows` (Sun AM · Mon AM · Tue PM · Thu AM · Sat AM), `segment_scope` (never `cold`), `theme_config` (per-theme Shopify code + collection). Authored/activated via [[../libraries/sms-marketing-policy-authoring]]. Two-switch dormancy like the optimizer: this policy's `active` **and** `function_autonomy('cmo')`.
- **Rails (escalate, never execute):** a stale segment book (<80% refreshed) or a theme with no coupon configured → Margo **blocks + records a `director_activity` line for Iris** instead of texting. Reversible within cap+scope (a scheduled send can be paused/cancelled before delivery).
- **KPI + grading:** [[../tables/sms_campaign_grades]] — revenue-per-send, `hypothesis_quality` scored apart from `result_quality`.
- **Status:** ⏳ **built + DORMANT** (`active=false`, placeholder theme codes). Set real Shopify codes + flip `active=true` (+ `function_autonomy('cmo')` live) to go live. Grader sweep = follow-up. Avatar photo = follow-up (mascot fallback for now).

## Owned / contributed goals

- Contributes to [[../goals/ceo-mode]] — the CMO director seat.

## Status

Charter doc. Owns the blog + social content engines + the SMS marketing agent (Margo, dormant).
