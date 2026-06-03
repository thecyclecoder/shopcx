# Backlog — in-flight + planned + roadmap

Single source of truth for what's being built next, what's parked, and what just shipped. Replaces the loose `project_*.md` files that lived in agent memory.

## How to use this

- **Status emojis** (per the convention in [[../project-management]]): ⏳ planned · 🚧 in progress · ✅ shipped (then folded + removed).
- **Items in the "Ready" section** are concrete enough to fire `/goal do everything in docs/brain/specs/{slug}.md` against, once promoted to their own spec file.
- **Roadmap items** are tracked here but don't get individual spec files until promoted to "Ready."
- **Move things between sections** as priorities shift. The order within a section is rough priority.
- When an item ships, fold its content into the relevant lifecycle/table/library pages and delete the row here (the spec file too, if it had one).

---

## Active specs (in flight)

| Status | Spec | Summary |
|---|---|---|
| ⏳🚧 | [ad-tool](ad-tool.md) | Avatar + LF8 ad-angle generator + Higgsfield render pipeline. Phase 0/0.5 in progress. |

---

## Ready to spec — data integrity / cleanup

Concrete, scoped, high-ROI work. Pick any one and promote to a full spec.

### 469 stuck subs — dunning skipped but `next_billing_date` never advanced
**Status:** ⏳ Diagnosed, fix not yet written.
- 462 of 469 are in dunning with `status='skipped'`; the next_billing_date stays stuck on the failed date forever.
- 7 are pre-dunning ghosts (Oct 2025).
- ~$35K+ MRR impact (~$75 avg × 469 subs).
- **Fix scope:** dunning skip handler must advance `next_billing_date` to the next cycle. Backfill script for the 469 stuck ones.
- May also need `sendPaymentUpdateEmail` for expired cards.
- Originally in `project_billing_investigation.md`.

### 52 grandfathered subs below the 50% MSRP floor
**Status:** ⏳ Stats captured, cleanup script not written.
- 52 sub-line-items pricing < 50% of `product_standard_price` (the configured `coupon_price_floor_pct`).
- Likely from old promos or migration errors.
- **Fix:** script that picks them via `price_cents / 0.75 < standard * 0.50`, calls `subUpdateLineItemPrice` to raise to floor, logs audit.
- Originally in `project_grandfathered_price_cleanup.md`.

### 136 grandfathered subs with stacked sale coupons
**Status:** ⏳ Stats captured, cleanup script not written.
- Sub has grandfathered pricing AND a code coupon — double-dipping.
- LOYALTY-* and smile-* are allowed; PRIMESALE / LUCKY / FLOWERS / VIPFreeShip / etc. must come off.
- **Fix:** script reads `applied_discounts[]` for active grandfathered subs, filters to non-loyalty CODE_DISCOUNT, removes via Appstle `subscription-contracts-remove-discount`.
- Originally in `project_grandfathered_coupon_cleanup.md`.

### Auto-grant exception detection (3 stubs)
**Status:** ⏳ Stubs returning false in `src/lib/playbook-executor.ts:760`.
- `cancelled_but_charged`: sub cancelled BEFORE order charged → auto-grant refund without return.
- `duplicate_charge`: detect from order/billing data (multiple charges same period).
- `never_delivered`: check fulfillment/tracking status.
- Without these, customers who got charged after cancelling go through the tiered exception flow instead of getting an immediate refund.
- Originally in `project_autogrant_detection.md`.

### Cancel event deduplication
**Status:** ⏳ Mostly diagnosed; Appstle email disable already shipped, dedup logic not written.
- Portal cancels double-log: `portal.subscription.cancelled` (source: portal) + `subscription.cancelled` (source: appstle). Apr 21 baseline: 8 portal / 14 appstle / 7 overlap.
- The ~5/day appstle-only mystery cancels were caused by Appstle's post-order emails linking to their merchant portal — Dylan disabled those 2026-04-22. Monitor to confirm.
- **Fix:** when an Appstle cancel webhook fires AND a portal event already exists for the sub in the last N minutes, suppress / mark the Appstle row as duplicate.
- Originally in `project_cancel_event_dedup.md`.

---

## Ready to spec — backfills + enrichment

### Klaviyo profile enrichment → customers.timezone + address
**Status:** ⏳ Sketched in memory.
- Many subscribers signed up via Klaviyo forms but never ordered, so we have no shipping address or timezone for them.
- Klaviyo Profile API has the data; we don't pull it.
- Drives the SMS timezone priority chain (`customers.timezone → zip → area_code → workspace fallback`) — Klaviyo-only subscribers all fall through to the workspace fallback today.
- **Fix:** Klaviyo Profile API client + matcher by email/phone + write `customers.timezone`, `customers.default_address` JSONB.
- Originally in `project_klaviyo_profile_enrichment.md`.

### Meta ad-comment attribution via effective_object_story_id
**Status:** ⏳ Architecturally designed in memory, not implemented.
- Same FB/IG post is "ad" or "organic" depending on entry path; the webhook shape is bimodal and `ad_id` alone is unreliable.
- Canonical truth: match `creative.effective_object_story_id` (FB) / `effective_instagram_media_id` (IG) on adcreatives against the webhook's `post.id`/`media.id`. If a creative matches, the post is ad-backed and the creative's destination URL drives product attribution.
- Originally in `project_meta_comments_ad_detection.md`.

### Klaviyo 180-day engagement backfill (local script)
**Status:** ⏳ Local script approach decided.
- Backfill engagement events from Klaviyo's history for the last 180 days.
- Local because hitting Klaviyo from Vercel risks rate-limit / timeout.
- Originally in `project_klaviyo_engagement_backfill_local.md`.

---

## Ready to spec — UX / product

### Custom checkout — alert on existing active subscription
**Status:** ⏳ Roadmap, blocked on custom storefront landing.
- Hidden-parallel-sub pattern: same customer, same product, multiple parallel subs (Jennifer Santiago = 2 Superfood Tabs subs for 7 months; Roxana Magana = 3 parallel Amazing Coffee subs).
- At checkout submit: lookup active subs containing the cart variant; if any, modal: *"You already have an active subscription with this — add to it, or create a new one?"* Default to add.
- Track choice so we can measure how often a real second-parallel-sub is intentional.
- Originally in `project_checkout_dedup_subs.md`. Depends on the custom storefront work.

### SMS phone preview component
**Status:** ⏳ UI component, scope clear.
- iPhone-style preview pane on the SMS campaign builder showing how the message renders.
- Originally in `project_sms_phone_preview.md`.

### 5 SMS buyer archetypes + replenishment-ratio framework
**Status:** ⏳ Framework drafted.
- Five archetypes (committed / new / cautious / value / lapsed) × per-product replenishment ratios drive campaign targeting.
- Originally in `project_segment_archetypes.md`.

### Predicted-purchase segments (Klaviyo event history)
**Status:** ⏳ Drafted.
- Use Klaviyo event history (placed-order frequency + product affinity) → "likely to repurchase X in the next 30d" segments.
- Originally in `project_predicted_purchase_segments.md`.

### Return-request auto-playbook
**Status:** ⏳ Roadmap.
- Auto-play return requests through the playbook executor (vs the current handler).
- Originally in `project_return_request_playbook.md`.

### Shipping-issues Opus chat
**Status:** ⏳ Deferred (low priority).
- Opus chat for the "shipping issues" cancel reason path — give customers a real conversation instead of a static remedy.
- Originally in `project_shipping_issues_ai_chat.md`.

---

## Ready to spec — analytics

### Storefront — own the checkout (#1 priority per memory)
**Status:** ⏳ Active work track (spans many sub-tasks).
- Replace Shopify checkout. Saves 3% txn fees, enables AOV boosters, custom sub conversion logic, full UX control.
- [[../lifecycles/storefront-checkout]] is the in-progress brain page.
- Promote sub-pieces into individual specs as they're picked up.
- Originally in `project_storefront_priority.md`.

### ROAS analytics — more cards / breakouts
**Status:** 🚧 Partly shipped (Amazon SP-API + Meta + ROAS dashboard live; CAC card just added).
- Remaining: LTV prediction column, channel-level CAC breakdown, payback-period curve.
- Originally in `project_roas_analytics.md`.

### Billing forecast — event-driven MRR
**Status:** ⏳ Roadmap.
- One pending forecast per subscription; webhook-driven updates; static forecast + change events.
- Originally in `project_billing_forecast.md`.

### Amazon pricing UI
**Status:** ⏳ Roadmap.
- Surface for managing Amazon-channel prices alongside Shopify pricing.
- Originally in `project_amazon_pricing.md`.

### Automation analytics dashboard
**Status:** ⏳ Roadmap.
- Surface that scores automation coverage per ticket type / customer-journey segment.
- Originally in `project_automation_analytics.md`.

### Anomaly-aware data tools
**Status:** ⏳ Reframe.
- Tickets are anomaly reports. Restructure orchestrator data tools to surface contradictions (sub cancelled but charged; subs cancelled with active orders; etc.) instead of just current state.
- Originally in `project_anomaly_aware_data_tools.md`.

---

## Ready to spec — integrations

### Cross-app integration (ShopCX / ShopGrowth / Shoptics shared API keys)
**Status:** ⏳ Roadmap.
- Shared API key + workspace mapping so the three apps can call each other without re-auth.
- Originally in `project_cross_app_integration.md`.

---

## Reference / runbooks (not work items)

These have no work attached — they're operational notes. Kept here because they were in memory; fold into recipes/ on next pass.

- **DB lockup diagnosis runbook** (`project_db_lockup_diagnosis.md`) — past root cause was missing index on `sms_campaign_recipients.message_sid` during MDW SMS sends. Use `scripts/pg-stat-statements.ts` + `scripts/pg-live-snapshot.ts` against the pooler. Should move to `docs/brain/recipes/db-lockup-diagnosis.md`.

---

## Recently shipped (delete from this index after the next pass)

- ✅ **Prompt-learning auto-review** (2026-06-03) — now in [[../lifecycles/ai-learning]].
- ✅ **Demographic enrichment lifecycle** (2026-06-03) — now in [[../lifecycles/demographic-enrichment]].
- ✅ **Product Intelligence Engine, ShopGrowth removal** (2026-06-03) — now in [[../lifecycles/product-intelligence]].
- ✅ **CSAT** (2026-06) — now in [[../lifecycles/csat]].
- ✅ **Customer voice / operational rules / UI conventions** brain pages (2026-06).
- ✅ **Email tracking spec** — mostly shipped; verify current state in [[../inngest/deliver-pending-send]] / Resend integration page if anyone touches it again.

---

## Past incident (kept for pattern-matching)

- **Apr 13 ticket glitch** — false-positive close + return response + 529 errors. Originally in `project_ticket_glitch_apr13.md`. If it recurs, check that file before re-investigating from scratch.

---

## Related

[[../project-management]] · [[../README]]
