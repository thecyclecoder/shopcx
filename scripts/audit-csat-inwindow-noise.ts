/**
 * Audit + stamp currently in-window CSAT-noise tickets.
 *
 * The CSAT cron now skips (and stamps `csat_sent_at`) tickets we never
 * actually answered — no customer-facing outbound, `do_not_reply`, or a
 * SKIP_TAGS tag (see src/lib/inngest/ticket-csat.ts). But tickets already
 * sitting in the 48h–7d window that match the new rule would still get one
 * last survey on the next tick before they age out. This one-off finds them
 * and stamps them skipped so the next cron tick doesn't survey them.
 *
 * Mirrors the cron's eligibility logic exactly.
 *
 * Dry-run by default — prints what it WOULD stamp. Pass --apply to write.
 *
 *   npx tsx scripts/audit-csat-inwindow-noise.ts            # dry run
 *   npx tsx scripts/audit-csat-inwindow-noise.ts --apply    # stamp them
 */
import { createAdminClient } from "./_bootstrap";
import { SKIP_TAGS } from "../src/lib/ticket-tags";

const CSAT_DELAY_HOURS = 48;
const CSAT_MAX_AGE_HOURS = 7 * 24;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();
  const now = Date.now();
  const oldestEligible = new Date(now - CSAT_DELAY_HOURS * 60 * 60 * 1000).toISOString();
  const tooOld = new Date(now - CSAT_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();

  // Same selection as the cron's find-due pass — the full in-window set.
  const { data: due, error } = await admin
    .from("tickets")
    .select("id, workspace_id, subject, do_not_reply, tags")
    .eq("status", "closed")
    .is("csat_sent_at", null)
    .not("customer_id", "is", null)
    .not("closed_at", "is", null)
    .gte("closed_at", tooOld)
    .lte("closed_at", oldestEligible)
    .order("closed_at", { ascending: true });

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  const ineligible: Array<{ id: string; subject: string | null; reason: string }> = [];
  for (const t of due || []) {
    const tags = (t.tags as string[] | null) || [];
    let reason: string | null = null;
    if (t.do_not_reply === true) reason = "do_not_reply";
    else if (tags.some(tag => SKIP_TAGS.has(tag))) reason = "skip_tag";
    else {
      const { count } = await admin
        .from("ticket_messages")
        .select("id", { count: "exact", head: true })
        .eq("ticket_id", t.id)
        .eq("direction", "outbound")
        .neq("visibility", "internal");
      if ((count ?? 0) === 0) reason = "no_customer_outbound";
    }
    if (reason) ineligible.push({ id: t.id, subject: t.subject, reason });
  }

  console.log(`In-window closed tickets scanned: ${(due || []).length}`);
  console.log(`Ineligible under new CSAT rule: ${ineligible.length}`);
  for (const t of ineligible) {
    console.log(`  ${t.id}  [${t.reason}]  ${(t.subject || "").slice(0, 70)}`);
  }

  if (!ineligible.length) {
    console.log("Nothing to stamp.");
    return;
  }

  if (!apply) {
    console.log("\nDry run — pass --apply to stamp these csat_sent_at = now().");
    return;
  }

  const ts = new Date().toISOString();
  const { error: updErr } = await admin
    .from("tickets")
    .update({ csat_sent_at: ts })
    .in("id", ineligible.map(t => t.id));
  if (updErr) {
    console.error("update failed:", updErr.message);
    process.exit(1);
  }
  console.log(`\nStamped ${ineligible.length} tickets csat_sent_at = ${ts}.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
