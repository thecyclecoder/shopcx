# Restore storefront_lever_importance.seeded_from on live DB

**Owner:** [[../functions/growth]] · **Parent:** extends [[../specs/regression-agent]] · **Regression-of:** [[storefront-lever-importance-memory]]
**Regression-signature:** `regression:storefront-lever-importance-memory:0b3c6be54084`

Restore the M2 lever-importance memory's posterior persist path. The live storefront_lever_importance table is missing the seeded_from column; the original migration creates it with CREATE TABLE IF NOT EXISTS so the column was never added retroactively, and every updatePosterior INSERT now fails (PostgREST 42703), leaving the learned posterior store empty and the funnel-dashboard panel hidden. Ship an additive ALTER TABLE migration so the live schema matches the migration file, the bandit can commit learnings again, and the 'What the agent believes matters' panel re-appears once any posterior is written.

## What regressed
M2 spec ✅ behaviour: updatePosterior writes a new row to storefront_lever_importance with seeded_from ∈ {cro_prior, general_transfer}; the dashboard panel surfaces those posteriors with their vs-prior delta. Both broke when the live DB ended up without the seeded_from column the migration file declares.

## Offending change
Schema drift between supabase/migrations/20260624120000_storefront_levers.sql (which declares seeded_from) and the live storefront_lever_importance table (which has 14 cols, no seeded_from). Because the migration uses CREATE TABLE IF NOT EXISTS, the table created at an earlier point without the column was never altered to match. src/lib/storefront/lever-memory.ts:301-314 INSERTs seeded_from on every new cell, so PostgREST returns 400/42703 and the persist path is fully blocked.

## Phase 1 — restore it
Add a tiny additive migration supabase/migrations/<next>_storefront_lever_importance_seeded_from.sql containing `alter table public.storefront_lever_importance add column if not exists seeded_from text not null default 'cro_prior';` (and `update public.storefront_lever_importance set seeded_from = 'cro_prior' where seeded_from is null;` defensively). Wire it into scripts/apply-storefront-lever-memory-migration.ts (append to MIGRATIONS) so the existing verification script applies both. No src/ code change is required — lever-memory.ts already INSERTs the column.
Gate on `npx tsc --noEmit`.

## Verification
- Run `npx tsx scripts/apply-storefront-lever-memory-migration.ts` → expect `✓ public.storefront_lever_importance has 15 columns` (the additive ALTER lands), the unique index `storefront_lever_importance_cell_uniq` and `storefront_levers_parent_idx` both still present in pg_indexes.
- Direct PostgREST probe `admin.from('storefront_lever_importance').select('id, seeded_from').limit(1)` → HTTP 200, no error (was 400/42703 before). Re-run the spec-test harness `_spec-test-harness-lever-math.ts` → still 14/14 (no regression on the pure math).
- Call `updatePosterior` with a fresh hero-`image` experiment for Amazing Coffee that has a meaningful proxy lift (or let M1 refresh promote one) → `select importance, prior, n_tests, evidence, seeded_from from storefront_lever_importance sli join storefront_levers sl on sl.id=sli.lever_id where sl.lever_key='image';` → row written with `importance > prior`, `n_tests = 1`, the experiment id in `evidence`, `seeded_from='cro_prior'` (or `'general_transfer'` if a general learning seeded it). Re-running with the same experiment id → `n_tests` stable (idempotent dedup still holds).
- Browse `/dashboard/storefront/funnel` after at least one posterior row exists → the 'What the agent believes matters' panel renders (was hidden by the empty-array guard) and lists the lever with `importance`, `vs prior`, scope, tests, and last-tested age.
- Re-run spec-test on [[storefront-lever-importance-memory]] → expect its previously-failing verification check(s) pass again (the original ✅ holds).

> Authored by the box Regression Agent — a confirmed regression of [[storefront-lever-importance-memory]] (signature `regression:storefront-lever-importance-memory:0b3c6be54084`). The DevOps Director queues the build (auto-approve within its leash; pre-M4 the CEO queues it).
