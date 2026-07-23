/** Applies 20261202120000_realtime_demo_broadcast.sql — the broadcast trigger + realtime.messages policy.
 *  Idempotent (create or replace fn, drop/create trigger, guarded policy). */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20261202120000_realtime_demo_broadcast.sql"), "utf8");
    await c.query(sql);
    const trg = await c.query(`select 1 from pg_trigger where tgname='realtime_demo_broadcast_trg' and not tgisinternal`);
    const pol = await c.query(`select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='realtime_demo_broadcast_read'`);
    console.log("✓ applied — trigger:", trg.rows.length===1, "| realtime.messages policy:", pol.rows.length===1);
  } finally { await c.end(); }
}
main().catch((e)=>{console.error(e);process.exit(1);});
