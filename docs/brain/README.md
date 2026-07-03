# brain — reference

System-level reference covering everything an agent needs to navigate the codebase: every database table, every background job, every external integration. Designed to be grep-able and `[[wikilinked]]`.

## What's here

| Folder | Contents | Count |
|---|---|---|
| [tables/](tables/) | One page per `public.*` table — columns, FKs (both directions), common queries, gotchas | 236 |
| [inngest/](inngest/) | One page per `src/lib/inngest/*.ts` — trigger event/cron, downstream events sent, tables read/written | 90 |
| [integrations/](integrations/) | One page per external API — auth model, credential location, key endpoints, rate limits, retry pattern, gotchas | 23 |
| [libraries/](libraries/) | One page per `src/lib/*.ts` — exports + signatures + callers + gotchas | 337 |
| [lifecycles/](lifecycles/) | Long-form narrative — end-to-end traces of key flows. Each wikilinks 5+ reference pages and ends with the src/lib files involved | 35 |
| [journeys/](journeys/) | One page per `journey_definitions` row — trigger pattern, steps, outcomes, channel rules, files | 9 + README |
| [playbooks/](playbooks/) | One page per active row in `playbooks` — steps, policies, exceptions, files | 2 + README |
| [recipes/](recipes/) | How-to pages for common operational tasks — helper + signature + example + gotchas | 42 + README |
| [incidents/](incidents/) | Post-mortems — timeline, root cause, the fixes, and the durable lessons | 1 |
| [dashboard/](dashboard/) | One page per dashboard route family + per `settings/*` page — purpose, features, API endpoints called, permissions, files | 65 + 38 settings |
| [functions/](functions/) | One page per org-chart function (Growth, CMO, Retention, CFO, Logistics, CS — the CEO-mode directors — plus Platform/Eng, the build org) — the permanent owner of work. Lists its perpetual mandates + the specs/goals it owns. Doubles as the CEO-mode director-agent charter. | 5 |
| [goals/](goals/) | One page per finite company goal / BHAG (e.g. CEO mode) — outcome, success metric, and the milestone → spec decomposition. Rolls up to 100% then closes. | 0 |
| [specs/](specs/) | Roadmap specs for in-flight or planned features. Every spec declares an **owner** (one function) + **parent** (a function mandate or a goal milestone). When a spec ships, content folds into the relevant lifecycle/table/library pages and the spec file is deleted. | 0 |
| (root) | Cross-cutting reference: [customer-voice.md](customer-voice.md), [operational-rules.md](operational-rules.md), [ui-conventions.md](ui-conventions.md), [orchestrator-tools.md](orchestrator-tools.md), [project-management.md](project-management.md), [archive.md](archive.md) (verified/retired specs) | 6 |

**How project management works in the brain** → see [project-management.md](project-management.md). The work hierarchy is **Function → (Mandate | Goal) → Spec → Phase → Build** — no orphan specs. Specs + phases live in `public.specs` / `public.spec_phases` (DB-driven status, not markdown emoji); the build flow accumulates phases on a `claude/build-{slug}` branch and promotes atomically (one-off spec → main, or a whole goal → main) — see [lifecycles/spec-goal-branch-pm-flow.md](lifecycles/spec-goal-branch-pm-flow.md). Lifecycle pages carry "Status / open work" blocks for shipped state. Spawn a session: `/goal do everything in docs/brain/specs/{slug}.md`.

## Tables (`tables/`)

Each page has:

- **Summary** — one line, what the table is for.
- **Columns** — name, type, nullable, FK target, encryption + default flags.
- **Foreign keys** — out (this → others) and in (others → this), both with `[[wikilinks]]` to related pages.
- **Common queries** — code-ready supabase-js / SQL snippets for the things agents actually need.
- **Gotchas** — case-sensitive enum values, hidden columns, mixed-case data, performance pitfalls.

## Naming conventions

- One file per table: `tables/{table_name}.md`.
- `[[wikilinks]]` use the table name as the link target — Obsidian-style, plain markdown elsewhere.
- Encrypted column names always end with `_encrypted` and use AES-256-GCM via `src/lib/crypto.ts`.
- **Internal joins ALWAYS use the UUID — never `shopify_*_id`.** Shopify is being sunset; every `shopify_contract_id`, `shopify_customer_id`, `shopify_order_id` will be deprecated. Those fields exist ONLY for crossing the Shopify boundary (webhooks ingesting Shopify payloads, outbound Shopify API calls). When joining between our own tables, use the UUID PK / FK. If a UUID FK column is marked nullable but is always populated in practice, that's a data invariant — treat a NULL as a bug to surface, not a fallback signal.
- Status / enum-like text columns are **lowercase** everywhere — see [Gotchas](#probing-technique) before writing `.eq()`.

## Probing technique

When in doubt:

```ts
const { data } = await admin.from("the_table").select("*").limit(1);
console.log(Object.keys(data?.[0] || {}));
```

For enum-like text columns, bucket a sample:

```ts
const { data } = await admin.from("the_table").select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
```

Five seconds of probing beats an hour of "why is my filter empty."

## Index

### Core entities

- [[tables/customer_demographics]] — Per-customer demographic enrichment (age band, household income band, etc.) from Census/Versium.
- [[tables/customer_events]] — Append-only customer event log — portal actions, subscription mutations, journey responses. Source of truth for the customer activity timeline.
- [[tables/customer_link_rejections]] — Customers explicitly rejected a suggested account link — never re-offer.
- [[tables/customer_links]] — Account-linking graph. Multiple `customer_id`s share a `group_id` = one real person.
- [[tables/customer_payment_methods]] — Customer payment methods snapshot from Shopify (last4, brand, expiry). Used for dunning card rotation dedup.
- [[tables/customers]] — Synced from Shopify. Email, retention_score, subscription_status, LTV, marketing consent. A 'lead' is a customer with no orders.
- [[tables/orders]] — Synced from Shopify. line_items, fulfillments, financial/fulfillment status, attribution UTMs.
- [[tables/product_variants]] — First-class variant rows (UUID PK). Source of truth for variants; `products.variants` JSONB is a legacy mirror.
- [[tables/products]] — Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.
- [[tables/subscriptions]] — Synced from Appstle. items JSONB, billing interval, next billing date. Will become source of truth post-Appstle.
- [[tables/transactions]] — Per-(order, customer, subscription) Braintree transaction log — type, amount, status, processor response. attempted_at / settled_at / refunded_at.
- [[tables/workspace_invites]] — Pending workspace invitations sent via email.
- [[tables/workspace_members]] — User ↔ workspace membership. role enum (owner/admin/agent/social/marketing/read_only). display_name is the user-facing label.
- [[tables/workspaces]] — Multi-tenant root. Encrypted credentials, sandbox_mode, response_delays, help_slug, portal_config, storefront branding.

### Tickets & messaging

- [[tables/banned_meta_users]] — Meta DM / comment senders banned from messaging us. Workspace-scoped.
- [[tables/email_events]] — Universal email tracking — sent, delivered, opened, clicked, bounced. Joined by `resend_email_id`.
- [[tables/email_filters]] — Per-workspace inbound-email rules (spam/auto-replies to ignore).
- [[tables/meta_ad_accounts]] — Meta Ads accounts connected to the workspace.
- [[tables/meta_attribution_daily]] — Per-(meta_ad_id, variant, day) attributed spend + revenue (iteration engine Phase 2).
- [[tables/meta_ads]] — Local mirror of Meta ad structure + status (iteration engine Phase 1).
- [[tables/meta_adsets]] — Local mirror of Meta ad set structure + budget + status (iteration engine Phase 1).
- [[tables/meta_campaigns]] — Local mirror of Meta campaign structure + budget + status (iteration engine Phase 1).
- [[tables/meta_connections]] — Per-workspace Meta OAuth state + connected page/instagram accounts.
- [[tables/meta_insights_daily]] — Daily Meta performance insights at campaign/adset/ad grain (iteration engine Phase 1).
- [[tables/meta_pages]] — Meta Pages connected for inbound DM + comment management.
- [[tables/meta_post_cache]] — Cached Meta post/ad metadata for comment context (text, image, ad attribution).
- [[tables/meta_sender_customer_links]] — Meta-sender-id ↔ internal customer_id mapping. Built from Conversations API on DM.
- [[tables/meta_webhook_raw]] — Raw Meta webhook bodies for debugging.
- [[tables/sms_marketing_inbound]] — Inbound SMS replies / STOP / HELP messages.
- [[tables/social_comment_replies]] — Outbound replies to social-comment tickets (Meta / IG comments).
- [[tables/social_comments]] — Inbound social comments (Meta Page posts, Instagram). channel='social_comments'.
- [[tables/support_emails]] — Per-workspace support@/help@ inbound email mailbox configs.
- [[tables/ticket_analyses]] — Per-ticket AI analysis output — sentiment, intent, summary, suggested action.
- [[tables/ticket_heal_attempts]] — Per-ticket auto-heal attempts (research-and-heal pipeline). See [[../lifecycles/research-and-heal]].
- [[tables/ticket_messages]] — Messages on a ticket. direction (in/out), visibility (public/internal), author_type (customer/agent/ai/system).
- [[tables/ticket_research_runs]] — Per-ticket research runs (the deep-investigation pipeline that runs before a heal attempt).
- [[tables/ticket_views]] — Saved ticket filter combos. Nested up to 2 levels via parent_id. Live in sidebar.
- [[tables/tickets]] — Customer support tickets. status (open/pending/closed/archived), channel, handled_by, ai_turn_count, journey/playbook state.
- [[tables/widget_path_mappings]] — Storefront widget — URL path patterns → widget config (which proactive prompt, what greeting).
- [[tables/widget_sessions]] — Per-visitor chat-widget session state (anonymous chat tickets begin here).

### AI orchestration

- [[tables/ai_channel_config]] — Per-(workspace, channel) AI agent settings — personality, confidence threshold, auto-resolve toggle, turn limit.
- [[tables/ai_personalities]] — Named AI personalities — tone, style, sign-off, emoji policy. Referenced by `ai_channel_config`.
- [[tables/ai_token_usage]] — Per-call AI token accounting — model, input/output/cache tokens, cost, latency. Drives usage dashboards.
- [[tables/ai_workflows]] — AI-callable workflows (e.g. marketing_signup). Discoverable by the Sonnet orchestrator and referenced by `tickets.ai_workflow_id`.
- [[tables/daily_analysis_reports]] — AI-generated daily analysis reports for the dashboard.
- [[tables/grader_prompts]] — Prompts used by the AI quality-grader pipeline to score sent responses.
- [[tables/kb_chunks]] — RAG retrieval chunks for knowledge base articles. pgvector embedding (1536).
- [[tables/knowledge_base]] — Help center articles — slug, content_html, view_count, helpful_yes/no. Public-facing.
- [[tables/knowledge_gaps]] — AI-detected knowledge gaps — moments the AI had nothing to say. Surfaced for admin review.
- [[tables/macro_usage_log]] — Per-use tracking of every macro send — source (ai/agent), outcome (accepted/rejected/personalized).
- [[tables/macros]] — Canned response templates with embeddings + AI-suggestion counters. Discoverable by Sonnet.
- [[tables/pattern_feedback]] — Smart-pattern agent feedback queue (agent removed an auto-applied smart: tag → review).
- [[tables/policies]] — Canonical published policies (refund window, restocking, exchange rules, etc). Consumed by orchestrator, storefront, and (TODO) playbook executor.
- [[tables/rules]] — Compound AND/OR rules engine — ordered actions, 8 action types. Evaluated on inbound events.
- [[tables/smart_patterns]] — Global + workspace-scoped patterns. 3-layer classifier (keywords → embeddings → Haiku fallback).
- [[tables/sonnet_prompts]] — DB-driven prompt rules for the Sonnet orchestrator. category: rule/approach/knowledge/tool_hint. Editable in Settings → AI → Prompts. Auto-review lifecycle in [[lifecycles/ai-learning]].
- [[tables/sonnet_prompt_decisions]] — Append-only audit log of auto-review decisions (cron + manual override) on sonnet_prompts. One row per Opus call.
- [[tables/workflows]] — Template-based deterministic workflows (order_tracking, cancel_request, subscription_inquiry, account_login, end_chat).
- [[tables/workspace_pattern_overrides]] — Per-workspace overrides on global smart_patterns (disable a global pattern, raise/lower its threshold).

### Journeys

- [[tables/chat_journeys]] — Active in-flight chat journey state per session (legacy — most chat journeys now use the same `journey_sessions` row as email).
- [[tables/journey_definitions]] — Journey configs — slug, channels, match_patterns, trigger_intent, step_ticket_status, priority. See [[../journeys/README]].
- [[tables/journey_sessions]] — Per-customer journey invocation. token (for `/journey/{token}`), responses, status. The customer-facing artifact.
- [[tables/journey_step_events]] — Append-only audit log of every step response within a journey session.

### Playbooks

- [[tables/playbook_exceptions]] — Per-(playbook, customer/ticket) one-off exception grants (e.g. tenured customer auto-approved).
- [[tables/playbook_policies]] — Policies attached to playbooks — limits, escalation thresholds. See [[../playbooks/README]].
- [[tables/playbook_simulations]] — Recorded playbook dry-runs for testing rule changes.
- [[tables/playbook_steps]] — Steps inside a playbook — ordered, with action type and config. See [[../playbooks/README]].
- [[tables/playbooks]] — Customer-service playbooks (e.g. unwanted_charge_subscription_dispute). Discoverable by Sonnet.

### Cancel & retention

- [[tables/coupon_mappings]] — Shopify coupon code ↔ internal mapping with VIP tier filtering. Referenced by remedies and discount journey.
- [[tables/product_review_analysis]] — Aggregate review analysis (sentiment, key phrases, themes).
- [[tables/product_reviews]] — Klaviyo-synced product reviews with AI summaries. Used for cancel-journey social proof.
- [[tables/remedies]] — Per-workspace retention remedies for cancel journey (coupon, pause, skip, frequency_change, free_product, line_item_modifier).
- [[tables/remedy_outcomes]] — Per-(session, remedy, reason) tracking — shown / accepted / rejected. Drives AI remedy selection learning.

### Crisis management

- [[tables/crisis_customer_actions]] — Per-customer state in a crisis campaign — segment, current tier, responses, swap/pause/remove actions. See [[../lifecycles/crisis-campaign]].
- [[tables/crisis_events]] — Crisis campaigns (e.g. Mixed Berry OOS) — affected variant, swap options, tiers, coupon. See [[../lifecycles/crisis-campaign]].

### Fraud & resellers

- [[tables/amazon_asins]] — Amazon catalog — ASIN ↔ product mapping, pricing, rank. Source for reseller discovery and pricing intelligence.
- [[tables/fraud_action_log]] — Append-only audit of every fraud rule match — what rule, what action taken, what context.
- [[tables/fraud_case_history]] — State transitions on a fraud case (open → reviewing → confirmed_fraud / dismissed).
- [[tables/fraud_cases]] — Active fraud investigations. rule_type, severity, orders_held, resolution.
- [[tables/fraud_rule_matches]] — Per-(rule, customer/order) rule-trigger events. Drives `fraud_cases` row creation.
- [[tables/fraud_rules]] — Configurable fraud detection rules (shared_address, high_velocity, address_distance, name_mismatch, amazon_reseller).
- [[tables/known_resellers]] — Amazon resellers (sellerId + business name + address) used by the `amazon_reseller` fraud rule. See CLAUDE.md § Reseller Defense.

### Chargebacks & dunning

- [[tables/appstle_api_calls]] — Audit log of every Appstle API request — endpoint, status, response. For debugging subscription mutations.
- [[tables/chargeback_events]] — Shopify disputes — reason, status, amount, customer. Drives auto-cancel pipeline and chargebacks dashboard.
- [[tables/chargeback_subscription_actions]] — Per-chargeback log of subscription cancellations/reinstatements.
- [[tables/dunning_cycles]] — Per-(subscription, billing cycle) dunning state machine. status: active/skipped/paused/recovered/exhausted. See Phase 5 in CLAUDE.md.
- [[tables/dunning_error_codes]] — Lookup table of payment gateway decline codes mapped to category + customer-facing wording.
- [[tables/payment_failures]] — Per-attempt log within a dunning cycle — card tried, result, attempt type (initial/card_rotation/payday_retry/new_card_retry).

### Returns & replacements

- [[tables/replacements]] — Reshipment/replacement orders. Created by playbooks or agent action. Counts against customer's replacement_threshold.
- [[tables/returns]] — Customer returns. status: open → label_created → in_transit → delivered → refunded. See returns pipeline in CLAUDE.md.
- [[tables/store_credit_log]] — Per-customer store credit ledger — issued, used, expired. Backed by Shopify storeCreditAccount.

### Loyalty

- [[tables/loyalty_members]] — Per-(workspace, customer) loyalty enrollment + tier + points balance.
- [[tables/loyalty_redemptions]] — Points redemption events — coupon issued, used, expired.
- [[tables/loyalty_settings]] — Per-workspace loyalty program config — tiers, point earn rates, redemption tiers.
- [[tables/loyalty_transactions]] — Append-only points ledger — earn (order placed), spend (redemption), adjust (manual).

### Storefront & checkout

- [[tables/cart_drafts]] — Server-side cart state for the custom storefront. Token-bound, server-validated pricing, lifecycle: pending → converted/abandoned. See [[../lifecycles/storefront-checkout]].
- [[tables/event_dispatches]] — Per-(event, sink) dispatch state for the CAPI clearinghouse — pending/sent/failed/dlq. See [[../lifecycles/storefront-checkout]].
- [[tables/event_sinks]] — Downstream destinations for storefront events — meta_capi, tiktok_events, google_enhanced, klaviyo, custom. Encrypted credentials.
- [[tables/posts]] — Blog/resource object — imported (Superfood Scoop) or auto-generated ([[lifecycles/auto-blog-generation]]); self-hosted images, AI-classified is_resource + grouping. Rendered on the public storefront blog + portal Resources. See [[lifecycles/blog-resources]].
- [[tables/post_products]] — Join: a [[tables/posts|post]] → many [[tables/products]] (a recipe shows under each product it uses).
- [[tables/pricing_rules]] — Storefront pricing rules — tier qty, mode (subscription vs one-time), frequency, discount %, line-item price.
- [[tables/pricing_rule_offers]] — Dynamic, time-boxed persist-to-renewal offers overlaying a [[tables/pricing_rules|rule]] for a scoped (product × lander × audience) / experiment arm; owner-approval-gated (M6).
- [[tables/shipping_rates]] — Storefront shipping rates per (region, weight) — referenced by orders + subscriptions.
- [[tables/storefront_events]] — Append-only storefront event log (pdp_view, pack_selected, order_placed, etc.). PK is client-generated UUID for CAPI dedup. 90d retention.
- [[tables/storefront_leads]] — Lead-capture events on the storefront. Customer is created/matched, this row logs the capture surface.
- [[tables/storefront_sessions]] — One row per anonymous_id. Device fingerprint, UTMs, click IDs, _fbp/_fbc cookies, IP-derived geo. Indefinite retention.

### Product catalog

- [[tables/product_benefit_angles]] — Benefit angles per product (anti-aging, energy, gut health) for marketing/PDP copy generation.
- [[tables/product_benefit_selections]] — Per-(product, angle) selection of which benefit angle is in active rotation.
- [[tables/product_how_it_works]] — PDP 'How it works' section content per product.
- [[tables/product_ingredient_research]] — Research/citations for each ingredient — used by the ingredient deep-dive PDP section.
- [[tables/product_ingredients]] — Per-product ingredient list with name, dose, function.
- [[tables/product_link_groups]] — Cross-product link groups — bundles, related products, upsell groups.
- [[tables/product_link_members]] — Members of a `product_link_groups` row.
- [[tables/product_media]] — Per-product media (images, videos) with dimensions and roles (hero, gallery, before/after).
- [[tables/product_page_content]] — PDP content blocks per product (sections, ordering).
- [[tables/product_pricing_rule]] — Per-product attached pricing rule.
- [[tables/product_pricing_tiers]] — Per-product pricing tiers (1-pack / 3-pack / 6-pack) with price.
- [[tables/product_seo_keywords]] — Per-product SEO keyword targets for ad/landing-page copy.
- [[tables/product_variants]] — First-class variant rows (UUID PK). Source of truth for variants; `products.variants` JSONB is a legacy mirror.
- [[tables/products]] — Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.

### Ad tool

- [[tables/product_ad_angles]] — Generated ad angles per product (hook × Life Force 8 slot, anchored to a verbatim lead benefit). Written by `src/lib/ad-angles.ts`.
- [[tables/ad_avatar_candidates]] — Saved avatar-FACE library: every Soul text-to-image face generated from the four attributes (gender/age/health/ethnicity), persisted + reusable so the operator never re-spends Soul credits. Written by `src/app/api/ads/avatars/candidates/route.ts`.
- [[tables/ad_avatars]] — Confirmed AI spokesperson characters (Higgsfield). Max 10 per workspace; promoted from `ad_avatar_proposals`.
- [[tables/ad_avatar_proposals]] — AI-proposed spokesperson archetypes grounded in a demographic snapshot. Written by `src/lib/ad-avatar-proposals.ts`.
- [[tables/ad_campaigns]] — A single ad concept: product × variant × angle × avatar, plus script + render settings. Fans out into 4 `ad_videos`.
- [[tables/ad_videos]] — Rendered media outputs. One ad = 4 sibling rows (Reels MP4 + Feed-4:5 MP4 + Stories JPG + Feed-4:5 JPG) via `format_variant_of_id`.
- [[tables/ad_segments]] — The creative library: every generated piece (talking-head Veo clip + its script, b-roll, music) + version history. Plus the stitch recipe on `ad_campaigns.composition`. Enables the [[recipes/ad-relaunch-refresh]] (refresh one beat, re-stitch).
- [[tables/ad_jobs]] — Audit/replay log of every Higgsfield API call. Written by `loggedHiggsfieldFetch()` in `src/lib/higgsfield.ts`.

### Marketing & SMS

- [[tables/marketing_shortlink_clicks]] — Per-click log for marketing shortlinks (`superfd.co/XXXXXX`) — timestamp, IP geo, user agent.
- [[tables/marketing_shortlinks]] — Shortlink slug ↔ target URL ↔ campaign mapping. Crockford base32 6-char slug, per-workspace `shortlink_domain`.
- [[tables/sms_campaign_recipients]] — Per-recipient SMS send row — local-time-resolved `send_time`, status, message_sid. See [[../tables/sms_campaigns]].
- [[tables/sms_campaigns]] — SMS campaign — message body, MMS image, send_date, target_local_hour, audience filter, coupon config, shortlink target.
- [[tables/sms_send_candidates]] — Pre-computed per-(profile, campaign) feature snapshot used at send time for predicted-buyer segment matching.

### Klaviyo & profiles

- [[tables/klaviyo_events]] — Imported Klaviyo events (Placed Order primarily) with UTM-attribution parsed back to `attributed_klaviyo_campaign_id`. See [[../tables/sms_campaigns]].
- [[tables/klaviyo_profile_directory]] — Klaviyo profile metadata cache — id, email, phone, attributes — used for staging+matching during enrichment.
- [[tables/klaviyo_profile_staging]] — Staging table for Klaviyo profile imports before they're merged into `customers`.
- [[tables/klaviyo_sms_campaign_history]] — Historical Klaviyo SMS campaigns — message body, send time, audience segments, recomputed conversion stats.
- [[tables/profile_engagement_summary]] — Per-(workspace, profile) engagement rollup in 30/60/90d windows. Built by RPC `rebuild_engagement_summary`. Currently empty (RPC timed out).
- [[tables/profile_events]] — Engagement events: Clicked SMS, Opened/Clicked Email, Active on Site, Viewed Product, Added to Cart, Checkout Started, Received SMS.

### Amazon & ads

- [[tables/amazon_connections]] — Per-workspace Amazon Seller Central / SP-API connections (encrypted credentials).
- [[tables/amazon_sales_channels]] — Per-ASIN per-channel sales rollup (Amazon vs Shopify) used for pricing strategy.
- [[tables/daily_amazon_order_snapshots]] — Per-day Amazon orders summary for the ROAS / margin dashboards.
- [[tables/daily_meta_ad_spend]] — Per-(account, day) Meta Ads spend rollup for ROAS dashboard.
- [[tables/daily_order_snapshots]] — Per-day Shopify orders summary for analytics dashboards.
- [[tables/demographics_snapshots]] — Per-workspace cohort demographic snapshots (frozen view of a segment at a point in time).
- [[tables/monthly_revenue_snapshots]] — Per-month revenue rollup for trend dashboards.
- [[tables/zip_code_demographics]] — US zip code demographic reference data (income, age distribution) for customer enrichment.

### Billing forecast

- [[tables/billing_forecast_events]] — Append-only events that mutate the static forecast (sub created, cancelled, paused, frequency change, price change). See PERPETUAL-CAMPAIGNS-SPEC.md.
- [[tables/billing_forecasts]] — Materialized billing-cycle forecast per subscription. Rebuilt from events.

### Ops & notifications

- [[tables/auth_otp_sessions]] — One-time-password sessions for customer portal / passwordless auth.
- [[tables/dashboard_notifications]] — Generic notification system — macro_suggestion, pattern_review, knowledge_gap, fraud_alert, manual_action_needed, etc. Surfaced in the bell.
- [[tables/escalation_gaps]] — Audit of cases where the AI escalated AND a manual signal said it shouldn't have — feedback loop for confidence tuning.
- [[tables/fleet_budgets]] — Per-kind / per-function spend ceilings (tokens + `$` cents) for the box agent fleet. The supervisor's BUDGET config for the [[specs/fleet-spend-governor]] — surfaced guardrail, never silent cap.
- [[tables/import_jobs]] — Background import jobs (Shopify/Gorgias/Klaviyo) with progress + status. UI shows a progress bar.
- [[tables/iteration_actions]] — Iteration engine's autonomous-action ledger (audit/idempotency/reversal); engine append/update only (Phase 4c).
- [[tables/iteration_policies]] — Iteration engine's versioned policy control surface; engine reads active version read-only, no active ⇒ zero autonomous actions (Phase 4c).
- [[tables/iteration_runs]] — Iteration engine's per-account daily-run audit log (status/timing/per-stage counts); the supervisable-autonomy record for the whole engine (Phase 5).
- [[tables/iteration_scorecards_daily]] — Deterministic daily ad/adset/campaign/variant/angle scorecards the iteration engine reads (Phase 3).
- [[tables/slack_notification_rules]] — Per-workspace Slack notification routing rules (which events go to which channel).
- [[tables/sync_jobs]] — Background sync job state (Shopify bulk ops, Appstle pulls) — progress, status, error.

## Inngest functions (`inngest/`)

Every background job, webhook fan-out, and cron lives here. Each page lists trigger event/cron, retries + concurrency, downstream events sent, and tables read/written (wikilinked).

- [[inngest/abandoned-cart]] — Sweeps `cart_drafts` past `expires_at` → flips to `abandoned`. Hourly.
- [[inngest/ai-nightly-analysis]] — Nightly review of recent AI-handled tickets. Writes `daily_analysis_reports`. Paused 2026-04-28.
- [[inngest/amazon-sync]] — Pulls Amazon SP-API order + ASIN data.
- [[inngest/amplifier-webhooks]] — Amplifier (3PL) `order_received` / `order_shipped` → updates `orders.amplifier_*`.
- [[inngest/auto-archive]] — Archives closed tickets older than threshold.
- [[inngest/auto-blog]] — Daily cron — auto-generates a human-voiced, intelligence-grounded blog post per eligible workspace + auto-publishes.
- [[inngest/chargeback-processing]] — Shopify dispute pipeline: classify → auto-cancel sub OR review → won/lost.
- [[inngest/client]] — SDK client init (not a function).
- [[inngest/crisis-campaign]] — Daily crisis-campaign cron. Tier advancement + auto-swap.
- [[inngest/customer-demographics]] — Census + Versium demographic enrichment.
- [[inngest/daily-analysis-report-cron]] — Schedules `ai-nightly-analysis`.
- [[inngest/daily-order-snapshot]] — Daily rollup → `daily_order_snapshots`.
- [[inngest/deliver-pending-send]] — Sends queued outbound messages from `ticket_messages.pending_send_at`.
- [[inngest/delivery-audit]] — Surfaces stuck `in_transit` orders to `dashboard_notifications`.
- [[inngest/dunning]] — Payment-failed orchestrator: card rotation → payday retries → cycle action. + new-card recovery + billing-success cleanup.
- [[inngest/fraud-detection]] — Per-order + per-customer + nightly fraud scans. Tags Shopify orders `suspicious`.
- [[inngest/import-subscriptions]] — Initial Appstle subscription import.
- [[inngest/internal-subscription-renewals]] — Post-Appstle internal scheduler stub.
- [[inngest/journey-outcomes]] — Tags tickets with `jo:positive` / `jo:negative` / `jo:neutral`.
- [[inngest/kb-embed]] — Embeds new/updated KB articles into `kb_chunks`.
- [[inngest/klaviyo-attribution-compute]] — Recomputes `klaviyo_sms_campaign_history.initial_revenue_cents`.
- [[inngest/klaviyo-engagement-backfill]] — 180d historical engagement backfill (unreliable; prefer local script).
- [[inngest/klaviyo-engagement-sync]] — Daily 4am CST incremental delta → `profile_events`.
- [[inngest/klaviyo-events-import]] — Placed Order events + UTM attribution.
- [[inngest/klaviyo-sms-import]] — Historical Klaviyo SMS campaigns.
- [[inngest/loop-heartbeats-prune]] — Daily prune of `loop_heartbeats` older than 3 days (Control Tower retention).
- [[inngest/marketing-coupon-cron]] — Auto-disables expired SMS-campaign coupons.
- [[inngest/marketing-text]] — SMS campaign send pipeline (schedule + 5-min send tick).
- [[inngest/meta-historical-comments-sync]] — Backfills `social_comments` from historical posts/ads.
- [[inngest/meta-performance]] — Meta campaign/adset/ad structure + daily insights ingest (iteration engine Phase 1).
- [[inngest/meta-sync]] — Per-workspace Meta Page + Instagram sync.
- [[inngest/migration-audit-retry]] — Re-verifies pending Appstle→internal migration audits every 10 min; flips to failed after MAX_RETRIES.
- [[inngest/migration-integrity-sweep]] — Daily back-audit: seeds + runs the checklist for internal subs never audited (old-logic migrations).
- [[inngest/monthly-revenue-snapshot]] — Month-end revenue rollup.
- [[inngest/order-address-fallback]] — Backfills missing ship/bill via `Customer.defaultAddress`.
- [[inngest/portal-auto-resume]] — Resumes paused subs at `pause_resume_at`.
- [[inngest/product-intelligence]] — AI product positioning + competitor analysis.
- [[inngest/refresh-customer-segments]] — Recomputes `customers.segments` for archetype targeting.
- [[inngest/reseller-discovery]] — Weekly Mon 6am CT — pulls Amazon competitor offers + upserts `known_resellers`.
- [[inngest/returns]] — Returns refund pipeline: process-delivery → issue-refund.
- [[inngest/review-tagging]] — Tags `product_reviews` via Haiku.
- [[inngest/scrape-help-center]] — Crawls help-center sites into `knowledge_base`.
- [[inngest/seo-keyword-research]] — Generates `product_seo_keywords`.
- [[inngest/sms-wave-promote]] — Promotes `sms_send_candidates` → `sms_campaign_recipients`.
- [[inngest/social-comment-moderate]] — Per-comment orchestrator + reply + hide/delete.
- [[inngest/sync-inventory]] — Shopify inventory sync.
- [[inngest/sync-reviews]] — Nightly + on-demand Klaviyo review sync with AI summaries.
- [[inngest/sync-shopify]] — Main Shopify bulk sync (customers, orders, products).
- [[inngest/ticket-analysis-cron]] — Nightly cron over recent tickets → `ticket_analyses`.
- [[inngest/ticket-csat]] — Cron every 15 min; sends CSAT survey 48h after ticket closes. See [[lifecycles/csat]] + [[tables/ticket_csat]].
- [[inngest/ticket-research]] — Research-and-heal pipeline: investigate → recipe → propose → auto-execute allowlisted.
- [[inngest/ticket-snooze]] — Wakes snoozed tickets.
- [[inngest/today-sync]] — Today-only incremental Shopify sync.
- [[inngest/triage-escalations]] — Hourly cron (`:30`) — enqueues one box `triage-escalations` job per workspace with a routine-owned escalated ticket (the box runs the solver→skeptic→quorum sweep).
- [[inngest/unified-ticket-handler]] — **THE main pipeline.** Every inbound message → resolve → playbook → Sonnet → execute.

## Integrations (`integrations/`)

External APIs we call. Each page documents auth model, credential location (env var or `workspaces.X_encrypted` column), key endpoints, rate limits + retry pattern, and known gotchas.

- [[integrations/shopify]] — Admin GraphQL + REST + Bulk Operations + Storefront API + App Proxy + Multipass. Per-workspace OAuth.
- [[integrations/appstle]] — Subscription contracts. Per-workspace API key + shop domain.
- [[integrations/klaviyo]] — Reviews + Placed Order events + engagement events + historical SMS campaigns. Per-workspace API key.
- [[integrations/resend]] — Transactional email send + inbound parse. Per-workspace API key + webhook secret. Self-hosted open/click tracking.
- [[integrations/twilio]] — SMS send/receive + Lookup v2 phone validation + Verify v2 OTP. Account-level env + per-workspace sender numbers.
- [[integrations/easypost]] — Return label purchase + reverse-shipment tracking. Per-workspace live + test API keys.
- [[integrations/braintree]] — Payment gateway for the custom storefront + recurring billing (replaces Shopify Payments + Appstle). Per-workspace merchant + keys.
- [[integrations/avalara]] — Sales tax calculation + commit. Per-workspace account + license key.
- [[integrations/meta-graph]] — Organic Pages/IG/Messenger — comments, DMs, replies. Per-workspace Page Access Token.
- [[integrations/meta-marketing]] — Paid ads insights + Conversions API (CAPI) fan-out. Same OAuth as meta-graph + system user token.
- [[integrations/inngest]] — Durable workflow engine. Account-level env keys only.
- [[integrations/openai]] — Embeddings only (`text-embedding-3-small`, 1536d). Account-level env.
- [[integrations/anthropic]] — Claude Haiku + Sonnet + Opus. All AI surfaces. Account-level env.
- [[integrations/quickbooks-online]] — QuickBooks Online accounting sync (OAuth 2.0; items/inventory/COGS, journal entries, sales receipts). **Reference skill-set ported from the sibling `shoptics` app — NOT yet implemented in shopcx;** see the page's "Porting to shopcx" section.

## Lifecycles (`lifecycles/`)

Long-form narrative pages tracing key flows end-to-end. Each wikilinks 5+ reference pages and ends with a `Files touched` section listing every `src/lib/*` involved.

- [[lifecycles/ticket-lifecycle]] — Inbound message → orchestrator → action → close → CSAT. The hottest path in the platform.
- [[lifecycles/ai-multi-turn]] — Route → assemble context → generate → confidence-gate → send → auto-resolve. Tool-use orchestrator details.
- [[lifecycles/ai-learning]] — Self-improvement loop: tickets → grader → daily report → proposed rules → auto-review (accept/reject/merge/supersede/revise; no human queue) → applied rules → orchestrator → tickets. Closes.
- [[lifecycles/dunning]] — Payment-failed → card rotation → payday retry → cycle action → recovery / pause.
- [[lifecycles/return-pipeline]] — `createFullReturn` → EasyPost label → delivered → issue-refund → confirmation email.
- [[lifecycles/cancel-flow]] — Cancel intent → cancel journey → Haiku remedy → save / cancel → tag.
- [[lifecycles/crisis-campaign]] — Crisis activation → daily cron → Tier 1/2/3 → resolve auto-resume.
- [[lifecycles/social-comment-moderation]] — Webhook → ingest → pass-1 classify → pass-2 generate → action.
- [[lifecycles/fraud-detection]] — Order create → rules → fraud_cases → hold orders → confirmed_fraud → orchestrator gate.
- [[lifecycles/storefront-checkout]] — PDP → cart → tax-quote → Braintree vault + sale → order create → CAPI fan-out.
- [[lifecycles/blog-resources]] — Shopify blog import → AI classify → [[tables/posts]] → public storefront blog + portal Resources.
- [[lifecycles/auto-blog-generation]] — Daily engine: product intelligence + web research → human-voiced post → branded NBP imagery → auto-published [[tables/posts]].
- [[lifecycles/subscription-billing]] — In-house billing-tick cron → renewal quote → tax → Braintree → orders → dunning on failure.
- [[lifecycles/customer-link-confirmation]] — Meta sender → fuzzy match → agent confirms → `meta_sender_customer_links` → backfill.
- [[lifecycles/chargeback-pipeline]] — Shopify dispute → `chargeback_events` → fraud classification → auto-cancel subs → `chargeback_subscription_actions`.
- [[lifecycles/demographic-enrichment]] — New customer → name→Haiku, ZIP→Census, orders→buyer_type → `customer_demographics` → snapshots → dashboard.
- [[lifecycles/product-intelligence]] — Product → ingredients → research → review analysis → benefit selections → page content → publish. The Product Intelligence Engine.
- [[lifecycles/roadmap-build-console]] — Describe a feature → spec → autonomous box build (Max) → answer/approve → merge → fold. The self-driving roadmap.
- [[lifecycles/spec-goal-branch-pm-flow]] — Authored spec → phases accumulate on `claude/build-{slug}` → branch-preview spec-test → `in_testing` → one-off spec → main (Gate A) OR spec → `goal/{goal}` (Gate B) → atomic goal → main (Gate C). Branch-accumulation + atomic promotion + Reva's escalate-not-revert.
- [[lifecycles/showcase]] — Password-gated `/showcase/*` investor/friend narrative section (gate in `src/proxy.ts`, signed cookie). Flagship: the Autonomous CTO DevOps explainer. Read-only static prose, no live data. Needs `SHOWCASE_PASSWORD` in Vercel (dev fallback `superfoods`).

## Journeys (`journeys/`)

One page per row in [[tables/journey_definitions]]. See [[journeys/README]] for the architecture, channel rules, and the "live render" principle.

- [[journeys/cancel]] — AI-powered retention with Haiku remedy selection. Highest priority (5).
- [[journeys/discount-signup]] — Marketing consent capture + coupon delivery.
- [[journeys/account-linking]] — Prepend-only. Silently inserted as Step 0 of other journeys.
- [[journeys/crisis-tier1-flavor-swap]] — Crisis Tier 1 — flavor swap.
- [[journeys/crisis-tier2-product-swap]] — Crisis Tier 2 — product swap + 20% coupon.
- [[journeys/crisis-tier3-pause-remove]] — Crisis Tier 3 — pause (berry_only) or remove item (berry_plus).
- [[journeys/shipping-address]] — Sub / order / default address change with EasyPost validation.
- [[journeys/missing-items]] — Line-item checklist driving replacements.
- [[journeys/select-subscription]] — Sub picker used by other flows.

## Playbooks (`playbooks/`)

One page per active row in [[tables/playbooks]]. See [[playbooks/README]] for the data model, step types, and the universal communication patterns.

- [[playbooks/refund]] — Sub-renewal dispute → identify → policy → tiered exceptions → return / refund / store credit.
- [[playbooks/replacement-order]] — Missing / damaged / lost → tracking check → missing-items checklist → fresh draft order at no cost.

## Libraries (`libraries/`)

One page per `src/lib/*.ts` file (175 pages). Each page lists exports + signatures, callers grep'd across the codebase, and gotchas. The required-list files (orchestrator, action executor, subscription helpers, Appstle, returns, dunning, journeys, social comments, etc.) have curated descriptions and gotchas; the long tail uses each file's header comment.

Most relevant entry points:

- [[libraries/sonnet-orchestrator-v2]] — THE brain
- [[libraries/anthropic-retry]] — Classifies a Claude failure (retryable outage vs terminal bug) so the run retries, not drops
- [[libraries/action-executor]] — Dispatches `SonnetDecision`
- [[libraries/subscription-items]] — Appstle line-item mutations (note 0.75 SubSave)
- [[libraries/appstle]] · [[libraries/appstle-discount]] · [[libraries/appstle-call-log]]
- [[libraries/shopify-returns]] · [[libraries/shopify-order-actions]] · [[libraries/replacement-order]]
- [[libraries/dunning]] · [[libraries/dunning-webhook]]
- [[libraries/journey-launcher]] · [[libraries/cancel-journey-builder]] · [[libraries/remedy-selector]]
- [[libraries/social-comment-orchestrator]] · [[libraries/social-comment-actions]] · [[libraries/social-comment-ingest]]
- [[libraries/email]] · [[libraries/email-tracking]] · [[libraries/crypto]] · [[libraries/rag]] · [[libraries/embeddings]]
- [[libraries/fraud-detector]] · [[libraries/pattern-matcher]] · [[libraries/rules-engine]]
- [[libraries/ticket-tags]] · [[libraries/first-touch]] · [[libraries/escalation]]

## Recipes (`recipes/`)

How-to pages for common operational tasks. Each page is structured the same: helper to call + file path, exact signature, minimal working example, gotchas. See [[recipes/README]] for the index.

Subscription mutations: [[recipes/change-line-item-price]] · [[recipes/swap-variant]] · [[recipes/change-quantity]] · [[recipes/pause-sub]] · [[recipes/resume-sub]] · [[recipes/cancel-sub-via-journey]] · [[recipes/bill-now]] · [[recipes/change-next-date]] · [[recipes/apply-coupon]] · [[recipes/apply-loyalty-coupon]]

Orders + returns: [[recipes/issue-replacement]] · [[recipes/create-return]] · [[recipes/issue-refund]] · [[recipes/partial-refund]]

Loyalty: [[recipes/redeem-loyalty]] · [[recipes/apply-loyalty-coupon]]

Tickets + comms: [[recipes/escalate-ticket]] · [[recipes/send-email-reply]] · [[recipes/send-chat-reply]]

Social: [[recipes/ban-meta-user]] · [[recipes/hide-comment]] · [[recipes/link-meta-sender-to-customer]]

Infra: [[recipes/fire-an-inngest-event]] · [[recipes/write-a-migration-apply-script]]

## Dashboard (`dashboard/`)

One page per route family under `src/app/dashboard/*` (top-level operational pages) and one per `src/app/dashboard/settings/*` (workspace configuration). Each page covers purpose, visible features (filters + buttons), API endpoints called (extracted from `fetch()`), sub-routes, permissions, and files touched.

### Operational pages

- [[dashboard/tickets]] — master ticket queue
- [[dashboard/subscriptions]] — all subs with recovery + status filters
- [[dashboard/migrations]] — Appstle→internal migration monitor (what's stuck? — renewals at risk)
- [[dashboard/customers]] — customer list with retention + LTV + linked groups
- [[dashboard/orders]] — order list + detail
- [[dashboard/products]] — catalog + sync + intelligence
- [[dashboard/social-comments]] — Meta + IG moderation queue
- [[dashboard/conversations]] — message-level flow across channels
- [[dashboard/fraud]] — fraud cases list + detail
- [[dashboard/chargebacks]] — disputes with active-sub count
- [[dashboard/returns]] — returns with status + refund tracking
- [[dashboard/replacements]] — replacement orders + threshold tracking
- [[dashboard/crisis]] — crisis campaigns
- [[dashboard/delivery]] — stuck-in-transit audit
- [[dashboard/knowledge-base]] — KB CRUD + scraper
- [[dashboard/loyalty]] — members + redemptions
- [[dashboard/macros]] — macro library with acceptance badges
- [[dashboard/marketing]] — SMS / email campaigns hub
- [[dashboard/analytics]] — revenue + ROAS + cohorts
- [[dashboard/storefront]] — storefront funnel + drop-off
- [[dashboard/storefront__blog]] — read-only blog/resources table (Storefront › Blog)
- [[dashboard/csat]] — survey results + resolution-gate stats
- [[dashboard/ai-analysis]] — nightly AI quality + research/heal
- [[dashboard/demographics]] — customer demographic cohorts
- [[dashboard/resellers]] — known reseller list with review queue
- [[dashboard/reviews]] — Klaviyo-synced reviews + summaries
- [[dashboard/portal-analytics]] — portal action funnel
- [[dashboard/team]] — workspace members + invites
- [[dashboard/home]] — overview KPIs

### Settings pages

Workspace configuration — most are owner/admin-gated:

- AI brain: [[dashboard/settings/ai]] · [[dashboard/settings/policies]] · [[dashboard/settings/playbooks]] · [[dashboard/settings/journeys]] · [[dashboard/settings/cancel-flow]] · [[dashboard/settings/patterns]] · [[dashboard/settings/rules]] · [[dashboard/settings/workflows]] · [[dashboard/settings/sandbox]] · [[dashboard/settings/auto-close]]
- Channels: [[dashboard/settings/integrations]] · [[dashboard/settings/chat-widget]] · [[dashboard/settings/email-filters]] · [[dashboard/settings/response-delay]] · [[dashboard/settings/slack]] · [[dashboard/settings/text-marketing]]
- Subscriptions: [[dashboard/settings/dunning]] · [[dashboard/settings/subscription-settings]] · [[dashboard/settings/pricing-rules]] · [[dashboard/settings/coupons]] · [[dashboard/settings/loyalty]]
- Risk: [[dashboard/settings/fraud]] · [[dashboard/settings/chargebacks]]
- Storefront: [[dashboard/settings/storefront-design]] · [[dashboard/settings/storefront-domain]] · [[dashboard/settings/portal]]
- Ops: [[dashboard/settings/import]] · [[dashboard/settings/knowledge-base]] · [[dashboard/settings/tags]] · [[dashboard/settings/views]] · [[dashboard/settings/order-sources]] · [[dashboard/settings/tracking-sla]] · [[dashboard/settings/amazon-pricing]]

---

[[../../CLAUDE]]
