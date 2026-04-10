# Cancel Flow System

## Overview
The cancel flow is a multi-step retention journey that presents customers with AI-selected remedies before allowing cancellation. Everything is database-driven — cancel reasons, remedies, and coupon mappings are configured in **Settings → Cancel Flow**.

## Data Sources (all from database, no hardcoded defaults)

### Cancel Reasons
- **Stored in:** `workspaces.portal_config.cancel_flow.reasons`
- **Managed at:** Settings → Cancel Flow
- **Fields:** slug, label, type (`remedy` or `ai_conversation`), enabled, sort_order, suggested_remedy_id
- **Type `remedy`:** Shows AI-selected remedies (pause, coupon, skip, etc.)
- **Type `ai_conversation`:** Opens free-form AI chat (Claude Sonnet) instead of remedies

### Remedies
- **Stored in:** `remedies` table
- **Managed at:** Settings → Cancel Flow → Remedies
- **Types:** coupon, pause, skip, frequency_change, free_product, line_item_modifier
- **Config per type:** pause_days, skip_count, frequency_interval, product_variant_id, coupon_mapping_id
- **AI selects top 3** based on cancel reason, customer LTV, retention score, subscription age, first-renewal status, and historical acceptance rates

### Remedy Outcomes
- **Stored in:** `remedy_outcomes` table
- **Tracks:** shown (was remedy displayed), outcome (accepted/rejected/passed_over), cancel_reason, session_id
- **AI learns:** Success rate = accepted / shown per remedy per reason. Uses per-reason stats if 200+ data points, else global stats.

### Coupon Mappings
- **Stored in:** `coupon_mappings` table
- **Referenced by:** remedy.config.coupon_mapping_id
- **Supports:** VIP tier filtering (all, vip, non_vip)

## Cancel Flow Steps

1. **Subscription Selection** (optional — only if customer has 2+ active/paused subscriptions)
2. **Cancel Reason** — loaded from `portal_config.cancel_flow.reasons`
3. **Remedies or AI Chat** — dynamically built based on reason type:
   - `remedy` type → AI (Haiku) selects top 3 from `remedies` table
   - `ai_conversation` type → Opens Sonnet-powered chat
4. **Confirm Cancel** — "Are you sure?" with cancel button
5. **Cancellation** — via Appstle API (`appstleSubscriptionAction("cancel")`)

## Code Architecture

### Single Source of Truth
- **`src/lib/cancel-journey-builder.ts`** — THE builder for cancel journey steps and metadata
  - Loads subscriptions (including linked accounts)
  - Detects first-renewal, shipping protection
  - Loads cancel reasons from database
  - Returns steps + metadata
- **`src/lib/journey-step-builder.ts`** — delegates to cancel-journey-builder for cancel journeys
- **`src/lib/remedy-selector.ts`** — AI remedy selection (Haiku) + open-ended AI conversation (Sonnet)

### Portal Path
- `src/lib/portal/handlers/cancel-journey.ts` — handles portal cancel flow
- Steps: reason → remedies/chat → remedy action → confirm cancel

### Mini-Site / Email / Chat Path
- `src/lib/journey-delivery.ts` — delivers cancel journey via email CTA or chat embedded form
- `src/app/journey/[token]/page.tsx` — renders cancel journey mini-site
- `src/app/api/journey/[token]/remedies/route.ts` — AI remedy selection endpoint
- `src/app/api/journey/[token]/complete/route.ts` — cancel completion + action execution

### Remedy Execution
Actions executed on remedy acceptance:
- **coupon:** `applyDiscountWithReplace()` via Appstle
- **pause:** Sets `pause_resume_at`, schedules auto-resume via Inngest
- **skip:** `appstleSkipNextOrder()` via Appstle
- **frequency_change:** `appstleUpdateBillingInterval()` via Appstle
- **free_product:** `appstleAddFreeProduct()` via Appstle
- **line_item_modifier:** Multi-step frontend flow (add/remove/swap items)

## Key Rules
- Cancel reasons ALWAYS come from the database (`portal_config.cancel_flow.reasons`)
- Remedies ALWAYS come from the `remedies` table
- No hardcoded default cancel reasons — if settings are empty, the step renders empty (admin must configure)
- AI selects remedies, admins configure them. AI never invents remedies.
- Remedy acceptance/rejection rates are tracked and influence future AI selections
- First-renewal customers get more aggressive save offers (higher discounts, "extend your trial" framing)
- Grandfathered pricing customers don't get coupon remedies (they already have a good deal)
