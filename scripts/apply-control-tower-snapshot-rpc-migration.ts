// apply-control-tower-snapshot-rpc-migration — create public.control_tower_snapshot(uuid)
// so the Control Tower API route can consolidate ~10-15 per-tick DB SELECTs into ONE round trip.
//
// Phase 3 of docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md.
// Idempotent (DROP FUNCTION IF EXISTS + CREATE OR REPLACE + GRANT). Run against the pooler:
//   npx tsx scripts/apply-control-tower-snapshot-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261005120000_control_tower_snapshot_rpc.sql"];

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
          and proname = 'control_tower_snapshot'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 control_tower_snapshot function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    const resultSig = String(fnRows[0].result);
    if (!argsSig.includes("p_workspace_id uuid")) {
      throw new Error(`unexpected args signature: ${argsSig}`);
    }
    if (!/jsonb/i.test(resultSig)) {
      throw new Error(`unexpected result signature: ${resultSig}`);
    }
    console.log(`✓ function public.control_tower_snapshot(${argsSig}) → ${resultSig}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
