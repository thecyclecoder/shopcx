-- workspaces.auto_fold_enabled — the owner kill-switch for the Auto-Ship Pipeline's auto-FOLD gate
-- (auto-ship-pipeline spec, Phase 2 / Gate B). When TRUE (the default) the gate auto-archives fully-
-- verified shipped specs (agent-verdict approved + 0 human checks waiting/failed + 0 regressions) via
-- enqueue_fold — the rubber-stamp "Mark verified & archive" click the owner made on every all-green spec.
-- Flip it FALSE to pause auto-fold instantly (the supervisable-autonomy kill-switch: the owner still owns
-- the objective + can stop the gate at any time). A spec with one waiting/failed check or a regression is
-- never folded — the gate doesn't skip human testing, it just stops the owner clicking once it's all-green.
-- Idempotent: ADD COLUMN IF NOT EXISTS, default true.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS auto_fold_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.workspaces.auto_fold_enabled IS
  'Auto-Ship Pipeline Gate B kill-switch (auto-ship-pipeline Phase 2). true (default) = fully-verified shipped specs auto-fold into the brain (enqueue_fold); false = paused, the owner clicks Mark verified & archive manually.';
