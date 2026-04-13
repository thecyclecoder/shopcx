# Portal Fixes Round 2 — Apr 13, 2026

## Outstanding Issues

### 1. Flavor swap adds instead of swapping
The inline flavor change sends `oldLineId` but the old variant isn't removed. Two Creatine Prime+ lines appear after a "flavor change." The `oldLineId` is the raw UUID from our DB but Appstle may need the GID format. The handler adds `gid://shopify/SubscriptionLine/` prefix but the swap still fails to remove the old one.

**Debug:** Check what `line_id` is stored on the subscription items vs what Appstle expects. The `line_id` comes from the webhook at `line.id` → `extractId()` which strips the GID. But the handler adds it back. Need to verify the UUID matches Appstle's actual line ID.

### 2. Grandfathered pricing not preserved on flavor swap  
Even with the `oldLineId` fix, the pricing preservation needs the two-step approach: swap variant → update line item price. The handler has this code but it depends on finding the old variant's `price_cents` in our DB items. If the items data is stale or the old variant was already replaced, the lookup fails.

**Fix needed:** The flavor change should:
1. Read old item's price from DB BEFORE the swap
2. Do the swap via Appstle
3. Call `subUpdateLineItemPrice` with the preserved base price
4. Only if old MSRP === new MSRP

### 3. Product swap modal still shows current product
The filter compares `line.productId` (UUID) against `p.productId` (Shopify ID). The `p.internalId` check was added but may not be in the deployed JS. Verify the built JS includes the `internalId` comparison.

### 4. Shipping protection card layout
Still rendering everything horizontally. The `display: flex; flex-direction: column` was added to `.sp-shipprot` but may be overridden by another rule. Need to inspect with browser dev tools.

### 5. Shipping protection toggle should use action overlay
Fixed in latest deploy (shopcx-73).

### 6. Reviews card not showing
The `normalizeProductId` fix was deployed. The bootstrap `metafields` column was removed. Need to verify reviews actually load now.

## Root Cause Analysis
Most issues stem from the same problem: **item `line_id` and `product_id` are stored in our internal format (UUID) but the portal frontend and Appstle API expect Shopify GID format.** Every time we cross this boundary, something breaks.

**Ideal fix:** Standardize on one format throughout. Either:
- Store Shopify format everywhere (GIDs for line_id, Shopify product IDs)
- Or always convert at the API boundary (strip on read, add back on write)

Currently we strip on read (`extractId`) and add back on write (`gid://shopify/SubscriptionLine/`), but the stored `line_id` might not match what Appstle expects if the line was modified.
