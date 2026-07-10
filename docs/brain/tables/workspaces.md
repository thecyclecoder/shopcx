# workspaces

Multi-tenant root. Encrypted credentials, sandbox_mode, response_delays, help_slug, portal_config, storefront branding.

**Primary key:** `id`

## Columns

| Column | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | — | PK · default: `gen_random_uuid()` |
| `name` | `text` | — |  |
| `storefront_launch_at` | `timestamptz` | ✓ | Go-live floor for the storefront funnel. The funnel clamps its window start to `max(requested, launch_at)`, so pre-launch testing + ad-review crawler data never appears. Null = no floor. |
| `shopify_domain` | `text` | ✓ |  |
| `shopify_access_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `meta_page_id` | `text` | ✓ |  |
| `stripe_account_id` | `text` | ✓ |  |
| `plan` | `workspace_plan` | — | default: `'free'` |
| `created_at` | `timestamptz` | — | default: `now()` |
| `resend_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `resend_domain` | `text` | ✓ |  |
| `shopify_client_id_encrypted` | `text` | ✓ | AES-256-GCM |
| `shopify_client_secret_encrypted` | `text` | ✓ | AES-256-GCM |
| `shopify_myshopify_domain` | `text` | ✓ |  |
| `shopify_oauth_state` | `text` | ✓ |  |
| `shopify_scopes` | `text` | ✓ |  |
| `order_source_mapping` | `jsonb` | ✓ | default: `'{}'` |
| `support_email` | `text` | ✓ |  |
| `sandbox_mode` | `bool` | — | default: `true` |
| `replacement_threshold_cents` | `int8` | — | default: `0` |
| `june_refund_approval_threshold_cents` | `int4` | — | default: `5000` ($50). A June ([[../libraries/cs-director]]) money remedy (refund/credit/replacement) STRICTLY ABOVE this routes to a founder SMS approval via Eve's cockpit before it fires; at-or-below runs autonomously. Read by [[../libraries/june-remedy-approval]] `getRefundApprovalThresholdCents`. Migration `20260710120000_june_refund_approval_threshold.sql`. |
| `appstle_webhook_secret_encrypted` | `text` | ✓ | AES-256-GCM |
| `appstle_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `auto_close_reply` | `text` | ✓ |  |
| `response_delays` | `jsonb` | ✓ |  |
| `help_center_url` | `text` | ✓ |  |
| `help_slug` | `text` | ✓ |  |
| `help_logo_url` | `text` | ✓ |  |
| `help_primary_color` | `text` | ✓ | default: `'#4f46e5'` |
| `help_custom_domain` | `text` | ✓ |  |
| `fraud_suppressed_addresses` | `text[]` | ✓ | default: `'{}'` |
| `chargeback_auto_cancel` | `bool` | — | default: `true` |
| `chargeback_notify` | `bool` | — | default: `true` |
| `chargeback_auto_ticket` | `bool` | — | default: `true` |
| `chargeback_evidence_reminder_days` | `int4` | — | default: `3` |
| `chargeback_evidence_reminder` | `bool` | — | default: `true` |
| `chargeback_auto_cancel_reasons` | `text[]` | — | default: `'{fraudulent,unrecognized}'` |
| `vip_retention_threshold` | `int4` | — | default: `85` |
| `widget_enabled` | `bool` | ✓ | default: `false` |
| `widget_color` | `text` | ✓ | default: `'#4f46e5'` |
| `widget_greeting` | `text` | ✓ | default: `'Hi! How can we help you today?'` |
| `widget_position` | `text` | ✓ | default: `'bottom-right'` |
| `meta_page_access_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `meta_instagram_id` | `text` | ✓ |  |
| `meta_webhook_verify_token` | `text` | ✓ |  |
| `meta_page_name` | `text` | ✓ |  |
| `meta_oauth_state` | `text` | ✓ |  |
| `twilio_phone_number` | `text` | ✓ |  |
| `klaviyo_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `klaviyo_public_key` | `text` | ✓ |  |
| `klaviyo_last_sync_at` | `timestamptz` | ✓ |  |
| `dunning_enabled` | `bool` | ✓ | default: `false` |
| `dunning_max_card_rotations` | `int4` | ✓ | default: `6` |
| `dunning_payday_retry_enabled` | `bool` | ✓ | default: `true` |
| `dunning_cycle_1_action` | `text` | ✓ | default: `'skip'` |
| `dunning_cycle_2_action` | `text` | ✓ | default: `'pause'` |
| `portal_config` | `jsonb` | — | default: `'{}'` |
| `slack_bot_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `slack_team_id` | `text` | ✓ |  |
| `google_drive_sa_json_encrypted` | `text` | ✓ | AES-256-GCM — GCP service-account JSON key for headless Drive API access ([[../specs/box-product-seeding]]) |
| `slack_team_name` | `text` | ✓ |  |
| `slack_connected_at` | `timestamptz` | ✓ |  |
| `slack_ada_channel_id` | `text` | ✓ | the `#cto-ada` channel for two-way chat with Ada — set by the `/ada-here` slash command ([[../lifecycles/ada-slack-chat]]) |
| `slack_growth_director_channel_id` | `text` | ✓ | the private `#director-growth-max` channel the Growth Director (Max) posts media-buyer shadow digests into ([[../specs/media-buyer-director-slack-digest]]). Mirrors `slack_ada_channel_id`'s posting path — a private channel needs only `chat:write` + bot membership for one-way posts (no fresh scope grant, no reinstall). Seeded to `C0BFW5YUVC1` for Superfoods by the Phase 1 migration; the bot is already a member. Phase 2 delivers the digest; two-way founder chat is deferred (adding `message.groups` later is a lighter lift — `groups:history` is already granted). |
| `shopify_multipass_secret_encrypted` | `text` | ✓ | AES-256-GCM |
| `amplifier_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `amplifier_order_source_code` | `text` | ✓ |  |
| `amplifier_tracking_sla_days` | `int4` | ✓ | default: `1` |
| `amplifier_cutoff_hour` | `int4` | ✓ | default: `11` |
| `amplifier_cutoff_timezone` | `text` | ✓ | default: `'America/Chicago'` |
| `amplifier_shipping_days` | `int4[]` | ✓ | default: `'{1,2,3,4,5}'` |
| `amplifier_webhook_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `amplifier_webhook_received_id` | `text` | ✓ |  |
| `amplifier_webhook_shipped_id` | `text` | ✓ |  |
| `return_address` | `jsonb` | ✓ |  |
| `easypost_test_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `default_return_parcel` | `jsonb` | ✓ |  |
| `easypost_webhook_secret` | `text` | ✓ |  |
| `easypost_live_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `easypost_test_mode` | `bool` | — | default: `true` |
| `chat_ticket_creation` | `bool` | — | default: `true` |
| `coupon_price_floor_pct` | `int4` | ✓ | default: `50` |
| `resend_webhook_signing_secret` | `text` | ✓ |  |
| `fraud_ai_enabled` | `bool` | ✓ | default: `false` |
| `census_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `versium_api_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `subscription_discount_pct` | `int4` | ✓ | default: `25` |
| `subscription_frequencies` | `jsonb` | ✓ |  |
| `subscription_free_shipping` | `bool` | ✓ | default: `false` |
| `subscription_free_shipping_threshold_cents` | `int4` | ✓ |  |
| `subscription_free_gift_variant_id` | `text` | ✓ |  |
| `subscription_free_gift_product_title` | `text` | ✓ |  |
| `subscription_free_gift_image_url` | `text` | ✓ |  |
| `storefront_domain` | `text` | ✓ |  |
| `storefront_slug` | `text` | ✓ |  |
| `storefront_font` | `text` | ✓ |  |
| `storefront_primary_color` | `text` | ✓ |  |
| `storefront_accent_color` | `text` | ✓ |  |
| `storefront_logo_url` | `text` | ✓ |  |
| `google_ads_developer_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `google_ads_client_id` | `text` | ✓ |  |
| `google_ads_client_secret_encrypted` | `text` | ✓ | AES-256-GCM |
| `google_ads_refresh_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `google_ads_customer_id` | `text` | ✓ |  |
| `google_search_console_credentials_encrypted` | `text` | ✓ | AES-256-GCM |
| `google_search_console_site_url` | `text` | ✓ |  |
| `google_ads_oauth_state` | `text` | ✓ |  |
| `storefront_off_platform_review_count` | `int4` | — | default: `0` |
| `storefront_favicon_url` | `text` | ✓ |  |
| `shortlink_domain` | `text` | ✓ |  |
| `klaviyo_engagement_backfill_started_at` | `timestamptz` | ✓ |  |
| `klaviyo_engagement_backfill_completed_at` | `timestamptz` | ✓ |  |
| `klaviyo_engagement_last_delta_at` | `timestamptz` | ✓ |  |
| `twilio_marketing_messaging_service_sid` | `text` | ✓ |  |
| `meta_user_access_token_encrypted` | `text` | ✓ | AES-256-GCM |
| `ad_destination_domains` | `text[]` | — | default: `'{}'` |
| `braintree_merchant_id` | `text` | ✓ |  |
| `braintree_public_key` | `text` | ✓ |  |
| `braintree_private_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `braintree_environment` | `text` | — | default: `'production'` |
| `shipping_protection_enabled` | `bool` | — | default: `false` |
| `shipping_protection_price_cents` | `int4` | — | default: `495` |
| `shipping_protection_title` | `text` | — | default: `'Shipping protection'` |
| `shipping_protection_description` | `text` | — |  |
| `transactional_reply_to_email` | `text` | ✓ |  |
| `transactional_from_email` | `text` | ✓ |  |
| `transactional_from_name` | `text` | ✓ |  |
| `portal_migration_enabled` | `bool` | — | default: `false` |
| `shopify_primary_domain` | `text` | ✓ |  |
| `avalara_account_id` | `text` | ✓ |  |
| `avalara_license_key_encrypted` | `text` | ✓ | AES-256-GCM |
| `avalara_company_code` | `text` | ✓ |  |
| `avalara_environment` | `text` | ✓ |  |
| `avalara_origin_address` | `jsonb` | ✓ |  |
| `avalara_default_tax_code` | `text` | ✓ |  |
| `avalara_enabled` | `bool` | — | default: `false` |
| `twilio_verify_service_sid` | `text` | ✓ |  |
| `meta_connected_admin_email` | `text` | ✓ |  |
| `meta_connected_admin_name` | `text` | ✓ |  |
| `social_brand_proof_points` | `text` | ✓ |  |
| `storefront_skip_customize` | `bool` | — | default: `false`. When true, pack-select navigates **straight to `/checkout`** (skipping `/customize`); checkout then shows a "Customize your order" button as the opt-in editor. A/B-toggleable without a deploy. On for Superfoods. See [[../lifecycles/storefront-checkout]] (the customize-bypass funnel). |
| `is_test` | `bool` | — | default: `false`. **Sentinel** — true = a dedicated **spec-test sandbox tenant** ([[../specs/spec-test-deep-verification]] Phase 2). The spec-test agent's sandbox toolkit (`scripts/spec-test-sandbox.ts`, [[../libraries/spec-test-sandbox]]) refuses to fire an event / call an endpoint / write a fixture against any workspace where `is_test` is not true (`assertTestWorkspace`), so "scope to the test workspace" = `workspace_id = the is_test workspace` and "zero writes to non-test-workspace rows" = "no row with a different `workspace_id` changed". Partial index `idx_workspaces_is_test (id) WHERE is_test`. Migration `20260622120000_workspaces_is_test.sql`. |
| `auto_merge_enabled` | `bool` | — | default: `true`. **Kill-switch** for the Auto-Ship Pipeline's auto-merge gate ([[../specs/auto-ship-pipeline]] Phase 1 / Gate A). true (default) = the [[../integrations/github-webhook|GitHub webhook]] auto-squash-merges ready (mergeable + all-checks-green) `claude/*` build PRs (`autoMergeReadyPrs` / `isAutoMergeEnabled` in [[../libraries/github-pr-resolve]]); false = paused, the owner merges manually. Read on the build-console workspace via `select("*")` so a pre-migration deploy degrades to enabled. Migration `20260622180000_workspaces_auto_merge.sql`. |
| `auto_fold_enabled` | `bool` | — | default: `true`. **Kill-switch** for the Auto-Ship Pipeline's auto-fold gate ([[../specs/auto-ship-pipeline]] Phase 2 / Gate B). true (default) = fully-verified shipped specs (agent-verdict `approved` + 0 human checks waiting/failed + 0 regressions) auto-fold into the brain via `enqueue_fold` (`autoFoldVerifiedSpecs` / `isAutoFoldEnabled` in [[../libraries/spec-test-runs]], coalesced into the batch fold-build [[../specs/fold-build-batching]]); false = paused, the owner clicks Mark verified & archive manually. Read via `select("*")` so a pre-migration deploy degrades to enabled. Migration `20260622193000_workspaces_auto_fold.sql`. |

## Foreign keys

**Out (this → others):**

_None._

**In (others → this):**

- [[ai_channel_config]].`workspace_id`
- [[ai_personalities]].`workspace_id`
- [[ai_token_usage]].`workspace_id`
- [[ai_workflows]].`workspace_id`
- [[amazon_asins]].`workspace_id`
- [[amazon_connections]].`workspace_id`
- [[amazon_sales_channels]].`workspace_id`
- [[appstle_api_calls]].`workspace_id`
- [[auth_otp_sessions]].`workspace_id`
- [[banned_meta_users]].`workspace_id`
- [[billing_forecast_events]].`workspace_id`
- [[billing_forecasts]].`workspace_id`
- [[cart_drafts]].`workspace_id`
- [[chargeback_events]].`workspace_id`
- [[chargeback_subscription_actions]].`workspace_id`
- [[chat_journeys]].`workspace_id`
- [[coupon_mappings]].`workspace_id`
- [[crisis_events]].`workspace_id`
- [[customer_demographics]].`workspace_id`
- [[customer_events]].`workspace_id`
- [[customer_link_rejections]].`workspace_id`
- [[customer_links]].`workspace_id`
- [[customer_payment_methods]].`workspace_id`
- [[customers]].`workspace_id`
- [[daily_amazon_order_snapshots]].`workspace_id`
- [[daily_analysis_reports]].`workspace_id`
- [[daily_meta_ad_spend]].`workspace_id`
- [[daily_order_snapshots]].`workspace_id`
- [[dashboard_notifications]].`workspace_id`
- [[demographics_snapshots]].`workspace_id`
- [[dunning_cycles]].`workspace_id`
- [[dunning_error_codes]].`workspace_id`
- [[email_events]].`workspace_id`
- [[email_filters]].`workspace_id`
- [[escalation_gaps]].`workspace_id`
- [[event_dispatches]].`workspace_id`
- [[event_sinks]].`workspace_id`
- [[fraud_action_log]].`workspace_id`
- [[fraud_case_history]].`workspace_id`
- [[fraud_cases]].`workspace_id`
- [[fraud_rule_matches]].`workspace_id`
- [[fraud_rules]].`workspace_id`
- [[grader_prompts]].`workspace_id`
- [[import_jobs]].`workspace_id`
- [[journey_definitions]].`workspace_id`
- [[journey_sessions]].`workspace_id`
- [[journey_step_events]].`workspace_id`
- [[kb_chunks]].`workspace_id`
- [[klaviyo_events]].`workspace_id`
- [[klaviyo_profile_directory]].`workspace_id`
- [[klaviyo_profile_staging]].`workspace_id`
- [[klaviyo_sms_campaign_history]].`workspace_id`
- [[knowledge_base]].`workspace_id`
- [[knowledge_gaps]].`workspace_id`
- [[known_resellers]].`workspace_id`
- [[loyalty_members]].`workspace_id`
- [[loyalty_redemptions]].`workspace_id`
- [[loyalty_settings]].`workspace_id`
- [[loyalty_transactions]].`workspace_id`
- [[macro_usage_log]].`workspace_id`
- [[macros]].`workspace_id`
- [[marketing_shortlinks]].`workspace_id`
- [[meta_ad_accounts]].`workspace_id`
- [[meta_connections]].`workspace_id`
- [[meta_pages]].`workspace_id`
- [[meta_post_cache]].`workspace_id`
- [[meta_sender_customer_links]].`workspace_id`
- [[monthly_revenue_snapshots]].`workspace_id`
- [[orders]].`workspace_id`
- [[pattern_feedback]].`workspace_id`
- [[payment_failures]].`workspace_id`
- [[playbook_exceptions]].`workspace_id`
- [[playbook_policies]].`workspace_id`
- [[playbook_simulations]].`workspace_id`
- [[playbook_steps]].`workspace_id`
- [[playbooks]].`workspace_id`
- [[policies]].`workspace_id`
- [[pricing_rules]].`workspace_id`
- [[product_benefit_angles]].`workspace_id`
- [[product_benefit_selections]].`workspace_id`
- [[product_how_it_works]].`workspace_id`
- [[product_ingredient_research]].`workspace_id`
- [[product_ingredients]].`workspace_id`
- [[product_link_groups]].`workspace_id`
- [[product_media]].`workspace_id`
- [[product_page_content]].`workspace_id`
- [[product_pricing_rule]].`workspace_id`
- [[product_pricing_tiers]].`workspace_id`
- [[product_review_analysis]].`workspace_id`
- [[product_reviews]].`workspace_id`
- [[product_seo_keywords]].`workspace_id`
- [[product_variants]].`workspace_id`
- [[products]].`workspace_id`
- [[profile_engagement_summary]].`workspace_id`
- [[profile_events]].`workspace_id`
- [[remedies]].`workspace_id`
- [[remedy_outcomes]].`workspace_id`
- [[replacements]].`workspace_id`
- [[returns]].`workspace_id`
- [[rules]].`workspace_id`
- [[shipping_rates]].`workspace_id`
- [[slack_notification_rules]].`workspace_id`
- [[smart_patterns]].`workspace_id`
- [[sms_campaigns]].`workspace_id`
- [[sms_marketing_inbound]].`workspace_id`
- [[sms_send_candidates]].`workspace_id`
- [[social_comment_replies]].`workspace_id`
- [[social_comments]].`workspace_id`
- [[sonnet_prompts]].`workspace_id`
- [[store_credit_log]].`workspace_id`
- [[storefront_events]].`workspace_id`
- [[storefront_leads]].`workspace_id`
- [[storefront_sessions]].`workspace_id`
- [[subscriptions]].`workspace_id`
- [[support_emails]].`workspace_id`
- [[sync_jobs]].`workspace_id`
- [[ticket_analyses]].`workspace_id`
- [[ticket_heal_attempts]].`workspace_id`
- [[ticket_research_runs]].`workspace_id`
- [[ticket_views]].`workspace_id`
- [[tickets]].`workspace_id`
- [[transactions]].`workspace_id`
- [[widget_path_mappings]].`workspace_id`
- [[widget_sessions]].`workspace_id`
- [[workflows]].`workspace_id`
- [[workspace_invites]].`workspace_id`
- [[workspace_members]].`workspace_id`
- [[workspace_pattern_overrides]].`workspace_id`

## Common queries

### Get current workspace by id
```ts
const { data: ws } = await admin.from("workspaces")
  .select("id, name, sandbox_mode, portal_config, response_delays")
  .eq("id", workspaceId).single();
```

### List workspaces a user belongs to (joined via workspace_members)
```ts
const { data } = await admin.from("workspace_members")
  .select("role, workspaces(id, name, shopify_domain)")
  .eq("user_id", userId);
```

### Decrypt a stored credential
```ts
import { decrypt } from "@/lib/crypto";
const key = ws.shopify_access_token_encrypted ? decrypt(ws.shopify_access_token_encrypted) : null;
```

## Gotchas

- All credential columns end with `_encrypted` — AES-256-GCM. Decrypt via `src/lib/crypto.ts`.
- `portal_config` JSONB holds cancel-flow reasons + portal branding. Edited in Settings → Cancel Flow / Portal.
- `response_delays` JSONB controls per-channel outbound message delays (drives `pending_send_at`). Keys: `email`, `chat`, `sms`, `meta_dm`, `help_center`, `social_comments`, `portal` (seconds), plus `skip_delay_for_members` (bool). A missing channel key falls back to the `email` delay. Edited at `/dashboard/settings/response-delay`.
- FKs from many tables point here — most queries filter by `workspace_id` from the cookie.

---

[[../README]] · [[../../CLAUDE]] · [[../../DATABASE]]
