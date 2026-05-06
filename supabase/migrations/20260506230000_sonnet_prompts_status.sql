-- Add status column to sonnet_prompts so admins can review AI-proposed
-- rules before they affect the conversation AI. Mirrors grader_prompts.
--
-- Existing rows default to 'approved' so the conversation AI keeps
-- behaving identically.

alter table sonnet_prompts
  add column if not exists status text not null default 'approved'
    check (status in ('proposed', 'approved', 'rejected', 'archived')),
  add column if not exists derived_from_ticket_id uuid references tickets(id) on delete set null,
  add column if not exists proposed_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid;

create index if not exists sonnet_prompts_workspace_status_idx
  on sonnet_prompts (workspace_id, status);
