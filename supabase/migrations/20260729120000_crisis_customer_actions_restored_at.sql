-- End-of-crisis restore: mark a crisis_customer_actions row as RESTORED.
--
-- The crisis system had no end-of-crisis action for the swapped cohort. The restore is run by
-- scripts/crisis-restore.ts, which must be idempotent and resumable across batches — a customer
-- whose subscription was already put back must never be swapped, resumed or re-added twice.
--
-- `restored_at` is that idempotency key AND the archive marker the CEO asked for: a stamped row is
-- "done with this crisis" and is skipped by every subsequent pass. We stamp rather than DELETE so
-- the campaign's outcome history (tier responses, segment, original_item, preserved price) survives
-- for the retrospective — deleting would destroy the only record of what we did to 949 subscriptions.
--
-- `restore_action` records WHICH branch ran, so a partial run is auditable and a bad batch can be
-- identified precisely rather than by inference.

alter table public.crisis_customer_actions
  add column if not exists restored_at timestamptz,
  add column if not exists restore_action text;

comment on column public.crisis_customer_actions.restored_at is
  'When the end-of-crisis restore put this subscription back (swap-back / resume / re-add). NULL = not yet restored. Set by scripts/crisis-restore.ts; doubles as the idempotency key so a re-run skips the row.';

comment on column public.crisis_customer_actions.restore_action is
  'Which restore branch ran: swap_back | swap_then_resume | resume_only | readd | skipped_<reason>. Audit trail for a partial or batched run.';

-- Partial index: every restore pass scans for un-restored rows in one crisis.
create index if not exists crisis_customer_actions_pending_restore_idx
  on public.crisis_customer_actions (crisis_id)
  where restored_at is null;
