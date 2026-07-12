-- claim-rpc-kill-switch-enforcement Phase 1 — node ancestry + WHERE-clause join in claim_agent_job
--
-- The universal on/off primitive ([[../../docs/brain/tables/kill_switches]] + `resolveEffectiveSwitch`)
-- resolves in TypeScript space by walking the canonical node registry. The box's central chokepoint —
-- `public.claim_agent_job` — was blind to it: a queued row for a switched-off department was still
-- claimable within one box tick, so the CEO's kill switch could not halt from the DB side.
--
-- This migration:
--   1) Adds `public.node_ancestry` — one row per registered node with kind + precomputed ancestors[]
--      populated from the canonical registry (`src/lib/control-tower/node-registry.ts`) via
--      `scripts/sync-node-ancestry.ts` (a lightweight sync run on box startup + nightly by the
--      `node-ancestry-sync-cron` Inngest cron). The registry lives in code — this table is a DB
--      mirror so the RPC can walk ancestors in SQL without a round-trip.
--   2) Adds `public.kind_to_node_id(k)` — resolves `agent_jobs.kind` → `node_ancestry.node_id`.
--   3) Rewrites `public.claim_agent_job(p_kinds)` — retains the existing status / claimed_at / kind
--      selection AND adds a `not exists` guard against `public.kill_switches`: if any ancestor of
--      the queued row's kind (or the kind's own node) has an open kill_switches row, the row is
--      NOT claimable. Fail-open by construction: an unregistered kind (empty ancestry) claims
--      normally.
--   4) Adds `public.claim_agent_job_diag(p_kinds)` — a jsonb peek over the top-20 queued rows
--      whose claim would have been suppressed by (3), so the box worker can surface the reason
--      as an `off by <ancestor>` heartbeat (Phase 2 — box worker surfaces suppressed-claim beats).
--
-- Verification is called out in the spec (test with `insert into kill_switches (node_id, scope, ...)
-- values ('growth','department', ...);` then `select * from claim_agent_job(array['media-buyer']);`
-- returns zero rows; `claim_agent_job_diag(...)` reports suppressed_by='growth', scope='department').

-- ── 1) node_ancestry table ─────────────────────────────────────────────────────
create table if not exists public.node_ancestry (
  -- the canonical node id from `src/lib/control-tower/node-registry.ts`. PK.
  node_id text primary key,
  -- the agent_jobs.kind slug this node handles. For a MONITORED_LOOPS row with `agentKind`, the
  -- agentKind value. For a KIND_OWNER_FALLBACK entry (a director's own sweep pass or a proposal
  -- kind), the raw kind slug. Uniquely selects the node in `kind_to_node_id`.
  kind text not null,
  -- ancestor node_ids walked parent → parent up to the root department, PLUS the bare function
  -- slug at the department level (so a `kill_switches` row keyed by `'growth'` — the CEO cockpit's
  -- convention — matches without normalizing the stored key). Empty for a root department.
  ancestors text[] not null default '{}'
);

create index if not exists node_ancestry_kind_idx on public.node_ancestry (kind);
-- GIN index on ancestors[] so the `not exists` join in claim_agent_job stays sub-ms as
-- kill_switches grows (though we expect it to stay small — one row per switched-off node).
create index if not exists node_ancestry_ancestors_gin on public.node_ancestry using gin (ancestors);

alter table public.node_ancestry enable row level security;
drop policy if exists node_ancestry_select on public.node_ancestry;
create policy node_ancestry_select on public.node_ancestry
  for select to authenticated using (auth.uid() is not null);
drop policy if exists node_ancestry_service on public.node_ancestry;
create policy node_ancestry_service on public.node_ancestry
  for all to service_role using (true) with check (true);

comment on table public.node_ancestry is
  'DB mirror of the canonical node registry (src/lib/control-tower/node-registry.ts) — one row per '
  'agent_jobs.kind with its node_id + precomputed ancestor chain. Powers the kill-switch cascade in '
  'public.claim_agent_job. Populated by scripts/sync-node-ancestry.ts on box startup + nightly by '
  'the node-ancestry-sync-cron Inngest cron. An unconfigured (empty) table is fail-open — every kind '
  'claims normally.';

comment on column public.node_ancestry.ancestors is
  'Parent → parent walk up to the root department, PLUS the bare function slug at the department '
  'level (`growth`, not just `dept:growth`) so a kill_switches row stored under either form is '
  'honored (mirrors resolveEffectiveSwitchFromMap in src/lib/control-tower/kill-switch-resolver.ts).';

-- ── 2) kind_to_node_id — resolves agent_jobs.kind → node_ancestry.node_id ──────
create or replace function public.kind_to_node_id(k text) returns text
language sql stable
as $$
  select node_id from public.node_ancestry where kind = k limit 1;
$$;

comment on function public.kind_to_node_id(text) is
  'Resolve an agent_jobs.kind slug to its canonical node_id via public.node_ancestry. Returns null '
  'for an unregistered kind — the caller (claim_agent_job) treats null as fail-open (claim proceeds).';

-- ── 3) claim_agent_job — with kill_switch cascade guard ────────────────────────
-- Rewrites the current implementation (see 20260727170000_durable_vale_review_passed_and_claim_cooldown.sql):
--   * status in ('queued','queued_resume')                     — unchanged
--   * (p_kinds is null or kind = any(p_kinds))                 — unchanged
--   * (claimed_at is null or claimed_at <= now())              — unchanged (build-gate cooldown)
--   * FOR UPDATE SKIP LOCKED, order by created_at, limit 1     — unchanged
--   * NEW: `and not exists (…)` — reject any row whose kind's node OR any ancestor has an open
--          public.kill_switches row. `na.node_id = kind_to_node_id(agent_jobs.kind)` picks the
--          unique ancestry row for the queued kind; the ks join then checks BOTH the kind's own
--          node_id AND every ancestor node_id (including the bare function slug at department
--          level). A missing ancestry row (`kind_to_node_id` returns null) drops the na row from
--          the join → `not exists` is true → claim proceeds (fail-open, matching the resolver).
create or replace function public.claim_agent_job(p_kinds text[] default null)
returns public.agent_jobs
language plpgsql
as $$
declare
  job public.agent_jobs;
begin
  select * into job from public.agent_jobs
    where status in ('queued', 'queued_resume')
      and (p_kinds is null or kind = any(p_kinds))
      and (claimed_at is null or claimed_at <= now())
      and not exists (
        select 1
          from public.kill_switches ks, public.node_ancestry na
         where na.node_id = public.kind_to_node_id(agent_jobs.kind)
           and (ks.node_id = na.node_id or ks.node_id = any(na.ancestors))
      )
    order by created_at
    for update skip locked
    limit 1;
  if not found then
    return null;
  end if;
  update public.agent_jobs
    set status = 'building', claimed_at = now(), updated_at = now()
    where id = job.id
    returning * into job;
  return job;
end $$;

comment on function public.claim_agent_job(text[]) is
  'Central box worker chokepoint. Selects the oldest queued/queued_resume row (skip-locked, honoring '
  'a future claimed_at as a build-gate cooldown) whose kind''s node — and every ancestor up to the '
  'department seat — is NOT switched off via public.kill_switches. One DB primitive gates every box '
  'lane centrally; a switched-off department halts every descendant within one box tick without any '
  'app-code changes. Fail-open: an unregistered kind (no node_ancestry row) claims normally.';

-- ── 4) claim_agent_job_diag — surface the reason a claim was suppressed ─────────
-- Returns a jsonb array of `{ agent_job_id, kind, suppressed_by, scope }` for the top 20 queued
-- rows the current kill_switches state would suppress. Read by scripts/builder-worker.ts when a
-- `claim_agent_job` call returns null — the worker emits an amber "off by <ancestor>" heartbeat
-- against agentLoopId(kind) so a switched-off tile in the Control Tower is not confused with a
-- silent idle lane. Ordered by created_at DESC to surface the freshest suppressed row first (so a
-- newly-blocked lane lights amber before an old backlog).
create or replace function public.claim_agent_job_diag(p_kinds text[] default null)
returns jsonb
language sql stable
as $$
  with suppressed as (
    select
      aj.id            as agent_job_id,
      aj.kind          as kind,
      ks.node_id       as suppressed_by,
      ks.scope         as scope,
      aj.created_at    as created_at
      from public.agent_jobs aj
      join public.node_ancestry na
        on na.node_id = public.kind_to_node_id(aj.kind)
      join public.kill_switches ks
        on ks.node_id = na.node_id
        or ks.node_id = any(na.ancestors)
     where aj.status in ('queued', 'queued_resume')
       and (p_kinds is null or aj.kind = any(p_kinds))
       and (aj.claimed_at is null or aj.claimed_at <= now())
  ),
  ranked as (
    select distinct on (agent_job_id)
           agent_job_id, kind, suppressed_by, scope, created_at
      from suppressed
     order by agent_job_id, created_at desc
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'agent_job_id', r.agent_job_id,
             'kind',         r.kind,
             'suppressed_by', r.suppressed_by,
             'scope',         r.scope
           )
           order by r.created_at desc
         ) filter (where r.agent_job_id is not null), '[]'::jsonb)
    from (select * from ranked order by created_at desc limit 20) r;
$$;

comment on function public.claim_agent_job_diag(text[]) is
  'jsonb peek at up to 20 queued rows the current kill_switches state would suppress via '
  'claim_agent_job. Each element carries `{ agent_job_id, kind, suppressed_by, scope }` naming the '
  'first ancestor node_id whose kill switch fired. Read by scripts/builder-worker.ts on a null '
  'claim so the Control Tower tile can show "off by <ancestor>" instead of a silent idle.';
