-- Goal Decomposition Engine: agent_jobs gains a `kind` so the box worker can branch between two
-- drivers on the SAME queue — `build` (build-spec → PR, the existing path) and `plan` (plan-goal →
-- propose a milestone → spec tree for approval). claim_agent_job() stays kind-agnostic; the worker
-- reads job.kind and runs the right skill. For a plan job, spec_slug holds the GOAL slug.
-- See docs/brain/specs/goal-decomposition-engine.md.
alter table public.agent_jobs
  add column if not exists kind text not null default 'build';
