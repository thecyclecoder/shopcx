/** Applies 20261203120000_agent_jobs_broadcast.sql — broadcast triggers on agent_jobs/roadmap_chats/
 *  worker_heartbeats → box:<ws> topic + the realtime.messages policy. Idempotent. */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
async function main() {
  const c = pgClient(); await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations/20261203120000_agent_jobs_broadcast.sql"), "utf8"));
    const trg = await c.query(`select tgname from pg_trigger where tgname in ('agent_jobs_broadcast_trg','roadmap_chats_broadcast_trg','worker_heartbeats_broadcast_trg') and not tgisinternal order by 1`);
    const pol = await c.query(`select 1 from pg_policies where schemaname='realtime' and tablename='messages' and policyname='box_broadcast_read'`);
    console.log("✓ triggers:", trg.rows.map((r:any)=>r.tgname).join(", "));
    console.log("✓ realtime.messages policy:", pol.rows.length===1);
  } finally { await c.end(); }
}
main().catch((e)=>{console.error(e);process.exit(1);});
