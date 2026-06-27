-- per-build-vercel-preview-deploys Phase 2 — capture the per-build Vercel PREVIEW deployment on the
-- owning agent_jobs row so M3 (spec-test-on-preview-pre-merge) can target it.
--
-- One `claude/*` build branch = one Vercel preview deployment (Phase 1 flipped the Ignored-Build-Step
-- so `claude/*` builds). Phase 2 resolves that deployment via /v6/deployments?meta-githubCommitRef={branch}
-- (see src/lib/vercel-project.ts `getLatestReadyDeploymentForBranch`) and persists:
--
--   - `preview_url`   the `https://…vercel.app` URL of the latest READY deployment for the branch.
--                     Set ONCE the deployment reaches READY; null while it's still BUILDING / unmatched.
--                     enqueuePreMergeSpecTest (src/lib/agent-jobs.ts) already writes this column on
--                     insert — the column was the only thing missing.
--
--   - `preview_state` the latest known Vercel state for the build branch's deployment:
--                     QUEUED | INITIALIZING | BUILDING | READY | ERROR | CANCELED. Free text (not an
--                     enum) so a future Vercel state addition lands without a schema migration. M3
--                     reads "preview exists" from `preview_state IS NOT NULL` (and "preview ready" from
--                     `preview_state = 'READY' AND preview_url IS NOT NULL`).
--
-- Both columns are nullable and unconstrained — the capture path is read-only against Vercel and
-- best-effort: a missing/late deployment leaves the row null/BUILDING, never fatal to the build, and
-- a re-poll re-stamps idempotently.

alter table public.agent_jobs
  add column if not exists preview_url text,
  add column if not exists preview_state text;

-- M3's pre-merge spec-test lookup will key on (workspace_id, kind='build', preview_state='READY',
-- preview_url IS NOT NULL) to find "build branches with a ready preview that haven't been tested yet".
-- A partial index over the predicate keeps that scan tight as the build queue grows.
create index if not exists agent_jobs_ready_preview_idx
  on public.agent_jobs (workspace_id, created_at desc)
  where kind = 'build' and preview_state = 'READY' and preview_url is not null;
