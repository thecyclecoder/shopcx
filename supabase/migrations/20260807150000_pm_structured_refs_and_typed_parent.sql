-- pm-structured-intent-and-refs Phase 2 — structured brain refs + typed parent.
-- See docs/brain/specs/pm-structured-intent-and-refs.md § Phase 2.
--
-- Two changes on the PM tree:
--
-- (1) public.spec_brain_refs — a relation replacing the `**Brain refs:**` prose line. One row per
-- (spec_id | phase_id → brain page slug). `spec_id` NOT NULL (every ref belongs to a spec); `phase_id`
-- OPTIONAL — a spec-level ref carries `phase_id=NULL`, a per-phase ref names its phase. The
-- `brain_slug` is the canonical `kind/name` path relative to `docs/brain/` (e.g. `libraries/author-spec`
-- or `tables/specs`). Populated by the existing brain-ref suggester at authoring time (still lives in
-- `src/lib/brain-ref-suggest.ts`); replaces the current `**Brain refs:**` line stuffed into the summary.
-- A CI script (`scripts/_check-brain-refs.ts`) validates every ref resolves to a real
-- `docs/brain/{kind}/{name}.md` file — a dangling ref fails CI.
--
-- (2) public.specs.parent — augmented with a typed reference. Today `parent` is free-text (a wikilink
-- or a mandate phrase). We add two typed slots that mirror the shape already used by `blocked_by`
-- (typed slug array) + `milestone_id` (typed FK):
--   - `parent_kind` — one of `function` | `mandate` | `milestone` | NULL (NULL for legacy rows).
--   - `parent_ref` — the resolvable value: the function slug (`platform`), the mandate key
--     (`platform#autonomous-build-platform`), or the milestone id as text (mirrors `milestone_id`).
-- The existing `parent` free-text stays for display + backward compat; the typed pair is authoritative
-- for CI resolution.
--
-- Nullable everywhere so existing rows keep working; app-layer authoring is updated to populate.

create table if not exists public.spec_brain_refs (
  id uuid primary key default gen_random_uuid(),
  spec_id uuid not null references public.specs(id) on delete cascade,
  -- optional per-phase link — NULL means a spec-level ref (applies to the whole spec).
  phase_id uuid references public.spec_phases(id) on delete cascade,
  -- the canonical `kind/name` path relative to `docs/brain/` (e.g. `libraries/author-spec`). Kept as a
  -- single text column (not a kind + name pair) so a future kind ("goals", "specs") is a data change
  -- only. Lowercased kebab-case by the app-layer writer; the CI check validates the file exists on disk.
  brain_slug text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotency spine — (spec_id, phase_id, brain_slug) is the unique dedup key. A spec-level ref and a
-- phase-level ref to the same brain page CAN coexist (different phase_id values), but the same phase +
-- ref pair cannot duplicate. NOTE: (phase_id IS NULL vs IS NOT NULL) needs the coalesce trick for the
-- unique index to actually dedup the spec-level (NULL) rows.
create unique index if not exists spec_brain_refs_dedup
  on public.spec_brain_refs (spec_id, coalesce(phase_id::text, ''), brain_slug);

-- Reverse-lookup spine: given a brain page, find every spec that touches it.
create index if not exists spec_brain_refs_slug_idx on public.spec_brain_refs (brain_slug);
-- Forward-lookup spine: given a spec (or phase), list its refs.
create index if not exists spec_brain_refs_spec_idx on public.spec_brain_refs (spec_id, phase_id);

alter table public.spec_brain_refs enable row level security;

drop policy if exists spec_brain_refs_select on public.spec_brain_refs;
create policy spec_brain_refs_select on public.spec_brain_refs
  for select to authenticated using (auth.uid() is not null);
drop policy if exists spec_brain_refs_service on public.spec_brain_refs;
create policy spec_brain_refs_service on public.spec_brain_refs
  for all to service_role using (true) with check (true);

comment on table public.spec_brain_refs is
  'pm-structured-intent-and-refs Phase 2 — one row per (spec | phase) → brain page ref. Replaces the '
  'free-text **Brain refs:** line stuffed into the summary. Populated by src/lib/brain-ref-suggest at '
  'authoring time; the CI script scripts/_check-brain-refs.ts validates every brain_slug resolves to a '
  'real docs/brain/{kind}/{name}.md file.';

-- ── specs.parent_kind + specs.parent_ref (typed parent) ──
alter table public.specs
  add column if not exists parent_kind text check (parent_kind is null or parent_kind in ('function', 'mandate', 'milestone')),
  add column if not exists parent_ref text;

comment on column public.specs.parent_kind is
  'pm-structured-intent-and-refs Phase 2 — typed parent kind (function | mandate | milestone | NULL). '
  'NULL for legacy rows / pre-Phase-2 authoring; the CI enforcer refuses a NEW spec authored without a '
  'typed parent going forward.';
comment on column public.specs.parent_ref is
  'pm-structured-intent-and-refs Phase 2 — the resolvable typed-parent value: a function slug '
  '(platform), a mandate key (platform#autonomous-build-platform), or a milestone_id as text. Paired '
  'with parent_kind. The free-text specs.parent stays for display + backward compat but the typed pair '
  'is authoritative for CI resolution.';
