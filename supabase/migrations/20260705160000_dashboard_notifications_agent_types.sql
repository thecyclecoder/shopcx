-- director-escalations-must-surface-to-ceo (the real root cause): the dashboard_notifications type CHECK
-- was never extended when the agents hub / approval-routing engine landed, so EVERY agent-inbox insert
-- (agent_approval_request / agent_message / agent_daily_summary) violated the constraint and was silently
-- swallowed — zero notifications, nothing reached the CEO inbox (and the box's P2 backstop would re-emit
-- into the same rejection). Add the three agent inbox types (AGENT_INBOX_TYPES in src/lib/agents/inbox.ts)
-- to the CHECK. Idempotent (drop + re-add). Applied to prod 2026-06-24.
alter table public.dashboard_notifications drop constraint if exists dashboard_notifications_type_check;
alter table public.dashboard_notifications add constraint dashboard_notifications_type_check
  check (type = any (array[
    'macro_suggestion', 'pattern_review', 'knowledge_gap', 'system', 'fraud_alert',
    'chargeback_alert', 'duplicate_order_alert', 'escalation_gap',
    'agent_approval_request', 'agent_message', 'agent_daily_summary'
  ]));
