import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s = await authorSpecRowStructured(WS, "ci-guard-migrations-applied-not-just-merged", {
    title: "Guard against merged-but-unapplied migrations (applied-state drift), not just missing ones",
    why: "The 2026-07-07 order_refunds incident had TWO layers. The sibling spec catches code that references a table with NO migration. But the deeper root cause was different: the refund-integrity migration that creates order_refunds merged to main on 2026-07-06 and was NEVER APPLIED to prod, so the guard code (and a later re-scope) ran against a table that did not exist — a silent runtime no-op caught only by a human days later. A migration that is merged but never applied is invisible to a static file check: the file exists, so 'does this table have a migration' passes, yet the table isn't in the database. This applied-state drift is the actual failure mode and it is broader than the missing-migration case — any merged migration can silently fail to apply and leave dependent code inert.",
    what: "Extend the existing control-tower migration-drift detection to reconcile the migration FILES on main against the database's record of APPLIED migrations, surfacing any migration that is merged but not applied — and close the loop so such a migration is alerted on and applied, never left merged-but-inert.",
    summary: "**Brain refs:** [[../libraries/control-tower]] [[../operational-rules]] [[../recipes/write-a-migration-apply-script]]. Grounded in the 2026-07-07 incident: 20260918120000_order_refunds_mirror (refund-integrity #1244) merged 2026-07-06 but was never applied — order_refunds did not exist in prod until a manual apply, and the merged guard code silently no-oped. Extends the existing migration-drift machinery (src/lib/control-tower/migration-drift.ts computeDrift + the migration-drift-check tile). Sibling of [[../specs/ci-guard-table-refs-have-migrations]] (catches the no-migration case; this catches the merged-but-unapplied case).",
    owner: "platform",
    parent: '[[../functions/platform]] — "Autonomous build platform" mandate: a migration that merges to main must actually apply to the database — a merged-but-unapplied migration must be surfaced and applied, never leave dependent code silently inert.',
    blocked_by: ["ci-guard-table-refs-have-migrations"],
    phases: [
      {
        title: "Phase 1 — reconcile migration files on main against the DB's applied set",
        why: "The failure is invisible to a static file check because the file exists; only comparing files-on-main against what the database has actually applied reveals a merged-but-unapplied migration.",
        what: "A reconciler that reads the migration versions present in supabase/migrations on main and the versions the database records as applied, and reports any migration merged but not applied — wired into the existing migration-drift-check tile.",
        body: "Extend src/lib/control-tower/migration-drift.ts: read the set of migration versions from supabase/migrations/*.sql on main and the set the DB records as applied (the supabase_migrations.schema_migrations history), and compute the merged-but-unapplied set (on main, not in applied). Surface it on the existing migration-drift-check control-tower tile ([[../libraries/control-tower]]) alongside the current rename-tracking drift. Ignore the benign reverse case (applied-but-not-in-local-files) except as an informational note. Cite computeDrift + the applied-migrations source.",
        verification: "Given a migration file present on main whose version is not in the DB's applied set, the reconciler reports it as merged-but-unapplied (regression pin for 20260918120000_order_refunds_mirror). A fully-applied repo reports zero merged-but-unapplied. The reverse (applied version with no local file) does not raise a false merged-but-unapplied alarm.",
        status: "planned",
      },
      {
        title: "Phase 2 — close the loop: alert + apply, never leave it inert",
        why: "Detection alone repeats the incident if nobody acts; a merged migration that isn't applied must trigger an alert and an apply so dependent code is never left running against a missing schema.",
        what: "When the reconciler finds a merged-but-unapplied migration, it raises a control-tower alert and applies it via the standard apply-script path (or gates the apply for approval when the migration is non-additive), so the merged-but-inert state cannot persist silently.",
        body: "On a detected merged-but-unapplied migration, raise a control-tower alert (the migration-drift-check tile goes red with the version named) and apply it using the sanctioned apply pattern ([[../recipes/write-a-migration-apply-script]] pgClient pooler) — auto-apply for additive/idempotent DDL, gate for approval when classifyMigrationSql flags it destructive ([[../operational-rules]] destructive-migration rails). Re-check after apply so a resolved drift clears the tile. Cite the apply pattern + the destructive-migration classifier.",
        verification: "A detected merged-but-unapplied additive migration is applied automatically and the tile clears; a destructive one is surfaced for approval rather than auto-applied. After a successful apply the reconciler reports zero drift. The alert names the specific migration version.",
        status: "planned",
      },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#build" });
  console.log("applied-drift follow-up spec:", s ? "authored" : "FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
