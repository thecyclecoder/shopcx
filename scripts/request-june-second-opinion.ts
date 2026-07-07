/**
 * Request an on-demand June second-opinion review of an escalated ticket.
 *
 * Phase 2 of june-review-replaces-solver-skeptic-quorum-triage: the default triage is a single
 * June review (Phase 1). This script is the on-demand exception — a supervisor calls it when a
 * June verdict is genuinely borderline and wants EXACTLY ONE fresh second review of the same
 * ticket. Enforced by `enqueueJuneSecondOpinion` (src/lib/cs-director-second-opinion.ts):
 *   - prior june_review exists,
 *   - no prior second_opinion,
 *   - no inflight cs-director-call for the ticket.
 *
 * Usage: `npx tsx scripts/request-june-second-opinion.ts <ticket_id>`
 *
 * The script prints the enqueue outcome and exits non-zero on any guard miss so a caller (a
 * batch script, a dashboard-side wrapper) can react. It NEVER mutates anything else — only the
 * agent_jobs row lands. The box worker's cs-director-call lane picks the row up next tick.
 */
import { createAdminClient } from "./_bootstrap";
import { enqueueJuneSecondOpinion } from "../src/lib/cs-director-second-opinion";

async function main() {
  const ticketId = process.argv[2];
  if (!ticketId) {
    console.error("Usage: npx tsx scripts/request-june-second-opinion.ts <ticket_id>");
    process.exit(2);
  }

  const admin = createAdminClient();
  const result = await enqueueJuneSecondOpinion(admin, ticketId);
  if (!result.ok) {
    console.error(`refused: ${result.reason}${result.detail ? ` — ${result.detail}` : ""}`);
    process.exit(1);
  }
  console.log(
    `ok — cs-director-call job ${result.job_id} queued (second opinion of triage_run ${result.first_run_id})`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
