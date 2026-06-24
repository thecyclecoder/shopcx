-- no-parked-specs-auto-route-needs-attention Phase 0 — classify the park reason.
--
-- needs_attention is currently a terminal state for the build worker — it punts, writes a reason, and
-- waits for a human to triage. This spec turns it into a CLASSIFICATION GATE: every park is auto-routed
-- (fold / child spec / chat) within minutes. Phase 0 adds the classification column the routers read.
--
-- `needs_attention_class` ∈ already_shipped | real_blocker | tooling_failure | design_change | unknown.
-- Free text (no CHECK) so a new class can land code-side without a schema migration — matches the same
-- approach as the `status` column (also free text). NULL = not yet classified (a fresh park before the
-- worker's classifier ran, or a pre-migration backfill row); the standing classifier sweep stamps it.
--
-- `spec_card_state.flags.last_park_class` mirrors the latest class on the spec's card so the board can
-- render a routing hint without joining agent_jobs. The flag lives on the existing `flags` jsonb (the
-- spec-status-db-driven Phase 1 pattern: critical / deferred ride on flags, no new schema for them).
-- We stamp it in code, not via DDL — no migration needed for the mirror.
--
-- Additive + nullable + indexed for the cron sweep. Safe to apply ahead of the code.

alter table public.agent_jobs
  add column if not exists needs_attention_class text;

create index if not exists agent_jobs_needs_attention_class_idx
  on public.agent_jobs (workspace_id, needs_attention_class, created_at desc)
  where status = 'needs_attention';
