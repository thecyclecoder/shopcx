-- approval_decisions — the supervisable-autonomy AUDIT LEDGER: one row per decision a director (or the
-- CEO) makes on a routed Approval Request (see docs/brain/specs/platform-director-agent.md +
-- docs/brain/goals/devops-director.md). The north-star contract made auditable: every AUTONOMOUS
-- auto-approval the Platform/DevOps Director makes writes a row here with its reasoning, so the CEO can
-- read after the fact WHAT the proxy decided and WHY (CEO → Director → tool). An escalation writes a
-- row too (decision='escalated') — the director punted the high-stakes call UP rather than acting.
--
-- The FIRST concrete writer is the Platform/DevOps Director (platform-director-agent.md, M4): for each
-- Platform-routed approval it confirms sound + low-risk + within the leash, it APPROVES (the existing
-- approve path flips the job queued_resume) and logs decision='approved', decided_by='director',
-- autonomous=true. A request it cannot confirm — or one outside the leash (destructive/irreversible,
-- goal-modify, new goal, a repeatedly-failing build) — it ESCALATES to the CEO and logs
-- decision='escalated'. (The approval-routing-engine M2 inbox is the surface; this is the ledger.)
--
-- `agent_job_id` is the gated agent_jobs row the decision acted on; `pending_action_id` the specific
-- pending action when a job carries more than one. `raised_by_function` = the function that owns the
-- raising tool; `routed_to_function` = where the approval was routed (the deciding role, or 'ceo').
-- `reasoning` is the plain-text "why" the CEO reads back. `autonomous` = the decision was made by a
-- live+autonomous director with no human in the loop (vs a human/CEO tap).
--
-- Workspace-scoped (mirrors director_activity / director_messages). RLS: any authenticated user reads
-- (the history surface is owner-gated above the DB); service role does all writes.

create table if not exists public.approval_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the gated agent_jobs row this decision acted on (the approval's source of truth).
  agent_job_id uuid references public.agent_jobs(id) on delete set null,
  -- the specific pending action decided, when the job carries more than one (null = the whole job).
  pending_action_id text,
  -- the function that owns the raising tool (e.g. 'platform'); 'ceo' when the kind is unmapped.
  raised_by_function text not null default 'ceo',
  -- where the approval was routed — the deciding role's function slug, or 'ceo' (the fail-safe root).
  routed_to_function text not null default 'ceo',
  -- who actually decided. Open vocabulary (no CHECK): 'director' (autonomous) ｜ 'ceo' ｜ 'human'.
  decided_by text not null,
  -- the call. Open vocabulary: 'approved' ｜ 'declined' ｜ 'escalated' (punted UP to the CEO).
  decision text not null,
  -- the plain-text "why" — the reasoning the CEO audits after the fact.
  reasoning text not null default '',
  -- the decision was made by a live+autonomous director with no human in the loop.
  autonomous boolean not null default false,
  -- structured per-decision context: { kind?, spec_slug?, leash?, signature?, ... }.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- The history read: a workspace's decisions newest-first (the CEO Decision-history surface).
create index if not exists approval_decisions_ws_created_idx
  on public.approval_decisions (workspace_id, created_at desc);
-- Per-job audit slice (every decision touching one gated job).
create index if not exists approval_decisions_job_idx
  on public.approval_decisions (agent_job_id);
-- Per-deciding-role slice (e.g. everything the platform director auto-approved).
create index if not exists approval_decisions_routed_idx
  on public.approval_decisions (routed_to_function, created_at desc);

alter table public.approval_decisions enable row level security;
drop policy if exists approval_decisions_select on public.approval_decisions;
create policy approval_decisions_select on public.approval_decisions
  for select to authenticated using (auth.uid() is not null);
drop policy if exists approval_decisions_service on public.approval_decisions;
create policy approval_decisions_service on public.approval_decisions
  for all to service_role using (true) with check (true);
