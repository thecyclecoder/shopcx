-- agent_jobs.kind: distinguish a spec BUILD job ('build') from a goal PLAN job ('plan').
-- The goal-decomposition engine adds a layer ABOVE specs: a 'plan' job runs the planner
-- (plan-goal skill) over a goal and emits a proposed milestone → spec tree for approval,
-- instead of building a spec. claim_agent_job() stays kind-agnostic — the box worker
-- branches on `kind`. For a 'plan' job, spec_slug carries the GOAL slug (one active plan
-- per goal, same guard as one active build per spec).
-- See docs/brain/specs/goal-decomposition-engine.md (Phase 3).

alter table public.agent_jobs
  add column if not exists kind text not null default 'build';  -- 'build' | 'plan'
