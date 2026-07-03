// apply-research-urls-classification-gates-migration — widen public.research_urls.classification
// CHECK to include 'excluded' + 'checkout' (rhea-research-automation Phase 2). Idempotent.
// Run against the pooler:
//   npx tsx scripts/apply-research-urls-classification-gates-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260814120000_research_urls_classification_gates.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    // Verify the CHECK now accepts the new values by inspecting the constraint expression.
    const { rows } = await c.query(
      `select pg_get_constraintdef(oid) as def
         from pg_constraint
        where conname = 'research_urls_classification_check'`,
    );
    if (!rows.length) throw new Error("research_urls_classification_check missing after migration");
    const def = rows[0].def as string;
    for (const v of ["excluded", "checkout"]) {
      if (!def.includes(`'${v}'`)) throw new Error(`CHECK missing '${v}': ${def}`);
    }
    console.log(`✓ research_urls_classification_check widened: ${def}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
