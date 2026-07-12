// apply-spec-phase-check-executable-migration — add `exec_kind` + `params` columns to
// public.spec_phase_checks (machine-declared-verification Phase 1). Additive + idempotent.
// Run against the pooler:
//   npx tsx scripts/apply-spec-phase-check-executable-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261013120000_spec_phase_check_executable.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows: cols } = await c.query(
      `select column_name
         from information_schema.columns
        where table_schema='public'
          and table_name='spec_phase_checks'
          and column_name in ('exec_kind','params')
        order by column_name`,
    );
    console.log(
      `→ spec_phase_checks now carries: ${cols.map((r: { column_name: string }) => r.column_name).join(", ")}`,
    );
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
