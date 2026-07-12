-- logistics_director_function_autonomy_seed — scaffold the Logistics Director (Marco) seat at
-- the safest leash (marco-logistics-director-seat spec, Phase 3 — READ-ONLY landing; the
-- behavior stays escalate-to-CEO for every card until marco-logistics-executor-surface lands).
--
-- The `function_autonomy` table is keyed by `function_slug` (one row per docs/brain/functions/{slug}.md
-- director; there is no `agent_name` or `autonomy_level` column — the "leash" is the (live, autonomous)
-- boolean pair per docs/brain/tables/function_autonomy.md). The initial 20260701120000 ALL-OFF seed
-- did NOT include 'logistics' (the org-chart function landed later, 2026-07-10). This migration
-- inserts a dormant `logistics` row (`live=false, autonomous=false`) — the safest leash: the
-- approval router walks past a non-live director and falls through to the CEO, so no
-- logistics-owned approval is auto-decided until the CEO flips the row live from the Agents hub.
--
-- This is the EXPLICIT scaffold action for the Logistics Director seat: it stamps the audit trail
-- (`updated_by` + `updated_at`) so the ledger records why this row exists — the M5 seat
-- deliberately claimed at the safest leash for a read-only observer. Compare-and-set on
-- ON CONFLICT DO UPDATE — it only refreshes the audit stamps when the row is STILL at
-- `(false, false)`; if the CEO has since flipped `logistics` live (or autonomous) via
-- `POST /api/developer/agents/autonomy`, the WHERE clause fails and this migration leaves the row
-- untouched — the scaffold never demotes an already-activated director.
--
-- Idempotent: re-running against a row already at (false, false) simply re-stamps the audit
-- note; running against an activated row is a no-op. Never destructive.

insert into public.function_autonomy (function_slug, live, autonomous, updated_by, updated_at)
values ('logistics', false, false, 'marco-logistics-director-seat Phase 3 scaffold — read-only observer', now())
on conflict (function_slug) do update
  set updated_by = excluded.updated_by,
      updated_at = now()
  where function_autonomy.live = false
    and function_autonomy.autonomous = false;
