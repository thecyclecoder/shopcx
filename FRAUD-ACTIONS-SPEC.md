# Fraud Actions — Spec

## 1. AI Analysis on Fraud Detail Page
- **Bug:** AI analysis runs on every page load. Should run ONCE and cache.
- **Fix:** Store AI analysis result on the `fraud_cases` record (e.g. `ai_analysis` JSONB column). Only re-run on explicit "Re-analyze" button click.

## 2. Enhanced Fraud Detail View
Show full context for each order in the case:
- Order line items + total amount
- Billing address (from `orders.billing_address`)
- Shipping address (from `orders.shipping_address`)
- Payment details (from `orders.payment_details` — card last4, brand, gateway)
- Customer email, name, account age
- **Highlight fraud indicators** — gibberish names get a red highlight, mismatched billing/shipping highlighted, suspicious email domains highlighted, gmail+ aliases highlighted

## 3. Immediate vs After-the-Fact Detection
- **Immediate (order webhook):** Order tagged "suspicious" → 3PL won't sync → safe
- **After-the-fact (nightly scan / delayed detection):** Order may already be at 3PL
  - Check `orders.amplifier_order_id` — if present, order is at Amplifier
  - If at Amplifier, check `amplifier_status` — is it still cancellable?
  - Surface Amplifier URL: `https://my.amplifier.com/orders/{amplifier_order_id}`
  - Agent must manually cancel at Amplifier before proceeding

## 4. "Confirmed Fraud" Action Series
A guided, visually engaging flow when agent clicks "Confirmed Fraud":

### Step 1: Amplifier Check
- Check `orders.amplifier_order_id` — if null, order never synced to 3PL → skip to Step 2
- If present, check `orders.amplifier_status`:
  - `"Processing Shipment"` + `amplifier_shipped_at: null` → **still cancellable**
    - Show Amplifier link: `https://my.amplifier.com/orders/{amplifier_order_id}`
    - Prompt: "This order is at Amplifier but hasn't shipped yet. Cancel it there first."
    - Two buttons: "I cancelled it at Amplifier" / "Too late to cancel"
  - `"Shipped"` + `amplifier_shipped_at` set → **already shipped, too late**
    - Show: "This order has already shipped from Amplifier"
    - Ask: "Should we still cancel/refund on Shopify?" (Yes/No)
    - Some scenarios agent just lets it through
- If "I cancelled it" → proceed to Step 2
- If "too late to cancel" or already shipped → ask about Shopify cancel/refund

### Amplifier Data Fields (on `orders` table)
```
amplifier_order_id: UUID (e.g. "4454f5cd-019f-4e7c-9f45-4f723598360b")
amplifier_status: "Processing Shipment" | "Shipped"
amplifier_shipped_at: timestamp (null if not shipped)
amplifier_received_at: timestamp (when 3PL received the order)
amplifier_carrier: string (shipping carrier)
amplifier_tracking_number: string
```
Amplifier URL format: `https://my.amplifier.com/orders/{amplifier_order_id}`

### Step 2: Cancel Active Subscriptions
- Find all active subs for this customer
- Cancel each via Appstle with reason "fraud"
- Show progress: "Cancelling subscription #12345... ✓"

### Step 3: Cancel & Refund Order
- Cancel order on Shopify with reason FRAUD, refund: true, notifyCustomer: false
- Show: "Order SC127881 cancelled and refunded ✓"

### Step 4: Ban Customer
- Set `portal_banned: true` on the customer record
- This prevents portal and minisite access
- **Verify:** Check that `checkPortalBan()` in portal helpers blocks banned customers
- Show: "Customer banned from self-service portal ✓"

### Step 5: Confirmation
- Animated success state — shield icon, confetti, "Fraud case resolved!"
- Summary of actions taken
- Case status updated to "confirmed_fraud"

### Visual Design
- Each step has a progress indicator (step 1 of 4, etc.)
- Animated transitions between steps
- Green checkmarks as each step completes
- Make the agent feel like they're protecting the business — superhero vibes
- Error states are clear but not blocking (e.g., "Couldn't cancel sub — already cancelled ✓")

## 5. Portal Ban Verification
- `checkPortalBan()` in `src/lib/portal/helpers.ts` checks `portal_banned` on customer
- Bootstrap checks ban and returns `portalBanned: true` → frontend shows `BannedView` component
- **Handlers WITH ban check:** pause, resume, reactivate, frequency, address, cancel-journey, cancel, coupon, change-date, order-now, replace-variants, loyalty-redeem, loyalty-apply-subscription
- **Handlers MISSING ban check (need to add):** subscriptions, subscription-detail, home, link-accounts, loyalty-balance, reviews, dunning-status
  - These are read-only routes, but a banned customer shouldn't access them at all
  - Bootstrap returns the ban flag and frontend blocks, but a direct API call bypasses the frontend
- **Action:** Add `checkPortalBan` to all handlers missing it (except `bootstrap` which handles ban differently, `index` which is the route map, and `ban-request` which IS the ban check)

## 6. API Endpoints Used

### Cancel Subscription (fraud reason)
```ts
import { appstleSubscriptionAction } from "@/lib/appstle";
await appstleSubscriptionAction(workspaceId, contractId, "cancel", "fraud", "Fraud Detection");
```

### Cancel & Refund Shopify Order
```graphql
mutation {
  orderCancel(orderId: "gid://shopify/Order/{id}", reason: FRAUD, notifyCustomer: false, refund: true) {
    orderCancelUserErrors { message }
  }
}
```

### Ban Customer
```ts
await admin.from("customers").update({ portal_banned: true }).eq("id", customerId);
```

### Shopify Credentials
```ts
import { getShopifyCredentials } from "@/lib/shopify-sync";
const { shop, accessToken } = await getShopifyCredentials(workspaceId);
```

## Files to Modify
- `src/app/dashboard/fraud/[id]/page.tsx` — fraud detail page (all UI changes)
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/route.ts` — API for confirmed fraud actions
- `src/app/api/workspaces/[id]/fraud-cases/[caseId]/confirm-fraud/route.ts` — NEW: multi-step confirm fraud API
- `supabase/migrations/` — add `ai_analysis` column to fraud_cases
- `src/lib/portal/helpers.ts` — verify ban check
