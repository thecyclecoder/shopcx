// apply-approval-decisions-migration — create public.approval_decisions (platform-director-agent /
// approval-routing-engine audit ledger: one row per routed-approval decision a director or the CEO
// makes — every autonomous auto-approval + every escalation, with reasoning). Idempotent (CREATE TABLE
// / INDEX IF NOT EXISTS · DROP/CREATE POLICY). Run against the pooler:
//   npx tsx scripts/apply-approval-decisions-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260703120000_approval_decisions.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='approval_decisions'",
    );
    console.log(`✓ approval_decisions table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
