-- data_op_runs — Phase 1 of ship-time-data-backfills-run-and-ledgered-not-silently-dead-code.
--
-- Ledger for one-time data backfills a spec ships as scripts/_backfill-*.ts. The post-merge
-- hook in src/lib/agent-jobs.ts applyMergedBuildEffects scans the merged build's diff for
-- added files matching that glob, upserts a `pending` row per file, and ESCALATES any row
-- with no successful `ran` outcome to the CEO inbox (Phase 1). Phase 2 will also auto-execute
-- idempotent scripts on ship and flip status to `ran`/`failed` while surfacing failures on a
-- Control Tower tile — same shape as the migration-drift tile ([[control-tower/migration-
-- drift]]). Mirrors the applyMergedMigrations ledger role: a shipped data-op must never sit
-- silently un-run.
--
-- Uniqueness on (workspace_id, spec_slug, script_path) makes the upsert idempotent — a re-run
-- of the same post-merge hook (auto-merge webhook + board reconcile can race) collapses to one
-- row, and a spec that ships two backfills carries one row per script.
--
-- RLS ENABLED with a service_role full-access policy (house convention — every read/write
-- flows through server-side code via createAdminClient()).

create table if not exists public.data_op_runs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid null references public.workspaces(id) on delete cascade,
  spec_slug      text not null,
  script_path    text not null,
  status         text not null default 'pending'
                   check (status in ('pending', 'ran', 'failed')),
  ran_at         timestamptz null,
  error          text null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (workspace_id, spec_slug, script_path)
);

create index if not exists data_op_runs_status_idx
  on public.data_op_runs (status)
  where status in ('pending', 'failed');

create index if not exists data_op_runs_workspace_spec_idx
  on public.data_op_runs (workspace_id, spec_slug);

alter table public.data_op_runs enable row level security;
drop policy if exists data_op_runs_service on public.data_op_runs;
create policy data_op_runs_service on public.data_op_runs
  for all to service_role using (true) with check (true);

comment on table public.data_op_runs is
  'Ledger for ship-time data backfills (scripts/_backfill-*.ts). Written by applyMergedBuildEffects post-merge detector in src/lib/agent-jobs.ts. status=pending → detected but not yet run; ran → executed successfully; failed → executor threw (escalated). Phase 1 of ship-time-data-backfills-run-and-ledgered-not-silently-dead-code — see docs/brain/tables/data_op_runs.md.';
comment on column public.data_op_runs.script_path is
  'Repo-relative path of the shipped backfill script (e.g. scripts/_backfill-foo.ts). Unique per (workspace_id, spec_slug).';
comment on column public.data_op_runs.status is
  'pending = detected in the merged diff, no successful run yet (escalated). ran = executed successfully via tsx on the box. failed = executor exited non-zero or threw (escalated, error captured).';
