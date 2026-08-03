-- one-open-escalation-per-thing Phase 1: make dedupe_key AUTHORITATIVE at the DB level.
--
-- Why: on 2026-07-28 02:30 UTC the escalation mint path produced 320,734 undismissed
-- "Escalation needs your call: <uuid>" rows for a handful of dedupe_keys, 864 in a single minute.
-- The mint site had a read-then-write dedupe check, but that races under concurrent sweeps — two
-- passes both read "no prior card" and both insert. Nothing at the DB level made the
-- metadata.dedupe_key unique on OPEN cards, so the amplification was unbounded.
--
-- What: a UNIQUE partial index on ((metadata->>'dedupe_key')) WHERE dismissed = false. The mint site
-- upsert is the visible path (bump counter + last_seen_at on an existing OPEN card, or insert one).
-- This index is the last-resort guarantee — a second concurrent insert for the same open dedupe_key
-- rejects at 23505 unique_violation instead of creating a duplicate. Partial on `dismissed = false`
-- because a dismissed card is a resolved state — the founder is telling us "this thing was
-- surfaced, deal with it"; a subsequent re-mint against a fresh dedupe_key is a legitimate signal.
--
-- Safe to create today: at the moment of write, all offending rows (the 320,734 spillover) already
-- carry dismissed = true (the founder dismissed them en masse). The partial predicate keeps them
-- out of the index build, so this migration will not conflict with historical data. If a workspace
-- ever DOES have >1 open card for the same dedupe_key at index-build time, the migration will
-- error (unique_violation on build) — that's the correct outcome; the operator resolves the
-- duplicates by dismissing the older ones, then re-runs.

create unique index if not exists dashboard_notifications_dedupe_key_open_uniq
  on public.dashboard_notifications ((metadata->>'dedupe_key'))
  where dismissed = false and metadata ? 'dedupe_key';

comment on index public.dashboard_notifications_dedupe_key_open_uniq is
  'One open card per dedupe_key. A concurrent mint for the same key rejects at 23505 unique_violation instead of duplicating; the emitter upserts (bump escalation_seen_count + escalation_last_seen_at on the existing OPEN card) so the DB constraint is the last-resort backstop, never the visible failure path. See one-open-escalation-per-thing-and-a-founder-answer-stops-the-asking Phase 1.';
