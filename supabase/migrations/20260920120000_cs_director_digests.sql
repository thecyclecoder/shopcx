-- cs_director_digests — one row per composed weekly CS Director → Founder storyline digest.
--
-- Phase 1 of docs/brain/specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply.md
-- (parent goal: guaranteed-ticket-handling → M5 "The autonomous CS Director"). The digest REPLACES
-- the per-ticket founder-escalation firehose with a BATCHED storyline digest: the composer cron
-- ([[../inngest/cs-director-digest-composer]]) rolls up (a) recent cs-director-call verdicts, (b)
-- recurring problem patterns in `ticket_resolution_events`, and (c) precedent judgment calls tagged
-- for CEO review into a single `storylines` array per period.
--
-- Written by src/lib/cs-director-digest.ts `composeCsDirectorDigest` (insert) — invoked by the weekly
-- `cs-director-digest-composer` cron. Phase 2 will surface the row on the /dashboard/agents/cs-director/
-- digests route and stamp `ceo_replied_at` + `ceo_reply_action` when the founder acts on a storyline.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes) so the apply script is safely re-runnable.

CREATE TABLE IF NOT EXISTS public.cs_director_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  digest_period_start timestamptz NOT NULL,
  digest_period_end timestamptz NOT NULL,
  -- Array of { kind: 'early_warning' | 'precedent_call', title, evidence, proposed_action }.
  -- `evidence` is free-form (may embed row-ids, counts, ticket-ids the digest cited); `proposed_action`
  -- is the machine-readable seed Phase 2's reply surface consumes ({ type: 'widen_leash' | 'tighten_leash'
  -- | 'add_policy' | 'add_rule' | null, ... }). Default `[]` lets the row exist even on a quiet week.
  storylines jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Phase 2 stamps: the founder's disposition (one per digest — a single "reply" applies across the
  -- storylines panel). NULL until the CEO acts.
  ceo_replied_at timestamptz,
  ceo_reply_action jsonb,
  CONSTRAINT cs_director_digests_period_ordered CHECK (digest_period_end > digest_period_start),
  CONSTRAINT cs_director_digests_storylines_is_array CHECK (jsonb_typeof(storylines) = 'array')
);

-- Read-path: "latest digest for this workspace" — Phase 2's dashboard route reads the newest row
-- to render the CEO surface, and the composer reads it to dedupe (one digest per period).
CREATE INDEX IF NOT EXISTS cs_director_digests_workspace_created_idx
  ON public.cs_director_digests (workspace_id, created_at DESC);

-- Read-path: "digests overlapping this period" — the composer's idempotency check ("did I already
-- compose the digest for this week?") uses (workspace, digest_period_start).
CREATE INDEX IF NOT EXISTS cs_director_digests_workspace_period_idx
  ON public.cs_director_digests (workspace_id, digest_period_start DESC);

-- RLS: service-role only. Every write goes through `createAdminClient()` from
-- src/lib/cs-director-digest.ts (see CLAUDE.md "All writes go through createAdminClient()").
ALTER TABLE public.cs_director_digests ENABLE ROW LEVEL SECURITY;
