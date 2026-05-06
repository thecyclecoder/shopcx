-- Per-ticket AI analysis system. Replaces the nightly batch with a
-- cron-driven scan that grades closed tickets in 30-min cycles.
-- Each row covers a specific message window so re-grades after reopens
-- only consider new activity.
--
-- See: discussion 2026-05-06 with Dylan re: real-time analysis +
-- correction-based learning loop.

create table if not exists ticket_analyses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  ticket_id uuid not null references tickets(id) on delete cascade,

  -- Window analyzed
  window_start timestamptz not null,
  window_end timestamptz not null,

  -- Auto score from grader
  score integer check (score between 1 and 10),
  issues jsonb default '[]'::jsonb,           -- [{type, description}, ...]
  action_items jsonb default '[]'::jsonb,
  summary text,

  -- Admin override (the calibration signal)
  admin_score integer check (admin_score between 1 and 10),
  admin_score_reason text,
  admin_corrected_at timestamptz,
  admin_corrected_by uuid,

  -- Cost / model accounting
  model text,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cost_cents numeric(10, 4) default 0,

  -- Trigger / context
  trigger text,                               -- 'auto_close', 'manual_close', 'reopen_close', 'manual'
  ai_message_count integer default 0,         -- AI messages in this window

  created_at timestamptz default now()
);

create index if not exists ticket_analyses_ticket_idx
  on ticket_analyses (ticket_id, window_end desc);

create index if not exists ticket_analyses_workspace_created_idx
  on ticket_analyses (workspace_id, created_at desc);

-- Grader prompts — calibration rules applied to the grader (Sonnet that
-- evaluates Sonnet conversations). Same shape as sonnet_prompts but a
-- separate table because the audience is different (the grader, not
-- the conversation AI).
--
-- Each rule is born from an admin override on a ticket_analyses row
-- (derived_from_ticket_id), proposed by Opus, reviewed by admin.
-- Auto-applied rules are forbidden — admin always approves.

create table if not exists grader_prompts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,

  title text not null,
  content text not null,

  -- 'proposed' (waiting for admin review) | 'approved' (in grader prompt) | 'rejected'
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'archived')),

  -- Provenance
  derived_from_ticket_id uuid references tickets(id) on delete set null,
  derived_from_analysis_id uuid references ticket_analyses(id) on delete set null,
  proposed_at timestamptz default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,

  sort_order integer default 100,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists grader_prompts_workspace_status_idx
  on grader_prompts (workspace_id, status);

-- last_analyzed_at on tickets for fast cron lookup
alter table tickets
  add column if not exists last_analyzed_at timestamptz;

create index if not exists tickets_last_analyzed_idx
  on tickets (workspace_id, status, last_analyzed_at)
  where status = 'closed';

-- RLS
alter table ticket_analyses enable row level security;
alter table grader_prompts enable row level security;

create policy ticket_analyses_select on ticket_analyses for select
  using (workspace_id in (select workspace_id from workspace_members where user_id = auth.uid()));
create policy ticket_analyses_admin on ticket_analyses for all to service_role using (true);

create policy grader_prompts_select on grader_prompts for select
  using (workspace_id in (select workspace_id from workspace_members where user_id = auth.uid()));
create policy grader_prompts_admin on grader_prompts for all to service_role using (true);
