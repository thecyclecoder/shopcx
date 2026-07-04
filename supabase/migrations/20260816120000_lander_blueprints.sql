-- lander_blueprints: Cleo's teardown → build-new blueprint entity.
--
-- Phase 1 of docs/brain/specs/cleo-lander-blueprint.md (parent goal:
-- acquisition-research-engine). The BRIDGE from Rhea's research (research_urls.teardown)
-- to Ada/Platform's build queue. Cleo's session is the ONE judgment step in the chain —
-- modify-vs-build-new: when the gap between a worthy teardown and our funnel is a whole
-- MISSING FUNNEL TYPE (not a single reversible lever), a blueprint row lands here with
-- the transferable_pattern adapted into `skeleton` (the ordered blocks + which levers
-- each carries), then Carrie (dr-content) fills `content` per block.
--
-- Design: a distinct ENTITY (not a research_urls flag) because it carries a build
-- lifecycle: content_in_progress → awaiting_upload → content_complete → build_submitted
-- (or → rejected).
--
-- North-star (supervisable autonomy): Cleo (Max's leash) proposes blueprints
-- deterministically off Rhea's teardowns; Carrie fills content within the same leash;
-- the build submission is where Ada/Platform's build discipline takes over. No silent
-- proxy-optimizer.
--
-- Chokepoint: all WRITES go through src/lib/lander-blueprints.ts via createAdminClient().
-- No raw .from('lander_blueprints').insert|update outside the SDK — same discipline as
-- research_urls / specs-table / goals-table.

create table if not exists public.lander_blueprints (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The target product for the new lander (e.g. Amazing Coffee for a superfood-coffee
  -- teardown). Cleo picks this by matching the teardown's category to a product's
  -- benefit tree. ON DELETE CASCADE — a deleted product's blueprints go with it.
  product_id uuid not null references public.products(id) on delete cascade,

  -- The source teardown Cleo diffed against our funnel. ON DELETE SET NULL so a purged
  -- research_urls row leaves the blueprint in place (its skeleton was copied inline).
  research_url_id uuid references public.research_urls(id) on delete set null,

  -- The funnel classification carried from the teardown (e.g. 'advertorial-listicle',
  -- 'quiz'). Free-text on purpose — vocabulary is Rhea's TeardownRecipe.funnel_type,
  -- extending it is a spec change over there, not a migration here.
  funnel_type text not null,

  -- The transferable_pattern ADAPTED to our benefit tree: the ordered blocks to build
  -- (each carrying which levers/beats it implements). Carrie's later content pass fills
  -- per-block copy into `content` — this column stays the skeleton (structure), never
  -- the copy.
  skeleton jsonb not null,

  -- Build lifecycle:
  --   content_in_progress — Cleo just landed the row; Carrie's dr-content job is queued.
  --   awaiting_upload     — Carrie needs assets (hero image, testimonials, ...) from ops.
  --   content_complete    — every block in `content` is filled; ready for build submit.
  --   build_submitted     — the build was handed to Ada/Platform (a spec_phases row was
  --                         authored off this blueprint).
  --   rejected            — Cleo (or an owner) killed the blueprint — a rationale change
  --                         re-surfaced the source teardown as a modify-existing case.
  status text not null default 'content_in_progress'
    check (status in (
      'content_in_progress',
      'awaiting_upload',
      'content_complete',
      'build_submitted',
      'rejected'
    )),

  -- Cleo's citation — the WHY behind picking build-new over modify-existing for this
  -- teardown/product pair. Kept next to the row so the decision is auditable when a
  -- reviewer opens the blueprint later.
  rationale text,

  -- Carrie fills this after her dr-content pass — copy + assets per skeleton block.
  -- Null until Carrie writes; the shape mirrors `skeleton` block-by-block so a reader
  -- can zip them.
  content jsonb,

  -- Author of the row. Free-text; 'cleo' for the deterministic session, operator email
  -- on manual authoring. Matches research_urls.classified_by convention.
  created_by text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Read-path indexes:
--   • browse-by-product (owner's blueprints panel for one PDP)
--   • Cleo/Carrie work queues by status
--   • lookup by source teardown (has this teardown already produced a blueprint?)
create index if not exists lander_blueprints_workspace_product_idx
  on public.lander_blueprints (workspace_id, product_id);
create index if not exists lander_blueprints_workspace_status_idx
  on public.lander_blueprints (workspace_id, status);
create index if not exists lander_blueprints_workspace_research_url_idx
  on public.lander_blueprints (workspace_id, research_url_id);

-- updated_at auto-bump on any UPDATE (mirrors research_urls_touch_updated_at).
create or replace function public.lander_blueprints_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists lander_blueprints_touch_updated_at on public.lander_blueprints;
create trigger lander_blueprints_touch_updated_at
  before update on public.lander_blueprints
  for each row execute function public.lander_blueprints_touch_updated_at();

alter table public.lander_blueprints enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'lander_blueprints' and policyname = 'lander_blueprints_select'
  ) then
    create policy lander_blueprints_select on public.lander_blueprints for select
      using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'lander_blueprints' and policyname = 'lander_blueprints_service'
  ) then
    create policy lander_blueprints_service on public.lander_blueprints for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
