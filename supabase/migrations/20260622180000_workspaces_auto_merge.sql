-- workspaces.auto_merge_enabled — the owner kill-switch for the Auto-Ship Pipeline's auto-merge gate
-- (auto-ship-pipeline spec, Phase 1 / Gate A). When TRUE (the default) the GitHub webhook squash-merges
-- ready (mergeable + all-checks-green) claude/* build PRs automatically — the rubber-stamp "merge" click
-- the owner made on every green build PR. Flip it FALSE to pause auto-merge instantly (the supervisable-
-- autonomy kill-switch: the owner still owns the objective + can stop the gate at any time). Conflicting
-- PRs are untouched here (the dirty-PR-resolver owns those); a red/pending PR is left for the human.
-- Idempotent: ADD COLUMN IF NOT EXISTS, default true.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS auto_merge_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.workspaces.auto_merge_enabled IS
  'Auto-Ship Pipeline Gate A kill-switch (auto-ship-pipeline Phase 1). true (default) = the GitHub webhook auto-squash-merges ready claude/* build PRs; false = paused, the owner merges manually.';
