-- Prune agent_todos.action_type to the four types the box routine still produces
-- (box-escalation-triage P4 — "no dead code"). The retired Anthropic-cloud routine produced
-- system-level todos (sonnet_prompt_new/edit, grader_prompt_edit, escalation_rule_fix,
-- brain_doc_edit, code_change); those outputs are now PROPOSED sonnet_prompts or committed spec
-- files, never agent_todos. Going forward only customer_reply | customer_action | ticket_close |
-- ticket_analysis_rescore are valid.
--
-- We tighten the CHECK with NOT VALID: new inserts/updates are constrained to the four kept types,
-- but historical executed rows carrying a now-retired action_type are NOT scanned/rejected (they are
-- the immutable audit trail — deleting or rewriting them would lose history). The box can never
-- insert a pruned type again; the past stays intact.
-- See docs/brain/specs/box-escalation-triage.md + docs/brain/tables/agent_todos.md.

alter table public.agent_todos drop constraint if exists agent_todos_action_type_check;

alter table public.agent_todos
  add constraint agent_todos_action_type_check
  check (action_type in (
    'customer_reply',
    'customer_action',
    'ticket_close',
    'ticket_analysis_rescore'
  )) not valid;
