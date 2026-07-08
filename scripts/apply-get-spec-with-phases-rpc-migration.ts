// apply-get-spec-with-phases-rpc-migration — create public.get_spec_with_phases(uuid, text)
// so specs-table.getSpec can collapse the two-round-trip .from() reads into a single pooled RPC.
//
// Phase 2 of docs/brain/specs/cut-internal-egress-pooler-and-spec-rpcs.md.
// Idempotent (DROP FUNCTION IF EXISTS + CREATE OR REPLACE). Run against the pooler:
//   npx tsx scripts/apply-get-spec-with-phases-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261004120000_get_spec_with_phases_rpc.sql"];

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
          and proname = 'get_spec_with_phases'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 get_spec_with_phases function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    const resultSig = String(fnRows[0].result);
    if (!argsSig.includes("p_workspace_id uuid") || !argsSig.includes("p_slug text")) {
      throw new Error(`unexpected args signature: ${argsSig}`);
    }
    if (!/TABLE\(spec jsonb, phases jsonb\)/i.test(resultSig)) {
      throw new Error(`unexpected result signature: ${resultSig}`);
    }
    console.log(`✓ function public.get_spec_with_phases(${argsSig}) → ${resultSig}`);

    // Verify the supporting indexes the RPC's read plan relies on.
    const { rows: idxRows } = await c.query(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and (
            (tablename = 'specs'       and indexname = 'specs_ws_slug') or
            (tablename = 'spec_phases' and indexname = 'spec_phases_spec_position')
          )
        order by indexname`,
    );
    const idxNames = idxRows.map((r) => String(r.indexname));
    const need = ["spec_phases_spec_position", "specs_ws_slug"];
    for (const n of need) if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    console.log(`✓ indexes present: ${need.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
