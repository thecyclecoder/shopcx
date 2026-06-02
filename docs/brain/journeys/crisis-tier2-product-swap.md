# Crisis Tier 2 — Product Swap

Second tier. Fires automatically `tier_wait_days` after a Tier 1 rejection. Bigger ask: try a different product entirely, with a discount coupon as the carrot.

DB row in [[../tables/journey_definitions]]: `slug='crisis-tier2-product-swap'`, `journey_type='custom'`, `trigger_intent='crisis_tier2'`.

See [[../lifecycles/crisis-campaign]].

## Trigger

- **trigger_intent**: `crisis_tier2` (system, not customer-initiated)
- **match_patterns**: empty
- **priority**: 10

## Channel

`email` only.

## Steps

1. **Pick a product** — single-choice from `crisis_events.available_product_swaps` (different SKU entirely, e.g. drink mix instead of tabs) + "Not interested in changing products."
2. **Quantity** (if a product was picked) — 1 to 4.

## On submit

If they picked a product:

1. Swap the line item via [[../integrations/appstle]] line-item mutation (remove old variant, add the new one with the chosen qty).
2. Apply `crisis_events.tier2_coupon_code` via [[../integrations/appstle]] `subscription-contracts-apply-discount`. Default 20%.
3. Update [[../tables/crisis_customer_actions]]: `tier2_response='accepted_swap'`, `tier2_swapped_to={variantId, title, qty}`, `tier2_coupon_applied=true`.

If they reject:

- `tier2_response='rejected'`. [[crisis-tier3-pause-remove]] fires after `tier_wait_days`.

## Pricing

The 20% coupon applies to the new product. Original `preserved_base_price_cents` rule from Tier 1 doesn't carry over — Tier 2 is a fresh subscription configuration with a discount, not a like-for-like swap.

## Outcomes

Tracked on [[../tables/crisis_customer_actions]].`tier2_response` and `.tier2_coupon_applied`. No `jo:*` tags.

## Step ticket status

`open`.

## Files

| File | Purpose |
|---|---|
| `src/lib/crisis-journey-builder.ts` | Builder |
| `src/lib/inngest/crisis-campaign.ts` | Tier advancement cron |
| `src/lib/subscription-items.ts` | Line-item swap |
| `src/lib/subscription-add-items.ts` | Line-item add |
| `src/lib/appstle.ts` | Apply discount + line ops |
| `src/lib/appstle-discount.ts` | applyDiscountWithReplace |
| `src/lib/email.ts` | Tier 2 email template |
| `src/app/api/journey/[token]/complete/route.ts` | Execute swap + apply coupon |

## Related

[[../lifecycles/crisis-campaign]] · [[crisis-tier1-flavor-swap]] · [[crisis-tier3-pause-remove]] · [[../tables/crisis_events]] · [[../tables/crisis_customer_actions]] · [[../tables/coupon_mappings]] · [[../integrations/appstle]] · [[../inngest/crisis-campaign]]
