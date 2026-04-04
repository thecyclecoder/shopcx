# Portal Updates Spec — Phase 7b

## Overview

Bug fixes, UX improvements, and missing features for the customer portal (Shopify extension). All changes are in `shopify-extension/` (frontend Preact app) and `src/lib/portal/` (backend handlers).

---

## 1. DOM / Stacking Context Fixes

### 1a. Modal portaling
- **Problem**: Modals render inside the portal app container, which sits inside the host Shopify site. The host site's fixed header has its own stacking context, so our modal can't escape it regardless of `z-index`.
- **Fix**: Portal all modals to `document.body` using Preact's `createPortal`. Apply `z-index: 2147483647` (max) on the modal overlay.
- **Affects**: `Modal.jsx` component (used by frequency, address, quantity, add/swap modals)

### 1b. Toast portaling
- **Problem**: Same stacking context issue — toasts with `position: fixed` are positioned relative to the portal container, not the viewport.
- **Fix**: Portal toast container to `document.body`. Use `position: fixed; bottom: 24px; z-index: 2147483647`.

### 1c. Scroll to top on navigation
- **Problem**: Screen transitions (e.g., entering cancel flow, moving between cancel steps) leave the user scrolled to the middle of the page.
- **Fix**: Call `window.scrollTo(0, 0)` on every screen/step transition in the router and within multi-step flows (cancel journey steps).

---

## 2. Item Management Fixes

### 2a. Collapse disclosures after mutation
- After any item mutation (remove, swap, quantity change), collapse ALL open `LineItemDisclosure` panels. Reset the `open` state for all items.

### 2b. Sequential remove fails ("no changes detected")
- **Problem**: After removing item A optimistically, the UI updates but the contract state used for removing item B is stale. The second remove sends old variant data.
- **Fix**: After a successful remove, the optimistic patch updates the UI, but we must also do a background re-fetch of the full contract to get fresh variant IDs/line IDs for subsequent mutations. Use the patch for immediate UI, then silently refresh contract state. Alternatively, always re-fetch the contract after any mutation before allowing the next one (disable mutation buttons during refresh).

### 2c. Cancelled subscription read-only
- When subscription status is cancelled:
  - Hide "Add item" button
  - Hide "Make changes to this item" disclosure buttons on all line items
  - Items card becomes read-only (just shows what was on the subscription)

---

## 3. Modal Styling Overhaul

### 3a. Close button
- Replace the browser-default `×` checkbox with a styled SVG close icon (circular, subtle border, hover state).

### 3b. Radio inputs → card-style selectable rows
- For frequency picker (and any future radio-based modals): replace native radio buttons with full-width tappable card rows.
- Each option is a bordered card. Selected state: highlighted border (primary color) + subtle fill.
- Tap anywhere on the row to select.

### 3c. Button hierarchy
- **Save/primary action**: filled/dark button (`sp-btn-primary` with dark background)
- **Cancel/secondary**: ghost button (`sp-btn--ghost`)
- Clear visual weight difference between the two.

### 3d. Modal padding & layout
- More internal padding on modal body
- Footer buttons separated from content with spacing or subtle divider
- Darker backdrop overlay (`rgba(0,0,0,0.5)` minimum)

---

## 4. Pause Fix

### 4a. `invalid_pauseDays` error
- **Problem**: Frontend `PauseCard` sends `{ contractId, days }` but the backend `pause` handler expects a different param name.
- **Fix**: Check `src/lib/portal/handlers/pause.ts` for the expected field name (likely `pauseDays` or `pause_days`) and align the frontend payload. Or update the handler to accept `days`.

---

## 5. Coupon Card Rewrite

### 5a. State-aware display
- **If coupon is applied**: Show coupon name (truncated with ellipsis if long) + discount value (e.g., "25% off") + "Remove" button. No input field.
- **If no coupon**: Show input + Apply button on the **same line** (flex row, not stacked).

### 5b. Coupon data source
- The subscription contract from Appstle/Shopify should include applied discount info. Read this from the contract response and pass to `CouponCard`.

### 5c. Apply feedback
- After successful apply: immediately switch to the "coupon applied" view showing the coupon name and discount. Don't leave the input visible.
- Use the mutation response to get the applied coupon details.

### 5d. Overflow handling
- Truncate long coupon names with `text-overflow: ellipsis`
- Ensure all coupon card content wraps properly on narrow screens — nothing pushed off-page.

---

## 6. Shipping Protection Fix

### 6a. Variant with selling plans
- **Problem**: `config.shippingProtectionProductIds` may contain variant IDs without selling plans, which can't be added to a subscription.
- **Fix**: In the bootstrap handler, when loading shipping protection product IDs, cross-reference with the product's variants to find the first variant that has selling plans associated. Only return variants with active selling plans.

### 6b. Add vs Replace
- **Problem**: When toggling shipping protection ON (no existing ship line), the frontend calls `replaceVariants` with only `newVariants` and no `oldVariants`. This may fail or behave unexpectedly since nothing is being replaced.
- **Fix**: For pure adds (no old variant), use a dedicated add flow. Either:
  - Create a new portal route `addLineItem` that uses the Shopify subscription draft workflow (`src/lib/shopify-subscriptions.ts` → `addLineItem()`)
  - Or ensure the Appstle `replaceVariants` endpoint properly handles add-only payloads (test this first — if Appstle handles it, no backend change needed, just fix the variant selection)

### 6c. Price display
- Verify the displayed price ($3.75 discounted) matches what Appstle actually charges after subscription discount is applied. If Appstle auto-applies the subscription discount, display the discounted price. If not, we may need to send a price override.

---

## 7. Cancel Flow Fixes & Enhancements

### 7a. Alert banner spacing
- Add `margin-bottom: 16px` (or appropriate spacing) to the "Not cancelled yet" alert banner so it doesn't collide with the heading below.

### 7b. Reviews on cancel reason step
- Add the reusable `ReviewsCard` component to the cancel reason selection step (step 1).
- **Layout**: Two-column on desktop (reasons left, reviews right), stacked on mobile (reasons first, reviews below).
- Use the customer's subscription product IDs to fetch relevant reviews.
- See section 10 for cancel-reason-aware review matching.

### 7c. AI chat placeholder fix
- **Problem**: Input placeholder shows literal `\u2026` instead of the `…` character.
- **Fix**: Replace the escaped unicode with the actual ellipsis character in the placeholder string.

### 7d. AI chat conversation logging
- **Problem**: The AI cancel chat (for "something else" / "just need a break" / "reached goals") is not saved anywhere for review.
- **Fix**: When the AI chat begins, create a ticket with:
  - Tag: `cancel:ai_chat`
  - `journey_id` set to the active cancel journey session ID (prevents journeys/workflows/AI from firing on it)
  - Channel: `chat` or `portal`
- Log each message exchange (customer + AI) as `ticket_messages` on this ticket (customer messages as `direction: 'in'`, AI as `direction: 'out'`, `author_type: 'ai'`)
- After cancel flow completes, the journey completion handler handles cleanup.
- This gives agents full visibility into what AI said during retention attempts.

### 7e. Scroll to top on step transitions
- Every cancel flow step change must `window.scrollTo(0, 0)`.

---

## 8. Reactivate Flow

### 8a. Reactivate card
- Show a `ReactivateCard` when subscription status is `cancelled` (in the same position as Pause/Resume cards).
- Card shows: "Reactivate subscription" title, subtitle "Pick up where you left off."
- Button opens a modal.

### 8b. Reactivate modal
- Modal title: "Reactivate subscription"
- **Date picker**: Calendar-only input for next order date. No manual text entry.
  - Use `<input type="date">` with `min` = tomorrow, `max` = 60 days from today
  - Or a custom calendar component if native date input doesn't match portal styling
  - Set `readonly` on the text portion / prevent keyboard input — force calendar selection only
- "Reactivate" primary button + "Cancel" ghost button
- On confirm: call `reactivate` portal endpoint with contractId + selected date

### 8c. Date picker pattern (shared)
- Apply the same calendar-only date picker to the "Change next order date" flow.
- Consistent behavior: tomorrow to 60 days, no manual entry, calendar selection only.

---

## 9. Cancel Flow Settings (New Page)

### 9a. Settings > Cancel Flow (`/dashboard/settings/cancel-flow`)
New settings page with two sections:

#### Cancel Reasons
- List of cancel reasons shown to customers during the cancel journey
- Each reason: label (customer-facing text), slug (internal key), enabled toggle
- Drag-to-reorder (or up/down arrows)
- Add / edit / remove reasons
- Default reasons: too_expensive, too_much_product, not_seeing_results, reached_goals, just_need_a_break, something_else
- These feed into the cancel journey builder + remedy selection

#### Remedies Library
- CRUD for the `remedies` table
- Each remedy: name, type (coupon, pause, skip, frequency_change, ai_conversation, social_proof, specialist), pitch text (max 25 words), enabled toggle, associated cancel reasons (multi-select)
- **Coupon-based remedies**: When type is `coupon`, show a dropdown to select from `coupon_mappings` table (same data as Settings > Coupons). Don't duplicate coupon management — reference existing coupons.
- Remedy stats display: show acceptance rate per remedy (from `remedy_outcomes` table), visual badge (green >50%, amber 25-50%, red <25%)
- AI selects top 3 remedies per cancel reason using Haiku. Initially best-guess, then narrows based on `remedy_outcomes` success rates over time.
- **Never show more than 3 remedies to a customer.**

### 9b. Settings card
- Add "Cancel Flow" card to the settings overview page, linking to `/dashboard/settings/cancel-flow`

---

## 10. Review Tagging for Cancel Reasons

### 10a. Database
- Add `cancel_relevance jsonb` column to `product_reviews` table — array of cancel reason slugs this review counters (e.g., `["too_expensive", "not_seeing_results"]`).
- Add `cancel_relevance_at timestamptz` — when the analysis was last run.

### 10b. AI analysis (Claude Haiku)
- For each review, send review text + full list of cancel reasons to Haiku.
- Prompt: "Which of these cancel reasons would this review help counter? A customer considering cancelling for reason X would be encouraged to stay after reading this review. Return only slugs where the review is clearly relevant."
- Store matching slugs in `cancel_relevance`.
- Only tag if Haiku returns with confidence — skip weak/generic reviews.

### 10c. Inngest functions
1. **`reviews/tag-cancel-relevance`** — Manual trigger, bulk: process all `product_reviews` where `cancel_relevance IS NULL`. Batch to respect Haiku rate limits. Run once to seed all existing reviews.
2. **`reviews/tag-cancel-relevance-cron`** — Weekly cron: process reviews where `created_at > now() - interval '7 days'` OR `cancel_relevance IS NULL` (catches stragglers).

### 10d. Surfacing at remedy time
- When displaying remedies for a cancel reason, query `product_reviews` where `cancel_relevance @> '["the_reason_slug"]'`, ordered by `rating DESC, smart_featured DESC`.
- Pick top 1 review to display alongside remedies.
- Falls back to the existing general ReviewsCard if no cancel-relevant review found.

---

## 11. Add Product / Subscription Line Item Flow

### 11a. Sanity check: pure add via replaceVariants
- Test whether Appstle's `replace-variants-v3` properly handles payloads with only `newVariants` (no `oldVariants`). If it works, no backend change needed for adds.
- If it doesn't handle pure adds: create a new portal route `addLineItem` that uses the Shopify subscription draft workflow (`src/lib/shopify-subscriptions.ts` → `addLineItem()`).

### 11b. Subscription discount behavior
- Test whether Appstle auto-applies the subscription discount when a product is added via `replaceVariants` or if we need to send a price override.
- Document the finding and adjust the add flow accordingly.

---

## 12. Portal Ban (Self-Serve Restriction)

### 12a. Overview
Admins/agents can ban a customer from self-serve portal access. Banned customers see a restricted view instead of the normal subscription management UI. This is for customers abusing the system (e.g., excessive cancels/reactivates, coupon abuse).

### 12b. Database
- Add `portal_banned boolean NOT NULL DEFAULT false` column to `customers` table.
- Add `portal_banned_at timestamptz` and `portal_banned_by uuid REFERENCES workspace_members(id)` for audit trail.
- Migration: `supabase/migrations/XXXXXX_portal_ban.sql`

### 12c. Portal behavior (frontend)
- The `bootstrap` response includes a `banned: true/false` flag for the logged-in customer.
- **If banned**: The entire portal renders a single restricted view instead of the normal app:
  - Message: "We're sorry but your account is not allowed to make self-serve changes to your subscriptions. Please use the form below to request changes."
  - Simple form: subject (dropdown: "Change my subscription", "Cancel my subscription", "Update shipping address", "Other"), message (textarea), submit button
  - On submit: creates a ticket via a new portal route `submitBanRequest` (channel: `portal`, tag: `portal:ban_request`)
  - No access to subscriptions list, detail, cancel flow, or any mutation endpoints
- **Backend enforcement**: All mutation handlers (`pause`, `resume`, `cancel`, `replaceVariants`, `frequency`, `address`, `coupon`, `reactivate`) should check the ban flag and return `403` with `{ error: "account_restricted" }` if banned. Defense in depth — don't rely solely on the frontend hiding things.

### 12d. Dashboard: apply/remove ban
Ban action available in three places:

#### Customer detail page (`/dashboard/customers/[id]`)
- "Ban from portal" / "Unban from portal" button in customer actions area
- Shows current ban status with timestamp and who banned them

#### Ticket detail sidebar (customer section)
- Small "Ban from portal" action link below customer info
- If already banned: show "Banned from portal" badge + "Unban" link

#### Subscription detail page (`/dashboard/subscriptions/[id]`)
- In the customer info section or actions dropdown
- Same ban/unban toggle

### 12e. API endpoint
- `POST /api/customers/[id]/portal-ban` — body: `{ banned: true/false }`
- Requires admin or owner role
- Updates `portal_banned`, `portal_banned_at`, `portal_banned_by`
- Creates an internal ticket note: "Customer banned from portal by {display_name}" or "Customer unbanned from portal by {display_name}"

### 12f. Portal route: `submitBanRequest`
- New handler in `src/lib/portal/handlers/ban-request.ts`
- Accepts: `{ subject, message }`
- Creates ticket with channel `portal`, tag `portal:ban_request`, customer linked
- Returns `{ ok: true, message: "Your request has been submitted. We'll get back to you within 24 hours." }`

---

## 13. Portal Loyalty Widget (Rewards Card Upgrade)

### 13a. Overview
The existing `RewardsCard` component becomes an interactive loyalty widget. Shows points balance, redemption options, and unused loyalty coupons. On subscription detail, integrates with the coupon card for one-click apply.

### 13b. Portal route handlers

**`loyaltyBalance`** — GET
- Look up `loyalty_members` by customer's `shopify_customer_id`
- Return: `{ points_balance, dollar_value, tiers: [{ label, points_cost, discount_value, affordable }] }`
- Include `unused_coupons`: query `loyalty_redemptions` where `status IN ('active', 'applied')` and `expires_at > now()` — return code, discount_value, status, expires_at

**`loyaltyRedeem`** — POST
- Accept: `{ tierId }` (index into tiers)
- Validate balance >= tier cost
- Create Shopify discount code via `discountCodeBasicCreate` (customer-locked, single-use, 90-day expiry)
- Deduct points, insert `loyalty_transactions` + `loyalty_redemptions`
- Return: `{ ok: true, code, discount_value, expires_at, new_balance }`

**`loyaltyApplyToSubscription`** — POST
- Accept: `{ contractId, redemptionId }` (or `{ contractId, tierId }` to redeem + apply in one step)
- If `redemptionId`: use existing unused coupon from `loyalty_redemptions`
- If `tierId`: redeem first (create discount code), then apply
- Apply coupon to subscription via Appstle `coupon` endpoint (same as existing coupon card)
- Update `loyalty_redemptions.status` to `'applied'` (see 13d)
- Return: `{ ok: true, code, discount_value }`

### 13c. Rewards Card widget (`RewardsCard.jsx` rewrite)

**Top section — Points balance:**
- Large display: "You have **{points}** reward points"
- Subtitle: "That's worth **${dollar_value}** in rewards"

**Redemption section:**
- Show available tiers as tappable cards/buttons (same card-style as frequency modal)
- Each tier: "$5 Off — 500 pts", "$10 Off — 1,000 pts", "$15 Off — 1,500 pts"
- Affordable tiers: active, tappable. Unaffordable: grayed out with "Need {X} more points"
- On tap: call `loyaltyRedeem` → show success with the generated coupon code
- After redeem: update balance display, add coupon to unused coupons list

**Unused coupons section:**
- List of active/applied loyalty coupons the customer has
- Each: code (truncated), discount value, status badge, expiry date
- Status badges:
  - `active` (green): "Ready to use"
  - `applied` (amber): "Applied to subscription"
- If no unused coupons: hide this section

### 13d. Redemption status lifecycle

`loyalty_redemptions.status` values:
- `active` — coupon created, not yet used or applied anywhere
- `applied` — coupon has been applied to a subscription (waiting for next billing cycle to consume it)
- `used` — coupon was consumed on an order (detected via `orders/create` webhook matching the discount code)
- `expired` — coupon passed its expiry date without being used

**Why `applied` matters**: Shopify coupons are single-use, but when applied to a subscription via Appstle, the coupon sits there until the next billing cycle charges. During that window it should NOT appear as "available" to use elsewhere. Marking it `applied` prevents the portal from showing it as redeemable and prevents double-apply.

**Transition rules:**
- `active` → `applied`: when `loyaltyApplyToSubscription` is called
- `active` → `used`: when `orders/create` webhook detects the discount code on a one-time order
- `applied` → `used`: when `orders/create` webhook detects the discount code on a subscription order
- `active`/`applied` → `expired`: cron or on-read check when `expires_at < now()`

### 13e. Subscription detail — coupon card integration

When the coupon card shows "no coupon applied":
- Below the coupon input, add a "Use reward points" section
- If customer has `active` loyalty coupons: show them as quick-apply buttons ("Apply $10 coupon — LOYALTY-10-A3F9XK")
- If customer has enough points but no unused coupons: show redeem + apply buttons per affordable tier ("Redeem $10 & apply — 1,000 pts")
- One-click flow: tap → calls `loyaltyApplyToSubscription` → coupon created (if needed) + applied to subscription → coupon card switches to "applied" view → redemption marked `applied`

When coupon card shows an active loyalty coupon:
- Display normally with the coupon name + discount + remove option
- If removed: set `loyalty_redemptions.status` back to `active` (coupon is still valid, just unapplied)

### 13f. Coupon expiry
- All loyalty coupons created with 90-day expiry (`endsAt` = now + 90 days)
- This is configured in `loyalty_settings.coupon_expiry_days` (default 90, minimum 60)

---

## File Changes Summary

| File | Change |
|------|--------|
| `shopify-extension/portal-src/js/components/Modal.jsx` | Portal to `document.body`, z-index max, styled close button, better padding/backdrop |
| `shopify-extension/portal-src/js/components/Toast.jsx` | Portal to `document.body`, fixed viewport positioning |
| `shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx` | Collapse disclosures after mutation, sequential remove fix, cancelled read-only, reactivate card, date picker |
| `shopify-extension/portal-src/js/screens/CancelFlow.jsx` (or equivalent) | Alert spacing, reviews on step 1, AI chat placeholder fix, conversation logging, scroll to top |
| `shopify-extension/portal-src/js/cards/ShippingProtectionCard.jsx` | Variant selling plan check, add vs replace logic |
| `shopify-extension/portal-src/js/cards/CouponCard.jsx` (or inline in SubscriptionDetail) | Full rewrite: state-aware, same-line input, truncation |
| `shopify-extension/portal-src/js/cards/PauseCard.jsx` (or inline) | Fix payload param name |
| `shopify-extension/portal-src/styles/components/_modal.scss` | Card-style radio rows, button hierarchy, backdrop |
| `shopify-extension/portal-src/styles/screens/_detail.scss` | Coupon row layout, cancel banner spacing |
| `src/lib/portal/handlers/bootstrap.ts` | Filter shipping protection variants by selling plan |
| `src/lib/portal/handlers/pause.ts` | Align param name with frontend |
| `src/app/dashboard/settings/cancel-flow/page.tsx` | New: cancel reasons + remedies library settings |
| `src/lib/inngest/review-tagging.ts` | New: bulk + weekly cron for cancel-relevance tagging |
| `supabase/migrations/XXXXXX_review_cancel_relevance.sql` | Add `cancel_relevance` + `cancel_relevance_at` to `product_reviews` |
| `supabase/migrations/XXXXXX_portal_ban.sql` | Add `portal_banned`, `portal_banned_at`, `portal_banned_by` to `customers` |
| `src/lib/portal/handlers/bootstrap.ts` | Include `banned` flag in bootstrap response |
| `src/lib/portal/handlers/ban-request.ts` | New: banned customer ticket submission |
| `shopify-extension/portal-src/js/screens/BannedView.jsx` | New: restricted portal view with request form |
| `src/app/api/customers/[id]/portal-ban/route.ts` | New: ban/unban endpoint |
| Dashboard pages (customer, ticket, subscription detail) | Ban/unban action buttons |
| `shopify-extension/portal-src/js/cards/RewardsCard.jsx` | Full rewrite: interactive loyalty widget with balance, redeem, unused coupons |
| `src/lib/portal/handlers/loyalty-balance.ts` | New: points balance + tiers + unused coupons |
| `src/lib/portal/handlers/loyalty-redeem.ts` | New: redeem points → Shopify discount code |
| `src/lib/portal/handlers/loyalty-apply-subscription.ts` | New: redeem + apply coupon to subscription in one step |
| `src/lib/portal/handlers/index.ts` | Register loyalty routes |
| `shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx` | Coupon card: "Use reward points" integration |

## Build Reminder
After all changes: `cd shopify-extension && node build-portal.js && npx sass portal-src/styles/portal.scss extensions/subscriptions-portal-theme/assets/portal.min.css --style=compressed --no-source-map`
