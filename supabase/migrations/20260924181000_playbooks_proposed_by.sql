-- Phase 2 of playbook-compiler-becomes-box-agent-mining-full-history:
-- the box-agent playbook-compiler now seeds recurring problem-to-resolution
-- trees as PROPOSED (is_active=false) playbook rows. This migration:
--
--  * adds `proposed_by text` so a compiler seed is distinguishable from a
--    RETIRED playbook (a retired row has is_active=false with proposed_by
--    IS NULL). Human approval clears proposed_by to null when it flips
--    is_active=true — the same shape agent_model_tiers.proposed_by /
--    approved_by uses ([[../libraries/model-tier-proposals]]).
--
--  * adds `source_tree_key text` pointing back to compiled_trees.tree_key
--    for the tree the seed derived from. The partial UNIQUE index
--    (workspace_id, source_tree_key) WHERE source_tree_key IS NOT NULL
--    anchors idempotency: a re-run of the compiler over the same tree
--    upserts the same playbook row, never a duplicate. Human-authored
--    playbooks carry source_tree_key IS NULL and are unaffected.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS · CREATE INDEX IF NOT EXISTS).
-- No RLS change — playbooks writes go through createAdminClient()
-- (service role) exclusively.

ALTER TABLE public.playbooks
  ADD COLUMN IF NOT EXISTS proposed_by text;

ALTER TABLE public.playbooks
  ADD COLUMN IF NOT EXISTS source_tree_key text;

-- Enforce one compiler-seeded playbook per (workspace, tree). NULL-tolerant
-- (a human-authored playbook has no source_tree_key and is exempt).
CREATE UNIQUE INDEX IF NOT EXISTS uidx_playbooks_source_tree_key
  ON public.playbooks (workspace_id, source_tree_key)
  WHERE source_tree_key IS NOT NULL;

-- Fast lookup for the dashboard "Proposed" subsection + the Phase 3 Sol M4
-- selection scan (proposed seeds get filtered out; approved ones don't).
CREATE INDEX IF NOT EXISTS idx_playbooks_proposed
  ON public.playbooks (workspace_id)
  WHERE proposed_by IS NOT NULL AND is_active = false;
