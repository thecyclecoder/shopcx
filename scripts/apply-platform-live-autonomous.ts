// apply-platform-live-autonomous — flip Platform's function_autonomy flag to live + autonomous, the
// Phase-4 ACTIVATION switch for the Platform/DevOps Director (platform-director-agent). Owner-confirmed.
//
// After this lands, approval-router resolveApprover routes platform-owned approvals to the director
// instead of the CEO, and the dormant machinery goes live: the approval enqueuer + auto-approval (P1),
// the goal escort (P2), the loop-guard + CEO escalation (P3), and the daily board watch update (P4).
// Reversible — turn it back off from the Agents hub (POST /api/developer/agents/autonomy) or re-run this
// with live/autonomous set to false. Idempotent (upsert on the function_slug PK). Run against the pooler:
//   npx tsx scripts/apply-platform-live-autonomous.ts
import { pgClient } from "./_bootstrap";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(
      `insert into public.function_autonomy (function_slug, live, autonomous, updated_by, updated_at)
       values ('platform', true, true, 'platform-director-agent P4 activation', now())
       on conflict (function_slug) do update
         set live = true,
             autonomous = true,
             updated_by = excluded.updated_by,
             updated_at = now()`,
    );
    const { rows } = await c.query(
      "select function_slug, live, autonomous, updated_by from public.function_autonomy where function_slug = 'platform'",
    );
    console.log("✓ platform autonomy:", rows[0]);
  } finally {
    await c.end();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
