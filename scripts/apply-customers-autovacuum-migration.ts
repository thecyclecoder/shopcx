// apply-customers-autovacuum-migration — owner-approval-only tune of the per-table autovacuum
// settings on `public.customers`, plus a one-off `VACUUM (ANALYZE)` to clear the current bloat.
// DB Health Agent signature `dbhealth:bloat:customers`; see docs/brain/recipes/db-vacuum-tune-customers.md.
//
// NEVER auto-run by the build worker (mirrors docs/brain/libraries/db-health.md § North star).
// Owner reviews the migration + this script in the PR, then executes here after merge:
//   npx tsx scripts/apply-customers-autovacuum-migration.ts
//
// Two-step: (1) apply the reloptions migration inside the pool connection; (2) VACUUM (ANALYZE)
// public.customers as its own statement — VACUUM cannot run inside a transaction, so it is issued
// separately after the ALTER TABLE.
//
// Idempotent — ALTER TABLE ... SET (reloptions) is safe to re-apply (a re-run just re-sets the
// same values), and VACUUM (ANALYZE) is safe to re-run (it is not destructive; NO DATA IS DELETED).
// Rollback (reverses ONLY the reloptions — the one-off VACUUM's reclaim is already durable):
//   alter table public.customers reset (
//     autovacuum_vacuum_scale_factor,
//     autovacuum_analyze_scale_factor,
//     autovacuum_vacuum_threshold
//   );
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260819120000_customers_autovacuum_scale_factor.sql";

const EXPECTED_RELOPTIONS: Record<string, string> = {
  autovacuum_vacuum_scale_factor: "0.05",
  autovacuum_analyze_scale_factor: "0.02",
  autovacuum_vacuum_threshold: "1000",
};

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8");
    await c.query(sql);
    console.log(`✓ applied ${MIGRATION}`);

    // Verify the per-table reloptions landed as expected. `pg_class.reloptions` is a text[] of
    // `key=value` strings; a missing entry means the ALTER TABLE didn't stick.
    const { rows: relRows } = await c.query(
      `select reloptions
         from pg_class
        where relname = 'customers'
          and relnamespace = 'public'::regnamespace`,
    );
    const reloptions = ((relRows[0]?.reloptions ?? []) as string[]) ?? [];
    console.log(`✓ customers reloptions: ${reloptions.length ? reloptions.join(" · ") : "(null)"}`);
    for (const [key, value] of Object.entries(EXPECTED_RELOPTIONS)) {
      const expected = `${key}=${value}`;
      if (!reloptions.includes(expected)) {
        throw new Error(
          `expected reloption ${expected} on public.customers, got: ${reloptions.length ? reloptions.join(" · ") : "(null)"}`,
        );
      }
    }

    // The one-off VACUUM (ANALYZE) — clears the current dead-tuple backlog + refreshes planner
    // stats so the DB Health Agent's next bloat pass sees a fresh `last_autovacuum` + a
    // sub-threshold `n_dead_tup / (n_live_tup + n_dead_tup)`. VACUUM cannot run inside a
    // transaction block; the pg driver sends this as its own message.
    console.log(`… running VACUUM (ANALYZE) public.customers — clears current bloat, no rows deleted`);
    await c.query(`VACUUM (ANALYZE) public.customers`);
    console.log(`✓ VACUUM (ANALYZE) public.customers complete`);

    // Show the post-VACUUM dead-tuple picture so the operator sees the state the next DB Health
    // Agent pass will read — a sanity check that the fix actually cleared the flagged signature.
    const { rows: statRows } = await c.query(
      `select n_live_tup, n_dead_tup, last_autovacuum, last_analyze
         from pg_stat_user_tables
        where schemaname = 'public'
          and relname = 'customers'`,
    );
    const stat = statRows[0] as
      | { n_live_tup: number | string; n_dead_tup: number | string; last_autovacuum: string | null; last_analyze: string | null }
      | undefined;
    if (stat) {
      const live = Number(stat.n_live_tup) || 0;
      const dead = Number(stat.n_dead_tup) || 0;
      const total = live + dead;
      const ratio = total > 0 ? dead / total : 0;
      console.log(
        `✓ post-VACUUM stats: live=${live.toLocaleString()} dead=${dead.toLocaleString()} ` +
          `dead_ratio=${(ratio * 100).toFixed(2)}% last_autovacuum=${stat.last_autovacuum ?? "(null)"} ` +
          `last_analyze=${stat.last_analyze ?? "(null)"}`,
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
