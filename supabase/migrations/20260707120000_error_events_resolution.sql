-- fix-error-reconcile-endless-loop — Phase 1 (see docs/brain/specs/fix-error-reconcile-endless-loop.md).
--
-- The repair-agent dispositions an error but the error_events row was left `open`, so every standing
-- reconcile pass re-scanned (and re-churned) the same signatures — an endless loop that drains nothing.
-- Phase 1 drives EVERY disposition to a terminal `resolved` state WITH a recorded reason, so a
-- dispositioned error leaves the open feed exactly once and the reconcile never re-processes it.
--
-- Two additive columns carry that "why it's terminal" on the row itself (the director_activity feed
-- records the reconcile move; these record the row's own disposition):
--   resolved_at        — when the disposition flipped this row off `open` (null while open).
--   resolution_reason  — the recorded reason ("fix [[slug]] authored, pending deploy" / "transient: …"
--                        / "needs-human: …" / "dismissed by owner" / stale-backlog park, …).
--
-- Note: status stays the existing open|resolved CHECK — a needs-human item is `resolved` on the row
-- (its terminal needs_attention-equivalent lives on the repair agent_jobs row, which the Control Tower
-- repair feed + director supervision read independently of error_events.status). A genuine re-fire
-- re-opens the row via recordError's existing update path, so resolving is reversible.

alter table public.error_events add column if not exists resolved_at timestamptz;
alter table public.error_events add column if not exists resolution_reason text;
