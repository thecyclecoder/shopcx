// apply-logistics-director-function-autonomy-seed-migration — seed the dormant `logistics` row
// in public.function_autonomy so Marco's read-only seat shows up in the Agents hub at the safest
// leash. marco-logistics-director-seat Phase 3. Compare-and-set on the audit stamps —
// never overwrites a CEO-flipped-live row. Idempotent.
//
// Run against the pooler:
//   npx tsx scripts/apply-logistics-director-function-autonomy-seed-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261016130000_logistics_director_function_autonomy_seed.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select function_slug, live, autonomous, updated_by from public.function_autonomy where function_slug='logistics'",
    );
    if (rows.length !== 1) {
      console.error(`✗ expected 1 row for logistics, got ${rows.length}`);
      process.exit(1);
    }
    console.log(`✓ logistics function_autonomy row: live=${rows[0].live} autonomous=${rows[0].autonomous} updated_by=${JSON.stringify(rows[0].updated_by)}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
