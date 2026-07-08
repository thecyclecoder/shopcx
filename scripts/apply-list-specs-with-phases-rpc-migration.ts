// apply-list-specs-with-phases-rpc-migration — create public.list_specs_with_phases(uuid, text)
// so listSpecs / getRoadmap can retire the client-side .in([spec_ids]) phase-batch fan-out.
//
// Phase 1 of docs/brain/specs/list-specs-with-phases-rpc-retire-in-array-client-join.md.
// Idempotent (DROP FUNCTION IF EXISTS + CREATE OR REPLACE + CREATE INDEX IF NOT EXISTS). Run against
// the pooler:
//   npx tsx scripts/apply-list-specs-with-phases-rpc-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261001120000_list_specs_with_phases_rpc.sql"];

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
          and proname = 'list_specs_with_phases'`,
    );
    if (fnRows.length !== 1) throw new Error(`expected 1 list_specs_with_phases function, found ${fnRows.length}`);
    const argsSig = String(fnRows[0].args);
    const resultSig = String(fnRows[0].result);
    if (!argsSig.includes("p_workspace_id uuid") || !argsSig.includes("p_scope text")) {
      throw new Error(`unexpected args signature: ${argsSig}`);
    }
    if (!/TABLE\(spec jsonb, phases jsonb\)/i.test(resultSig)) {
      throw new Error(`unexpected result signature: ${resultSig}`);
    }
    console.log(`✓ function public.list_specs_with_phases(${argsSig}) → ${resultSig}`);

    // Verify the supporting indexes.
    const { rows: idxRows } = await c.query(
      `select indexname from pg_indexes
        where schemaname = 'public'
          and (
            (tablename = 'specs'       and indexname = 'specs_ws_status_idx') or
            (tablename = 'spec_phases' and indexname = 'spec_phases_spec_position')
          )
        order by indexname`,
    );
    const idxNames = idxRows.map((r) => String(r.indexname));
    const need = ["spec_phases_spec_position", "specs_ws_status_idx"];
    for (const n of need) if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    console.log(`✓ indexes present: ${need.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
