// apply-dunning-payday-retry-count-migration — add dunning_cycles.payday_retry_count so the
// payday-retry cron can enforce MAX_PAYDAY_RETRIES. Idempotent (ADD COLUMN IF NOT EXISTS).
//   npx tsx scripts/apply-dunning-payday-retry-count-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261222120000_dunning_cycles_payday_retry_count.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const f of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", f), "utf8"));
      console.log(`✓ applied ${f}`);
    }
    const { rows } = await c.query(
      "select count(*)::int n from information_schema.columns where table_name='dunning_cycles' and column_name='payday_retry_count'",
    );
    console.log(`✓ dunning_cycles.payday_retry_count present: ${rows[0].n === 1}`);
    const { rows: r } = await c.query(
      "select count(*)::int retrying from public.dunning_cycles where status='retrying'",
    );
    console.log(`✓ ${r[0].retrying} cycle(s) in 'retrying' — each now capped at 4 further attempts`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
