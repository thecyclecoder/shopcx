-- compiled_trees — the durable store for the playbook-compiler box agent's mined
-- problem-to-resolution trees.
--
-- Phase 1 of the playbook-compiler-becomes-box-agent-mining-full-history spec:
-- the compiler is no longer a raw-Anthropic-API cron mining the 30-day
-- ticket_resolution_events ledger. A supervised box agent (kind='playbook-compile',
-- dispatched by scripts/builder-worker.ts → runPlaybookCompileJob) now reads the
-- FULL history (tickets + ticket_analyses over MINING_WINDOW_DAYS_ALL — no
-- 30-day floor) and emits ONE JSON verdict listing recurring problem × resolution
-- trees. The deterministic worker upserts each verdict tree here so the store is
-- the substrate Phase 2 will read to propose data-grounded playbook seeds
-- (playbooks + playbook_steps, is_active=false).
--
-- Idempotency: UNIQUE (workspace_id, tree_key). tree_key is deterministic
-- (normalized problem + sorted action-types tuple), so re-running the box agent
-- over unchanged history is a no-op (the upsert replaces the same row).
--
-- RLS: service-role writes only (mirrors director_activity — all callers go
-- through createAdminClient()).

CREATE TABLE IF NOT EXISTS public.compiled_trees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  -- Deterministic per-workspace key: "<problem> :: <action_type>+<action_type>...".
  -- Same construction the pure helper `treeKeyFor(problem, actionTypes)` in
  -- src/lib/playbook-compiler.ts produces, so the upsert path and the box
  -- agent's proposed key line up bit-for-bit.
  tree_key text NOT NULL,
  problem text NOT NULL,
  action_types text[] NOT NULL,
  -- Distinct ticket count backing this tree over the mining window — the "N
  -- tickets landed here" evidence. Support >= support_min qualifies the tree
  -- for Phase 2 playbook proposal.
  support int4 NOT NULL,
  -- Up to N sample ticket ids that participated in the tree — passed to Phase
  -- 2's playbook-seed prompt as evidence + surfaced in the audit UI.
  sample_ticket_ids uuid[] NOT NULL DEFAULT '{}',
  -- Real intent distribution over the tree's tickets — the source Phase 2's
  -- playbook.trigger_intents is derived from (not hand-guessed keywords). Shape:
  -- { intent_name: distinct_ticket_count, ... }.
  intent_distribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Ordered resolution actions the tree resolves via — the source Phase 2's
  -- playbook_steps rows are derived from. Shape: [{action_type, notes?}, ...].
  resolution_sequence jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Structured evidence pointers (ticket_analyses ids, resolution_event ids,
  -- window bounds) so the compiled row is auditable back to its source rows.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The box agent's short human-readable why for this tree — a 1-2 sentence
  -- rationale. Copied into the director_activity row's reason too.
  reasoning text,
  compiled_at timestamptz NOT NULL DEFAULT now(),
  -- The agent_jobs row that produced this tree (nullable so a legacy backfill
  -- run without a job row still records cleanly). ON DELETE SET NULL so a job
  -- row cleanup doesn't cascade into losing compiled trees.
  compiled_by_job_id uuid REFERENCES public.agent_jobs(id) ON DELETE SET NULL,
  UNIQUE (workspace_id, tree_key)
);

CREATE INDEX IF NOT EXISTS idx_compiled_trees_workspace_compiled
  ON public.compiled_trees (workspace_id, compiled_at DESC);

-- RLS on. No policies — service-role bypasses RLS, so every write goes through
-- createAdminClient() (matches director_activity's shape). If a public read
-- surface lands later, add a select policy then.
ALTER TABLE public.compiled_trees ENABLE ROW LEVEL SECURITY;
