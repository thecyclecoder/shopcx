// apply-list-spec-phase-anomalies-rpc-migration — create public.list_spec_phase_anomalies(uuid) so
// listSpecPhaseAnomalies (src/lib/specs-table.ts) can retire the residual `.in("id", specIds.slice(...))`
// batch loop that still marshals every phase's parent spec_id array client-side.
//
// Phase 1 of docs/brain/specs/retire-residual-in-array-batching-to-server-side-rpcs.md. Additive
// CREATE FUNCTION only — no schema/data change. Idempotent (DROP FUNCTION IF EXISTS + CREATE OR
// REPLACE). Run against the pooler:
//   npx tsx scripts/apply-list-spec-phase-anomalies-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261003120000_list_spec_phase_anomalies_rpc.sql"];

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
          and proname = 'list_spec_phase_anomalies'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 list_spec_phase_anomalies function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    const resultSig = String(fnRows[0].result);
    if (!argsSig.includes("p_workspace_id uuid")) {
      throw new Error(`unexpected args signature: ${argsSig}`);
    }
    if (!/TABLE\(kind text, phase_id uuid, spec_id uuid, "?position"? integer, status text, slug text, workspace_id uuid\)/i.test(resultSig)) {
      throw new Error(`unexpected result signature: ${resultSig}`);
    }
    console.log(`✓ function public.list_spec_phase_anomalies(${argsSig}) → ${resultSig}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
