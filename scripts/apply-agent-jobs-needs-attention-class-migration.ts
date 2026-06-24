// apply-agent-jobs-needs-attention-class-migration — add agent_jobs.needs_attention_class so the
// auto-route-needs-attention routers (no-parked-specs-auto-route-needs-attention, Phase 0) can read
// the park reason. Additive + nullable + indexed. Idempotent.
//   npx tsx scripts/apply-agent-jobs-needs-attention-class-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260711120000_agent_jobs_needs_attention_class.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='agent_jobs' and column_name='needs_attention_class'",
    );
    console.log("✓ needs_attention_class column present:", rows.map((r) => r.column_name));
    const { rows: idx } = await c.query(
      "select indexname from pg_indexes where tablename='agent_jobs' and indexname='agent_jobs_needs_attention_class_idx'",
    );
    console.log("✓ index present:", idx.map((r) => r.indexname));
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
