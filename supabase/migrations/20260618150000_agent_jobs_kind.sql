-- Goal Decomposition Engine: agent_jobs grows a `kind` so the box worker can run TWO kinds of job
-- off the same queue + claim_agent_job() RPC. 'build' (default, existing behavior — build a spec to
-- a PR) | 'plan' (run the plan-goal skill against a goal/mandate → propose a milestone→spec tree for
-- approval, then auto-author the approved specs + queue their builds). claim_agent_job() stays
-- kind-agnostic; the worker branches on this column. See docs/brain/specs/goal-decomposition-engine.md.
alter table public.agent_jobs
  add column if not exists kind text not null default 'build';

-- One active PLAN per goal mirrors "one active build per spec": the slug column holds the goal slug
-- for plan jobs, so the existing (workspace_id, spec_slug, created_at) index already covers the guard.
