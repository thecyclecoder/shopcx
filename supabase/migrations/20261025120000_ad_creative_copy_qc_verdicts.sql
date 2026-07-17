-- ad_creative_copy_qc_verdicts — Max's independent copy-QC verdict per ad_campaigns row
-- (docs/brain/specs/dahlia-max-independent-copy-qc-box-session.md Phase 1). The goal's line 27
-- requires an INDEPENDENT director (Max) that bounces on hard gates and records an ADVISORY
-- persuasion score without letting the rubric become a Goodhart objective. This table is the
-- storage for that advisory score + the hard-gate booleans + the per-check evidence so future
-- CAC-correlation work has somewhere to read from — one row per QC attempt for a given campaign,
-- keyed by (workspace_id, ad_campaign_id, retry_index).
--
-- Writers: src/lib/ads/creative-qa.ts `runQaCreativeCopyViaBoxSession` (Phase 2) via an SDK
-- helper (never raw .from() per CLAUDE.md's SDK-chokepoint rule). Reader: future CAC-correlation
-- work + the Max QC dashboard. RLS mirrors ad_campaigns' pattern (service-role does all writes;
-- any workspace member can select).
--
-- Additive + idempotent (create table IF NOT EXISTS, standard RLS bootstrap).
create table if not exists public.ad_creative_copy_qc_verdicts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces(id) on delete cascade,
  ad_campaign_id      uuid not null references public.ad_campaigns(id) on delete cascade,
  -- Hard-gate summary: true iff EVERY per-check gate in `hard_gates` is true. A single false
  -- forces this to false (a mismatched pair — hard_gate_pass=true with a false gate inside
  -- hard_gates — is treated as a defect by the caller and fails closed).
  hard_gate_pass      boolean not null,
  -- Per-check hard-gate booleans, shape:
  --   { no_fabrication:boolean, no_cold_offer:boolean, no_competitor_leak:boolean,
  --     single_promise:boolean, render_ok:boolean }
  -- Open JSON (no CHECK) so a future gate can land without a migration; the .ts parser
  -- pins the required keys.
  hard_gates          jsonb not null,
  -- Max's ADVISORY 0-10 persuasion score. NULL for a hard-gate-fail verdict (Max never
  -- scored the rubric — the bounce is the signal). Range-checked so a stray write can't
  -- degrade the column.
  persuasion_score    int check (persuasion_score is null or (persuasion_score >= 0 and persuasion_score <= 10)),
  -- Max's 5 sub-scores + evidence array, shape:
  --   { lf8:int, schwartz:int, cialdini:int, hopkins:int, sugarman:int,
  --     evidence:string[] }
  -- NULL on a hard-gate fail (same reason as persuasion_score).
  persuasion_rubric   jsonb,
  -- Short human-readable "why" — the fail reason on a bounce, or a one-line pass summary.
  verdict_reason      text,
  -- 0 for the first attempt; incremented by the caller on a revise loop. Bounded by the caller
  -- against MAX_COPY_QA_ATTEMPTS (Phase 2 constant); exhaustion writes a director_activity row
  -- and refuses the bin insert.
  retry_index         int not null default 0,
  created_at          timestamptz not null default now()
);

-- Per-campaign read: latest attempt first (the caller looks up "did Max ever pass this
-- campaign?" and "what's the latest verdict reason?").
create index if not exists ad_creative_copy_qc_verdicts_campaign_idx
  on public.ad_creative_copy_qc_verdicts (ad_campaign_id, retry_index desc);
-- Workspace-wide read (the dashboard / CAC-correlation reader iterates newest-first).
create index if not exists ad_creative_copy_qc_verdicts_workspace_idx
  on public.ad_creative_copy_qc_verdicts (workspace_id, created_at desc);

alter table public.ad_creative_copy_qc_verdicts enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='ad_creative_copy_qc_verdicts' and policyname='ad_creative_copy_qc_verdicts_service_all') then
    create policy ad_creative_copy_qc_verdicts_service_all on public.ad_creative_copy_qc_verdicts for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename='ad_creative_copy_qc_verdicts' and policyname='ad_creative_copy_qc_verdicts_member_select') then
    create policy ad_creative_copy_qc_verdicts_member_select on public.ad_creative_copy_qc_verdicts for select to authenticated
      using (exists (select 1 from public.workspace_members m where m.workspace_id = ad_creative_copy_qc_verdicts.workspace_id and m.user_id = auth.uid()));
  end if;
end $$;

comment on table public.ad_creative_copy_qc_verdicts is
  'Max independent copy-QC verdict per ad_campaigns row (dahlia-max-independent-copy-qc-box-session Phase 1). One row per QC attempt; hard_gate_pass=false triggers a copy-only revise loop up to MAX_COPY_QA_ATTEMPTS; persuasion_score is ADVISORY (never blocks) and exists for future CAC-correlation.';
