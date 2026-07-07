-- docs/brain/specs/assisted-purchase-playbook.md Phase 2 — seed the
-- assisted-purchase playbook + its DB-driven steps.
--
-- Phase 1 shipped an unconditional vaulted-PM guard on the direct
-- create_order / create_subscription action handlers (fail-closed
-- deterministic safety net). Phase 2 adds a DB-driven playbook that
-- SEQUENCES the same intent:
--   step 0  check_vaulted_pm    — the branching gate: has vaulted PM?
--                                 → advance; else launch
--                                 add_payment_method + park; on
--                                 completion resume + advance.
--   step 1  create_order OR     — the terminal effector; dispatches via
--          create_subscription   the SAME directActionHandlers registry
--                                 the direct path uses (one effector,
--                                 two entry paths).
--
-- Two playbooks — one per create action — because the terminal step's
-- type is the concrete action (removing/reordering a row changes
-- behavior, per the spec's DB-driven verification).

-- ── 1. Extend the playbook_steps.type CHECK constraint ─────────────────
-- Additive: retain every existing type so live playbooks don't fail
-- validation; add check_vaulted_pm + create_order + create_subscription.
ALTER TABLE playbook_steps DROP CONSTRAINT IF EXISTS playbook_steps_type_check;
ALTER TABLE playbook_steps ADD CONSTRAINT playbook_steps_type_check CHECK (
  type IN (
    'identify_order', 'identify_subscription', 'check_other_subscriptions',
    'apply_policy', 'offer_exception', 'initiate_return', 'cancel_subscription',
    'issue_store_credit', 'stand_firm', 'explain', 'custom',
    'clarify_issue', 'check_tracking', 'classify_issue', 'select_missing_items',
    'confirm_shipping_address', 'create_replacement', 'adjust_subscription',
    'check_vaulted_pm', 'create_order', 'create_subscription'
  )
);

-- ── 2. Seed the two assisted-purchase playbooks per workspace ──────────
-- Fanned across every workspace via SELECT FROM workspaces so a new
-- tenant onboarded post-merge gets the playbook too (mirrors the
-- add_payment_method journey seed).

-- 2a. Assisted Order Purchase — terminal step is create_order.
INSERT INTO playbooks (
  workspace_id, name, description, trigger_intents, trigger_patterns,
  priority, is_active, exception_limit, stand_firm_max,
  stand_firm_before_exceptions, stand_firm_between_tiers,
  exception_disqualifiers, disqualifier_behavior
)
SELECT
  w.id,
  'Assisted Order Purchase',
  'Assisted-purchase flow for a one-time order: gates create_order behind a chargeable vaulted PM, launching add_payment_method + parking when none exists.',
  ARRAY['create_order', 'assisted_purchase_order', 'buy', 'reorder'],
  ARRAY[]::text[],
  40, true, 0, 0, 0, 0,
  '[]'::jsonb, 'silent'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM playbooks p
  WHERE p.workspace_id = w.id AND p.name = 'Assisted Order Purchase'
);

-- Step 0 — check_vaulted_pm gate.
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'check_vaulted_pm', 0, 'Check Vaulted Payment Method', '{}'::jsonb
FROM playbooks p
WHERE p.name = 'Assisted Order Purchase'
  AND NOT EXISTS (
    SELECT 1 FROM playbook_steps s
    WHERE s.playbook_id = p.id AND s.type = 'check_vaulted_pm'
  );

-- Step 1 — create_order terminal step. `config.vendor` is the default
-- vendor (overridable via ctx.assisted_purchase_params.vendor at
-- runtime); Phase 3 wires the orchestrator to populate the rest of the
-- params (line_items, address, etc.) into ctx.assisted_purchase_params.
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'create_order', 1, 'Create Order on Vaulted PM',
       '{"vendor": "internal"}'::jsonb
FROM playbooks p
WHERE p.name = 'Assisted Order Purchase'
  AND NOT EXISTS (
    SELECT 1 FROM playbook_steps s
    WHERE s.playbook_id = p.id AND s.type = 'create_order'
  );

-- 2b. Assisted Subscription Purchase — terminal step is create_subscription.
INSERT INTO playbooks (
  workspace_id, name, description, trigger_intents, trigger_patterns,
  priority, is_active, exception_limit, stand_firm_max,
  stand_firm_before_exceptions, stand_firm_between_tiers,
  exception_disqualifiers, disqualifier_behavior
)
SELECT
  w.id,
  'Assisted Subscription Purchase',
  'Assisted-purchase flow for a new subscription: gates create_subscription behind a chargeable vaulted PM, launching add_payment_method + parking when none exists.',
  ARRAY['create_subscription', 'assisted_purchase_subscription', 'add_subscription', 'subscribe'],
  ARRAY[]::text[],
  40, true, 0, 0, 0, 0,
  '[]'::jsonb, 'silent'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM playbooks p
  WHERE p.workspace_id = w.id AND p.name = 'Assisted Subscription Purchase'
);

-- Step 0 — check_vaulted_pm gate.
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'check_vaulted_pm', 0, 'Check Vaulted Payment Method', '{}'::jsonb
FROM playbooks p
WHERE p.name = 'Assisted Subscription Purchase'
  AND NOT EXISTS (
    SELECT 1 FROM playbook_steps s
    WHERE s.playbook_id = p.id AND s.type = 'check_vaulted_pm'
  );

-- Step 1 — create_subscription terminal step.
INSERT INTO playbook_steps (workspace_id, playbook_id, type, step_order, name, config)
SELECT p.workspace_id, p.id, 'create_subscription', 1, 'Create Subscription on Vaulted PM',
       '{"vendor": "internal"}'::jsonb
FROM playbooks p
WHERE p.name = 'Assisted Subscription Purchase'
  AND NOT EXISTS (
    SELECT 1 FROM playbook_steps s
    WHERE s.playbook_id = p.id AND s.type = 'create_subscription'
  );
