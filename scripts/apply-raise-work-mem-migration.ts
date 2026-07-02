// apply-raise-work-mem-migration — owner-approval-only raise of `work_mem` (+
// `hash_mem_multiplier`) on the `authenticated` role. DB Health Agent signature
// `dbhealth:instance:temp_spill_pressure`; see docs/brain/recipes/raise-work-mem.md.
//
// NEVER auto-run by the build worker (mirrors docs/brain/libraries/db-health.md § North star).
// Owner reviews the migration + this script in the PR, then executes here after merge:
//   npx tsx scripts/apply-raise-work-mem-migration.ts
//
// Idempotent — ALTER ROLE ... SET is safe to re-apply; a re-run just re-sets the same value.
// Rollback: `alter role authenticated reset work_mem;` + `... reset hash_mem_multiplier;`.
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260811120000_raise_authenticated_work_mem.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select rolconfig from pg_roles where rolname = 'authenticated'",
    );
    const cfg = (rows[0]?.rolconfig ?? null) as string[] | null;
    console.log(`✓ authenticated rolconfig: ${cfg ? cfg.join(" · ") : "(null)"}`);
    const hasWorkMem = Array.isArray(cfg) && cfg.some((s) => s.startsWith("work_mem="));
    const hasHashMult = Array.isArray(cfg) && cfg.some((s) => s.startsWith("hash_mem_multiplier="));
    if (!hasWorkMem || !hasHashMult) {
      throw new Error(
        `expected work_mem + hash_mem_multiplier on authenticated rolconfig, got: ${cfg ? cfg.join(" · ") : "(null)"}`,
      );
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
