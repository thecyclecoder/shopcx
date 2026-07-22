-- Phase 1 of docs/brain/specs/sol-dispatch-matches-journey-playbook-workflow-via-sdk-not-freeform-cta.md
--
-- Extends the ticket_direction_path enum with a fourth value: 'journey'. Sol's first-touch box
-- session now names the specific matched mechanism on the Direction — a real catalog row, not a
-- prose "click below" — so downstream cheap-execution (Phase 2) can APPLY the mechanism
-- deterministically (launchJourneyForTicket / startPlaybook) instead of composing a freeform
-- reply that references a button that was never launched.
--
-- Existing values: 'playbook' | 'stateless' | 'needs_info' — see
-- supabase/migrations/20260925120000_ticket_directions.sql. The new 'journey' value pairs with
-- plan.journey_slug, and writeDirection at src/lib/ticket-directions.ts gates the slug against
-- public.journey_definitions before the row lands (is_active=true, workspace-scoped) — the same
-- "confirming predicate at the action point" pattern the existing playbook_slug gate applies
-- (learning #2), so an unknown slug bails HERE, not at the executor.
--
-- Idempotent (ADD VALUE IF NOT EXISTS). ALTER TYPE ADD VALUE cannot run inside a wrapping
-- transaction on older Postgres versions; the pooler runs migrations as top-level statements so
-- this is safe as-is. Re-runs are a no-op once 'journey' is present.

ALTER TYPE public.ticket_direction_path ADD VALUE IF NOT EXISTS 'journey';
