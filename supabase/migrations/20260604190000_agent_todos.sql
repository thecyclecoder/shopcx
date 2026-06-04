-- Agent To-Do system — async approval queue for escalated tickets.
--
-- Phase 0 of the spec at docs/brain/specs/agent-todo-system.md.
-- A Claude Code Routine reasons about escalated tickets hourly and writes
-- proposed actions here as todos. Dylan + Zach approve/reject on
-- /dashboard/tickets/todos. Approval triggers execution (customer-facing via
-- the agent-todo-execute Inngest worker; system-level via the Routine).

create table if not exists public.agent_todos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- Where this todo came from
  source text not null default 'ticket'
    check (source in ('ticket', 'csat', 'cron', 'manual')),
  source_ticket_id uuid references public.tickets(id) on delete set null,
  group_id uuid not null,                       -- links N todos from one logical fix

  -- The proposed action
  action_type text not null
    check (action_type in (
      'customer_reply',
      'customer_action',
      'ticket_close',
      'sonnet_prompt_new',
      'sonnet_prompt_edit',
      'ticket_analysis_rescore',
      'grader_prompt_edit',
      'escalation_rule_fix',
      'brain_doc_edit',
      'code_change'
    )),
  payload jsonb not null default '{}'::jsonb,    -- action-specific (reply HTML, mutation params, diff)
  summary text not null,                         -- short label for list view
  context_what_happened text,                    -- plain-English customer-side narrative
  context_what_we_propose text,                  -- plain-English fix narrative
  pre_exec_context jsonb not null default '{}'::jsonb,  -- snapshot for drift detection
  confidence real,
  urgency text not null default 'normal'
    check (urgency in ('urgent', 'normal', 'low')),

  -- Lifecycle
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'executed', 'rejected', 'superseded', 'failed')),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  approval_role text check (approval_role in ('owner', 'admin')),
  executed_at timestamptz,
  execution_result jsonb,
  rejected_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  reject_reason text,
  routine_run_id uuid,                           -- which routine pass proposed this

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- List-view paging: "pending todos for this workspace, newest first."
create index if not exists agent_todos_ws_status_created_idx
  on public.agent_todos (workspace_id, status, created_at desc);

-- Linked-todos block on the ticket / detail page, and the reasoning-pass
-- "does this ticket already have an active group?" check.
create index if not exists agent_todos_source_ticket_idx
  on public.agent_todos (source_ticket_id);

-- Group expansion on list + detail views.
create index if not exists agent_todos_group_idx
  on public.agent_todos (group_id);

alter table public.agent_todos enable row level security;

create policy "agent_todos_select" on public.agent_todos
  for select using (
    workspace_id in (
      select workspace_id from public.workspace_members where user_id = auth.uid()
    )
  );

create policy "agent_todos_service" on public.agent_todos
  for all using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

comment on table public.agent_todos is
  'Async approval queue for the Agent To-Do system. One row per proposed action. A Claude Code Routine writes pending rows hourly; humans approve/reject on /dashboard/tickets/todos. See docs/brain/lifecycles/agent-todo-system.md.';

comment on column public.agent_todos.group_id is
  'Links every todo that belongs to one logical fix (e.g. 1 customer_reply + 2 customer_action). Only one active group per ticket at a time.';

comment on column public.agent_todos.pre_exec_context is
  'Snapshot captured at proposal time (latest_inbound_message_id, sub state hash). The execution worker re-checks against live state; on drift the todo is superseded.';

comment on column public.agent_todos.execution_result is
  'Outcome of execution. For brain_doc_edit / code_change holds {pr_url, branch, merged_at}. For DB actions holds the affected row id. For failures holds {error}.';
