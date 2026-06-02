# brain — table reference

One page per table in the `public` schema (138 total). Each page has:

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
- [[tables/meta_connections]] — Per-workspace Meta OAuth state + connected page/instagram accounts.
- [[tables/meta_pages]] — Meta Pages connected for inbound DM + comment management.
- [[tables/meta_post_cache]] — Cached Meta post/ad metadata for comment context (text, image, ad attribution).
- [[tables/meta_sender_customer_links]] — Meta-sender-id ↔ internal customer_id mapping. Built from Conversations API on DM.
- [[tables/meta_webhook_raw]] — Raw Meta webhook bodies for debugging.
- [[tables/sms_marketing_inbound]] — Inbound SMS replies / STOP / HELP messages.
- [[tables/social_comment_replies]] — Outbound replies to social-comment tickets (Meta / IG comments).
- [[tables/social_comments]] — Inbound social comments (Meta Page posts, Instagram). channel='social_comments'.
- [[tables/support_emails]] — Per-workspace support@/help@ inbound email mailbox configs.
- [[tables/ticket_analyses]] — Per-ticket AI analysis output — sentiment, intent, summary, suggested action.
- [[tables/ticket_heal_attempts]] — Per-ticket auto-heal attempts (research-and-heal pipeline). See RESEARCH-AND-HEAL.md.
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
- [[tables/macro_audit_jobs]] — Jobs that re-audit macro acceptance rates and flag low-performers for review.
- [[tables/macro_usage_log]] — Per-use tracking of every macro send — source (ai/agent), outcome (accepted/rejected/personalized).
- [[tables/macros]] — Canned response templates with embeddings + AI-suggestion counters. Discoverable by Sonnet.
- [[tables/pattern_feedback]] — Smart-pattern agent feedback queue (agent removed an auto-applied smart: tag → review).
- [[tables/policies]] — Canonical published policies (refund window, restocking, exchange rules, etc). Consumed by orchestrator, storefront, and (TODO) playbook executor.
- [[tables/rules]] — Compound AND/OR rules engine — ordered actions, 8 action types. Evaluated on inbound events.
- [[tables/smart_patterns]] — Global + workspace-scoped patterns. 3-layer classifier (keywords → embeddings → Haiku fallback).
- [[tables/sonnet_prompts]] — DB-driven prompt rules for the Sonnet orchestrator. category: rule/approach/knowledge/tool_hint. Editable in Settings → AI → Prompts.
- [[tables/workflows]] — Template-based deterministic workflows (order_tracking, cancel_request, subscription_inquiry, account_login, end_chat).
- [[tables/workspace_pattern_overrides]] — Per-workspace overrides on global smart_patterns (disable a global pattern, raise/lower its threshold).

### Journeys

- [[tables/chat_journeys]] — Active in-flight chat journey state per session (legacy — most chat journeys now use the same `journey_sessions` row as email).
- [[tables/journey_definitions]] — Journey configs — slug, channels, match_patterns, trigger_intent, step_ticket_status, priority. See JOURNEYS.md.
- [[tables/journey_sessions]] — Per-customer journey invocation. token (for `/journey/{token}`), responses, status. The customer-facing artifact.
- [[tables/journey_step_events]] — Append-only audit log of every step response within a journey session.

### Playbooks

- [[tables/playbook_exceptions]] — Per-(playbook, customer/ticket) one-off exception grants (e.g. tenured customer auto-approved).
- [[tables/playbook_policies]] — Policies attached to playbooks — limits, escalation thresholds. See PLAYBOOK-SPEC.md.
- [[tables/playbook_simulations]] — Recorded playbook dry-runs for testing rule changes.
- [[tables/playbook_steps]] — Steps inside a playbook — ordered, with action type and config. See PLAYBOOK-SPEC.md.
- [[tables/playbooks]] — Customer-service playbooks (e.g. unwanted_charge_subscription_dispute). Discoverable by Sonnet.

### Cancel & retention

- [[tables/coupon_mappings]] — Shopify coupon code ↔ internal mapping with VIP tier filtering. Referenced by remedies and discount journey.
- [[tables/product_review_analysis]] — Aggregate review analysis (sentiment, key phrases, themes).
- [[tables/product_reviews]] — Klaviyo-synced product reviews with AI summaries. Used for cancel-journey social proof.
- [[tables/remedies]] — Per-workspace retention remedies for cancel journey (coupon, pause, skip, frequency_change, free_product, line_item_modifier).
- [[tables/remedy_outcomes]] — Per-(session, remedy, reason) tracking — shown / accepted / rejected. Drives AI remedy selection learning.

### Crisis management

- [[tables/crisis_customer_actions]] — Per-customer state in a crisis campaign — segment, current tier, responses, swap/pause/remove actions. See CRISIS-MANAGEMENT-SPEC.md.
- [[tables/crisis_events]] — Crisis campaigns (e.g. Mixed Berry OOS) — affected variant, swap options, tiers, coupon. See CRISIS-MANAGEMENT-SPEC.md.

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

- [[tables/cart_drafts]] — Server-side cart state for the custom storefront. Token-bound, server-validated pricing, lifecycle: pending → converted/abandoned. See STOREFRONT.md.
- [[tables/event_dispatches]] — Per-(event, sink) dispatch state for the CAPI clearinghouse — pending/sent/failed/dlq. See STOREFRONT.md.
- [[tables/event_sinks]] — Downstream destinations for storefront events — meta_capi, tiktok_events, google_enhanced, klaviyo, custom. Encrypted credentials.
- [[tables/pricing_rules]] — Storefront pricing rules — tier qty, mode (subscription vs one-time), frequency, discount %, line-item price.
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
- [[tables/product_intelligence]] — AI-generated product intelligence (positioning, competitor analysis, recommended angles).
- [[tables/product_link_groups]] — Cross-product link groups — bundles, related products, upsell groups.
- [[tables/product_link_members]] — Members of a `product_link_groups` row.
- [[tables/product_media]] — Per-product media (images, videos) with dimensions and roles (hero, gallery, before/after).
- [[tables/product_page_content]] — PDP content blocks per product (sections, ordering).
- [[tables/product_pricing_rule]] — Per-product attached pricing rule.
- [[tables/product_pricing_tiers]] — Per-product pricing tiers (1-pack / 3-pack / 6-pack) with price.
- [[tables/product_seo_keywords]] — Per-product SEO keyword targets for ad/landing-page copy.
- [[tables/product_variants]] — First-class variant rows (UUID PK). Source of truth for variants; `products.variants` JSONB is a legacy mirror.
- [[tables/products]] — Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.

### Marketing & SMS

- [[tables/marketing_shortlink_clicks]] — Per-click log for marketing shortlinks (`superfd.co/XXXXXX`) — timestamp, IP geo, user agent.
- [[tables/marketing_shortlinks]] — Shortlink slug ↔ target URL ↔ campaign mapping. Crockford base32 6-char slug, per-workspace `shortlink_domain`.
- [[tables/sms_campaign_recipients]] — Per-recipient SMS send row — local-time-resolved `send_time`, status, message_sid. See TEXT-MARKETING.md.
- [[tables/sms_campaigns]] — SMS campaign — message body, MMS image, send_date, target_local_hour, audience filter, coupon config, shortlink target.
- [[tables/sms_send_candidates]] — Pre-computed per-(profile, campaign) feature snapshot used at send time for predicted-buyer segment matching.

### Klaviyo & profiles

- [[tables/klaviyo_events]] — Imported Klaviyo events (Placed Order primarily) with UTM-attribution parsed back to `attributed_klaviyo_campaign_id`. See TEXT-MARKETING.md.
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
- [[tables/import_jobs]] — Background import jobs (Shopify/Gorgias/Klaviyo) with progress + status. UI shows a progress bar.
- [[tables/slack_notification_rules]] — Per-workspace Slack notification routing rules (which events go to which channel).
- [[tables/sync_jobs]] — Background sync job state (Shopify bulk ops, Appstle pulls) — progress, status, error.

---

[[../../CLAUDE]] · [[../../DATABASE]] · [[../../JOURNEYS]] · [[../../STOREFRONT]] · [[../../SONNET-ORCHESTRATOR]] · [[../../TEXT-MARKETING]]
