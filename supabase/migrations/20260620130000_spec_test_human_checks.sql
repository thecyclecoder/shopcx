-- spec_test_human_checks — the owner's resolution state for the box spec-test agent's "needs human"
-- checks (spec-test-agent Phase 2: the human-test queue). The spec-test agent classifies the
-- mutating/visual `## Verification` bullets it CAN'T run as `needs_human`; the Developer → Human-test
-- queue aggregates those across every shipped-unverified spec, and the owner marks each one tested.
-- One row per (workspace_id, spec_slug, check_key) — `check_key` is a stable hash of the bullet text
-- (sha1 of normalized text) so a resolution survives re-runs as long as the bullet text is unchanged.
-- The agent NEVER writes here — only the owner-gated resolve API does. See docs/brain/specs/spec-test-agent.md.
create table if not exists public.spec_test_human_checks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  spec_slug text not null,
  -- sha1(normalized check text).slice(0,16) — stable across re-runs of the same bullet (see src/lib/spec-test-runs.ts checkKey)
  check_key text not null,
  -- the verbatim `## Verification` bullet (denormalized for the queue's "Done" list + audit)
  check_text text not null,
  -- verified = owner tested it in prod and it works · failed = owner tested it and it's broken · dismissed = N/A
  resolution text not null default 'verified',
  note text,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (workspace_id, spec_slug, check_key)
);

-- The queue read is "all resolutions for a workspace" (joined in memory against the latest runs).
create index if not exists spec_test_human_checks_ws_idx
  on public.spec_test_human_checks (workspace_id);

alter table public.spec_test_human_checks enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'spec_test_human_checks' and policyname = 'spec_test_human_checks_select') then
    create policy spec_test_human_checks_select on public.spec_test_human_checks for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'spec_test_human_checks' and policyname = 'spec_test_human_checks_service') then
    create policy spec_test_human_checks_service on public.spec_test_human_checks for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
