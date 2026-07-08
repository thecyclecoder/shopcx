-- tickets.ai_cost_cents — running per-ticket AI cost in whole cents.
--
-- Stamped inline by src/lib/action-executor.ts executeSonnetDecision after
-- each Sonnet turn: sums the ai_token_usage rows this turn produced (matched
-- on ticket_id + created_at >= turn start), converts tokens → cents via
-- src/lib/ai-usage.ts usageCostCents(), and adds the delta.
--
-- Non-null with default 0 so every existing row starts clean and the
-- executor never has to null-guard. Phase 2 backfill will populate historical
-- rows from ai_token_usage.
--
-- Spec: docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md
-- Milestone parent: goals/sol-ticket-direction-then-cheap-execution M5
-- "Cost + quality measurement + the guardrails".

ALTER TABLE public.tickets
  ADD COLUMN IF NOT EXISTS ai_cost_cents BIGINT NOT NULL DEFAULT 0;

-- Atomic increment helper so a per-turn stamp is a single round-trip and
-- concurrent turns on the same ticket (rare — the unified handler serializes
-- per-ticket, but a merge-time cross-ticket re-fire can race) don't lose an
-- increment to a read-modify-write. SECURITY DEFINER + service-role grant so
-- only the executor can call it.
CREATE OR REPLACE FUNCTION public.add_ticket_ai_cost(
  p_ticket_id UUID,
  p_delta BIGINT
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.tickets
     SET ai_cost_cents = ai_cost_cents + p_delta
   WHERE id = p_ticket_id;
$$;

REVOKE ALL ON FUNCTION public.add_ticket_ai_cost(UUID, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_ticket_ai_cost(UUID, BIGINT) TO service_role;
