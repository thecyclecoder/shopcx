# Migration-drift parser: follow ALTER TABLE … RENAME TO ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[../specs/control-tower]] + [[../specs/error-feed-monitoring]] · **Verdict:** monitor-false-positive
**Repair-root-cause:** `src/lib/control-tower/migration-drift.ts::monitor-false-positive`
**Repair-signature:** `loop:migration-drift-check`

Make the Control Tower migration-drift check rename-aware so a table renamed by a later migration is no longer falsely reported as a silently-skipped CREATE. Today the parser only nets CREATE against DROP; a `RENAME TO` leaves the old name stuck in the expected set, reddening the tile even though the live schema is fully correct.

## Problem (from Control Tower signature `loop:migration-drift-check`)
parseExpectedTables() in src/lib/control-tower/migration-drift.ts tracks extractCreatedTables and extractDroppedTables only. Migration 20260705150000_worker_to_agent_rename.sql renames worker_action_grades, worker_grader_prompts, worker_instructions, worker_coaching_log → agent_* (applied; information_schema confirms agent_* present, worker_* absent). With no DROP for the old names, the parser still expects worker_* and computeDrift flags all four as missing → the migration-drift-check loop tile went RED with a bogus 'silently-skipped migration / PGRST205' alert on a healthy DB. Add an extractRenamedTables(sql) helper (regex `\balter\s+table\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?<name>"?\s+rename\s+to\s+"?<name>"?`, comment-stripped like the others) and apply renames in filename order inside parseExpectedTables: for each (old→new), delete old from expected, set new in expected mapped to the migration that first created the original (fallback: the rename migration), and clear/transfer dropped-set membership. Add a unit-style fixture covering create-then-rename so worker_*→agent_* nets to expecting only agent_*. Scope: parser + helper + test, no schema or DB changes.

**Likely target:** `src/lib/control-tower/migration-drift.ts`

## Phase 1 — close it ✅
Scope from the problem above; land the fix + its brain page; gate on `npx tsc --noEmit`.

Shipped: added `extractRenamedTables(sql)` (`ALTER TABLE … RENAME TO …`, comment-stripped, ignores `RENAME COLUMN`) + a pure fs-free `foldMigrations(files)` core that applies create→rename→drop in filename order — `parseExpectedTables` now delegates to it. A renamed table's old name is deleted from `expected`, the new name carried forward mapped to the original's first-creating migration (fallback: the rename file), and dropped-set membership cleared. New unit test `src/lib/control-tower/migration-drift.test.ts` (`npm run test:migration-drift`, 7 cases incl. the worker_*→agent_* create-then-rename net = only agent_*). Brain page `libraries/control-tower.md` updated. `npx tsc --noEmit` clean. Parser-only — no schema/DB changes.

## Verification
- Re-trigger the originating condition (signature `loop:migration-drift-check`) → expect no new error_events row / loop_alert for it, and the Control Tower tile stays green.

> Authored by the box Repair Agent from Control Tower signature `loop:migration-drift-check` (verdict: monitor-false-positive). Commission the build from the Control Tower / Roadmap board.
