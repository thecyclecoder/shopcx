-- Prompt Learning — auto-review of proposed sonnet_prompts.
--
-- Phase 1 of the spec at docs/brain/specs/prompt-learning.md.
-- Adds the auto_decision columns to sonnet_prompts and creates the
-- sonnet_prompt_decisions append-only audit log + workspace enable flag
-- + daily-cap setting.

-- ── 1. workspaces flags
alter table workspaces
  add column if not exists sonnet_auto_review_enabled boolean not null default false,
  add column if not exists sonnet_auto_review_daily_cap int not null default 10;

-- ── 2. sonnet_prompts columns
alter table sonnet_prompts
  add column if not exists auto_decision text
    check (auto_decision in ('accept', 'reject', 'merge', 'supersede', 'human_review', 'revise')),
  add column if not exists auto_decision_at timestamptz,
  add column if not exists auto_decision_reason text,
  add column if not exists auto_decision_model text,
  add column if not exists auto_decision_confidence real,
  add column if not exists superseded_by_id uuid references sonnet_prompts(id) on delete set null,
  add column if not exists merged_into_id uuid references sonnet_prompts(id) on delete set null,
  add column if not exists source_pattern_id uuid references daily_analysis_reports(id) on delete set null;

-- Index for the cron's hot path: "give me every proposed prompt with no
-- auto_decision yet for workspaces that have the feature enabled."
create index if not exists sonnet_prompts_pending_auto_review_idx
  on sonnet_prompts (workspace_id, status)
  where status = 'proposed' and auto_decision is null;

-- ── 3. sonnet_prompt_decisions — append-only audit log
create table if not exists sonnet_prompt_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  sonnet_prompt_id uuid not null references sonnet_prompts(id) on delete cascade,

  -- The decision itself
  decision text not null
    check (decision in ('accept', 'reject', 'merge', 'supersede', 'human_review', 'revise')),
  confidence real not null,
  reasoning text not null,
  references_json jsonb not null default '[]'::jsonb,  -- [{type, id, why}]
  suggested_revisions text,
  merge_target_id uuid references sonnet_prompts(id) on delete set null,
  supersede_target_id uuid references sonnet_prompts(id) on delete set null,

  -- Inputs the model saw (for replay/debug)
  input_proposal jsonb not null,            -- the proposed prompt as the model received it
  input_similar_prompts jsonb not null,      -- existing prompts considered
  input_policies jsonb not null,             -- policies considered
  input_source_tickets jsonb not null,        -- contributing tickets
  input_voice_doc_hashes jsonb,              -- {customer_voice: sha, operational: sha, ui: sha}

  -- Model accounting
  model text not null,
  input_tokens int,
  output_tokens int,
  cost_usd_cents int,
  latency_ms int,

  -- Source of the decision: 'cron' | 'manual_override' | 'safety_test'
  source text not null default 'cron'
    check (source in ('cron', 'manual_override', 'safety_test')),
  performed_by uuid,                          -- user_id when source='manual_override'

  created_at timestamptz not null default now()
);

create index if not exists sonnet_prompt_decisions_ws_created_idx
  on sonnet_prompt_decisions (workspace_id, created_at desc);

create index if not exists sonnet_prompt_decisions_prompt_idx
  on sonnet_prompt_decisions (sonnet_prompt_id);

-- Used by the daily-cap query: count accepts per workspace per day.
create index if not exists sonnet_prompt_decisions_ws_decision_created_idx
  on sonnet_prompt_decisions (workspace_id, decision, created_at desc)
  where decision = 'accept';

alter table sonnet_prompt_decisions enable row level security;

create policy "sonnet_prompt_decisions_select" on sonnet_prompt_decisions
  for select using (
    workspace_id in (
      select workspace_id from workspace_members where user_id = auth.uid()
    )
  );

create policy "sonnet_prompt_decisions_service" on sonnet_prompt_decisions
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table sonnet_prompt_decisions is
  'Append-only audit log of auto-review decisions on sonnet_prompts. One row per Opus decision (cron, override, or safety test).';

comment on column sonnet_prompts.auto_decision is
  'Auto-review decision: accept/reject/merge/supersede/human_review/revise. NULL means not yet reviewed.';
comment on column sonnet_prompts.superseded_by_id is
  'When this prompt was superseded by a better one, the new prompt id. The old row stays in place with enabled=false; supersede is reversible.';
comment on column sonnet_prompts.merged_into_id is
  'When this prompt was merged into another, the canonical prompt id.';
