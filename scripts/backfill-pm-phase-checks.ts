/**
 * Backfill pm-structured-intent-and-refs Phase 3 — hydrate spec_phase_checks from every existing
 * `spec_phases.verification` blob. Splits the free-text verification into bullet-line check rows
 * via `parseVerificationBlobToChecks`; every check lands `kind='auto'` (the safe default — the
 * spec-test agent re-classifies to `human` when it can't run the check).
 *
 * Idempotent: for each phase we DELETE the existing spec_phase_checks rows then INSERT the freshly
 * parsed set. A rerun with no verification changes converges on the same row set.
 *
 * DRY-RUN by default; pass `APPLY=1` to write.
 *
 * Run:
 *   npx tsx scripts/backfill-pm-phase-checks.ts               # dry-run
 *   APPLY=1 npx tsx scripts/backfill-pm-phase-checks.ts       # write
 */
import { pgClient } from "./_bootstrap";
import { parseVerificationBlobToChecks } from "../src/lib/spec-phase-checks-table";

const APPLY = process.env.APPLY === "1";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const { rows: phases } = await c.query<{
      id: string;
      spec_id: string;
      position: number;
      verification: string | null;
    }>(`
      select p.id, p.spec_id, p.position, p.verification
      from public.spec_phases p
    `);
    console.log(`Scanning ${phases.length} spec_phases…`);

    let rowsWritten = 0;
    let phasesHydrated = 0;
    let phasesSkipped = 0;

    for (const p of phases) {
      const checks = parseVerificationBlobToChecks(p.verification);
      if (!checks.length) { phasesSkipped++; continue; }
      phasesHydrated++;
      rowsWritten += checks.length;
      console.log(`  phase ${p.id.slice(0, 8)}… (spec ${p.spec_id.slice(0, 8)}…, pos ${p.position}) — ${checks.length} check(s)`);
      if (APPLY) {
        await c.query("delete from public.spec_phase_checks where phase_id = $1", [p.id]);
        for (const check of checks) {
          await c.query(
            "insert into public.spec_phase_checks (phase_id, position, description, kind) values ($1, $2, $3, $4)",
            [p.id, check.position, check.description, check.kind],
          );
        }
      }
    }

    console.log(``);
    console.log(`Summary${APPLY ? " (APPLIED)" : " (dry-run — pass APPLY=1 to write)"}:`);
    console.log(`  phases hydrated : ${phasesHydrated}`);
    console.log(`  phases skipped  : ${phasesSkipped} (no verification blob)`);
    console.log(`  check rows      : ${rowsWritten}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
