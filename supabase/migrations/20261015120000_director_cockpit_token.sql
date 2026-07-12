-- director-sms-cockpit-per-director Phase 1 — a per-director SMS cockpit token.
--
-- The founder needs the SAME reach as the web coach chat from her phone, bounded to
-- ONE director's leash. This adds Eve's cockpit_token / sliding + absolute TTLs / SMS
-- notified-at columns to director_coach_threads so an armDirectorCockpit call mints a
-- 48-hex ticket the /god/[token] surface can resolve to that thread. The token space
-- is DISJOINT from god_mode_sessions.cockpit_token — src/lib/cockpit-resolver.ts is
-- the single chokepoint that decides director vs god vs unknown.
--
-- Additive + nullable — safe to apply ahead of the SDK. See
-- docs/brain/specs/director-sms-cockpit-per-director.md.

alter table public.director_coach_threads
  add column if not exists cockpit_token text,
  add column if not exists token_expires_at timestamptz,
  add column if not exists absolute_expires_at timestamptz,
  add column if not exists sms_notified_at timestamptz;

-- A live cockpit token must be unique across ALL director threads so the /god/[token]
-- resolver can look one up by cockpit_token alone. Partial index: null tokens (a
-- thread with no cockpit armed) coexist freely.
create unique index if not exists idx_director_coach_threads_cockpit_token
  on public.director_coach_threads (cockpit_token)
  where cockpit_token is not null;
