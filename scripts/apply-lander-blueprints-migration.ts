// apply-lander-blueprints-migration — create public.lander_blueprints (Cleo's teardown →
// build-new blueprint entity). Phase 1 of docs/brain/specs/cleo-lander-blueprint.md.
// Idempotent (create table if not exists / check constraints / RLS guarded).
// Run against the pooler:
//   npx tsx scripts/apply-lander-blueprints-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260816120000_lander_blueprints.sql"];

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
        order by ordinal_position`,
    );
    const wanted = new Set([
      "id",
      "workspace_id",
      "product_id",
      "research_url_id",
      "funnel_type",
      "skeleton",
      "status",
      "rationale",
      "content",
      "created_by",
      "created_at",
      "updated_at",
    ]);
    const have = new Set(cols.map((r) => r.column_name));
    for (const w of wanted) {
      if (!have.has(w)) throw new Error(`lander_blueprints.${w} missing after migration`);
    }
    console.log(`✓ lander_blueprints has ${cols.length} columns (${[...wanted].sort().join(", ")})`);

    for (const idx of [
      "lander_blueprints_workspace_product_idx",
      "lander_blueprints_workspace_status_idx",
      "lander_blueprints_workspace_research_url_idx",
    ]) {
      const { rows } = await c.query(
        `select indexname from pg_indexes
          where schemaname='public' and tablename='lander_blueprints' and indexname=$1`,
        [idx],
      );
      if (rows.length !== 1) throw new Error(`index ${idx} missing after migration`);
      console.log(`✓ index ${idx} present`);
    }

    for (const pol of ["lander_blueprints_select", "lander_blueprints_service"]) {
      const { rows } = await c.query(
        `select policyname from pg_policies
          where schemaname='public' and tablename='lander_blueprints' and policyname=$1`,
        [pol],
      );
      if (rows.length !== 1) throw new Error(`policy ${pol} missing after migration`);
      console.log(`✓ policy ${pol} present`);
    }
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
