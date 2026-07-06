// apply-action-handler-aliases — create the action_handler_aliases catalog + seed
// the observable global misses (docs/brain/specs/orchestrator-handler-alias-catalog-
// for-no-handler-misses.md, Phase 1). Idempotent (CREATE TABLE IF NOT EXISTS +
// INSERT … ON CONFLICT DO NOTHING against the partial-unique global index).
//   npx tsx scripts/apply-action-handler-aliases.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260917120000_action_handler_aliases.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows: tables } = await c.query(
      "select table_name from information_schema.tables where table_name = 'action_handler_aliases'",
    );
    console.log("✓ tables present:", tables.map((r) => r.table_name));

    const { rows: seeds } = await c.query(
      `select source_type, target_type, active from public.action_handler_aliases
       where workspace_id is null order by source_type`,
    );
    console.log(`✓ global seeds (${seeds.length}):`);
    for (const s of seeds) {
      console.log(`    ${s.source_type} → ${s.target_type}${s.active ? "" : " (inactive)"}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
