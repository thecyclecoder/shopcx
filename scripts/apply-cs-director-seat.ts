// apply-cs-director-seat — scaffold the CS Director seat at the safest leash by applying the
// cs_director_function_autonomy_seed migration (cs-director-persona-and-org-placement spec, Phase 2).
//
// The `cs` function_autonomy row is already seeded at (live=false, autonomous=false) — that IS the
// safest leash. This apply-script runs the explicit scaffold migration that stamps the audit trail
// (updated_by + updated_at) so the ledger records why this row exists, then prints the row for
// verification. The migration is compare-and-set — it never demotes an already-activated director.
//
//   npx tsx scripts/apply-cs-director-seat.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260917120000_cs_director_function_autonomy_seed.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows } = await c.query(
      "select function_slug, live, autonomous, updated_by, updated_at from public.function_autonomy where function_slug = 'cs'",
    );
    if (rows.length !== 1) {
      throw new Error(`expected exactly 1 cs row, got ${rows.length}`);
    }
    const row = rows[0];
    const leash = row.live === false && row.autonomous === false ? "dormant (safest)" : `live=${row.live}, autonomous=${row.autonomous}`;
    console.log("✓ CS Director seat:", { ...row, leash });
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
