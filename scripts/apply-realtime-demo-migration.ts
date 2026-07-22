/**
 * Applies 20261129120000_realtime_demo_table.sql — the Realtime verification table + publication add.
 * Idempotent (create table if not exists, guarded policies + publication add, empty-guard seed).
 */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(
      resolve(__dirname, "../supabase/migrations/20261129120000_realtime_demo_table.sql"),
      "utf8",
    );
    await c.query(sql);

    const inPub = await c.query(
      `select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='realtime_demo'`,
    );
    const seeded = await c.query(`select count(*)::int n from public.realtime_demo`);
    console.log("✓ migration applied");
    console.log("  in supabase_realtime publication:", inPub.rows.length === 1);
    console.log("  seed rows:", seeded.rows[0].n);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
