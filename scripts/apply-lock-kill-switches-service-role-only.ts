// apply-lock-kill-switches-service-role-only — Phase 3 (Fix 1) of
// [[monitor-cadence-scaled-liveness-window]]. Drops the broad
// `for select to authenticated` policies on public.kill_switches and
// public.node_ancestry so only the service_role policy grants direct table
// access. Run against the pooler:
//   npx tsx scripts/apply-lock-kill-switches-service-role-only.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261016000000_lock_kill_switches_service_role_only.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select tablename, policyname from pg_policies where schemaname='public' and tablename in ('kill_switches','node_ancestry') order by tablename, policyname",
    );
    console.log("remaining policies:", rows);
    const bad = rows.filter((r) => r.policyname === "kill_switches_select" || r.policyname === "node_ancestry_select");
    if (bad.length) {
      console.error("✗ authenticated SELECT policy still present:", bad);
      process.exit(1);
    }
    console.log("✓ kill_switches + node_ancestry now service_role-only");
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
