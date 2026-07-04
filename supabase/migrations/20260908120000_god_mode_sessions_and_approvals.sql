-- god_mode_sessions + god_mode_approvals: Phase 1 of docs/brain/specs/god-mode.md.
--
-- The founder's ELEVATED bridge to the box. Unlike dev-ask (read-only console),
-- god-mode runs a resumable claude -p session with PROD-WRITE creds through a
-- LIVE per-tool permission gate (Phase 2). This migration is the STATE MODEL only:
--   • god_mode_sessions — one active session per workspace, token-authed cockpit
--   • god_mode_approvals — approvals queue+history for a session
--   • workspaces.god_mode_pin_hash — the PIN (destructive-approval extra check),
--     stored ONLY as a one-way hash (never plaintext; never in a migration).
--
-- Chokepoint (Phase 1 SDK): all WRITES go through src/lib/god-mode.ts. No raw
-- .from('god_mode_sessions'|'god_mode_approvals').insert|update|delete outside
-- the SDK — same discipline as specs-table / goals-table / lander-blueprints.
--
-- Deliberate design notes:
--   • Approvals are their OWN table (not agent_jobs.pending_actions) because
--     god-mode uses a LIVE in-session gate, not the propose-then-worker-executes
--     model. Self-contained also means cleanly removable when the CEO exec layer
--     retires this stopgap (see god-mode.md § sunset).
--   • cockpit_token is 48-char hex (24 random bytes), matching journey_sessions.
--   • Both a sliding TTL (token_expires_at, ~20min bump on activity — Phase 5
--     reaper) AND a hard absolute ceiling (arm+12h) — the founder re-arms with
--     one tap if the incident outlives the ceiling.

create table if not exists public.god_mode_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The owner who armed the session. Only workspace_members.role='owner' can arm
  -- (enforced in the arm route via requireOwner). Kept for audit.
  created_by uuid not null,

  -- Lifecycle:
  --   armed     — active; the cockpit token is live; the box can drive turns.
  --   disarmed  — the founder tore it down (or the cockpit did) — token nulled.
  --   expired   — the Phase-5 reaper closed it (idle past token_expires_at with
  --               no in-flight signal, OR past absolute_expires_at regardless).
  -- Reused across every read path; Phase 5's reaper is the only auto-writer.
  status text not null default 'armed'
    check (status in ('armed', 'disarmed', 'expired')),

  -- 48-char hex (24 random bytes) — the /god/{token} slug. Unguessable, matches
  -- journey_sessions token size. NULLED on disarm/expire so a stale slug can't
  -- reach a dead session. Uniqueness enforced by a partial index below (only
  -- non-null tokens must be unique — a disarmed session can share NULL).
  cockpit_token text,

  -- Sliding TTL — every GET/message/approve/turn bumps this forward (~20min).
  -- The Phase-5 reaper expires a session when now()>token_expires_at AND
  -- nothing is in-flight (no building turn, no pending approval).
  token_expires_at timestamptz,

  -- Hard ceiling — arm + 12h. Independent of activity; the reaper force-disarms
  -- any session past this regardless of what's in flight. The founder re-arms.
  absolute_expires_at timestamptz,

  -- Box session pinning — captured from the `claude -p` stream after each turn
  -- so subsequent turns pass --resume against the SAME Max account. Mirrors
  -- agent_jobs.claude_session_id / claude_session_config_dir. NULL until the
  -- first turn completes.
  box_session_id text,
  box_session_config_dir text,

  -- The transcript. Shape: [{ role: 'user'|'assistant'|'system', content: string, ts: string }].
  -- Same convention as dev_message_threads.messages — the cockpit + dashboard
  -- render straight off this array.
  messages jsonb not null default '[]'::jsonb,

  -- Phase-5 in-flight signal AND liveness bump — every GET/message/approve
  -- pushes this forward alongside token_expires_at. Kept as a distinct column
  -- (not derivable from token_expires_at, which is sliding-window) so the
  -- reaper can distinguish "idle but not yet expired" from "recently active".
  last_activity_at timestamptz not null default now(),

  armed_at timestamptz not null default now(),
  disarmed_at timestamptz,

  created_at timestamptz not null default now()
);

-- Cockpit token lookup — the hot path for every /api/god/[token] request.
-- Partial + UNIQUE because disarmed sessions null the token (many NULLs are OK)
-- but a live token must be globally unique across the table.
create unique index if not exists god_mode_sessions_cockpit_token_key
  on public.god_mode_sessions (cockpit_token)
  where cockpit_token is not null;

-- "The active session for this workspace" — arm() upsert path + the dashboard
-- Phase-4 tab. Partial so the reaper's disarmed rows don't collide.
create unique index if not exists god_mode_sessions_workspace_armed_uniq
  on public.god_mode_sessions (workspace_id)
  where status = 'armed';

-- Reaper scan — "give me the idle armed sessions past their sliding TTL".
create index if not exists god_mode_sessions_reaper_idx
  on public.god_mode_sessions (status, token_expires_at)
  where status = 'armed';

create table if not exists public.god_mode_approvals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.god_mode_sessions(id) on delete cascade,

  -- Denormalized for RLS + fast per-workspace history. Set by the SDK, not the
  -- caller — always mirrors god_mode_sessions.workspace_id.
  workspace_id uuid not null references public.workspaces(id) on delete cascade,

  -- The blocked tool name — 'Bash', 'Edit', 'Write', 'ApplyMigration', etc.
  -- Whatever the Phase-2 permission gate saw. Free-text; the tool vocabulary is
  -- the Claude Code PreToolUse contract, not our concern.
  tool_name text not null,

  -- The raw tool input the gate saw (command string, edit patch, migration SQL).
  -- jsonb because the shape varies per tool_name.
  tool_input jsonb not null,

  -- Human-readable single-string preview the cockpit renders on the approval
  -- card. The gate synthesizes this from tool_input (the command line, the
  -- diff summary, the migration filename). Never null — the founder needs
  -- SOMETHING to decide on.
  preview text not null,

  -- Deterministic classification of the blocked call:
  --   safe        — reserved (safe reads auto-allow without hitting this table).
  --   write       — reversible mutation (Write/Edit/most Bash). Approve→proceed.
  --   destructive — irreversible/prod-scale (drop/delete/truncate/force-push).
  --                 Approve additionally requires the founder PIN (Phase 3).
  risk text not null default 'write'
    check (risk in ('safe', 'write', 'destructive')),

  -- Decision lifecycle:
  --   pending  — the gate is polling; the box tool call is blocked.
  --   approved — the founder let it through. The gate returns allow.
  --   denied   — the founder blocked it. The gate returns deny (no error msg).
  --   asked    — the founder wrote back a QUESTION (question_text). The gate
  --              returns deny-with-message so the box reads it, replies in the
  --              transcript, and re-requests approval. A live back-and-forth.
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'asked')),

  -- Populated only on status='asked' — the founder's question for the box.
  question_text text,

  decided_at timestamptz,

  created_at timestamptz not null default now()
);

-- Gate poll — "is this row still pending?" — the hot path in Phase 2.
create index if not exists god_mode_approvals_gate_poll_idx
  on public.god_mode_approvals (id, status);

-- Cockpit render — pending at top, history below, most recent first.
create index if not exists god_mode_approvals_session_created_idx
  on public.god_mode_approvals (session_id, created_at desc);

-- Workspace-wide approval history (audit / dashboard).
create index if not exists god_mode_approvals_workspace_created_idx
  on public.god_mode_approvals (workspace_id, created_at desc);

-- Founder PIN — the extra check on destructive approvals. Stored ONLY as a
-- one-way hash; the plaintext PIN is set out-of-band via a disposable script
-- (scripts/_set-god-mode-pin.ts) and never lives in the DB or the source tree.
-- Follows the workspaces._encrypted convention only in NAME (this is a hash,
-- not a reversible cipher — hash cannot be reversed to reveal the PIN).
alter table public.workspaces
  add column if not exists god_mode_pin_hash text;

-- RLS: service role only (all god-mode writes go through the SDK with the
-- admin client — no user-facing raw table access). No SELECT policy for
-- workspace members: the cockpit reads via the token-authed service-role API
-- (matches journey_sessions), and the dashboard tab reads via the owner-gated
-- server route. Not exposed to authenticated end-users at all.
alter table public.god_mode_sessions enable row level security;
alter table public.god_mode_approvals enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'god_mode_sessions' and policyname = 'god_mode_sessions_service'
  ) then
    create policy god_mode_sessions_service on public.god_mode_sessions for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
  if not exists (
    select 1 from pg_policies
    where tablename = 'god_mode_approvals' and policyname = 'god_mode_approvals_service'
  ) then
    create policy god_mode_approvals_service on public.god_mode_approvals for all
      using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
  end if;
end $$;
