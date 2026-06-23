-- approval_decisions — the supervisable-autonomy ledger (approval-routing-engine spec, Phase 3).
--
-- One row per ROUTED decision on an approval. The North star (operational-rules § supervisable
-- autonomy): an autonomous tool answers to an objective-owner, never a silent proxy. When a future
-- live+autonomous director auto-approves one of its tools' requests, the CEO must always be able to
-- audit WHAT the proxy decided and WHY — in history, never in the queue. This table is that ledger.
--
-- A decision is made either by the CEO seat (decided_by='ceo' — the request routed to the fail-safe
-- root and the owner decided it), by a HUMAN overriding a director's queue (decided_by='human' — a
-- person decided a director-routed request manually), or AUTONOMOUSLY by a live+autonomous director
-- (decided_by='director', autonomous=true — the only path that sets autonomous). The invariant: NO
-- auto-approval without a row here capturing the reasoning. The flag enables *who decides*, never
-- *whether it's recorded*.
--
-- raised_by_function = the org-chart function that owns the raising tool (resolveApprover's input);
-- routed_to_function = where it routed (first live+autonomous ancestor, else 'ceo'). decision ∈
-- approved｜declined｜escalated (escalated = routed up rather than decided here). pending_action_id is
-- the string id within agent_jobs.pending_actions (NOT a uuid). reasoning is the human notes or the
-- director's stated rationale.
--
-- Workspace-scoped (mirrors dashboard_notifications / director_messages — the decision belongs to the
-- workspace whose agent_jobs raised it). RLS: any authenticated user reads (the history API + Agents
-- hub are owner-gated above the DB); service role does all writes (the approve path + future director).

create table if not exists public.approval_decisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the agent_jobs row this decision gates (null only for a non-job decision source).
  agent_job_id uuid references public.agent_jobs(id) on delete set null,
  -- the string id of the decided action within agent_jobs.pending_actions (NOT a uuid).
  pending_action_id text,
  -- the org-chart function that owns the raising tool (resolveApprover's input; 'ceo' when unmapped).
  raised_by_function text not null default 'ceo',
  -- where the approval routed: first live+autonomous ancestor, else 'ceo' (the fail-safe root).
  routed_to_function text not null default 'ceo',
  -- who actually decided: the CEO seat, an autonomous director, or a human override of a director queue.
  decided_by text not null check (decided_by in ('ceo', 'director', 'human')),
  -- the terminal decision. escalated = routed up rather than decided at this seat.
  decision text not null check (decision in ('approved', 'declined', 'escalated')),
  -- the human notes / the director's stated rationale — the auditable "why".
  reasoning text,
  -- true only for an autonomous director auto-approval (decided_by='director'). The supervisable bit.
  autonomous boolean not null default false,
  created_at timestamptz not null default now()
);

-- The history read: a workspace's decisions newest-first (the CEO Decision-history view).
create index if not exists approval_decisions_ws_created_idx
  on public.approval_decisions (workspace_id, created_at desc);
-- A director's own decisions (the routed-inbox history view filters by the function it routed to).
create index if not exists approval_decisions_routed_idx
  on public.approval_decisions (routed_to_function, created_at desc);

alter table public.approval_decisions enable row level security;
drop policy if exists approval_decisions_select on public.approval_decisions;
create policy approval_decisions_select on public.approval_decisions
  for select to authenticated using (auth.uid() is not null);
drop policy if exists approval_decisions_service on public.approval_decisions;
create policy approval_decisions_service on public.approval_decisions
  for all to service_role using (true) with check (true);
