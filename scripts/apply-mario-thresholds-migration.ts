// apply-mario-thresholds-migration — create public.mario_thresholds, seed the M3
// default SLA rows for every workspace, and install the two RLS policies so
// Mario has its self-owned threshold vocabulary in place. Additive; idempotent
// (unique constraint on (workspace_id, from_event, to_event) makes the seed a
// no-op on re-run).
//   npx tsx scripts/apply-mario-thresholds-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20261004120000_mario_thresholds.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='mario_thresholds' order by ordinal_position",
    );
    console.log(
      "✓ columns present:",
      rows.map((r) => r.column_name),
    );
    const seeded = await c.query(
      "select workspace_id, from_event, to_event, sla_ms from public.mario_thresholds order by workspace_id, from_event, to_event",
    );
    console.log(`✓ seeded rows: ${seeded.rows.length}`);
    for (const r of seeded.rows) {
      console.log(`  ${r.workspace_id}  ${r.from_event} → ${r.to_event}  sla_ms=${r.sla_ms}`);
    }
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
