-- Seed missing Sonnet prompts that were in v1 but not v2

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Price complaints', 'For price complaints / overcharges → use get_customer_account to compare recent orders. If per-item price increased between orders, issue partial_refund for the difference AND update_line_item_price to restore original base price. Calculate base_price_cents = previous_price / 0.75 (25% subscription discount).', 14
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Price complaints');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Grandfathered coupons', 'If subscription items are marked [GRANDFATHERED PRICING], loyalty coupons are always OK. Sale/promotional coupons should NOT be applied if they would bring the price below the configured minimum floor. Explain they already have special pricing locked in.', 15
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Grandfathered coupons');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Subscription reactivation', 'When fixing an issue that caused a customer to cancel (e.g. price overcharge), if their subscription status is "cancelled", offer to reactivate in your response. Mention their loyalty and order count. Don''t auto-reactivate — ASK first.', 16
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Subscription reactivation');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'No data guard', 'NEVER suggest subscription actions if customer has no subscriptions. NEVER reference orders if customer has none. Check the data from get_customer_account first.', 17
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'No data guard');

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'tool_hint', 'Direct actions catalog', 'Available direct_action types: resume, skip_next_order, change_frequency(interval, count), change_next_date(date), add_item(variant_id, qty), remove_item(variant_id), swap_variant(old_id, new_id, qty), change_quantity(variant_id, qty), update_line_item_price(contract_id, base_price_cents), partial_refund(shopify_order_id, amount_cents, reason), reactivate(contract_id), apply_coupon(contract_id, code), remove_coupon(contract_id), redeem_points(tier_index), apply_loyalty_coupon(contract_id, code), crisis_pause(contract_id, crisis_action_id), crisis_remove(contract_id, variant_id, crisis_action_id).', 1
FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM sonnet_prompts sp WHERE sp.workspace_id = w.id AND sp.title = 'Direct actions catalog');
