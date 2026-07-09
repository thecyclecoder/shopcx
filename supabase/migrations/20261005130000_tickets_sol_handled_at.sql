-- tickets.sol_handled_at — deterministic "Sol handled this ticket" signal.
--
-- Stamped by the worker (harness) in scripts/builder-worker.ts runTicketHandleJob
-- when the box session reaches its terminal COMPLETED state (parsed.status ==
-- "completed" and Sol authored a valid direction / drafted a first reply).
-- Written via createAdminClient(), NOT by Sol's in-session writeDirection call —
-- so a silent DB outage on the mid-session direction insert (observed on the
-- first ~6-7 Sol-handled tickets) can no longer hide the fact that Sol handled
-- the ticket. Phase 2 replaces ticket-analysis-cron's brittle
-- `if (!direction) return false` selection gate with `if (!sol_handled_at) return false`,
-- so Cora's grader consumes this deterministic signal instead of a live
-- ticket_directions row.
--
-- Nullable timestamptz — most historical rows have no Sol turn, and the column
-- is idempotent-overwritable (later runs advance to the latest handling). No
-- default: an unstamped row is one Sol has never handled.
--
-- Spec: docs/brain/specs/cora-grades-on-deterministic-sol-handled-signal-not-brittle-direction-existence.md
-- Owner: functions/cs · Parent: cs#fix-weird-tickets-fast-calibrate-so-they-dont-recur

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS sol_handled_at TIMESTAMPTZ;
