# Recipe: Recover live data with PITR (disaster runbook) (`pitr-disaster-recovery`)

**The under-fire procedure when a migration / prod-script / agent action destroyed live data** — a cascade delete, an unfiltered `DELETE`/`UPDATE`, a dropped table. Don't figure this out mid-incident; follow it. Point-in-Time Recovery is ENABLED on the Supabase project (turned on 2026-07-03), second-granularity, ~14-day retention window (verify the current window in the dashboard). This is the reversibility backstop the [[../specs/destructive-migration-safety-rails]] design leans on — the last line of defence, not the first.

> **Who reads this:** the CEO / operator during a data-loss incident, and any agent proposing a destructive DB change (so it knows the recovery cost of a wrong call). Prevention lives in [[../specs/destructive-migration-safety-rails]]; this page is what you do when prevention failed.

## The one decision that changes everything: SCOPED vs TOTAL

**A PITR restore rolls back the ENTIRE database, never a single table.** So the first question is whether the damage is scoped (specific rows/tables) or total (the whole DB is unusable) — because an in-place restore to undo one bad `DELETE` would *also* throw away every legitimate order, ticket, and write since the incident.

- **Scoped** (99% of cases — "an agent deleted rows from table X") → **Path A**. Prod stays live; you surgically re-insert the lost rows.
- **Total** (the whole DB is corrupt and losing recent writes is acceptable) → **Path B**, the nuclear option.

## Path A — Scoped loss: restore to a NEW project, extract, re-import (NO prod downtime)

This is almost always the right path. Prod keeps taking orders the entire time.

1. **Stop the bleeding.** Pause whatever caused it so it can't re-run — drain the box (`worker_controls.drain_for_update`), disable the offending cron/agent, or revert the bad code. Confirm the destructive op isn't still firing.
2. **Restore a clone as of just before the incident.** Dashboard → **Database → Backups → Restore to a New Project** → for a PITR project, use the **date/time selector** to pick the exact second BEFORE the damage → **Restore**. (It shows projected cost first.) Prod is untouched — no downtime on the source.
3. **Extract the lost rows from the clone.** Connect to the new project's connection string and `pg_dump`/`COPY` the affected table(s) or just the deleted rows as of that timestamp.
4. **Re-import into LIVE prod, reconciling.** Insert only the missing rows back into prod — `INSERT … ON CONFLICT DO NOTHING`, or a targeted load — so you restore what was lost WITHOUT clobbering good writes that landed after the incident. Never a blind full-table overwrite.
5. **Verify + resume.** Check row counts against expectation, un-drain the pipeline, write an incident note (what ran, blast radius, what was recovered).

**Caveats:** the clone includes schema/data/indexes/roles/auth users but EXCLUDES Storage objects, edge functions, DB extensions, and realtime config (you only need DB rows here, so fine). A clone can't itself be cloned further.

## Path B — Total corruption: in-place PITR restore (destructive to recent writes)

Only when the whole database is unusable and losing every write since the incident is acceptable.

1. **Freeze writes** — the app goes down for this.
2. Dashboard → **Backups** → restore the **existing** project to the pre-incident timestamp. This rolls the WHOLE database back; **every write after that point is gone** (the RPO loss — orders/tickets since the incident).
3. Accept the downtime + data loss, bring the app back, reconcile external systems (Shopify/Appstle/Stripe) against the rolled-back state.

Prefer Path A whenever the damage is scoped — Path B trades a bounded data loss for a much larger one.

## Key facts

- **Whole-DB, not table-level.** PITR has no per-table restore; Path A's clone-and-extract IS the table/row-level recovery mechanism.
- **Retention:** ~14 days on the current plan (verify). Older than that → only daily physical backups exist.
- **Restore-to-new-project = zero prod downtime** — the safe default and why Path A beats Path B.
- **Excluded from any restore:** Storage objects, edge functions, DB extensions, realtime config, read replicas — reconfigure manually on a full cutover.
- **Even a wrong "yes" is recoverable via Path A** — this is what makes it safe to delegate the final call on reversible DB changes to Ada (the CTO seat); see [[../operational-rules]] § North star and [[../specs/destructive-migration-safety-rails]].

## Related

[[../specs/destructive-migration-safety-rails]] · [[../operational-rules]] · [[write-a-migration-apply-script]] · [[../libraries/platform-director]] · [[../functions/platform]]
