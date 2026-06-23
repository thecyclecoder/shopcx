// apply-director-messages-migration — create public.director_messages (directors-board-gamified Phase 1:
// the board store behind the gamified #directors board's Messages tab). Idempotent
// (CREATE TABLE / INDEX IF NOT EXISTS · DROP/CREATE POLICY). Run against the pooler:
//   npx tsx scripts/apply-director-messages-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260701120000_director_messages.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='director_messages'",
    );
    console.log(`✓ director_messages table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
