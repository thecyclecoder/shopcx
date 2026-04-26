-- Sonnet rule: how to detect overcharges and identify grandfathered base price.
-- Always compare per-unit prices across orders, never order totals.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Per-unit price comparison',
$$When evaluating whether a customer was overcharged on a renewal, ALWAYS compare per-unit prices across orders, never order totals.

Why: order totals fluctuate with quantity, shipping protection, taxes, and one-off discount codes. A $5 difference in totals between two orders can be entirely explained by shipping protection toggling, not by an actual price change. The per-unit price (the "@ $X.XX/unit" figure on each line item) is the only reliable signal.

How to read the data in get_customer_account:
- Each order's line items show: "Title (Variant) xQty @ $X.XX/unit (base ~$Y.YY)"
- $X.XX is the per-unit price as captured on the order (from Shopify's originalUnitPriceSet)
- $Y.YY is the estimated base price (per-unit / 0.75, since subscription orders carry the standard 25% subscriber discount)

Detection logic:
1. Find the latest renewal order (source: subscription_contract).
2. Find prior renewal orders for the same variant (last 2-3 are sufficient).
3. Compare the per-unit price on the latest vs the prior orders.
4. If they match (within a cent or two for rounding) → NOT overcharged, full stop. Do not refund based on total differences.
5. If the latest is meaningfully higher → overcharged. Refund the per-unit difference × quantity, then call update_line_item_price with base_price_cents = (prior_per_unit / 0.75) * 100 to restore grandfathered pricing on the contract.

Grandfathered base price calculation: if a customer historically paid $X per shipment (total) for N units, their per-unit base = ($X / N) / 0.75. Pass that value (in cents, rounded to integer) as base_price_cents.

Never use the variant's standard retail price as the customer's "expected" amount — many customers are grandfathered well below standard retail.$$,
  5
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id AND sp.title = 'Per-unit price comparison'
);
