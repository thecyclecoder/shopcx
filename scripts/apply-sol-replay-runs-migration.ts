// apply-sol-replay-runs-migration — create public.sol_replay_runs (audit-trail
// table for pre-Sol shadow-baseline replays). Phase 4 of
// docs/brain/specs/sol-cost-csat-measurement-vs-pre-sol-baseline.md.
// Idempotent (CREATE TABLE / CREATE INDEX IF NOT EXISTS + DO-guarded policies).
// Run against the pooler:
//   npx tsx scripts/apply-sol-replay-runs-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20260929120001_sol_replay_runs.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='sol_replay_runs'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("sol_replay_runs table missing after migration");
    console.log(`✓ sol_replay_runs has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const need = ["id", "workspace_id", "run_at", "sample_size", "window_start", "window_end", "results", "total_estimated_cents"];
    const got = new Set(cols.map((c) => c.column_name));
    for (const n of need) {
      if (!got.has(n)) throw new Error(`sol_replay_runs.${n} missing after migration`);
    }

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='sol_replay_runs'`,
    );
    if (!idx.some((r) => r.indexname === "idx_sol_replay_runs_ws_run_at")) {
      throw new Error("idx_sol_replay_runs_ws_run_at missing after migration");
    }
    console.log(`✓ idx_sol_replay_runs_ws_run_at present`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
