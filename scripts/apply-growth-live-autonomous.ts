// apply-growth-live-autonomous — flip Growth's function_autonomy flag to live + autonomous, the
// Phase-2 ACTIVATION switch for the growth-director-live-autonomous-cutover (M6 of goals/growth).
// Owner-confirmed; mirrors scripts/apply-platform-live-autonomous.ts.
//
// After this lands, approval-router resolveApprover routes growth-owned approvals to the Growth
// Director instead of the CEO, and the dormant guards on every surface from Phase 3 lift — the
// growth-director job becomes active in the box-worker poll, and the daily director-recap / grade
// rollup start producing real Growth data.
//
// Reversible — turn it back off from the Agents hub
// (POST /api/developer/agents/autonomy {function_slug:'growth', autonomous:false}) or re-run the
// platform-style upsert with autonomous=false. Idempotent (upsert on the function_slug PK).
//
// Pre-flight: run scripts/check-growth-cutover-ready.ts <WORKSPACE_ID> FIRST and confirm exit 0.
// Run against the pooler:
//   npx tsx scripts/apply-growth-live-autonomous.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(
      `insert into public.function_autonomy (function_slug, live, autonomous, updated_by, updated_at)
       values ('growth', true, true, 'ceo', now())
       on conflict (function_slug) do update
         set live = true,
             autonomous = true,
             updated_by = excluded.updated_by,
             updated_at = now()`,
    );
    const { rows } = await c.query(
      "select function_slug, live, autonomous, updated_by, updated_at from public.function_autonomy where function_slug = 'growth'",
    );
    console.log("✓ growth autonomy:", rows[0]);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
