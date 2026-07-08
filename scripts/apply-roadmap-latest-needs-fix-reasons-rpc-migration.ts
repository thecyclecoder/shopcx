// apply-roadmap-latest-needs-fix-reasons-rpc-migration — create
// public.roadmap_latest_needs_fix_reasons(uuid) so readNeedsFixReasons (src/lib/brain-roadmap.ts)
// can retire the residual `inSpecSlugChunks` .in("spec_slug", …) batching — the third and last
// per-slug brain-roadmap reader still marshalling a slug array over the wire.
//
// Phase 2 of docs/brain/specs/retire-residual-in-array-batching-to-server-side-rpcs.md. Additive
// CREATE FUNCTION only — no schema/data change. Idempotent (DROP FUNCTION IF EXISTS + CREATE OR
// REPLACE + CREATE INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-roadmap-latest-needs-fix-reasons-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261003130000_roadmap_latest_needs_fix_reasons_rpc.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    // Verify the function exists with the expected signature.
    const { rows: fnRows } = await c.query(
      `select pg_get_function_identity_arguments(oid) as args,
              pg_get_function_result(oid)             as result
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = 'roadmap_latest_needs_fix_reasons'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 roadmap_latest_needs_fix_reasons function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    const resultSig = String(fnRows[0].result);
    if (!argsSig.includes("p_workspace_id uuid")) {
      throw new Error(`unexpected args signature: ${argsSig}`);
    }
    if (!/TABLE\(spec_slug text, reason text, metadata jsonb\)/i.test(resultSig)) {
      throw new Error(`unexpected result signature: ${resultSig}`);
    }
    console.log(`✓ function public.roadmap_latest_needs_fix_reasons(${argsSig}) → ${resultSig}`);

    // Verify the supporting index (matches the shape of agent_jobs_slug_idx / spec_status_history_slug_at).
    const { rows: idxRows } = await c.query(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and tablename = 'director_activity'
          and indexname = 'director_activity_ws_slug_created_idx'`,
    );
    if (!idxRows.length) throw new Error("index director_activity_ws_slug_created_idx missing after migration");
    console.log(`✓ index director_activity_ws_slug_created_idx present`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
