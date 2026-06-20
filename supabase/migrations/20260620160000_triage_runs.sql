-- triage_runs: the per-ticket-per-sweep audit trail of the box-hosted escalation triage routine
-- (box-escalation-triage). Every hour the box sweeps routine-owned escalated tickets with a
-- solver→skeptic→quorum loop; this table records BOTH transcripts + the quorum verdict for every
-- ticket it touched — including the no-quorum cases where NOTHING is materialized (the ticket stays
-- escalated and a human needs to see the disagreement). The materialized outputs themselves live in
-- agent_todos / sonnet_prompts / committed spec files; this is the supervisable-autonomy audit log.
-- See docs/brain/specs/box-escalation-triage.md + docs/brain/tables/triage_runs.md.

create table if not exists public.triage_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the sweep job that produced this run (one agent_jobs kind='triage-escalations' row per sweep)
  job_id uuid references public.agent_jobs(id) on delete set null,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  -- solver taxonomy: customer_fix | escalation_false_positive | analysis_gap | system_gap | no_action
  decision text,
  -- quorum verdict: agree | revise | reject | no_quorum (skeptic never agreed within the bounded re-loop)
  verdict text not null default 'no_quorum',
  -- true when solver + skeptic reached quorum and the worker wrote the outputs
  materialized boolean not null default false,
  -- human-readable summary of what landed (agent_todos group / proposed prompt / committed spec) OR why not
  outcome text,
  -- {proposal, raw, revised?} — the solver's structured proposal(s) + raw transcript tail
  solver_transcript jsonb,
  -- {verdict, critique, concerns, raw} — the skeptic's adversarial re-check
  skeptic_transcript jsonb,
  -- the agent_todos group_id materialized for this ticket (when decision produced todos), else null
  group_id uuid,
  created_at timestamptz not null default now()
);

create index if not exists triage_runs_ticket_idx on public.triage_runs (ticket_id, created_at desc);
create index if not exists triage_runs_ws_idx on public.triage_runs (workspace_id, created_at desc);
create index if not exists triage_runs_job_idx on public.triage_runs (job_id);

alter table public.triage_runs enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'triage_runs' and policyname = 'triage_runs_select') then
    create policy triage_runs_select on public.triage_runs for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'triage_runs' and policyname = 'triage_runs_service') then
    create policy triage_runs_service on public.triage_runs for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
