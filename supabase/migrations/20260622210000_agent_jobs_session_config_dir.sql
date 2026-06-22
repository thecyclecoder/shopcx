-- box-multi-account-failover Phase 1: the box runs `claude` on Max across a POOL of accounts, each an
-- isolated CLAUDE_CONFIG_DIR. A `claude --resume <session>` only works under the SAME config dir that
-- CREATED the session — a cross-account resume always fails "No conversation found" (learned + proven
-- 2026-06-22). So persist the account (config dir) that created each session alongside claude_session_id;
-- the worker pins every resume to it, and starts fresh on a healthy account only if that one is capped.
-- Note: `blocked_on_usage` is a new agent_jobs.status VALUE (status is free text, no CHECK constraint) —
-- the row is parked there when every account is at its usage wall and the worker auto-requeues it once an
-- account resets. That needs no schema change; only this column is new.
alter table public.agent_jobs
  add column if not exists claude_session_config_dir text;
