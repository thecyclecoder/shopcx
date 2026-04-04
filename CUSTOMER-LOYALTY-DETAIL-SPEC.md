# Customer Page Loyalty + Detail View — Spec

## 1. Move Loyalty Section Higher on Customer Detail Page

**File**: `src/app/dashboard/customers/[id]/page.tsx`

Move the Loyalty Points card to appear right after the customer info/stats section, before Subscriptions. Current order is: Customer Info → Subscriptions → Orders → ... → Loyalty → Store Credit History. New order: Customer Info → **Loyalty** → Subscriptions → Orders → ... → Store Credit History.

---

## 2. Loyalty Detail Page

**New page**: `src/app/dashboard/loyalty/[memberId]/page.tsx`

Clickable from the customer detail page (click the Loyalty card header) and from the `/dashboard/loyalty` members list.

### Content:
- **Points summary**: Balance (large), earned, spent, dollar value equivalent
- **Redemption tool**: Same dropdown + submit pattern as customer page (select tier → Redeem button)
- **Unused coupons**: List of `loyalty_redemptions` where `status IN ('active', 'applied')` and `expires_at > now()`
  - Show: code, discount value, status badge (active/applied), expiry date
- **Redemption history**: Full list of `loyalty_redemptions` for this member
  - Show: code, discount value, status (active/applied/used/expired), created date, used date
- **Transaction history**: Full list of `loyalty_transactions` for this member
  - Show: type (earning/spending/import/refund/chargeback), points change (+/-), description, date
- **Manual adjustment** (admin only): Input for points amount (+/-) + reason textarea + submit
  - Calls existing loyalty adjust logic

### API:
- `GET /api/loyalty/members/[memberId]` — returns member detail + transactions + redemptions
- Or reuse existing endpoints with member ID filter

### Navigation:
- Customer page Loyalty card: clicking the header goes to `/dashboard/loyalty/{memberId}`
- Loyalty list page: clicking a row goes to `/dashboard/loyalty/{memberId}`

---

## 3. Query Shopify for Customer-Specific Discount Codes

**Goal**: Show historical discount codes assigned to this customer (from before ShopCX, e.g., Smile.io loyalty coupons or manually created ones).

### Shopify GraphQL query:
```graphql
query CustomerDiscountCodes($customerId: ID!) {
  customer(id: $customerId) {
    # No direct field for this — need to search discounts by customer
  }
}
```

Actually, Shopify doesn't have a direct "discounts for customer" query. The approach:

**Option A**: Search `discountNodes` and filter by customer selection — expensive, paginated, slow.

**Option B**: On the customer detail/loyalty page, query `orders` for this customer and extract all discount codes used. This shows historical usage without needing to query every discount.

```graphql
query CustomerOrderDiscounts($customerId: ID!, $first: Int!) {
  customer(id: $customerId) {
    orders(first: $first) {
      nodes {
        discountCodes
        name
        createdAt
      }
    }
  }
}
```

**Recommendation**: Use Option B — query orders and extract discount codes. Show as "Discount History" section on the loyalty detail page. We already have orders in our DB with discount data, so we can do this from our own database:

```sql
SELECT DISTINCT jsonb_array_elements_text(
  CASE WHEN tags LIKE '%discount%' THEN tags END
) FROM orders WHERE customer_id = ? AND ...
```

Actually simpler: Shopify order payload includes `discount_codes` array. We can check if we store that, or query from Shopify. Since we have 125K orders in our DB, checking there first is fastest.

### Implementation:
- On the loyalty detail page, query our `orders` table for this customer
- Extract any discount codes from order data (if stored)
- Display as "Discount History" — code, amount, order number, date
- If we don't store discount codes on orders, add a one-time backfill or start capturing them on the webhook

---

## File Changes

| File | Change |
|------|--------|
| `src/app/dashboard/customers/[id]/page.tsx` | Move loyalty card higher (after stats, before subscriptions). Make header clickable → loyalty detail. |
| `src/app/dashboard/loyalty/[memberId]/page.tsx` | New: loyalty detail with points, redemption tool, unused coupons, history, transactions |
| `src/app/api/loyalty/members/[memberId]/route.ts` | New: member detail + transactions + redemptions API |
| `src/app/dashboard/loyalty/page.tsx` | Make member rows clickable → loyalty detail |

## Implementation Order

1. Create loyalty detail page with all sections
2. Create member detail API endpoint
3. Move loyalty card higher on customer page + make clickable
4. Make loyalty list rows clickable
5. Add discount history from orders data
