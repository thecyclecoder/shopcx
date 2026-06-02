#!/usr/bin/env python3
"""Inserts a Related-links section into each high-traffic dashboard page."""
import os, sys

RELATED = {
    "tickets": "[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../tables/ticket_views]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/ai-multi-turn]] · [[../recipes/escalate-ticket]] · [[../recipes/send-email-reply]] · [[../recipes/send-chat-reply]] · [[settings/views]] · [[settings/rules]]",
    "subscriptions": "[[../tables/subscriptions]] · [[../lifecycles/subscription-billing]] · [[../lifecycles/dunning]] · [[../recipes/pause-sub]] · [[../recipes/resume-sub]] · [[../recipes/cancel-sub-via-journey]] · [[../recipes/bill-now]] · [[../recipes/change-next-date]] · [[../recipes/swap-variant]] · [[../recipes/change-line-item-price]] · [[../recipes/apply-coupon]] · [[../integrations/appstle]]",
    "customers": "[[../tables/customers]] · [[../tables/customer_links]] · [[../tables/customer_events]] · [[../lifecycles/customer-link-confirmation]] · [[../tables/loyalty_members]]",
    "social-comments": "[[../tables/social_comments]] · [[../tables/social_comment_replies]] · [[../tables/meta_sender_customer_links]] · [[../lifecycles/social-comment-moderation]] · [[../recipes/hide-comment]] · [[../recipes/ban-meta-user]] · [[../recipes/link-meta-sender-to-customer]] · [[../integrations/meta-graph]]",
    "fraud": "[[../tables/fraud_cases]] · [[../tables/fraud_rules]] · [[../tables/known_resellers]] · [[../tables/fraud_action_log]] · [[../lifecycles/fraud-detection]] · [[settings/fraud]]",
    "returns": "[[../tables/returns]] · [[../lifecycles/return-pipeline]] · [[../recipes/create-return]] · [[../recipes/issue-refund]] · [[../recipes/partial-refund]] · [[../integrations/easypost]]",
    "chargebacks": "[[../tables/chargeback_events]] · [[../tables/chargeback_subscription_actions]] · [[../lifecycles/chargeback-pipeline]] · [[settings/chargebacks]]",
    "replacements": "[[../tables/replacements]] · [[../tables/orders]] · [[../recipes/issue-replacement]] · [[../playbooks/replacement-order]] · [[../lifecycles/return-pipeline]]",
    "crisis": "[[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../lifecycles/crisis-campaign]] · [[../journeys/crisis-tier1-flavor-swap]] · [[../journeys/crisis-tier2-product-swap]] · [[../journeys/crisis-tier3-pause-remove]]",
    "csat": "[[../tables/tickets]] · [[../inngest/ticket-csat]]",
    "loyalty": "[[../tables/loyalty_members]] · [[../tables/loyalty_redemptions]] · [[../tables/loyalty_transactions]] · [[../recipes/redeem-loyalty]] · [[../recipes/apply-loyalty-coupon]] · [[settings/loyalty]]",
    "marketing": "[[../tables/sms_campaigns]] · [[../tables/sms_campaign_recipients]] · [[../tables/marketing_shortlinks]] · [[../inngest/marketing-text]] · [[../integrations/twilio]] · [[../integrations/klaviyo]]",
    "macros": "[[../tables/macros]] · [[../tables/macro_usage_log]] · [[../lifecycles/ai-multi-turn]] · [[../libraries/rag]]",
    "resellers": "[[../tables/known_resellers]] · [[../tables/amazon_asins]] · [[../lifecycles/fraud-detection]] · [[../inngest/reseller-discovery]]",
    "ai-analysis": "[[../tables/ticket_analyses]] · [[../tables/daily_analysis_reports]] · [[../tables/ai_token_usage]] · [[../tables/knowledge_gaps]] · [[../inngest/ai-nightly-analysis]] · [[../lifecycles/research-and-heal]]",
    "knowledge-base": "[[../tables/knowledge_base]] · [[../tables/kb_chunks]] · [[../inngest/kb-embed]] · [[../inngest/scrape-help-center]] · [[settings/knowledge-base]]",
    "storefront": "[[../tables/storefront_events]] · [[../tables/storefront_sessions]] · [[../tables/cart_drafts]] · [[../lifecycles/storefront-checkout]]",
    "reviews": "[[../tables/product_reviews]] · [[../tables/product_review_analysis]] · [[../inngest/sync-reviews]] · [[../integrations/klaviyo]]",
    "delivery": "[[../tables/orders]] · [[../tables/returns]] · [[../inngest/delivery-audit]] · [[../integrations/easypost]]",
    "orders": "[[../tables/orders]] · [[../tables/transactions]] · [[../integrations/shopify]]",
    "products": "[[../tables/products]] · [[../tables/product_variants]] · [[../tables/product_intelligence]] · [[../inngest/sync-shopify]]",
    "demographics": "[[../tables/customer_demographics]] · [[../tables/demographics_snapshots]] · [[../tables/zip_code_demographics]] · [[../inngest/customer-demographics]]",
    "portal-analytics": "[[../tables/customer_events]] · [[../tables/customers]]",
    "conversations": "[[../tables/tickets]] · [[../tables/ticket_messages]] · [[../lifecycles/ticket-lifecycle]]",
    "team": "[[../tables/workspace_members]] · [[../tables/workspace_invites]]",
    "analytics": "[[../tables/daily_order_snapshots]] · [[../tables/daily_amazon_order_snapshots]] · [[../tables/daily_meta_ad_spend]] · [[../tables/monthly_revenue_snapshots]] · [[../inngest/daily-order-snapshot]] · [[../inngest/monthly-revenue-snapshot]]",
    "home": "[[../README]] · [[../lifecycles/ticket-lifecycle]] · [[../lifecycles/dunning]] · [[../lifecycles/subscription-billing]]",
}

# Settings pages too
RELATED_SETTINGS = {
    "ai": "[[../../tables/ai_channel_config]] · [[../../tables/ai_personalities]] · [[../../tables/sonnet_prompts]] · [[../../lifecycles/ai-multi-turn]]",
    "cancel-flow": "[[../../tables/remedies]] · [[../../tables/remedy_outcomes]] · [[../../tables/coupon_mappings]] · [[../../journeys/cancel]] · [[../../lifecycles/cancel-flow]]",
    "chargebacks": "[[../../tables/chargeback_events]] · [[../../lifecycles/chargeback-pipeline]] · [[../chargebacks]]",
    "chat-widget": "[[../../tables/widget_sessions]] · [[../../tables/widget_path_mappings]]",
    "coupons": "[[../../tables/coupon_mappings]] · [[../../recipes/apply-coupon]]",
    "dunning": "[[../../tables/dunning_cycles]] · [[../../tables/payment_failures]] · [[../../lifecycles/dunning]] · [[../../integrations/appstle]]",
    "email-filters": "[[../../tables/email_filters]] · [[../../integrations/resend]]",
    "fraud": "[[../../tables/fraud_rules]] · [[../../tables/fraud_cases]] · [[../../lifecycles/fraud-detection]] · [[../fraud]]",
    "import": "[[../../tables/import_jobs]] · [[../../tables/sync_jobs]] · [[../../inngest/sync-shopify]] · [[../../inngest/klaviyo-events-import]]",
    "integrations": "[[../../integrations/shopify]] · [[../../integrations/appstle]] · [[../../integrations/klaviyo]] · [[../../integrations/resend]] · [[../../integrations/twilio]] · [[../../integrations/easypost]] · [[../../integrations/braintree]] · [[../../integrations/avalara]] · [[../../integrations/meta-graph]] · [[../../integrations/meta-marketing]] · [[../../integrations/anthropic]] · [[../../integrations/openai]] · [[../../integrations/inngest]]",
    "journeys": "[[../../tables/journey_definitions]] · [[../../tables/journey_sessions]] · [[../../journeys/README]]",
    "knowledge-base": "[[../../tables/knowledge_base]] · [[../../inngest/scrape-help-center]] · [[../knowledge-base]]",
    "loyalty": "[[../../tables/loyalty_settings]] · [[../../tables/loyalty_members]] · [[../../recipes/redeem-loyalty]]",
    "order-sources": "[[../../tables/orders]] · [[../../integrations/shopify]]",
    "patterns": "[[../../tables/smart_patterns]] · [[../../tables/workspace_pattern_overrides]] · [[../../libraries/pattern-matcher]]",
    "playbooks": "[[../../tables/playbooks]] · [[../../tables/playbook_steps]] · [[../../tables/playbook_policies]] · [[../../tables/playbook_exceptions]] · [[../../playbooks/README]] · [[../../playbooks/refund]] · [[../../playbooks/replacement-order]]",
    "policies": "[[../../tables/policies]] · [[../../tables/sonnet_prompts]]",
    "portal": "[[../../tables/workspaces]] · [[../../libraries/portal__auth]]",
    "pricing-rules": "[[../../tables/pricing_rules]] · [[../../tables/product_pricing_tiers]] · [[../../lifecycles/storefront-checkout]]",
    "response-delay": "[[../../tables/workspaces]] · [[../../inngest/deliver-pending-send]]",
    "rules": "[[../../tables/rules]] · [[../../libraries/rules-engine]] · [[../../libraries/rules-actions]]",
    "sandbox": "[[../../tables/workspaces]]",
    "slack": "[[../../tables/slack_notification_rules]] · [[../../libraries/slack-notify]]",
    "amazon-pricing": "[[../../tables/amazon_asins]] · [[../../tables/amazon_sales_channels]] · [[../../tables/amazon_connections]]",
    "auto-close": "[[../../tables/workspaces]] · [[../../tables/tickets]]",
    "storefront-design": "[[../../tables/workspaces]] · [[../../lifecycles/storefront-checkout]]",
    "storefront-domain": "[[../../tables/workspaces]]",
    "subscription-settings": "[[../../tables/workspaces]] · [[../../tables/subscriptions]]",
    "tags": "[[../../tables/tickets]] · [[../../tables/customers]]",
    "text-marketing": "[[../../tables/sms_campaigns]] · [[../../tables/marketing_shortlinks]] · [[../../integrations/twilio]]",
    "tracking-sla": "[[../../tables/orders]] · [[../../integrations/easypost]]",
    "views": "[[../../tables/ticket_views]] · [[../tickets]]",
    "workflows": "[[../../tables/workflows]] · [[../../tables/ai_workflows]] · [[../../libraries/workflow-executor]]",
}

def patch_dir(base, mapping):
    for slug, related in mapping.items():
        path = os.path.join(base, f"{slug}.md")
        if not os.path.exists(path):
            print(f"skip: missing {path}")
            continue
        with open(path) as f: src = f.read()
        if "## Related" in src:
            continue
        needle = "\n---\n\n[[../README]]" if base.endswith("dashboard") else "\n---\n\n[[../README]]"
        if needle not in src:
            print(f"skip: footer not in {path}")
            continue
        new = src.replace(needle, f"\n## Related\n\n{related}\n{needle}", 1)
        with open(path,'w') as f: f.write(new)
        print(f"patched: {path}")

patch_dir("docs/brain/dashboard", RELATED)
patch_dir("docs/brain/dashboard/settings", RELATED_SETTINGS)
