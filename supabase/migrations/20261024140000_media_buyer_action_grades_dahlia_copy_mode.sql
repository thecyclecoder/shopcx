-- Split media_buyer_action_grades by Dahlia copy mode so realized cost-per-add-to-cart /
-- inline-link-CTR / CAC break out per author vs deterministic (Dahlia M3 measurement lane —
-- docs/brain/specs/dahlia-cold-graded-inline-link-ctr-leading-signal.md Phase 2).
--
-- The M3 flag-graduation gate for flipping DAHLIA_COPY_MODE from 'deterministic' to 'author'
-- reads getPerCopyModeCtrCac(workspaceId, {days, audienceCohort:'cold'}) — that helper buckets
-- grade rows by this column. Stamped at grade time in src/lib/media-buyer/grader.ts by joining
-- source_meta_ad_id → ad_publish_jobs.meta_ad_id → ad_publish_jobs.campaign_id →
-- ad_campaigns.author_self_score (non-null → 'author'; null → 'deterministic').
--
-- Nullable-means-pre-migration: existing grade rows stay NULL until the ship-time backfill
-- (scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts, auto-ledgered via data_op_runs)
-- stamps them. Per-mode readers exclude NULLs from their buckets so the pre-migration gap
-- doesn't skew averages.
alter table public.media_buyer_action_grades
  add column if not exists dahlia_copy_mode text
    check (dahlia_copy_mode is null or dahlia_copy_mode in ('author', 'deterministic'));

comment on column public.media_buyer_action_grades.dahlia_copy_mode is
  'Dahlia copy mode the graded creative was authored in (M3 measurement lane). ''author'' when ad_campaigns.author_self_score is non-null at grade time; ''deterministic'' when null. NULL for pre-migration rows (backfilled idempotently by scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts) — per-mode readers exclude NULLs from their averages so the pre-migration gap doesn''t skew the flag-graduation gate. Consumed by getPerCopyModeCtrCac in src/lib/media-buyer/insights.ts.';

-- Partial index on the two live buckets so the per-mode helper's trailing-window scan is fast
-- once the backfill catches up. NULL rows are excluded from the index (they're excluded from
-- the read too).
create index if not exists media_buyer_action_grades_copy_mode_idx
  on public.media_buyer_action_grades (workspace_id, dahlia_copy_mode, graded_at desc)
  where dahlia_copy_mode is not null;
