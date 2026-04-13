# Portal Fixes — Apr 13, 2026

## Root Cause: Product ID Mismatch
Items on subscriptions have our internal UUID as `product_id`, but the portal catalog uses `shopify_product_id`. The `getProductMap` in `transform-subscription.ts` was updated to index by both, but the **portal frontend** receives `ln.productId` which is the internal UUID while `catalog[].productId` uses the Shopify ID (set by bootstrap). This causes:

- **Change flavor button not showing** — can't find product in catalog by `ln.productId`
- **Product swap not filtering current product** — `line.productId !== p.productId` never matches
- **Reviews not rendering** — product review lookup by wrong ID format
- **Swap modal image 300px** — separate issue, just change `?width=300` to `?width=800` in `AddSwapModal.jsx` `pickImage()`

**Fix:** In bootstrap handler, set `productId` on catalog items to BOTH formats, OR resolve in the frontend by matching via variant ID overlap. Simplest: have bootstrap also include the internal UUID on each catalog product.

## Fixes List

### 1. "Make changes to this item" — padding
**File:** `portal-src/styles/screens/_detail.scss`
The `.sp-disclosure` button needs left/right padding (~12px) and bottom margin (~10px) inside `.sp-line-group`.

### 2. Frequency modal — disable current, "Current" badge
**File:** `portal-src/js/screens/SubscriptionDetail.jsx` — `FrequencyCard`
- Compare each option's interval/count against `contract.billingPolicy`
- Disable the matching option, add a "Current" badge span
- Save button disabled until a different option is selected

### 3. Coupon — hide input when coupon applied
**File:** `portal-src/js/screens/SubscriptionDetail.jsx` — `CouponCard`
- Only show the discount code input + Apply button when no coupon is active
- When coupon is applied, only show the applied coupon with Remove button

### 4. Address — EasyPost verification + state dropdown
**Files:** `portal-src/js/screens/SubscriptionDetail.jsx`, `src/lib/portal/handlers/address.ts`
- Research existing EasyPost implementation in the address change journey (check `src/lib/address-journey-builder.ts` or similar)
- Province field → state dropdown (US states)
- On save, verify address via EasyPost before submitting to Appstle
- Show verification result (suggested address vs entered)

### 5. Swap modal — image size + filter current product
**File:** `portal-src/js/modals/AddSwapModal.jsx`
- `pickImage()`: change `?width=300` to `?width=800`
- Product filter not working due to ID mismatch (see root cause above)

### 6. Change flavor not showing
**File:** `portal-src/js/screens/SubscriptionDetail.jsx` — `LineItemDisclosure`
- Flavor variants lookup uses `ln.productId` to find product in catalog
- Fails because of ID format mismatch (see root cause)

### 7. Shipping protection — wrong variant ID + card redesign
**Files:** `portal-src/js/cards/ShippingProtectionCard.jsx`, `portal-src/styles/`
- Variant ID `7510145040557` is wrong — investigate where it comes from in bootstrap
- Card redesign: green gradient background, shield icon, "Protected/Not Protected" status, make it feel like insurance worth having

### 8. Cards pushed off screen (mobile layout)
**File:** `portal-src/styles/screens/_detail.scss`
- Two-column layout not stacking on mobile — right column pushed off-screen
- Ensure proper `flex-wrap` or single-column on mobile breakpoint

### 9. Reviews not showing
**File:** `portal-src/js/screens/SubscriptionDetail.jsx` or wherever the reviews card is rendered
- Product review lookup fails due to product ID mismatch
- Reviews card exists in portal — featured reviews first, then 5-star, rotate by product
- Query `product_reviews` table — logic exists in `src/lib/klaviyo.ts`

### 10. Cancel button — dim text, smaller
**File:** `portal-src/styles/screens/_detail.scss`
- Cancel subscription card button: muted/dimmed text color, smaller font/padding

## Build Order
1. Fix root cause (product ID mismatch in bootstrap/catalog)
2. Fix all dependent issues (flavor change, product filter, reviews, swap images)
3. CSS fixes (padding, layout, cancel button)
4. Frequency modal UX
5. Coupon card logic
6. Shipping protection investigation + redesign
7. Address verification (requires EasyPost research)
8. Build portals: `node scripts/build-all-portals.js`
9. Deploy: `cd shopify-extension && npx shopify app deploy --force`
