// apply-storefront-lever-memory-migration — create the storefront lever-importance model +
// CRO-learnings memory tables (storefront-lever-importance-memory spec, M2):
//   storefront_levers           — the canonical chapter→component lever taxonomy + CRO priors
//   storefront_lever_importance — the learned posterior per (lever × product × lander_type × audience)
// Idempotent (CREATE TABLE / INDEX / POLICY IF NOT EXISTS, ON CONFLICT DO NOTHING seed). Run against the pooler:
//   npx tsx scripts/apply-storefront-lever-memory-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260624120000_storefront_levers.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    for (const table of ["storefront_levers", "storefront_lever_importance"]) {
      const { rows } = await c.query(
        "select count(*)::int as n from information_schema.columns where table_schema='public' and table_name=$1",
        [table],
      );
      console.log(`✓ public.${table} has ${rows[0].n} columns`);
    }
    const { rows: levers } = await c.query(
      "select chapter, lever_key, prior from public.storefront_levers order by prior desc, chapter, lever_key",
    );
    console.log(`✓ seeded ${levers.length} levers (top: ${levers.slice(0, 3).map((r) => `${r.lever_key}=${r.prior}`).join(", ")})`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
