-- proposed_action_aliases — the review queue for Sonnet-emitted action types
-- that missed every handler AND the alias catalog
-- (docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md,
--  Phase 2).
--
-- The executor's "Unknown action type" branch upserts one row per (workspace,
-- source_type) here on every silent miss. `occurrences` counts how many times
-- the type has been seen, `ticket_id` is the most-recent example (kept as a
-- convenience for the admin surface — the full replay is via the shadow
-- harness). When `occurrences >= 3` a small Sonnet call proposes a target
-- from `directActionHandlers`; the admin surface at
-- /dashboard/settings/ai/handler-aliases lists these and lets an admin
-- Approve (insert into action_handler_aliases with active=true) or Decline
-- (mark declined, stop proposing).

create table if not exists public.proposed_action_aliases (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_type text not null,
  -- Most-recent example ticket. Nullable because a shadow-harness backfill
  -- won't always know which ticket to pin (and the ticket row could later
  -- be deleted — the queue row still matters).
  ticket_id uuid references public.tickets(id) on delete set null,

  occurrences integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),

  -- Populated by the small Sonnet call once occurrences >= 3. Null until then.
  suggested_target text,
  suggested_at timestamptz,
  suggested_model text,
  suggested_reasoning text,

  -- 'pending' — awaiting admin review (default on insert)
  -- 'approved' — an admin approved it; a matching action_handler_aliases row
  --              was inserted with active=true (the API route does both).
  -- 'declined' — admin declined; do NOT re-prompt Sonnet on further hits,
  --              just keep counting occurrences for observability.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (workspace_id, source_type)
);

-- The executor's hot upsert path — `on conflict (workspace_id, source_type)`.
-- The unique constraint above already covers it.

-- The admin queue lookup: pending items for a workspace, most-recent first.
create index if not exists proposed_action_aliases_ws_status_idx
  on public.proposed_action_aliases (workspace_id, status, last_seen desc);

-- The shadow-harness lookup: workspace-independent top-N over the last 30 days.
create index if not exists proposed_action_aliases_last_seen_idx
  on public.proposed_action_aliases (last_seen desc);

-- ── RLS — workspace-member SELECT, service-role write ──
alter table public.proposed_action_aliases enable row level security;

drop policy if exists proposed_action_aliases_select on public.proposed_action_aliases;
create policy proposed_action_aliases_select on public.proposed_action_aliases
  for select to authenticated
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

drop policy if exists proposed_action_aliases_service on public.proposed_action_aliases;
create policy proposed_action_aliases_service on public.proposed_action_aliases
  for all to service_role using (true) with check (true);
