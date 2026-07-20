-- cs_director_function_autonomy_seed — scaffold the CS Director seat at the safest leash
-- (cs-director-persona-and-org-placement spec, Phase 2; identity + placement only — behavior
-- lands in the downstream M5 specs).
--
-- The `function_autonomy` table is keyed by `function_slug` (one row per docs/brain/functions/{slug}.md
-- director; there is no `agent_name` or `autonomy_level` column — the "leash" is the (live, autonomous)
-- boolean pair per docs/brain/tables/function_autonomy.md). The `cs` row already exists at
-- `(live=false, autonomous=false)` from the 20260701120000 ALL-OFF seed — that IS the safest leash
-- ("dormant"): the approval router walks past a non-live director and falls through to the CEO,
-- so no CS-owned approval is auto-decided until the CEO flips the row live from the Agents hub.
--
-- This migration is the EXPLICIT scaffold action for the CS Director seat: it stamps the audit
-- trail (`updated_by` + `updated_at`) so the ledger records why this row exists — the M5 seat
-- deliberately claimed at the safest leash. It is a **compare-and-set**: it only updates the
-- audit stamps when the row is STILL at `(false, false)`; if the CEO has since flipped `cs` live
-- (or autonomous) via `POST /api/developer/agents/autonomy`, the WHERE clause fails and this
-- migration leaves the row untouched — the scaffold never demotes an already-activated director.
--
-- Idempotent: re-running against a row already at (false, false) simply re-stamps the audit
-- note; running against an activated row is a no-op. Never destructive.

insert into public.function_autonomy (function_slug, live, autonomous, updated_by, updated_at)
values ('cs', false, false, 'cs-director M5 scaffold — safest leash', now())
on conflict (function_slug) do update
  set updated_by = excluded.updated_by,
      updated_at = now()
  where function_autonomy.live = false
    and function_autonomy.autonomous = false;
