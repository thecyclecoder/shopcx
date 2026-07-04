// apply-lander-blueprints-build-spec-slug-migration — add the `build_spec_slug`
// linkback column to public.lander_blueprints (Phase 2 of
// docs/brain/specs/content-upload-and-lander-build.md — the deterministic verify +
// build-spec handoff to devops). Idempotent (ADD COLUMN IF NOT EXISTS + partial index).
// Run against the pooler:
//   npx tsx scripts/apply-lander-blueprints-build-spec-slug-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260907120000_lander_blueprints_build_spec_slug.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='lander_blueprints'
          and column_name='build_spec_slug'`,
    );
    if (cols.length !== 1) throw new Error("lander_blueprints.build_spec_slug missing after migration");
    if (cols[0].data_type !== "text") throw new Error(`lander_blueprints.build_spec_slug wrong data type ${cols[0].data_type}`);
    console.log(`✓ lander_blueprints.build_spec_slug present (${cols[0].data_type}, nullable=${cols[0].is_nullable})`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='lander_blueprints'
          and indexname='lander_blueprints_workspace_build_spec_slug_idx'`,
    );
    if (idx.length !== 1) throw new Error("lander_blueprints_workspace_build_spec_slug_idx missing after migration");
    console.log("✓ index lander_blueprints_workspace_build_spec_slug_idx present");
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
