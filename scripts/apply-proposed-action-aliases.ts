// apply-proposed-action-aliases — create the proposed_action_aliases review queue
// (docs/brain/specs/orchestrator-handler-alias-catalog-for-no-handler-misses.md,
// Phase 2). Idempotent (CREATE TABLE IF NOT EXISTS + partial unique).
//   npx tsx scripts/apply-proposed-action-aliases.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260918120000_proposed_action_aliases.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name = 'proposed_action_aliases'",
    );
    console.log("✓ tables present:", rows.map((r) => r.table_name));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
