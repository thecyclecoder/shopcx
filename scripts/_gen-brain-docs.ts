/**
 * Generates docs/brain/tables/{table}.md for every public.* table.
 * Auto: columns, FKs (as wikilinks), indexes.
 * Curated: summaries, gotchas, query examples (inlined below).
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

type Col = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  udt_name: string;
};
type FK = {
  table_name: string;
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
};
type Schema = {
  tables: string[];
  columns: Record<string, Col[]>;
  fks: Record<string, FK[]>;
  pks: Record<string, string[]>;
  indexes: Record<string, { indexname: string; indexdef: string }[]>;
};

const schema: Schema = JSON.parse(
  readFileSync(resolve(__dirname, "../tmp-schema.json"), "utf8"),
);

// ────────────────────────────────────────────────────────────────────────────
// SUMMARIES — one-line description per table
// ────────────────────────────────────────────────────────────────────────────
const SUMMARIES: Record<string, string> = {
  ai_channel_config: "Per-(workspace, channel) AI agent settings — personality, confidence threshold, auto-resolve toggle, turn limit.",
  ai_personalities: "Named AI personalities — tone, style, sign-off, emoji policy. Referenced by `ai_channel_config`.",
  ai_token_usage: "Per-call AI token accounting — model, input/output/cache tokens, cost, latency. Drives usage dashboards.",
  ai_workflows: "AI-callable workflows (e.g. marketing_signup). Discoverable by the Sonnet orchestrator and referenced by `tickets.ai_workflow_id`.",
  amazon_asins: "Amazon catalog — ASIN ↔ product mapping, pricing, rank. Source for reseller discovery and pricing intelligence.",
  amazon_connections: "Per-workspace Amazon Seller Central / SP-API connections (encrypted credentials).",
  amazon_sales_channels: "Per-ASIN per-channel sales rollup (Amazon vs Shopify) used for pricing strategy.",
  appstle_api_calls: "Audit log of every Appstle API request — endpoint, status, response. For debugging subscription mutations.",
  auth_otp_sessions: "One-time-password sessions for customer portal / passwordless auth.",
  banned_meta_users: "Meta DM / comment senders banned from messaging us. Workspace-scoped.",
  billing_forecast_events: "Append-only events that mutate the static forecast (sub created, cancelled, paused, frequency change, price change). See PERPETUAL-CAMPAIGNS-SPEC.md.",
  billing_forecasts: "Materialized billing-cycle forecast per subscription. Rebuilt from events.",
  cart_drafts: "Server-side cart state for the custom storefront. Token-bound, server-validated pricing, lifecycle: pending → converted/abandoned. See STOREFRONT.md.",
  chargeback_events: "Shopify disputes — reason, status, amount, customer. Drives auto-cancel pipeline and chargebacks dashboard.",
  chargeback_subscription_actions: "Per-chargeback log of subscription cancellations/reinstatements.",
  chat_journeys: "Active in-flight chat journey state per session (legacy — most chat journeys now use the same `journey_sessions` row as email).",
  coupon_mappings: "Shopify coupon code ↔ internal mapping with VIP tier filtering. Referenced by remedies and discount journey.",
  crisis_customer_actions: "Per-customer state in a crisis campaign — segment, current tier, responses, swap/pause/remove actions. See CRISIS-MANAGEMENT-SPEC.md.",
  crisis_events: "Crisis campaigns (e.g. Mixed Berry OOS) — affected variant, swap options, tiers, coupon. See CRISIS-MANAGEMENT-SPEC.md.",
  customer_demographics: "Per-customer demographic enrichment (age band, household income band, etc.) from Census/Versium.",
  customer_events: "Append-only customer event log — portal actions, subscription mutations, journey responses. Source of truth for the customer activity timeline.",
  customer_link_rejections: "Customers explicitly rejected a suggested account link — never re-offer.",
  customer_links: "Account-linking graph. Multiple `customer_id`s share a `group_id` = one real person.",
  customer_payment_methods: "Customer payment methods snapshot from Shopify (last4, brand, expiry). Used for dunning card rotation dedup.",
  customers: "Synced from Shopify. Email, retention_score, subscription_status, LTV, marketing consent. A 'lead' is a customer with no orders.",
  daily_amazon_order_snapshots: "Per-day Amazon orders summary for the ROAS / margin dashboards.",
  daily_analysis_reports: "AI-generated daily analysis reports for the dashboard.",
  daily_meta_ad_spend: "Per-(account, day) Meta Ads spend rollup for ROAS dashboard.",
  daily_order_snapshots: "Per-day Shopify orders summary for analytics dashboards.",
  dashboard_notifications: "Generic notification system — macro_suggestion, pattern_review, knowledge_gap, fraud_alert, manual_action_needed, etc. Surfaced in the bell.",
  demographics_snapshots: "Per-workspace cohort demographic snapshots (frozen view of a segment at a point in time).",
  dunning_cycles: "Per-(subscription, billing cycle) dunning state machine. status: active/skipped/paused/recovered/exhausted. See Phase 5 in CLAUDE.md.",
  dunning_error_codes: "Lookup table of payment gateway decline codes mapped to category + customer-facing wording.",
  email_events: "Universal email tracking — sent, delivered, opened, clicked, bounced. Joined by `resend_email_id`.",
  email_filters: "Per-workspace inbound-email rules (spam/auto-replies to ignore).",
  escalation_gaps: "Audit of cases where the AI escalated AND a manual signal said it shouldn't have — feedback loop for confidence tuning.",
  event_dispatches: "Per-(event, sink) dispatch state for the CAPI clearinghouse — pending/sent/failed/dlq. See STOREFRONT.md.",
  event_sinks: "Downstream destinations for storefront events — meta_capi, tiktok_events, google_enhanced, klaviyo, custom. Encrypted credentials.",
  fraud_action_log: "Append-only audit of every fraud rule match — what rule, what action taken, what context.",
  fraud_case_history: "State transitions on a fraud case (open → reviewing → confirmed_fraud / dismissed).",
  fraud_cases: "Active fraud investigations. rule_type, severity, orders_held, resolution.",
  fraud_rule_matches: "Per-(rule, customer/order) rule-trigger events. Drives `fraud_cases` row creation.",
  fraud_rules: "Configurable fraud detection rules (shared_address, high_velocity, address_distance, name_mismatch, amazon_reseller).",
  grader_prompts: "Prompts used by the AI quality-grader pipeline to score sent responses.",
  import_jobs: "Background import jobs (Shopify/Gorgias/Klaviyo) with progress + status. UI shows a progress bar.",
  journey_definitions: "Journey configs — slug, channels, match_patterns, trigger_intent, step_ticket_status, priority. See JOURNEYS.md.",
  journey_sessions: "Per-customer journey invocation. token (for `/journey/{token}`), responses, status. The customer-facing artifact.",
  journey_step_events: "Append-only audit log of every step response within a journey session.",
  kb_chunks: "RAG retrieval chunks for knowledge base articles. pgvector embedding (1536).",
  klaviyo_events: "Imported Klaviyo events (Placed Order primarily) with UTM-attribution parsed back to `attributed_klaviyo_campaign_id`. See TEXT-MARKETING.md.",
  klaviyo_profile_directory: "Klaviyo profile metadata cache — id, email, phone, attributes — used for staging+matching during enrichment.",
  klaviyo_profile_staging: "Staging table for Klaviyo profile imports before they're merged into `customers`.",
  klaviyo_sms_campaign_history: "Historical Klaviyo SMS campaigns — message body, send time, audience segments, recomputed conversion stats.",
  knowledge_base: "Help center articles — slug, content_html, view_count, helpful_yes/no. Public-facing.",
  knowledge_gaps: "AI-detected knowledge gaps — moments the AI had nothing to say. Surfaced for admin review.",
  known_resellers: "Amazon resellers (sellerId + business name + address) used by the `amazon_reseller` fraud rule. See CLAUDE.md § Reseller Defense.",
  loyalty_members: "Per-(workspace, customer) loyalty enrollment + tier + points balance.",
  loyalty_redemptions: "Points redemption events — coupon issued, used, expired.",
  loyalty_settings: "Per-workspace loyalty program config — tiers, point earn rates, redemption tiers.",
  loyalty_transactions: "Append-only points ledger — earn (order placed), spend (redemption), adjust (manual).",
  macro_audit_jobs: "Jobs that re-audit macro acceptance rates and flag low-performers for review.",
  macro_usage_log: "Per-use tracking of every macro send — source (ai/agent), outcome (accepted/rejected/personalized).",
  macros: "Canned response templates with embeddings + AI-suggestion counters. Discoverable by Sonnet.",
  marketing_shortlink_clicks: "Per-click log for marketing shortlinks (`superfd.co/XXXXXX`) — timestamp, IP geo, user agent.",
  marketing_shortlinks: "Shortlink slug ↔ target URL ↔ campaign mapping. Crockford base32 6-char slug, per-workspace `shortlink_domain`.",
  meta_ad_accounts: "Meta Ads accounts connected to the workspace.",
  meta_connections: "Per-workspace Meta OAuth state + connected page/instagram accounts.",
  meta_pages: "Meta Pages connected for inbound DM + comment management.",
  meta_post_cache: "Cached Meta post/ad metadata for comment context (text, image, ad attribution).",
  meta_sender_customer_links: "Meta-sender-id ↔ internal customer_id mapping. Built from Conversations API on DM.",
  meta_webhook_raw: "Raw Meta webhook bodies for debugging.",
  monthly_revenue_snapshots: "Per-month revenue rollup for trend dashboards.",
  orders: "Synced from Shopify. line_items, fulfillments, financial/fulfillment status, attribution UTMs.",
  pattern_feedback: "Smart-pattern agent feedback queue (agent removed an auto-applied smart: tag → review).",
  payment_failures: "Per-attempt log within a dunning cycle — card tried, result, attempt type (initial/card_rotation/payday_retry/new_card_retry).",
  playbook_exceptions: "Per-(playbook, customer/ticket) one-off exception grants (e.g. tenured customer auto-approved).",
  playbook_policies: "Policies attached to playbooks — limits, escalation thresholds. See PLAYBOOK-SPEC.md.",
  playbook_simulations: "Recorded playbook dry-runs for testing rule changes.",
  playbook_steps: "Steps inside a playbook — ordered, with action type and config. See PLAYBOOK-SPEC.md.",
  playbooks: "Customer-service playbooks (e.g. unwanted_charge_subscription_dispute). Discoverable by Sonnet.",
  policies: "Canonical published policies (refund window, restocking, exchange rules, etc). Consumed by orchestrator, storefront, and (TODO) playbook executor.",
  pricing_rules: "Storefront pricing rules — tier qty, mode (subscription vs one-time), frequency, discount %, line-item price.",
  product_benefit_angles: "Benefit angles per product (anti-aging, energy, gut health) for marketing/PDP copy generation.",
  product_benefit_selections: "Per-(product, angle) selection of which benefit angle is in active rotation.",
  product_how_it_works: "PDP 'How it works' section content per product.",
  product_ingredient_research: "Research/citations for each ingredient — used by the ingredient deep-dive PDP section.",
  product_ingredients: "Per-product ingredient list with name, dose, function.",
  product_link_groups: "Cross-product link groups — bundles, related products, upsell groups.",
  product_link_members: "Members of a `product_link_groups` row.",
  product_media: "Per-product media (images, videos) with dimensions and roles (hero, gallery, before/after).",
  product_page_content: "PDP content blocks per product (sections, ordering).",
  product_pricing_rule: "Per-product attached pricing rule.",
  product_pricing_tiers: "Per-product pricing tiers (1-pack / 3-pack / 6-pack) with price.",
  product_review_analysis: "Aggregate review analysis (sentiment, key phrases, themes).",
  product_reviews: "Klaviyo-synced product reviews with AI summaries. Used for cancel-journey social proof.",
  product_seo_keywords: "Per-product SEO keyword targets for ad/landing-page copy.",
  product_variants: "First-class variant rows (UUID PK). Source of truth for variants; `products.variants` JSONB is a legacy mirror.",
  products: "Synced from Shopify Online Store channel. `variants` JSONB is legacy — real source is `product_variants`.",
  profile_engagement_summary: "Per-(workspace, profile) engagement rollup in 30/60/90d windows. Built by RPC `rebuild_engagement_summary`. Currently empty (RPC timed out).",
  profile_events: "Engagement events: Clicked SMS, Opened/Clicked Email, Active on Site, Viewed Product, Added to Cart, Checkout Started, Received SMS.",
  remedies: "Per-workspace retention remedies for cancel journey (coupon, pause, skip, frequency_change, free_product, line_item_modifier).",
  remedy_outcomes: "Per-(session, remedy, reason) tracking — shown / accepted / rejected. Drives AI remedy selection learning.",
  replacements: "Reshipment/replacement orders. Created by playbooks or agent action. Counts against customer's replacement_threshold.",
  returns: "Customer returns. status: open → label_created → in_transit → delivered → refunded. See returns pipeline in CLAUDE.md.",
  rules: "Compound AND/OR rules engine — ordered actions, 8 action types. Evaluated on inbound events.",
  shipping_rates: "Storefront shipping rates per (region, weight) — referenced by orders + subscriptions.",
  slack_notification_rules: "Per-workspace Slack notification routing rules (which events go to which channel).",
  smart_patterns: "Global + workspace-scoped patterns. 3-layer classifier (keywords → embeddings → Haiku fallback).",
  sms_campaign_recipients: "Per-recipient SMS send row — local-time-resolved `send_time`, status, message_sid. See TEXT-MARKETING.md.",
  sms_campaigns: "SMS campaign — message body, MMS image, send_date, target_local_hour, audience filter, coupon config, shortlink target.",
  sms_marketing_inbound: "Inbound SMS replies / STOP / HELP messages.",
  sms_send_candidates: "Pre-computed per-(profile, campaign) feature snapshot used at send time for predicted-buyer segment matching.",
  social_comment_replies: "Outbound replies to social-comment tickets (Meta / IG comments).",
  social_comments: "Inbound social comments (Meta Page posts, Instagram). channel='social_comments'.",
  sonnet_prompts: "DB-driven prompt rules for the Sonnet orchestrator. category: rule/approach/knowledge/tool_hint. Editable in Settings → AI → Prompts.",
  store_credit_log: "Per-customer store credit ledger — issued, used, expired. Backed by Shopify storeCreditAccount.",
  storefront_events: "Append-only storefront event log (pdp_view, pack_selected, order_placed, etc.). PK is client-generated UUID for CAPI dedup. 90d retention.",
  storefront_leads: "Lead-capture events on the storefront. Customer is created/matched, this row logs the capture surface.",
  storefront_sessions: "One row per anonymous_id. Device fingerprint, UTMs, click IDs, _fbp/_fbc cookies, IP-derived geo. Indefinite retention.",
  subscriptions: "Synced from Appstle. items JSONB, billing interval, next billing date. Will become source of truth post-Appstle.",
  support_emails: "Per-workspace support@/help@ inbound email mailbox configs.",
  sync_jobs: "Background sync job state (Shopify bulk ops, Appstle pulls) — progress, status, error.",
  ticket_analyses: "Per-ticket AI analysis output — sentiment, intent, summary, suggested action.",
  ticket_heal_attempts: "Per-ticket auto-heal attempts (research-and-heal pipeline). See RESEARCH-AND-HEAL.md.",
  ticket_messages: "Messages on a ticket. direction (in/out), visibility (public/internal), author_type (customer/agent/ai/system).",
  ticket_research_runs: "Per-ticket research runs (the deep-investigation pipeline that runs before a heal attempt).",
  ticket_views: "Saved ticket filter combos. Nested up to 2 levels via parent_id. Live in sidebar.",
  tickets: "Customer support tickets. status (open/pending/closed/archived), channel, handled_by, ai_turn_count, journey/playbook state.",
  transactions: "Per-(order, customer, subscription) Braintree transaction log — type, amount, status, processor response. attempted_at / settled_at / refunded_at.",
  widget_path_mappings: "Storefront widget — URL path patterns → widget config (which proactive prompt, what greeting).",
  widget_sessions: "Per-visitor chat-widget session state (anonymous chat tickets begin here).",
  workflows: "Template-based deterministic workflows (order_tracking, cancel_request, subscription_inquiry, account_login, end_chat).",
  workspace_invites: "Pending workspace invitations sent via email.",
  workspace_members: "User ↔ workspace membership. role enum (owner/admin/agent/social/marketing/read_only). display_name is the user-facing label.",
  workspace_pattern_overrides: "Per-workspace overrides on global smart_patterns (disable a global pattern, raise/lower its threshold).",
  workspaces: "Multi-tenant root. Encrypted credentials, sandbox_mode, response_delays, help_slug, portal_config, storefront branding.",
  zip_code_demographics: "US zip code demographic reference data (income, age distribution) for customer enrichment.",
};

// ────────────────────────────────────────────────────────────────────────────
// GOTCHAS — table-specific quirks, mostly from DATABASE.md
// ────────────────────────────────────────────────────────────────────────────
const GOTCHAS: Record<string, string[]> = {
  subscriptions: [
    "`status` is **lowercase**: `\"active\"`, `\"paused\"`, `\"cancelled\"`. `.eq(\"status\", \"ACTIVE\")` returns zero rows.",
    "No `cancelled_at` / `paused_at` columns — the timestamp lives in `customer_events`. To know *when* a sub was cancelled, query the event log.",
    "`shopify_customer_id` is a denormalized fallback. When `customer_id` is wrong/missing, query by `shopify_customer_id` against `customers.shopify_customer_id` as a second pass.",
    "Always include linked customers — use `linkedIds(customerId)` helper, then `.in(\"customer_id\", ids)`.",
    "`items` is JSONB — variant ids live inside, not on a join table. Use `items->0->>'variantId'`.",
  ],
  customers: [
    "`email_marketing_status` / `sms_marketing_status`: `\"subscribed\"`, `\"unsubscribed\"`, `\"not_subscribed\"`, or `null`. Lowercase.",
    "`subscription_status`: `\"active\"`, `\"cancelled\"`, `\"never\"`, `\"paused\"`. `\"never\"` = a lead (no orders yet).",
    "Customers can be linked. To get a customer's full history, expand to linked group first (see `customer_links`).",
    "A lead IS a customer (no orders, `subscription_status='never'`). No parallel `leads` table.",
    "`banned` (storefront ban) vs `portal_banned` (customer portal ban) are different flags.",
    "Email is the matching key but **`shopify_customer_id` is the primary lookup** — match by it first, fall back to email. See feedback_shopify_id_primary.",
  ],
  orders: [
    "There is no `name` column — use `order_number` (e.g. `\"SC129467\"`).",
    "There is no `processed_at` — use `created_at` for time-ordering.",
    "`shipping_address` and `billing_address` are both JSONB. If only one is populated on the Shopify side, both are mirrored — see feedback_address_mirror_rule.",
    "`line_items` is JSONB. Variant ids inside, not a join.",
    "`shopify_order_id` is a numeric string. Internal joins should use `id` (UUID), not the Shopify id.",
    "`financial_status`: `\"paid\"`, `\"refunded\"`, `\"partially_refunded\"`, `\"voided\"` (lowercase).",
    "`fulfillment_status`: `\"fulfilled\"`, `\"partial\"`, `\"unfulfilled\"`, or `null`.",
  ],
  tickets: [
    "`status`: `\"open\"`, `\"pending\"`, `\"closed\"`, `\"archived\"` (lowercase).",
    "`channel`: `\"email\"`, `\"chat\"`, `\"help_center\"`, `\"social_comments\"`, `\"meta_dm\"`, `\"sms\"`.",
    "`handled_by` is a free-text label — `\"AI Agent\"`, `\"Workflow: order_tracking\"`, `\"Journey: cancel\"`, or a display_name. Filter for the customer-reply-driven AI path with `LIKE 'Journey:%' OR ='AI Agent' OR LIKE 'Workflow:%'`.",
    "`escalated_to` set when escalated to a human; `assigned_to` is the human owner.",
    "`agent_intervened` flips true the moment a real human sends an outbound — AI must read this before generating.",
    "`merged_into` (self-FK): merged duplicates point at the surviving ticket. Filter with `merged_into IS NULL` to get canonical rows only.",
    "`do_not_reply` blocks outbound — e.g. mailer-daemon. Set by inbound filters.",
  ],
  ticket_messages: [
    "Not workspace-scoped — keyed by `ticket_id`. Workspace comes via the parent ticket.",
    "Body field is `body_clean` (cleaned for AI prompts) and `body` (verbatim). Not `clean_body` / `cleaned_body`.",
    "`resend_email_id` not `resend_id`. supabase-js will silently insert with unknown columns dropped — always check `error` on insert.",
    "`author_type`: `\"customer\"`, `\"agent\"`, `\"ai\"`, `\"system\"`.",
    "`direction`: `\"inbound\"`, `\"outbound\"`.",
    "`visibility`: `\"public\"`, `\"internal\"`. Internal notes never leave our system.",
  ],
  returns: [
    "`status`: `\"open\"`, `\"label_created\"`, `\"in_transit\"`, `\"delivered\"`, `\"refunded\"`, `\"restocked\"`, `\"cancelled\"`.",
    "`resolution_type`: `\"refund_return\"`, `\"store_credit_return\"`, `\"refund_no_return\"`, `\"store_credit_no_return\"`.",
    "`source`: `\"ai\"`, `\"agent\"`, `\"playbook\"`, `\"portal\"`, `\"system\"`.",
    "There is no `name` column — use `order_number`.",
    "Returns refund on EasyPost `delivered`, **not** carrier first-scan. See feedback_return_refund_trigger.",
    "Filter to returns we created: `.not(\"easypost_shipment_id\", \"is\", null)`. Imported/external returns we don't own the refund for.",
    "`net_refund_cents` is the contract — set at return-creation. Trust it; never re-derive at refund time.",
  ],
  products: [
    "`variants` JSONB is a **legacy mirror** — source of truth is `product_variants`. Each JSONB element gets `internal_id` stamped on it so legacy readers can resolve the UUID.",
    "Internal joins on variants should reference `product_variants.id` (UUID).",
    "\"Default Title\" variant is a Shopify placeholder for no-variant products. Never display it — show just the product title. See feedback_default_title_variant.",
  ],
  product_variants: [
    "UUID PK is canonical. Use it for internal joins.",
    "`shopify_variant_id` is nullable (allows internal-only variants for future).",
    "Read via `src/lib/product-variants.ts` helpers (`getProductVariants`, `findVariant`).",
  ],
  ticket_views: [
    "Nested 2 levels deep via `parent_id`. Don't recurse past that.",
  ],
  customer_links: [
    "Linkage is via `group_id`. All customers in the same group are the same real person.",
    "Always expand to the group before scoping per-customer queries — see DATABASE.md `linkedIds()`.",
    "When suggesting links, check `customer_link_rejections` first — never re-offer a rejected link.",
  ],
  customer_events: [
    "Field is `event_type` (not `event_name`) and `properties` JSONB (not `event_data`).",
    "Source of truth for the activity timeline. Subscription cancel/pause timestamps live here, not on the sub row.",
  ],
  workspaces: [
    "All credential columns end with `_encrypted` — AES-256-GCM. Decrypt via `src/lib/crypto.ts`.",
    "`portal_config` JSONB holds cancel-flow reasons + portal branding. Edited in Settings → Cancel Flow / Portal.",
    "`response_delays` JSONB controls per-channel outbound message delays (drives `pending_send_at`).",
    "FKs from many tables point here — most queries filter by `workspace_id` from the cookie.",
  ],
  dunning_cycles: [
    "Status: `active` / `skipped` / `paused` / `recovered` / `exhausted`.",
    "Per-(subscription, billing cycle). Don't conflate with `payment_failures` which is per-attempt within a cycle.",
    "Driven by Inngest `dunning/payment-failed`. See Phase 5 in CLAUDE.md.",
  ],
  email_events: [
    "Join key: `resend_email_id` (the Resend outbound id). Inbound emails don't have one.",
    "Event types: `sent`, `delivered`, `opened`, `clicked`, `bounced`. Open + click tracked via self-hosted pixel + redirect, not Resend's tracking.",
  ],
  storefront_events: [
    "PK is client-generated UUID — same id forwarded to CAPI sinks for dedup.",
    "Append-only. **90-day retention** via daily cron.",
    "Denormalized `anonymous_id` + `customer_id` for fast funnel queries.",
    "`identity_source` records how we know who this is (cookie, purchase, portal_login, backfilled_*). Filter to high-confidence identities for attribution.",
  ],
  storefront_sessions: [
    "One row per anonymous_id (the `sid` cookie). 365-day cookie.",
    "Indefinite retention — no raw PII; only IP-derived geo + UTMs + device fingerprint.",
    "`customer_id` backfilled when the user identifies (lead capture / checkout / portal login).",
  ],
  cart_drafts: [
    "Token-bound (cart cookie). Server **always** re-validates line totals against `pricing_rules`; never trust client.",
    "Lifecycle: `pending` → `converted` (linked to `converted_order_id`) or `abandoned` (cron flips after `expires_at`).",
    "Abandoned drafts retained for analytics — don't delete.",
  ],
  remedies: [
    "All remedy options come from this table — never hardcode. AI selects, admins configure.",
    "Types: `coupon`, `pause`, `skip`, `frequency_change`, `free_product`, `line_item_modifier`.",
    "Type-specific config lives in the `config` JSONB.",
  ],
  remedy_outcomes: [
    "Drives AI remedy-selection learning. Per-reason stats kick in at 200+ data points; otherwise global stats.",
    "`first_renewal` boolean flags 'never renewed yet' so first-renewal save rate stays separate from steady-state.",
  ],
  crisis_customer_actions: [
    "`subscription_id` is the **internal UUID**, not `shopify_contract_id`. See feedback_crisis_action_subscription_id.",
    "Tier progression is monotonic: 0 → 1 → 2 → 3. Tier 3 outcomes diverge by segment (`berry_only` pauses, `berry_plus` removes item).",
  ],
  fraud_cases: [
    "`rule_type` matches `fraud_rules.slug`.",
    "`status`: `open`, `reviewing`, `confirmed_fraud`, `dismissed`.",
    "Orchestrator bails (closes + escalates with confirmed-fraud reply) if customer has ANY `status='confirmed_fraud'` OR `rule_type='amazon_reseller'`. See feedback_orchestrator_fraud_gate.",
    "Chargebacks don't create fraud cases anymore — only actual rules do.",
  ],
  known_resellers: [
    "Default new entries to `status='active'` — there are no authorized resellers. See feedback_no_resellers_allowed.",
    "Address comparison is two-pass: exact normalized match, then Haiku fuzzy match when zip + street number agree.",
  ],
  policies: [
    "5 canonical policies. Replaces ~60 scattered `sonnet_prompts` rules.",
    "Consumed by orchestrator + storefront. Playbook executor migration is pending.",
  ],
  sonnet_prompts: [
    "category: `rule` / `approach` / `knowledge` / `tool_hint`.",
    "Loaded at orchestrator init. Edits via Settings → AI → Prompts take effect on next message.",
  ],
  journey_definitions: [
    "`channels` is a text array — `social_comments` is **never** included.",
    "`match_patterns` is empty `[]` for non-auto-triggered journeys (e.g. account_linking — only ever prepended).",
    "`trigger_intent` is the slug Sonnet may return; lookup is case-insensitive vs `name` too.",
  ],
  journey_sessions: [
    "`token` is the URL slug for `/journey/{token}`.",
    "Steps + config are rebuilt **live** from current data on every mini-site click — no `config_snapshot` to go stale.",
    "Customer-facing state — never edit directly outside the completion endpoint.",
  ],
  sms_campaign_recipients: [
    "`send_time` is **per-recipient local time** — resolved through customer tz → shipping zip → area code → workspace fallback chain.",
    "Status: `pending` / `sent` / `skipped` / `failed`.",
    "Missing index on `message_sid` was the cause of past DB lockups. See project_db_lockup_diagnosis.",
  ],
  sms_campaigns: [
    "Message body supports `{coupon}` and `{shortlink}` placeholders — substituted at send time.",
    "Coupon code generated in Shopify at schedule time (format `MAY` + 4 base32 chars).",
  ],
  product_reviews: [
    "Synced from Klaviyo. AI-summarized (Haiku, max 15 words) for cancel-journey social proof.",
    "Featured reviews (`smart_featured` from Klaviyo) prioritized, then highest-rated.",
  ],
  klaviyo_events: [
    "Placed Order events parsed for `attributed_klaviyo_campaign_id` from `utm_campaign`'s parenthesized id.",
  ],
  workspace_members: [
    "Roles: `owner`, `admin`, `agent`, `social`, `marketing`, `read_only`.",
    "Always use `display_name` for user-facing strings — never full name. See feedback_display_name.",
  ],
  macros: [
    "Embeddings (1536) for similarity search.",
    "AI-suggestion counters: `ai_suggest_count`, `ai_accept_count`, `ai_reject_count`, `ai_edit_count` — drive acceptance-rate badges in settings.",
  ],
  smart_patterns: [
    "Global patterns (no `workspace_id`) + workspace-scoped overrides via `workspace_pattern_overrides`.",
    "3-layer classifier: keyword match → pgvector embedding → Claude Haiku fallback.",
  ],
  marketing_shortlinks: [
    "Crockford base32, 6 chars, ~1B namespace.",
    "Per-workspace shortlink_domain on `workspaces.shortlink_domain`. Subdomain routing via middleware.",
  ],
  payment_failures: [
    "`attempt_type`: `initial` / `card_rotation` / `payday_retry` / `new_card_retry`.",
    "Per-attempt — distinct from `dunning_cycles` which is per-billing-cycle aggregate.",
  ],
  chargeback_events: [
    "From Shopify dispute polling + webhook. `reason` maps to category for auto-action decisions.",
    "`auto_action_taken` records what we did automatically (auto-cancel sub, etc.).",
  ],
  meta_post_cache: [
    "Holds `effective_object_story_id` for ad-served posts — canonical attribution back to the ad creative. See project_meta_comments_ad_detection.",
  ],
  playbooks: [
    "Discoverable by Sonnet via name OR any entry in `trigger_intents[]` (case-insensitive).",
  ],
  workflows: [
    "Discoverable by Sonnet via name OR `trigger_tag` OR `template` (case-insensitive).",
  ],
  ai_workflows: [
    "Distinct from `workflows` (deterministic templates). These are AI-callable actions the agent can offer (e.g. marketing_signup).",
  ],
};

// ────────────────────────────────────────────────────────────────────────────
// QUERIES — hand-written examples for high-traffic tables.
// Auto-generated patterns supplement these for tables without entries.
// ────────────────────────────────────────────────────────────────────────────
const QUERIES: Record<string, string> = {
  workspaces: `
### Get current workspace by id
\`\`\`ts
const { data: ws } = await admin.from("workspaces")
  .select("id, name, sandbox_mode, portal_config, response_delays")
  .eq("id", workspaceId).single();
\`\`\`

### List workspaces a user belongs to (joined via workspace_members)
\`\`\`ts
const { data } = await admin.from("workspace_members")
  .select("role, workspaces(id, name, shopify_domain)")
  .eq("user_id", userId);
\`\`\`

### Decrypt a stored credential
\`\`\`ts
import { decrypt } from "@/lib/crypto";
const key = ws.shopify_access_token_encrypted ? decrypt(ws.shopify_access_token_encrypted) : null;
\`\`\`
`,
  customers: `
### Find a customer by Shopify id (primary lookup)
\`\`\`ts
const { data: customer } = await admin.from("customers")
  .select("id, email, retention_score, subscription_status, ltv_cents")
  .eq("workspace_id", workspaceId)
  .eq("shopify_customer_id", shopifyCustomerId)
  .maybeSingle();
\`\`\`

### Find by email as fallback
\`\`\`ts
const { data } = await admin.from("customers")
  .select("id, shopify_customer_id")
  .eq("workspace_id", workspaceId)
  .ilike("email", email).maybeSingle();
\`\`\`

### Marketing-eligible customers
\`\`\`ts
const { data } = await admin.from("customers")
  .select("id, email, phone")
  .eq("workspace_id", workspaceId)
  .eq("email_marketing_status", "subscribed");   // lowercase!
\`\`\`

### Active subscribers
\`\`\`ts
const { data } = await admin.from("customers")
  .select("id, email")
  .eq("workspace_id", workspaceId)
  .eq("subscription_status", "active");
\`\`\`

### Get the linked-account group for a customer
\`\`\`ts
// See DATABASE.md linkedIds() — always expand the group before scoping queries.
\`\`\`
`,
  orders: `
### Customer's order history (across linked accounts)
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data: orders } = await admin.from("orders")
  .select("order_number, created_at, total_cents, line_items, financial_status")
  .in("customer_id", ids)
  .order("created_at", { ascending: false });
\`\`\`

### Get one order with its transactions
\`\`\`ts
const { data: order } = await admin.from("orders")
  .select("*").eq("order_number", "SC129467").maybeSingle();
const { data: txns } = await admin.from("transactions")
  .select("type, amount_cents, status, created_at, settled_at, refunded_at")
  .eq("order_id", order.id);
\`\`\`

### Orders attributed to a Klaviyo campaign
\`\`\`ts
const { data } = await admin.from("klaviyo_events")
  .select("customer_id, properties")
  .eq("attributed_klaviyo_campaign_id", campaignId);
\`\`\`

### Orders by UTM campaign
\`\`\`ts
const { data } = await admin.from("orders")
  .select("order_number, total_cents")
  .eq("workspace_id", workspaceId)
  .eq("attributed_utm_campaign", "founders_day_2026")
  .gte("created_at", since);
\`\`\`

### Recent paid orders (head count only)
\`\`\`ts
const { count } = await admin.from("orders")
  .select("id", { count: "exact", head: true })
  .eq("workspace_id", workspaceId)
  .eq("financial_status", "paid")
  .gte("created_at", since);
\`\`\`
`,
  subscriptions: `
### Customer's truly-active subscriptions
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data: subs } = await admin.from("subscriptions")
  .select("id, shopify_contract_id, status, items, billing_interval, next_billing_date, delivery_price_cents")
  .in("customer_id", ids)
  .eq("status", "active");   // lowercase
\`\`\`

### Fallback when customer_id is wrong/missing
\`\`\`ts
const { data: subs } = await admin.from("subscriptions")
  .select("...")
  .or(\`customer_id.eq.\${cid},shopify_customer_id.eq.\${shopifyCid}\`);
\`\`\`

### All paused subscriptions in a workspace
\`\`\`ts
const { data } = await admin.from("subscriptions")
  .select("id, customer_id, pause_resume_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "paused");
\`\`\`

### Subs auto-billing in the next 7 days
\`\`\`ts
const soon = new Date(Date.now() + 7*86400e3).toISOString();
const { data } = await admin.from("subscriptions")
  .select("id, customer_id, next_billing_date, delivery_price_cents, items")
  .eq("workspace_id", workspaceId)
  .eq("status", "active")
  .lte("next_billing_date", soon);
\`\`\`

### When was this sub cancelled? (event log, NOT a column)
\`\`\`ts
const { data } = await admin.from("customer_events")
  .select("created_at, properties")
  .eq("event_type", "subscription.cancelled")
  .contains("properties", { subscription_id: subId })
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
\`\`\`
`,
  tickets: `
### Open tickets in a channel
\`\`\`ts
const { data } = await admin.from("tickets")
  .select("id, subject, customer_id, created_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "open")
  .eq("channel", "email")
  .is("merged_into", null);
\`\`\`

### Find tickets handled by AI / journey / workflow
\`\`\`ts
const { data } = await admin.from("tickets")
  .select("id, handled_by")
  .eq("workspace_id", workspaceId)
  .or("handled_by.eq.AI Agent,handled_by.like.Journey:%,handled_by.like.Workflow:%");
\`\`\`

### Customer's full ticket history (linked accounts)
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("tickets")
  .select("id, subject, status, channel, created_at")
  .in("customer_id", ids)
  .is("merged_into", null)
  .order("created_at", { ascending: false });
\`\`\`

### Tickets escalated to a specific agent
\`\`\`ts
const { data } = await admin.from("tickets")
  .select("id, subject, escalation_reason, escalated_at")
  .eq("workspace_id", workspaceId)
  .eq("escalated_to", agentUserId)
  .eq("status", "open");
\`\`\`

### Active playbook tickets needing manual review
\`\`\`ts
const { data } = await admin.from("tickets")
  .select("id, active_playbook_id, playbook_step, playbook_exceptions_used")
  .eq("workspace_id", workspaceId)
  .not("active_playbook_id", "is", null);
\`\`\`
`,
  ticket_messages: `
### Full conversation transcript (for AI prompts)
\`\`\`ts
const { data: msgs } = await admin.from("ticket_messages")
  .select("direction, visibility, author_type, body, body_clean, created_at")
  .eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
// Use body_clean for AI; body for verbatim display.
\`\`\`

### Find the inbound email message that started a ticket
\`\`\`ts
const { data } = await admin.from("ticket_messages")
  .select("email_message_id, body_clean, created_at")
  .eq("ticket_id", ticketId)
  .eq("direction", "inbound")
  .eq("author_type", "customer")
  .order("created_at", { ascending: true }).limit(1).maybeSingle();
\`\`\`

### Check whether an inbound message just landed
\`\`\`ts
const { data } = await admin.from("ticket_messages")
  .select("id")
  .eq("ticket_id", ticketId)
  .eq("direction", "inbound")
  .gt("created_at", since);
\`\`\`

### Outbound resend ids for tracking joins
\`\`\`ts
const { data } = await admin.from("ticket_messages")
  .select("id, resend_email_id, created_at")
  .eq("ticket_id", ticketId)
  .eq("direction", "outbound")
  .not("resend_email_id", "is", null);
\`\`\`
`,
  returns: `
### Customer's open + non-cancelled returns
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("returns")
  .select("order_number, status, label_url, tracking_number, net_refund_cents, delivered_at, refunded_at")
  .in("customer_id", ids)
  .neq("status", "cancelled")
  .order("created_at", { ascending: false });
\`\`\`

### Returns we created (filter out imported/external)
\`\`\`ts
const { data } = await admin.from("returns")
  .select("*")
  .eq("workspace_id", workspaceId)
  .not("easypost_shipment_id", "is", null);
\`\`\`

### Returns awaiting refund (delivered but no refund yet)
\`\`\`ts
const { data } = await admin.from("returns")
  .select("id, order_number, net_refund_cents, delivered_at")
  .eq("workspace_id", workspaceId)
  .eq("status", "delivered")
  .is("refunded_at", null);
\`\`\`

### Failed-refund returns needing manual action
\`\`\`ts
const { data } = await admin.from("dashboard_notifications")
  .select("title, body, ticket_id")
  .eq("workspace_id", workspaceId)
  .eq("type", "manual_action_needed")
  .ilike("title", "%Return%");
\`\`\`
`,
  customer_links: `
### Get the group of linked customer ids for a customer
\`\`\`ts
async function linkedIds(admin, customerId): Promise<string[]> {
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links")
    .select("customer_id").eq("group_id", link.group_id);
  return (group || []).map((r) => r.customer_id);
}
\`\`\`

### Has this link already been rejected?
\`\`\`ts
const { data } = await admin.from("customer_link_rejections")
  .select("id")
  .eq("customer_id", primary)
  .eq("rejected_customer_id", candidate).maybeSingle();
\`\`\`
`,
  customer_events: `
### Customer activity timeline
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("customer_events")
  .select("event_type, properties, created_at")
  .in("customer_id", ids)
  .order("created_at", { ascending: false }).limit(100);
\`\`\`

### When did this subscription cancel?
\`\`\`ts
const { data } = await admin.from("customer_events")
  .select("created_at, properties")
  .eq("event_type", "subscription.cancelled")
  .contains("properties", { subscription_id: subId })
  .order("created_at", { ascending: false }).limit(1).maybeSingle();
\`\`\`
`,
};

// ────────────────────────────────────────────────────────────────────────────
// QUERY TEMPLATE GENERATORS — used for tables not in QUERIES{}
// ────────────────────────────────────────────────────────────────────────────
function colNames(table: string): string[] {
  return (schema.columns[table] || []).map((c) => c.column_name);
}
function has(table: string, col: string) {
  return colNames(table).includes(col);
}
function buildAutoQueries(table: string): string {
  const cols = colNames(table);
  const out: string[] = [];

  if (has(table, "workspace_id")) {
    const interesting = cols.filter((c) =>
      ["id", "name", "slug", "title", "status", "created_at", "updated_at"].includes(c),
    );
    const select = (interesting.length ? interesting : cols.slice(0, 6)).join(", ");
    out.push(`### List rows for a workspace
\`\`\`ts
const { data } = await admin.from("${table}")
  .select("${select}")
  .eq("workspace_id", workspaceId)
  .order("created_at", { ascending: false }).limit(50);
\`\`\``);
  }

  if (has(table, "customer_id")) {
    out.push(`### Rows for a customer (expand linked accounts first)
\`\`\`ts
const ids = await linkedIds(admin, customerId);
const { data } = await admin.from("${table}")
  .select("*").in("customer_id", ids)
  .order("created_at", { ascending: false });
\`\`\``);
  }

  if (has(table, "status")) {
    out.push(`### Bucket by status (probe actual values first)
\`\`\`ts
const { data } = await admin.from("${table}")
  .select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
\`\`\``);
  }

  if (has(table, "shopify_order_id") || has(table, "shopify_customer_id") || has(table, "shopify_contract_id")) {
    const col = has(table, "shopify_order_id")
      ? "shopify_order_id"
      : has(table, "shopify_contract_id")
        ? "shopify_contract_id"
        : "shopify_customer_id";
    out.push(`### Cross-Shopify boundary lookup
\`\`\`ts
const { data } = await admin.from("${table}")
  .select("*").eq("${col}", shopifyId).maybeSingle();
\`\`\``);
  }

  if (has(table, "ticket_id")) {
    out.push(`### Rows for a ticket
\`\`\`ts
const { data } = await admin.from("${table}")
  .select("*").eq("ticket_id", ticketId)
  .order("created_at", { ascending: true });
\`\`\``);
  }

  if (has(table, "created_at")) {
    out.push(`### Count since a given time
\`\`\`ts
const { count } = await admin.from("${table}")
  .select("id", { count: "exact", head: true })
  .gte("created_at", since);
\`\`\``);
  }

  if (out.length === 0) {
    out.push(`### Read all rows (small reference table)
\`\`\`ts
const { data } = await admin.from("${table}").select("*");
\`\`\``);
  }

  return out.join("\n\n");
}

// ────────────────────────────────────────────────────────────────────────────
// RENDER
// ────────────────────────────────────────────────────────────────────────────
function renderColumnsTable(table: string): string {
  const cols = schema.columns[table] || [];
  const lines = [
    "| Column | Type | Nullable | Notes |",
    "|---|---|---|---|",
  ];
  const fkMap = new Map<string, FK>();
  for (const fk of schema.fks[table] || []) fkMap.set(fk.column_name, fk);

  for (const c of cols) {
    const type = c.udt_name.startsWith("_") ? `${c.udt_name.slice(1)}[]` : c.udt_name;
    const nullable = c.is_nullable === "YES" ? "✓" : "—";
    const fk = fkMap.get(c.column_name);
    const notes: string[] = [];
    if (fk) notes.push(`→ [[${fk.foreign_table_name}]].${fk.foreign_column_name}`);
    if (c.column_name.endsWith("_encrypted")) notes.push("AES-256-GCM");
    if (c.column_name === "id" && type === "uuid") notes.push("PK");
    if (c.column_default && c.column_default !== "NULL") {
      const d = c.column_default.replace(/::[a-z _\[\]\"]+$/, "").trim();
      if (d.length < 40) notes.push(`default: \`${d}\``);
    }
    lines.push(`| \`${c.column_name}\` | \`${type}\` | ${nullable} | ${notes.join(" · ") || ""} |`);
  }
  return lines.join("\n");
}

function renderFKsOut(table: string): string {
  const fks = schema.fks[table] || [];
  if (!fks.length) return "_None._";
  return fks.map((fk) => `- \`${fk.column_name}\` → [[${fk.foreign_table_name}]].\`${fk.foreign_column_name}\``).join("\n");
}

function renderFKsIn(table: string): string {
  const incoming: string[] = [];
  for (const [otherTable, fks] of Object.entries(schema.fks)) {
    for (const fk of fks) {
      if (fk.foreign_table_name === table) {
        incoming.push(`- [[${otherTable}]].\`${fk.column_name}\``);
      }
    }
  }
  if (!incoming.length) return "_None._";
  return incoming.sort().join("\n");
}

function renderGotchas(table: string): string {
  const items = GOTCHAS[table];
  if (!items || !items.length) return "_None documented. Probe before assuming — see [[../README]] § Probing technique._";
  return items.map((s) => `- ${s}`).join("\n");
}

function renderQueries(table: string): string {
  return QUERIES[table]?.trim() || buildAutoQueries(table);
}

function renderPage(table: string): string {
  const summary = SUMMARIES[table] || `_TODO: one-line summary._`;
  const pks = schema.pks[table] || [];
  return `# ${table}

${summary}

**Primary key:** ${pks.length ? pks.map((p) => `\`${p}\``).join(", ") : "_none_"}

## Columns

${renderColumnsTable(table)}

## Foreign keys

**Out (this → others):**

${renderFKsOut(table)}

**In (others → this):**

${renderFKsIn(table)}

## Common queries

${renderQueries(table)}

## Gotchas

${renderGotchas(table)}

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
`;
}

// ────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────
const outDir = resolve(__dirname, "../docs/brain/tables");
mkdirSync(outDir, { recursive: true });

let wrote = 0;
for (const table of schema.tables) {
  const path = resolve(outDir, `${table}.md`);
  writeFileSync(path, renderPage(table));
  wrote++;
}
console.log(`Wrote ${wrote} table pages to docs/brain/tables/`);

// ────────────────────────────────────────────────────────────────────────────
// README — index + conventions
// ────────────────────────────────────────────────────────────────────────────
const grouped: Record<string, string[]> = {
  "Core entities": ["workspaces", "workspace_members", "workspace_invites", "customers", "customer_links", "customer_link_rejections", "customer_events", "customer_payment_methods", "customer_demographics", "orders", "products", "product_variants", "subscriptions", "transactions"],
  "Tickets & messaging": ["tickets", "ticket_messages", "ticket_views", "ticket_analyses", "ticket_research_runs", "ticket_heal_attempts", "email_events", "email_filters", "support_emails", "social_comments", "social_comment_replies", "meta_sender_customer_links", "meta_webhook_raw", "meta_post_cache", "meta_ad_accounts", "meta_pages", "meta_connections", "banned_meta_users", "sms_marketing_inbound", "widget_sessions", "widget_path_mappings"],
  "AI orchestration": ["ai_channel_config", "ai_personalities", "ai_workflows", "ai_token_usage", "sonnet_prompts", "policies", "macros", "macro_usage_log", "macro_audit_jobs", "smart_patterns", "workspace_pattern_overrides", "pattern_feedback", "rules", "workflows", "knowledge_base", "kb_chunks", "knowledge_gaps", "grader_prompts", "daily_analysis_reports"],
  "Journeys": ["journey_definitions", "journey_sessions", "journey_step_events", "chat_journeys"],
  "Playbooks": ["playbooks", "playbook_steps", "playbook_policies", "playbook_exceptions", "playbook_simulations"],
  "Cancel & retention": ["remedies", "remedy_outcomes", "coupon_mappings", "product_reviews", "product_review_analysis"],
  "Crisis management": ["crisis_events", "crisis_customer_actions"],
  "Fraud & resellers": ["fraud_cases", "fraud_case_history", "fraud_rules", "fraud_rule_matches", "fraud_action_log", "known_resellers", "amazon_asins"],
  "Chargebacks & dunning": ["chargeback_events", "chargeback_subscription_actions", "dunning_cycles", "dunning_error_codes", "payment_failures", "appstle_api_calls"],
  "Returns & replacements": ["returns", "replacements", "store_credit_log"],
  "Loyalty": ["loyalty_members", "loyalty_settings", "loyalty_redemptions", "loyalty_transactions"],
  "Storefront & checkout": ["storefront_events", "storefront_sessions", "storefront_leads", "cart_drafts", "pricing_rules", "shipping_rates", "event_sinks", "event_dispatches"],
  "Product catalog": ["products", "product_variants", "product_media", "product_ingredients", "product_ingredient_research", "product_how_it_works", "product_benefit_angles", "product_benefit_selections", "product_link_groups", "product_link_members", "product_page_content", "product_pricing_rule", "product_pricing_tiers", "product_seo_keywords"],
  "Marketing & SMS": ["sms_campaigns", "sms_campaign_recipients", "sms_send_candidates", "marketing_shortlinks", "marketing_shortlink_clicks"],
  "Klaviyo & profiles": ["klaviyo_events", "klaviyo_profile_directory", "klaviyo_profile_staging", "klaviyo_sms_campaign_history", "profile_events", "profile_engagement_summary"],
  "Amazon & ads": ["amazon_connections", "amazon_sales_channels", "daily_amazon_order_snapshots", "daily_meta_ad_spend", "monthly_revenue_snapshots", "daily_order_snapshots", "demographics_snapshots", "zip_code_demographics"],
  "Billing forecast": ["billing_forecasts", "billing_forecast_events"],
  "Ops & notifications": ["dashboard_notifications", "import_jobs", "sync_jobs", "slack_notification_rules", "escalation_gaps", "auth_otp_sessions"],
};

const allSet = new Set(schema.tables);
const groupedSet = new Set(Object.values(grouped).flat());
const uncategorized = [...allSet].filter((t) => !groupedSet.has(t)).sort();
if (uncategorized.length) grouped["Other"] = uncategorized;

const readme = `# brain — table reference

One page per table in the \`public\` schema (${schema.tables.length} total). Each page has:

- **Summary** — one line, what the table is for.
- **Columns** — name, type, nullable, FK target, encryption + default flags.
- **Foreign keys** — out (this → others) and in (others → this), both with \`[[wikilinks]]\` to related pages.
- **Common queries** — code-ready supabase-js / SQL snippets for the things agents actually need.
- **Gotchas** — case-sensitive enum values, hidden columns, mixed-case data, performance pitfalls.

## Naming conventions

- One file per table: \`tables/{table_name}.md\`.
- \`[[wikilinks]]\` use the table name as the link target — Obsidian-style, plain markdown elsewhere.
- Encrypted column names always end with \`_encrypted\` and use AES-256-GCM via \`src/lib/crypto.ts\`.
- \`UUID PK\` is canonical for internal joins. \`shopify_*_id\` columns are denormalized fallbacks for crossing the Shopify boundary.
- Status / enum-like text columns are **lowercase** everywhere — see [Gotchas](#probing-technique) before writing \`.eq()\`.

## Probing technique

When in doubt:

\`\`\`ts
const { data } = await admin.from("the_table").select("*").limit(1);
console.log(Object.keys(data?.[0] || {}));
\`\`\`

For enum-like text columns, bucket a sample:

\`\`\`ts
const { data } = await admin.from("the_table").select("status").limit(2000);
const counts = new Map();
for (const r of data || []) counts.set(r.status, (counts.get(r.status) || 0) + 1);
\`\`\`

Five seconds of probing beats an hour of "why is my filter empty."

## Index

${Object.entries(grouped)
  .map(([group, tables]) => {
    const valid = tables.filter((t) => allSet.has(t)).sort();
    if (!valid.length) return "";
    return `### ${group}\n\n${valid.map((t) => `- [[tables/${t}]] — ${SUMMARIES[t] || "_TODO_"}`).join("\n")}`;
  })
  .filter(Boolean)
  .join("\n\n")}

---

[[../../CLAUDE]] · [[../../DATABASE]] · [[../../JOURNEYS]] · [[../../STOREFRONT]] · [[../../SONNET-ORCHESTRATOR]] · [[../../TEXT-MARKETING]]
`;

writeFileSync(resolve(__dirname, "../docs/brain/README.md"), readme);
console.log("Wrote docs/brain/README.md");
