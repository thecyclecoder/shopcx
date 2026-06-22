// apply-agent-jobs-chain-phases-migration — add public.agent_jobs.chain_phases
// (build-all-phases-chain Phase 1 — the "Build all" chain flag). Idempotent (ADD COLUMN IF NOT EXISTS).
// Run against the pooler:
//   npx tsx scripts/apply-agent-jobs-chain-phases-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260622200000_agent_jobs_chain_phases.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='agent_jobs' and column_name='chain_phases'",
    );
    console.log(`✓ agent_jobs.chain_phases column present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
