// apply-deploy-watches-migration — create the deploy_watches table (the Deploy Guardian's deploy-watch
// store) for docs/brain/specs/deploy-health-rollback-guardian.md Phase 1. One row per auto-merged
// claude/<slug> deploy; a minute-cadence cron evaluates each over its canary window → a healthy |
// regressed | unsure verdict. Idempotent (CREATE … IF NOT EXISTS).
//   npx tsx scripts/apply-deploy-watches-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260705170000_deploy_watches.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name = 'deploy_watches' order by ordinal_position",
    );
    console.log("✓ deploy_watches columns:", rows.map((r) => r.column_name).join(", "));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
