// apply-roadmap-rollups-rpc-migration — create public.roadmap_latest_build_signals(uuid) +
// public.roadmap_latest_status_transitions(uuid) so brain-roadmap.ts can retire the slug-batched
// full-table scans of agent_jobs (kind='build', limit 2000) and spec_status_history (field='status',
// limit 5000) that were the cause of the slow roadmap page load.
//
// Phase 3 of docs/brain/specs/list-specs-with-phases-rpc-retire-in-array-client-join.md. Idempotent
// (DROP FUNCTION IF EXISTS + CREATE OR REPLACE + CREATE INDEX IF NOT EXISTS). Run against the pooler:
//   npx tsx scripts/apply-roadmap-rollups-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261002120000_roadmap_rollups_rpc.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }

    // Verify both functions exist with the expected signatures.
    const { rows: fnRows } = await c.query(
      `select proname,
              pg_get_function_identity_arguments(oid) as args,
              pg_get_function_result(oid)             as result
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname in ('roadmap_latest_build_signals','roadmap_latest_status_transitions')
        order by proname`,
    );
    const byName = new Map<string, { args: string; result: string }>();
    for (const r of fnRows) byName.set(String(r.proname), { args: String(r.args), result: String(r.result) });
    const expectBuild = { args: "p_workspace_id uuid", result: /TABLE\(spec_slug text, status text, preview_url text\)/i };
    const expectStatus = { args: "p_workspace_id uuid", result: /TABLE\(spec_slug text, to_value text\)/i };
    const b = byName.get("roadmap_latest_build_signals");
    if (!b) throw new Error("roadmap_latest_build_signals missing after migration");
    if (b.args !== expectBuild.args) throw new Error(`build_signals args mismatch: ${b.args}`);
    if (!expectBuild.result.test(b.result)) throw new Error(`build_signals result mismatch: ${b.result}`);
    console.log(`✓ public.roadmap_latest_build_signals(${b.args}) → ${b.result}`);
    const s = byName.get("roadmap_latest_status_transitions");
    if (!s) throw new Error("roadmap_latest_status_transitions missing after migration");
    if (s.args !== expectStatus.args) throw new Error(`status_transitions args mismatch: ${s.args}`);
    if (!expectStatus.result.test(s.result)) throw new Error(`status_transitions result mismatch: ${s.result}`);
    console.log(`✓ public.roadmap_latest_status_transitions(${s.args}) → ${s.result}`);

    const { rows: idxRows } = await c.query(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and (
            (tablename = 'agent_jobs'          and indexname = 'agent_jobs_slug_idx') or
            (tablename = 'spec_status_history' and indexname = 'spec_status_history_slug_at')
          )
        order by indexname`,
    );
    const idxNames = idxRows.map((r) => String(r.indexname));
    const need = ["agent_jobs_slug_idx", "spec_status_history_slug_at"];
    for (const n of need) if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    console.log(`✓ indexes present: ${need.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
