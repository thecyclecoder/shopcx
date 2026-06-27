-- spec-test-on-preview-pre-merge Phase 2 — record the pre-merge spec-test target on every run.
-- A pre-merge spec-test (enqueuePreMergeSpecTest, src/lib/agent-jobs.ts) runs the same runner
-- against a per-build *.vercel.app preview origin instead of prod. We carry both pieces on the
-- run row so M3's green-signal helper (and M4's promote gate) can read the latest verdict for a
-- given (slug, branch) deterministically — no JOIN through agent_jobs.spec_branch on every read.
-- Both columns are nullable: a post-ship run from the standing lane carries neither and is
-- unaffected; only pre-merge runs populate them. Latest-per-(slug, branch) is the new common
-- read pattern, hence the extra composite index alongside the existing latest-per-slug one.
alter table public.spec_test_runs
  add column if not exists spec_branch text,
  add column if not exists preview_url text;

create index if not exists spec_test_runs_ws_slug_branch_idx
  on public.spec_test_runs (workspace_id, spec_slug, spec_branch, run_at desc);
