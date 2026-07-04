# CMO (function)

The permanent owner of **owned + organic marketing** — email, SMS, organic social, blog/content, and website content. (Paid acquisition + landing-page CRO is [[growth]]'s; CMO owns the channels we don't buy.) One of the org-chart functions ([[../goals/ceo-mode]]); this doc is both the **CMO director-agent's CEO-mode charter** and the **home that owns every CMO mandate + spec**.

> **Operate + author, never build (CEO directive 2026-06-29).** The CMO director OPERATES its own software (its `function_autonomy` is *operational* autonomy) and AUTHORS specs for the tools it needs — it is the requester/operator. It NEVER drives a build: **Ada / Platform / DevOps is the sole builder for every spec, all departments, permanently** ([[platform]]). A CMO-owned spec's `owner` is attribution + where the finished tool's operation lives; the build is always Ada's. CMO going live+autonomous does not move build-driving onto it.

## Scope + owned metrics

- **Owns:** email marketing (Klaviyo), SMS marketing (Twilio), organic social (FB/IG posts/reels/stories), blog + content/SEO, website editorial content.
- **North-star metrics:** owned-channel revenue + engagement, email/SMS list growth + revenue-per-send, organic reach/engagement, blog-driven sessions + rank.
- **Data we have:** Klaviyo, Twilio, Meta organic, [[../lifecycles/product-intelligence]] (content grounding).

## Mandates (perpetual)

### Organic content & SEO
A standing engine of genuinely useful, human-voiced content (blog + resources) that ranks, gives value to buyers, and reinforces value for considerers.
- **Metric:** ranked keywords, blog-driven sessions, content→assisted-revenue.
- **Specs:** **auto-blog-generation** ✅ (verified + archived → [[../lifecycles/auto-blog-generation]]) · **blog-resources** ✅ (verified + archived → [[../lifecycles/blog-resources]])

### Organic social
Always-on organic posts/reels/stories to FB + IG for engagement, sourced from existing assets + PI-grounded copy.
- **Metric:** posting cadence kept full, organic reach/engagement.
- **Specs:** [[../specs/automated-social-scheduler]] ✅

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
