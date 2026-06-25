-- spec-fold-from-db-row Phase 2 (expand-contract step 1): additive typed columns on public.specs that
-- become the post-retirement home for the surviving spec_card_state fields. The complementary contract
-- step (drop the table, retire the spec-card-state library, scrub references) lives in the follow-up
-- [[specs/retire-spec-card-state]] spec — gated `Blocked-by` THIS spec so the dual-write has time to
-- catch every existing row before any reader is cut over.
--
-- Field accounting (spec-fold-from-db-row Phase 2):
--  - status / per-phase status / priority / deferred / intended_status — ALREADY on specs (spec-body-table-and-backfill).
--  - spec_phases.{pr, merge_sha}                                       — ALREADY on the child rows (spec-status-phase-pr-provenance).
--  - last_merge_sha                — NEW HERE. The deploy-aware UI slot (deploymentState compares this to
--                                    VERCEL_GIT_COMMIT_SHA to decide "shipped · deploying" vs "shipped · live").
--  - short_circuit + reason        — NEW HERE. The director-dismiss-park-and-short-circuit-spec flag pair —
--                                    a shipped spec closed cleanly without all phases shipping ("we changed
--                                    our mind"). short_circuit_reason is required when short_circuit=true.
--  - vale_pass                     — NEW HERE. spec-review-agent Phase 3: Vale's quality verdict; a passed
--                                    in_review spec is ready for Ada's disposition lane.
--  - ada_disposition               — NEW HERE. spec-review-agent Phase 3: Ada's disposition record
--                                    ('autonomous_same' | 'autonomous_downgrade' | 'pending_upgrade'). Cleared
--                                    when the spec leaves in_review.
--  - merged_pr                     — NEW HERE. spec-status-phase-pr-provenance Phase 1: card-level shipping PR
--                                    for a ONE-SHOT spec (no phases) — multi-phase specs record PRs per-phase
--                                    in spec_phases.pr instead.
--
-- DERIVED (NOT a column):
--  - deploy_pending                — computed at read time as (last_merge_sha != VERCEL_GIT_COMMIT_SHA).
--  - blocked                       — computed at read time from blocked_by + the sibling specs' status.
--
-- Idempotent (IF NOT EXISTS on every column). Backfill is split into a separate UPDATE block so the migration
-- can be re-run safely (the UPDATE is idempotent — same source row → same result).

alter table public.specs
  add column if not exists last_merge_sha       text,
  add column if not exists short_circuit        boolean,
  add column if not exists short_circuit_reason text,
  add column if not exists vale_pass            boolean,
  add column if not exists ada_disposition      text,
  add column if not exists merged_pr            integer;

-- One-time backfill from the existing spec_card_state mirror — copy the per-(workspace, slug) row's flag
-- subset onto the future-canonical specs row. Joins on (workspace_id, slug) which is the unique key on both
-- sides. The flags jsonb is unpacked one key at a time; absent keys leave the new column NULL. Safe to re-
-- run: it always writes the same value the mirror currently carries.
update public.specs s
   set last_merge_sha       = coalesce(s.last_merge_sha,       sc.last_merge_sha),
       short_circuit        = coalesce(s.short_circuit,        (sc.flags->>'short_circuit')::boolean),
       short_circuit_reason = coalesce(s.short_circuit_reason, sc.flags->>'short_circuit_reason'),
       vale_pass            = coalesce(s.vale_pass,            (sc.flags->>'vale_pass')::boolean),
       ada_disposition      = coalesce(s.ada_disposition,      sc.flags->>'ada_disposition'),
       merged_pr            = coalesce(s.merged_pr,            nullif(sc.flags->>'merged_pr','')::integer)
  from public.spec_card_state sc
 where sc.workspace_id = s.workspace_id
   and sc.spec_slug    = s.slug;
