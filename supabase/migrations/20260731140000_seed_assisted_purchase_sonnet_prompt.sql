-- docs/brain/specs/assisted-purchase-playbook.md Phase 3 — orchestrator
-- trigger wiring. Phase 2 shipped the DB-driven playbook (playbooks +
-- playbook_steps rows with trigger_intents like 'buy', 'reorder',
-- 'create_order', 'create_subscription', 'subscribe'), so
-- matchPlaybookScored already picks the assisted-purchase playbook
-- from a purchase-intent classification. This migration adds the
-- orchestrator/tooling implication: a sonnet_prompts row that
-- instructs Sonnet to PREFER the playbook over a bare create_order /
-- create_subscription direct_action so the vaulted-PM gate always
-- runs — no bare-create smuggle path when the classifier has already
-- returned a purchase intent.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order)
SELECT w.id, 'rule', 'Assisted purchase (prefer playbook over bare create)',
$$For ANY purchase intent (customer wants to place a new order, add a subscription, buy more, reorder, subscribe) → route to the assisted-purchase playbook ('Assisted Order Purchase' for one-time orders, 'Assisted Subscription Purchase' for new subs). Do NOT emit a bare create_order or create_subscription direct_action for a purchase intent — the playbook wraps the create in a check_vaulted_pm gate that launches the add_payment_method journey when the customer has no chargeable card on file. The direct create_order / create_subscription handlers already fail-closed on a missing PM (Phase 1 of docs/brain/specs/assisted-purchase-playbook.md), but the playbook is the observable, DB-driven path that sequences the customer through add_payment_method → resume → create in one flow. Rule of thumb: intent classifier returned buy / reorder / add_subscription / create_order / create_subscription → playbook. Only bypass the playbook when the customer is completing an already-launched purchase (a resume signal from the playbook itself), never on the initial purchase intent.$$,
  31
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id
    AND sp.title = 'Assisted purchase (prefer playbook over bare create)'
);
