-- CS Director grader — seed the anti-Goodhart calibration clause verbatim
-- (cs-director-grade-with-antigoodhart-rubric-no-fewest-escalations spec, Phase 1;
-- M5 of goal/guaranteed-ticket-handling — "the autonomous CS Director").
--
-- Phase 1 pairs a code-side extension of src/lib/agents/director-grader.ts (two new
-- dimensions — 'cs_director_call' + 'cs_storyline_precedent') with a director_grader_prompts
-- calibration row so the deployed grader prompt injects the anti-Goodhart clause
-- WITHOUT waiting for a per-workspace CEO approval step. This IS the CEO's own
-- correction to the CS-Director rubric: the CS Director must NEVER be graded on
-- 'fewest escalations to founder' — that proxy degenerates to a refund-everyone
-- strategy that minimizes founder pages while destroying the actual objective
-- (customer trust + margin). See docs/brain/operational-rules.md § North star and
-- docs/brain/libraries/director-grader.md § Two dimensions (CS-Director branches).
--
-- The clause is inserted with status='approved' + a low sort_order (10) so it lands
-- FIRST in the CALIBRATION RULES block of buildDirectorGraderSystemPrompt (rules are
-- ordered by sort_order ASC). Idempotent via NOT EXISTS guard keyed on
-- (workspace_id, title) — the table carries no natural unique on seeded rules
-- (provenance columns are keyed to overrides, not seeds), and a rerun must never
-- double-insert. Never destructive: an existing row keeps whatever status it now
-- has (proposed / approved / rejected / archived) — the CEO's later disposition is
-- respected. One row per workspace is populated by iterating public.workspaces.
--
-- Applies via: npx tsx scripts/apply-cs-director-grader-anti-goodhart-clause.ts

insert into public.director_grader_prompts (workspace_id, title, content, status, sort_order)
select w.id,
       'CS Director anti-Goodhart clause — never fewest escalations',
       'The CS Director is NEVER graded on frequency of founder escalations. A refund-everyone strategy that minimizes founder pages must NEVER score high. Grade the CS Director on soundness of the hard call, outcome truthfulness verified against ticket_resolution_events, and whether storyline judgment calls held up as policy.',
       'approved',
       10
  from public.workspaces w
 where not exists (
   select 1 from public.director_grader_prompts p
    where p.workspace_id = w.id
      and p.title = 'CS Director anti-Goodhart clause — never fewest escalations'
 );
