-- Handler-alias catalog for the orchestrator action executor
-- (docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md, Phase 1;
--  M3 "Right-cost routing" of docs/brain/goals/guaranteed-ticket-handling.md).
--
-- The Sonnet orchestrator occasionally emits action types that are semantically
-- correct but don't match any handler key in `directActionHandlers` — e.g.
-- `cancel_subscription` instead of `cancel`, or `refund_partial` instead of
-- `partial_refund`. Those requests land on the executor's "Unknown action
-- type" silent-miss branch and the customer's actual request never fires.
--
-- This table is the DB-driven alias catalog the executor consults before it
-- falls through to that branch. `workspace_id` is NULLABLE — a null row is a
-- GLOBAL alias applied to every workspace. Non-null rows are workspace scoped
-- and win over globals when both match (see src/lib/action-executor.ts
-- resolveAlias for the resolution order).
--
--   source_type — what Sonnet emitted (e.g. 'cancel_subscription')
--   target_type — the canonical handler key it should map to (e.g. 'cancel')
--   active      — soft-disable a mapping without deleting it (so we can
--                 shadow-observe before flipping any default)
--
-- Phase 2 will add proposed_action_aliases (the review queue) + the
-- /dashboard/settings/ai/handler-aliases admin surface + a shadow harness
-- over the last 30 days of 'Unknown action type' hits.

create table if not exists public.action_handler_aliases (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: null means GLOBAL (applies to every workspace). A non-null
  -- workspace_id scopes the alias and wins over any matching global row.
  workspace_id uuid references public.workspaces(id) on delete cascade,
  source_type text not null,
  target_type text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Globals are the read path most often taken; scoping the uniqueness by
-- workspace_id lets a workspace override a global with a different target
-- (or disable it via active=false) without violating a global unique.
-- Two partial unique indexes — one for globals (workspace_id is null), one
-- for workspace-scoped rows — because Postgres' unique treats nulls as
-- distinct in a single composite index.
create unique index if not exists action_handler_aliases_global_uidx
  on public.action_handler_aliases (source_type)
  where workspace_id is null;
create unique index if not exists action_handler_aliases_workspace_uidx
  on public.action_handler_aliases (workspace_id, source_type)
  where workspace_id is not null;

-- The executor's hot lookup: `resolveAlias(workspace_id, source_type)`.
-- Not filtered on `active` because the picker needs to see an inactive
-- workspace-scoped row (used to disable an inherited global mapping).
create index if not exists action_handler_aliases_lookup_idx
  on public.action_handler_aliases (source_type, workspace_id);

-- ── Seed the globally observable misses ────────────────────────────────
-- Idempotent: `on conflict do nothing` against the global partial-unique.
insert into public.action_handler_aliases (workspace_id, source_type, target_type, active)
values
  (null, 'cancel_subscription', 'cancel',         true),
  (null, 'refund_partial',      'partial_refund', true),
  (null, 'pause_subscription',  'pause',          true),
  (null, 'resume_subscription', 'resume',         true)
on conflict do nothing;

-- ── RLS — workspace-member SELECT, service-role write ──
alter table public.action_handler_aliases enable row level security;

drop policy if exists action_handler_aliases_select on public.action_handler_aliases;
create policy action_handler_aliases_select on public.action_handler_aliases
  for select to authenticated
  using (
    workspace_id is null
    or workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid())
  );

drop policy if exists action_handler_aliases_service on public.action_handler_aliases;
create policy action_handler_aliases_service on public.action_handler_aliases
  for all to service_role using (true) with check (true);
