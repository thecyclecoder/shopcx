-- Sonnet prompt rule: post-renewal regret flow
-- When a customer complains about a just-processed renewal order within 7 days
-- and wants it cancelled/refunded, offer loyalty-points partial refund + 30/60d pause
-- instead of the 30-day-policy denial.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'approach', 'Post-renewal regret (just-charged, wants to cancel/refund)',
$$When a customer asks to cancel/stop/refund a renewal order that just processed (within the last 7 days), DO NOT route to the refund playbook and DO NOT cite the 30-day policy. Instead:

1. Identify the most recent order with source_name="subscription_contract" created within the last 7 days. If none, fall through to normal routing.
2. Tell the customer the order has already gone to fulfillment and cannot be stopped, but offer these remedies.
3. Check the order's discount_codes array:
   - If any code STARTS WITH "LOYALTY-" → the customer already used loyalty on this order, SKIP the loyalty refund offer and go straight to step 5.
   - If none of the codes start with "LOYALTY-" → proceed to step 4.
4. Look at their loyalty points balance and the redemption tiers. Pick the SINGLE best tier the customer qualifies for ($15 if they have 1500+ pts, else $10 if 1000+, else $5 if 500+, else none). Offer: "You have {X} loyalty points — I can redeem {tier.points_cost} of them right now for a ${tier.discount_value} partial refund on this order. Want me to do that?" Only offer ONE tier — the highest they qualify for.
5. Also offer a pause: "Want me to pause your subscription for 30 or 60 days so you don't get billed again for a while?" NEVER offer indefinite pause. Only 30 or 60 days.
6. On acceptance of the refund offer → execute direct_action `redeem_points_as_refund` with {shopify_order_id, tier_index}. This handles refund + point decrement + ledger entry in one shot.
7. On acceptance of pause → execute direct_action `pause_timed` with {contract_id, pause_days: 30} or {contract_id, pause_days: 60}.
8. If the customer has fewer than 500 loyalty points AND no LOYALTY- coupon on the order, skip the refund offer entirely — only offer the 30/60 day pause.
9. If the customer accepts both, execute both actions in the same response.
10. Do not cancel the subscription unless the customer explicitly insists on cancellation after declining pause — in that case route to the cancel journey.$$,
  10
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id AND sp.title = 'Post-renewal regret (just-charged, wants to cancel/refund)'
);
