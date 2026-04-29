-- Sonnet rule: when a customer reports a wrong order/wrong item, check
-- for an active workspace crisis BEFORE routing to the regular returns
-- playbook. If a crisis is active and the customer received the swap
-- variant from auto-swap (or has a sub containing the affected variant),
-- enroll them via the crisis_enroll direct action with auto_readd=true.
--
-- Self-deactivating: when no crisis is active, get_crisis_status reports
-- "No active workspace crises" and the rule's preconditions fail — Sonnet
-- falls through to the normal wrong-item handling. So this stays in place
-- across crises without manual cleanup.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT
  w.id,
  'rule',
  'Wrong item — check active crisis first',
  'WRONG ITEM / WRONG ORDER complaints: BEFORE routing to a return or refund playbook, call get_crisis_status. If an active workspace crisis exists AND (a) the customer''s recent order from get_customer_account contains the swap variant listed under "Customers were auto-swapped to", OR (b) the customer''s subscription contains the affected variant, AND the customer is NOT already enrolled (no per-customer crisis row): use direct_action with type "crisis_enroll" and the customer''s subscription contract_id. The crisis_enroll action sets auto_readd=true so the subscription gets switched back to the original product when the crisis is resolved — you do not need to remember to undo anything. After enrolling, send an apologetic message acknowledging the wrong-item delivery, explain we ran out of their original product and shipped a replacement flavor, and that we''ll automatically send their original flavor back as soon as it''s in stock. If a coupon is listed in the crisis context, offer it as an apology. If NO active workspace crisis exists, ignore this rule entirely and route the wrong-item complaint to the regular return/replacement playbook.',
  5
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id AND sp.title = 'Wrong item — check active crisis first'
);
