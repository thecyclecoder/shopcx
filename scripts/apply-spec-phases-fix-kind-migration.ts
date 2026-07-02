// apply-spec-phases-fix-kind-migration — add public.spec_phases.kind + origin_check_keys (fixes-as-phases).
// Idempotent (ADD COLUMN IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-spec-phases-fix-kind-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260808130000_spec_phases_fix_kind.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='spec_phases' and column_name in ('kind','origin_check_keys') order by column_name",
    );
    console.log(`✓ spec_phases columns present: ${rows.map((r: { column_name: string }) => r.column_name).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
