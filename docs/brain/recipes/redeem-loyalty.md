# Redeem loyalty points for a coupon

Convert a customer's [[../tables/loyalty_members]].`points_balance` into a Shopify discount code at one of the configured redemption tiers.

## Helpers

```ts
import {
  getLoyaltySettings,
  getOrCreateMember,
  validateRedemption,
  spendPoints,
} from "@/lib/loyalty";
```

**Files:** `src/lib/loyalty.ts`, `src/lib/portal/handlers/loyalty-redeem.ts` (the canonical caller).

## Minimal example

```ts
import { createAdminClient } from "@/lib/supabase/admin";

const admin = createAdminClient();

// 1. Load settings + member
const settings = await getLoyaltySettings(workspaceId);
const member = await getOrCreateMember(admin, workspaceId, customerId, email);

// 2. Pick a tier (e.g. $5 off for 500 points)
const tier = settings.redemption_tiers.find(t => t.points_cost === 500);

// 3. Validate
const ok = validateRedemption(member, tier, settings);
if (!ok.valid) throw new Error(ok.reason);

// 4. Generate the Shopify discount code (the portal handler does this via Shopify GraphQL)
const code = `LOY-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
const discountNodeId = await createShopifyDiscount(workspaceId, code, tier);

// 5. Deduct points + write redemption ledger
await spendPoints(member, tier.points_cost, `Redeemed ${tier.label}`, discountNodeId);
await admin.from("loyalty_redemptions").insert({
  workspace_id: workspaceId,
  member_id: member.id,
  customer_id: customerId,
  shopify_discount_node_id: discountNodeId,
  coupon_code: code,
  points_spent: tier.points_cost,
  label: tier.label,
});
```

The canonical end-to-end implementation is `src/lib/portal/handlers/loyalty-redeem.ts` — read it before reinventing.

## Gotchas

- **Always `spendPoints` AND insert `loyalty_redemptions`.** Skipping the ledger insert breaks the customer's history view.
- **`validateRedemption` checks tier eligibility** (tier-locked customers can only redeem within their tier).
- **Discount code creation** is a separate Shopify GraphQL call — use the portal handler's implementation as the template.
- **Don't issue twice.** If a previous redemption is still un-used, surface that first — see [[../lifecycles/ai-multi-turn]] "check unused coupons first."
- **Internal subs** still need a Shopify discount code — loyalty redemptions go through Shopify regardless.

## Related

[[../libraries/loyalty]] · [[../tables/loyalty_members]] · [[../tables/loyalty_redemptions]] · [[../tables/loyalty_transactions]] · [[apply-loyalty-coupon]]
