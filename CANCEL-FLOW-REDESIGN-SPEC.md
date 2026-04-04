# Cancel Flow & Remedy System Redesign — Spec

## Overview

Redesign the cancel flow logic and remedy system. Cancel reasons config determines whether AI picks remedies or starts a conversation. Updated remedy types. Line item modifier remedy for flavor/product swaps. Save tracking.

---

## 1. Cancel Reason Config

### Settings > Cancel Flow (`/dashboard/settings/cancel-flow`)

Each cancel reason now has:
- `label` — customer-facing text
- `slug` — internal key
- `type` — `remedy` or `ai_conversation`
  - `remedy`: AI picks top 3 remedies from the library for this reason
  - `ai_conversation`: opens the AI chat directly (e.g., "something else", "just need a break")
- `suggested_remedy_id` — optional, suggests a specific remedy to AI (AI will prioritize it but still picks best 3). Leave blank for AI to decide purely on its own.
- `enabled` — toggle
- `sort_order` — drag/reorder

### DB Migration

```sql
ALTER TABLE cancel_reasons ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'remedy';
ALTER TABLE cancel_reasons ADD COLUMN IF NOT EXISTS suggested_remedy_id uuid REFERENCES remedies(id);
```

If cancel_reasons doesn't exist as a table (currently may be in journey_definitions or portal_config), create it or add these fields to wherever reasons are stored.

---

## 2. Remedy Types (Updated)

Remove: `social_proof`, `ai_conversation`, `specialist` — these are not selectable remedies.

**Final remedy types:**
- `coupon` — discount code (references coupon_mappings)
- `pause` — pause subscription (30 or 60 days, configurable)
- `skip` — skip next order
- `frequency_change` — change delivery frequency
- `free_product` — one-time free item on next order ($0 price via Appstle)
- `line_item_modifier` — select item → change quantity/remove/swap variant/swap product

### Free Product Remedy

When accepted:
- Needs a product selection in the remedy config (from Shopify products list)
- Uses Appstle one-time variant add with price override to $0
- Research Appstle's `replace-variants-v3` with `newOneTimeVariants` and price override, OR Shopify subscription draft `subscriptionDraftLineAdd` with `currentPrice: 0`

### Line Item Modifier Remedy

When accepted in the cancel flow:
1. Show customer's subscription items
2. Customer selects which item to change
3. Options: change quantity, remove item, change variant (flavor swap), swap to different product
4. After change → redirect to subscription detail, cancel flow ends = save

---

## 3. Cancel Flow Portal Behavior

### Reason selected → type `remedy`
1. Call cancel journey handler with reason
2. Handler calls AI remedy selector (Haiku) to pick top 3
3. Display remedies with social proof reviews alongside (ambient, not a remedy)
4. Customer accepts a remedy → execute it → save
5. Customer declines all → proceed to confirm cancellation

### Reason selected → type `ai_conversation`
1. Open AI chat immediately (no remedies step)
2. **No cancel button visible during AI chat**
3. After **2 AI turns**, show the "I still want to cancel" button
4. If AI conversation recommends "talk to specialist" → offer that (creates escalation ticket)
5. Nothing blocks cancel — customer can always get there after 2 turns

---

## 4. Save Tracking

- A **save** = customer started cancel flow but exited without completing cancellation
- Track in `journey_sessions` or `remedy_outcomes`
- If customer restarts cancel flow **same day** and completes cancellation → remove the save, count as cancellation
- This prevents inflated save metrics from abandoned flows

---

## 5. Add/Swap Modal Styling (Portal)

### `shopify-extension/portal-src/js/modals/AddSwapModal.jsx`

- **Product images**: Use Shopify `_300x300` size transform (append `&width=300` to image URL or use Shopify's image resize syntax)
- **Image container**: `max-width: 200px`, `max-height: 200px`, centered
- **Star rating**: Gold stars below product name (from reviews data if available, or hide if no data)
- **"Select product" CTA**: Premium gradient button (warm orange/coral, matching the loyalty tier style)
- **Step 2 pricing**: MSRP crossed out + subscription price (MSRP × 0.75) + "25% OFF" pill badge
  - No tiered quantity break pricing
  - Badge: small rounded pill, amber/orange background, white text

### Styles in `_detail.scss`

```scss
.sp-addswap__img { max-width: 200px; max-height: 200px; border-radius: 12px; object-fit: contain; }
.sp-addswap__stars { color: #f5b301; font-size: 16px; letter-spacing: 1px; margin: 6px 0; }
.sp-addswap__select-btn { /* premium gradient like loyalty tier buttons */ }
.sp-addswap__discount-badge { background: linear-gradient(135deg, #f59e0b, #f97316); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
```

---

## File Changes

| File | Change |
|------|--------|
| `src/app/dashboard/settings/cancel-flow/page.tsx` | Add type (remedy/ai_conversation) + suggested_remedy_id per reason |
| `src/lib/portal/handlers/cancel-journey.ts` | Route to remedy or AI chat based on reason type |
| `shopify-extension/portal-src/js/screens/Cancel.jsx` | Hide cancel button during AI chat until 2 turns |
| `shopify-extension/portal-src/js/modals/AddSwapModal.jsx` | Smaller images, star rating, premium CTA, simple 25% pricing |
| `shopify-extension/portal-src/styles/screens/_detail.scss` | Add/swap modal styles, discount badge |
| `supabase/migrations/XXXXXX_cancel_reason_types.sql` | Add type + suggested_remedy_id columns |
| `src/lib/remedy-selector.ts` | Accept suggested_remedy_id, prioritize it in selection |

## Implementation Order

1. Cancel reason config: add type + suggested_remedy_id to settings page + DB
2. Cancel flow handler: route based on reason type
3. Portal Cancel.jsx: hide cancel button until 2 AI turns
4. Add/Swap modal styling (portal)
5. Free product remedy type + line_item_modifier type (DB + settings + handler stubs)
6. Save tracking logic
