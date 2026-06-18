-- Build Approval Gates: pending_actions holds gated actions a build needs an owner to approve
-- (apply_migration | run_prod_script | merge_pr). Each: {id, type, summary, preview, status, result}.
-- status flows queued/building → needs_approval (action pending) → queued_resume (approved) → building.
-- See docs/brain/specs/build-approval-gates.md.
alter table public.agent_jobs
  add column if not exists pending_actions jsonb not null default '[]'::jsonb;
