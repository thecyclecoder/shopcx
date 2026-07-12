// apply-kill-switch-enforce-claim-migration — create public.node_ancestry + rewrite
// public.claim_agent_job with the kill-switch cascade guard + add public.claim_agent_job_diag
// ([[claim-rpc-kill-switch-enforcement]] Phase 1). Idempotent (CREATE TABLE IF NOT EXISTS +
// CREATE OR REPLACE FUNCTION, seeded empty — the box worker + node-ancestry-sync-cron populate
// public.node_ancestry). Run against the pooler:
//   npx tsx scripts/apply-kill-switch-enforce-claim-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261014000000_kill_switch_enforce_claim.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: tables } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='node_ancestry'",
    );
    console.log(`✓ node_ancestry table present: ${tables[0].n === 1}`);

    const { rows: fns } = await c.query(
      `select proname
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('kind_to_node_id','claim_agent_job','claim_agent_job_diag')
        order by proname`,
    );
    console.log(`✓ functions present: ${fns.map((r: { proname: string }) => r.proname).join(", ")}`);

    const { rows: seed } = await c.query("select count(*)::int as n from public.node_ancestry");
    console.log(`✓ node_ancestry seeded rows (expect 0 — box worker syncs on next startup): ${seed[0].n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
