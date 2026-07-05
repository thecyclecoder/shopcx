// apply-specs-related-spec-migration — add public.specs.related_spec (no-spec-parent: a fix-spec's LINK to
// an origin spec, so agents never abuse `parent` to reference a sibling spec). Idempotent. Run:
//   npx tsx scripts/apply-specs-related-spec-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260910140000_specs_related_spec.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name, data_type, is_nullable from information_schema.columns where table_name='specs' and column_name='related_spec'",
    );
    console.log(`✓ specs.related_spec:`, rows[0] ?? "(missing!)");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
