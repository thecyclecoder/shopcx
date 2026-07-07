-- Retire skip_next_order — seed the routing rule that instructs the Sonnet
-- orchestrator to alias skip-next-order intents to change_next_date or bill_now.
-- Spec: docs/brain/specs/retire-skip-next-order-action-type-with-shadow-measured-alias.
--
-- The direct-action type "skip_next_order" ran against a dead upstream endpoint
-- and failed ~88% of the time (goal: guaranteed-ticket-handling, M3 right-cost
-- routing). The orchestrator's system prompt now carries a retirement note; this
-- migration lands the same routing guidance as a sonnet_prompts row so it appears
-- in the RULES section that buildPromptSections renders (single-source-of-truth
-- for Settings → AI → Prompts, and it survives if the hard-coded note is ever
-- moved). Per-workspace, idempotent on `title`.

INSERT INTO sonnet_prompts (workspace_id, category, title, content, sort_order, enabled, status)
SELECT
  w.id,
  'rule',
  'Retire skip_next_order — alias to change_next_date / bill_now',
$$For a customer asking to skip the next order, emit direct_action with type change_next_date and a date one billing cycle out (the next-next-scheduled-date), OR direct_action with type bill_now if they said today/asap. NEVER emit an action of type skip_next_order — that action-type has been retired (dead upstream endpoint, ~88% failure). If neither reading of the customer's intent fits, escalate rather than emit skip_next_order.$$,
  10,
  true,
  'approved'
FROM workspaces w
WHERE NOT EXISTS (
  SELECT 1 FROM sonnet_prompts sp
  WHERE sp.workspace_id = w.id
    AND sp.title = 'Retire skip_next_order — alias to change_next_date / bill_now'
);
