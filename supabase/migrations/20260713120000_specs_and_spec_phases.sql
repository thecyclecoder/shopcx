-- Spec body in the DB — public.specs + public.spec_phases (db-driven-specs M1, spec-body-table-and-backfill).
-- See docs/brain/specs/spec-body-table-and-backfill.md.
--
-- The card metadata + the BODY for every spec move into the DB. specs holds the card (title, summary, owner,
-- parent, blocked_by, priority/critical, deferred, intended_status, status, milestone_id). spec_phases holds
-- ONE ROW PER PHASE — a child TABLE (not a jsonb array on specs) so a phase can MOVE between specs (lift P5
-- into a new deferred spec) via a single UPDATE that preserves the phase's stable id + pr + merge_sha +
-- history (spec-status-phase-pr-provenance). A jsonb array would force destroy+recreate, which BREAKS the
-- per-phase PR provenance chain.
--
-- specs.status ROLLS UP from spec_phases via the row-level trigger below — IMPOSSIBLE to commit
-- specs.status='shipped' while a phase is still planned (the spec-review-agent "shipped with 1 phase" class).
-- The .md files in docs/brain/specs/ stay authoritative until spec-readers-from-db-retire-parser cuts readers
-- over (M3); this spec only ADDS the new relations + backfills them.
--
-- Workspace-scoped (mirrors spec_card_state). RLS: any authenticated user reads; service role does all writes
-- (the writers run with service-role creds). No client-side spec writes.

-- ──────────────────────────────────────────────────────────────────────────────
-- public.specs — the card row (one per spec)
-- ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.specs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- the spec slug (docs/brain/specs/{slug}.md — the file key).
  slug text not null,
  title text not null,
  -- the first paragraph below the H1 — the card summary.
  summary text,
  -- function slug (DRI) — growth | cmo | retention | cfo | logistics | cs | platform — same shape parseSpec
  -- carries today. Free-text to avoid forcing a hard FK before the functions table catches up.
  owner text not null,
  -- mandate or goal milestone (free-text, same shape parseSpec carries today). milestone_id below is the typed
  -- FK link set by goals-milestones-tables-and-backfill — null for standalone specs.
  parent text not null,
  -- sibling spec slugs (spec-blockers) — prerequisite specs whose status must be `shipped` to clear the gate.
  blocked_by text[] not null default '{}',
  -- **Priority:** critical flag (director-executable-plans-and-priority) — orthogonal to status; null otherwise.
  priority text,
  -- **Deferred:** parked — wins over phase rollup for display (director-drives-all-specs-and-deferred-status).
  deferred boolean not null default false,
  -- author's suggested disposition (spec-review-agent disposition lane) — null when the spec hasn't been routed.
  intended_status text check (intended_status is null or intended_status in ('planned','deferred')),
  -- rolled-up overall status. The trigger below KEEPS this consistent with spec_phases — a direct write that
  -- contradicts the phases is corrected on the next phase write. `folded` (M4) + `in_review` (spec-review-agent)
  -- are terminal-ish: they're NOT overwritten by the rollup until cleared.
  status text not null default 'in_review' check (
    status in ('in_review','planned','in_progress','shipped','deferred','folded')
  ),
  -- who set intended_status — surface for the Slack disposition flow.
  intended_status_set_by text,
  -- the box Repair-Agent's signature for a repair-authored spec (drives the board's 🔧 Repair source chip).
  repair_signature text,
  -- owner opt-out from spec-blockers Phase 2 auto-queue. Default false (auto-build off until explicitly enabled).
  auto_build boolean not null default false,
  -- typed FK link to the goal milestone this spec implements — set by goals-milestones-tables-and-backfill.
  -- Nullable: a standalone spec (function mandate, ad-hoc) has none.
  milestone_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Upsert spine: one row per (workspace, slug). Every backfill / writer goes through this onConflict key.
create unique index if not exists specs_ws_slug on public.specs (workspace_id, slug);
create index if not exists specs_ws_status_idx on public.specs (workspace_id, status);
create index if not exists specs_ws_milestone_idx on public.specs (workspace_id, milestone_id) where milestone_id is not null;

alter table public.specs enable row level security;

drop policy if exists specs_select on public.specs;
create policy specs_select on public.specs
  for select to authenticated using (auth.uid() is not null);
drop policy if exists specs_service on public.specs;
create policy specs_service on public.specs
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- public.spec_phases — one row per phase (a child TABLE, not a jsonb array)
-- ──────────────────────────────────────────────────────────────────────────────
-- The phase id is STABLE across moves — movePhase(phaseId, newSpecId, newPosition) is a single UPDATE that
-- preserves id + pr + merge_sha + created_at (spec-status-phase-pr-provenance). A jsonb-style destroy+recreate
-- would BREAK that provenance chain.
create table if not exists public.spec_phases (
  id uuid primary key default gen_random_uuid(),
  spec_id uuid not null references public.specs(id) on delete cascade,
  -- 1-indexed phase position — the ordering surface. Unique per (spec_id, position).
  position int not null,
  title text not null,
  -- the phase content as the brain renders it: bullets, prose, code. Markdown-as-text.
  body text not null,
  status text not null default 'planned' check (status in ('planned','in_progress','shipped','rejected')),
  -- the PR # that shipped this phase (spec-status-phase-pr-provenance Phase 3). Provable, not inferred.
  pr int,
  -- the merge commit SHA — provenance for the PR # above.
  merge_sha text,
  -- the per-phase ## Verification block when present (verification-guides).
  verification text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spec_phases_spec_position on public.spec_phases (spec_id, position);
create index if not exists spec_phases_spec_idx on public.spec_phases (spec_id);

alter table public.spec_phases enable row level security;

drop policy if exists spec_phases_select on public.spec_phases;
create policy spec_phases_select on public.spec_phases
  for select to authenticated using (auth.uid() is not null);
drop policy if exists spec_phases_service on public.spec_phases;
create policy spec_phases_service on public.spec_phases
  for all to service_role using (true) with check (true);

-- ──────────────────────────────────────────────────────────────────────────────
-- Rollup function + trigger — specs.status follows spec_phases automatically
-- ──────────────────────────────────────────────────────────────────────────────
-- Same rule deriveStatus / rollupPhaseStatus enforce in app code today (brain-roadmap.ts,
-- spec-card-state.ts), but ENFORCED IN THE DB so it's impossible to bypass: any in_progress / partial-shipped
-- → in_progress; all shipped (ignoring rejected) → shipped; deferred wins over phase progress; in_review +
-- folded are terminal-ish (the rollup leaves them alone until something flips status out explicitly). HARD
-- RAIL: if this function/trigger ever disappears, the spec-review-agent "shipped with 1 phase" class returns.
create or replace function public.roll_up_spec_status(p_spec_id uuid)
returns void
language plpgsql
as $$
declare
  v_total int;
  v_shipped int;
  v_in_progress int;
  v_deferred boolean;
  v_current text;
  v_next text;
begin
  select status, deferred into v_current, v_deferred from public.specs where id = p_spec_id;
  if not found then return; end if;

  -- in_review and folded are terminal-ish — the rollup never overwrites them. They leave only via an explicit
  -- status change (the spec-review-agent disposition for in_review; the fold worker for folded).
  if v_current in ('in_review','folded') then return; end if;

  -- The deferred flag wins over phase progress for display (director-drives-all-specs-and-deferred-status).
  if v_deferred then v_next := 'deferred';
  else
    select
      count(*) filter (where status <> 'rejected'),
      count(*) filter (where status = 'shipped'),
      count(*) filter (where status = 'in_progress')
    into v_total, v_shipped, v_in_progress
    from public.spec_phases where spec_id = p_spec_id;

    if v_total = 0 then
      v_next := 'planned';
    elsif v_shipped = v_total then
      v_next := 'shipped';
    elsif v_in_progress > 0 or v_shipped > 0 then
      v_next := 'in_progress';
    else
      v_next := 'planned';
    end if;
  end if;

  if v_current is distinct from v_next then
    update public.specs set status = v_next, updated_at = now() where id = p_spec_id;
  end if;
end $$;

create or replace function public.spec_phases_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  -- INSERT / UPDATE → rollup on the (new) spec_id. DELETE → rollup on the (old) spec_id. A movePhase
  -- UPDATE that changes spec_id fires both sides via this single statement.
  if tg_op = 'DELETE' then
    perform public.roll_up_spec_status(old.spec_id);
    return old;
  end if;
  perform public.roll_up_spec_status(new.spec_id);
  if tg_op = 'UPDATE' and old.spec_id is distinct from new.spec_id then
    perform public.roll_up_spec_status(old.spec_id);
  end if;
  return new;
end $$;

drop trigger if exists spec_phases_rollup on public.spec_phases;
create trigger spec_phases_rollup
  after insert or update or delete on public.spec_phases
  for each row execute function public.spec_phases_rollup_trigger();

-- specs.deferred toggling also affects the rollup result — recompute when it flips so a manual UPDATE
-- specs SET deferred=true (or false) propagates to status without waiting for the next phase write.
create or replace function public.specs_deferred_rollup_trigger()
returns trigger
language plpgsql
as $$
begin
  if old.deferred is distinct from new.deferred then
    perform public.roll_up_spec_status(new.id);
  end if;
  return new;
end $$;

drop trigger if exists specs_deferred_rollup on public.specs;
create trigger specs_deferred_rollup
  after update of deferred on public.specs
  for each row execute function public.specs_deferred_rollup_trigger();
