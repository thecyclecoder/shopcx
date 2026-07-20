-- ticket_improve_chats.seen_at: the per-session read marker for the Improve Queue
-- (improve-queue-mark-read spec). null = never read. A session is "Waiting on you" (unread) when the
-- box has responded / wants you — turn_status in (idle, awaiting_approval, error) — AND it has changed
-- since you last looked: seen_at IS NULL OR updated_at > seen_at. Marking read sets seen_at = updated_at,
-- so a later box turn (which bumps updated_at) re-surfaces it. Reading ≠ approving — a still-parked
-- pending_plan stays separately actionable even once read.
-- See docs/brain/specs/improve-queue-mark-read.md + docs/brain/tables/ticket_improve_chats.md.

alter table public.ticket_improve_chats add column if not exists seen_at timestamptz;
