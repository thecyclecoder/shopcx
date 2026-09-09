// apply-dunning-closed-reason-migration — add dunning_cycles.closed_reason and move the
// subscription_* values out of terminal_error_code. Idempotent.
//   npx tsx scripts/apply-dunning-closed-reason-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261223120000_dunning_cycles_closed_reason.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const f of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", f), "utf8"));
      console.log(`✓ applied ${f}`);
    }
    const { rows } = await c.query(
      `select count(*)::int with_closed_reason,
              count(*) filter (where terminal_error_code like 'subscription_%')::int leftover
       from public.dunning_cycles`);
    console.log(`✓ closed_reason set on ${rows[0].with_closed_reason} row(s); leftover in terminal_error_code: ${rows[0].leftover}`);
  } finally { await c.end(); }
}
main().catch((e) => { console.error(e); process.exit(1); });
