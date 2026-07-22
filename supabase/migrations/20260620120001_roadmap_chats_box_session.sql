-- Box-hosted spec chat (docs/brain/specs/box-spec-chat.md).
-- The roadmap authoring chat moves off the Anthropic API onto the build box as a long-running,
-- resumable `claude -p` session on Max. Each user turn enqueues a kind='spec-chat' agent_jobs row
-- that resumes the SAME box session; the thread itself stays the roadmap_chats row. Three new columns
-- carry the resume handle + the per-turn lifecycle so the UI can poll while the box thinks.
--   box_session_id — the `claude -p` session id; null = no box turn has run yet (turn 1 starts fresh).
--   turn_status    — idle | thinking | error. 'thinking' while a spec-chat job is in flight; the
--                    composer disables + shows "thinking on the box…" until it returns to 'idle'.
--   last_error     — the failure reason surfaced when turn_status='error' (UI shows a retry affordance).
-- 'spec-chat' is just a new agent_jobs.kind value (no CHECK constraint on kind; claim_agent_job takes a
-- dynamic p_kinds array) so the worker's concurrency-1 spec-chat lane needs no further DB change.
alter table public.roadmap_chats
  add column if not exists box_session_id text,
  add column if not exists turn_status text not null default 'idle',
  add column if not exists last_error text;
