/**
 * One-time idempotent stale-sweep: clear escalation flags on resolved tickets.
 *
 * Escalation is an open-state concept — a ticket that is closed/resolved/archived
 * must NOT carry escalated_at/escalated_to/escalation_reason. The status-write
 * paths now clear these on close (see docs/brain/specs/clear-escalation-on-resolve.md),
 * but historical rows closed before that fix could still carry stale flags. They
 * would linger on the Escalated list (/dashboard/tickets/escalated) looking
 * unhandled. This sweep clears them across all workspaces.
 *
 * Idempotent + safe to re-run: it only touches rows that are terminal-status AND
 * still carry at least one escalation flag. As of 2026-06-21 the count is 0
 * (the original offender, 5965ee60, was cleared by hand) — this ships as a
 * future-proof safety net.
 *
 * Dry-run by default — prints what it WOULD clear. Pass --apply to write.
 *
 *   npx tsx scripts/sweep-stale-escalation-on-closed.ts            # dry run
 *   npx tsx scripts/sweep-stale-escalation-on-closed.ts --apply    # clear them
 */
import { createAdminClient } from "./_bootstrap";

const TERMINAL_STATUSES = ["closed", "resolved", "archived"];

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  // Terminal-status tickets that still carry an escalation flag. escalated_at is
  // the canonical "is escalated" marker, but we also catch rows where only
  // escalated_to / escalation_reason lingers, for completeness.
  const { data: stale, error } = await admin
    .from("tickets")
    .select("id, workspace_id, subject, status, escalated_at, escalated_to, escalation_reason")
    .in("status", TERMINAL_STATUSES)
    .or("escalated_at.not.is.null,escalated_to.not.is.null,escalation_reason.not.is.null")
    .order("escalated_at", { ascending: true });

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  const rows = stale || [];
  console.log(`Found ${rows.length} terminal-status ticket(s) still carrying escalation flags.`);
  for (const t of rows) {
    console.log(
      `  ${t.id}  [${t.status}]  ${(t.subject || "(no subject)").slice(0, 60)}  ` +
        `escalated_at=${t.escalated_at ?? "null"} escalated_to=${t.escalated_to ?? "null"}`
    );
  }

  if (rows.length === 0) {
    console.log("Nothing to clear — already clean.");
    return;
  }

  if (!apply) {
    console.log(`\nDry run — pass --apply to clear escalation flags on these ${rows.length} ticket(s).`);
    return;
  }

  let cleared = 0;
  for (const t of rows) {
    const { error: updErr } = await admin
      .from("tickets")
      .update({ escalated_at: null, escalated_to: null, escalation_reason: null })
      .eq("id", t.id);
    if (updErr) {
      console.error(`  failed ${t.id}: ${updErr.message}`);
    } else {
      cleared++;
    }
  }
  console.log(`\nCleared escalation flags on ${cleared}/${rows.length} ticket(s).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
