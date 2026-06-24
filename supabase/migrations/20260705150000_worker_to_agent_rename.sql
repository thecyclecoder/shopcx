-- Org-tier "worker" → "agent" rename: unify the L2 vocabulary on "agent" (matches agent_jobs).
-- Renames ONLY the org-tier grading/coaching tables + their worker_kind column. The box-daemon
-- worker_heartbeats table is a DIFFERENT concept (the build-worker process) and is intentionally NOT
-- touched. Data is preserved (ALTER … RENAME). Idempotent via IF EXISTS + drop/recreate of policies.

-- ── tables ────────────────────────────────────────────────────────────────────
alter table if exists public.worker_action_grades rename to agent_action_grades;
alter table if exists public.worker_grader_prompts rename to agent_grader_prompts;
alter table if exists public.worker_instructions  rename to agent_instructions;
alter table if exists public.worker_coaching_log  rename to agent_coaching_log;

-- ── the worker_kind column → agent_kind (it stores agent_jobs.kind) ─────────────
alter table if exists public.agent_action_grades rename column worker_kind to agent_kind;
alter table if exists public.agent_grader_prompts rename column worker_kind to agent_kind;
alter table if exists public.agent_instructions  rename column worker_kind to agent_kind;
alter table if exists public.agent_coaching_log  rename column worker_kind to agent_kind;

-- ── indexes (cosmetic rename so the prefix matches the table) ───────────────────
alter index if exists worker_action_grades_job_uniq    rename to agent_action_grades_job_uniq;
alter index if exists worker_action_grades_ws_idx       rename to agent_action_grades_ws_idx;
alter index if exists worker_action_grades_worker_idx   rename to agent_action_grades_agent_idx;
alter index if exists worker_grader_prompts_ws_status_idx rename to agent_grader_prompts_ws_status_idx;
alter index if exists worker_grader_prompts_worker_idx  rename to agent_grader_prompts_agent_idx;
alter index if exists worker_instructions_load_idx      rename to agent_instructions_load_idx;
alter index if exists worker_instructions_class_idx     rename to agent_instructions_class_idx;
alter index if exists worker_coaching_log_worker_idx    rename to agent_coaching_log_agent_idx;
alter index if exists worker_coaching_log_class_idx     rename to agent_coaching_log_class_idx;

-- ── RLS policies (drop + recreate under the new names; same rules) ──────────────
do $$
declare t text;
begin
  foreach t in array array['agent_action_grades','agent_grader_prompts','agent_instructions','agent_coaching_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', 'worker_'||substr(t,7)||'_select', t);  -- best-effort old-name cleanup
    execute format('drop policy if exists %I on public.%I', t||'_select', t);
    execute format('create policy %I on public.%I for select to authenticated using (auth.uid() is not null)', t||'_select', t);
    execute format('drop policy if exists %I on public.%I', 'worker_'||substr(t,7)||'_service', t);
    execute format('drop policy if exists %I on public.%I', t||'_service', t);
    execute format('create policy %I on public.%I for all to service_role using (true) with check (true)', t||'_service', t);
  end loop;
end $$;
