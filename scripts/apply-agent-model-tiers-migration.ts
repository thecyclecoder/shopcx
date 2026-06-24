// apply-agent-model-tiers-migration — create public.agent_model_tiers (box-agent-model-tiers
// Phase 1: the per-agent model-tier registry — one row per (workspace_id, agent_kind) mapping a
// kind → haiku｜sonnet｜opus, nullable = the Max default). Idempotent (CREATE TABLE IF NOT EXISTS
// + CREATE INDEX IF NOT EXISTS + drop/create policy). Run against the pooler:
//   npx tsx scripts/apply-agent-model-tiers-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260706170000_agent_model_tiers.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.tables where table_name='agent_model_tiers'",
    );
    console.log(`✓ agent_model_tiers table present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
