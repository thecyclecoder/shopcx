/**
 * Applies 20261128120000_agent_jobs_ws_created_at_idx.sql — creates the
 * (workspace_id, created_at DESC) index that serves the workspace-scoped recent-jobs read path.
 *
 * Idempotent (create index if not exists). Also the ship-time apply so the before/after EXPLAIN can be
 * measured immediately rather than waiting for control-tower's applyMergedMigrations on merge.
 */
import { pgClient } from "./_bootstrap";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    const sql = readFileSync(
      resolve(__dirname, "../supabase/migrations/20261128120000_agent_jobs_ws_created_at_idx.sql"),
      "utf8",
    );
    await c.query(sql);
    const idx = await c.query(
      `select indexname from pg_indexes where schemaname='public' and tablename='agent_jobs'
         and indexname='agent_jobs_ws_created_at_idx'`,
    );
    console.log("✓ migration applied; index present:", idx.rows.length === 1);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
