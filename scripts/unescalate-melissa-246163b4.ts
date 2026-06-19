/**
 * Ticket 246163b4 — Melissa Sachs. The auto-analyzer silently re-opened +
 * escalated this positively-closed ticket with reason "customer threat
 * language (score 9)" — a false positive: her email reply quoted our own
 * "Join our Facebook group!" footer, and the threat scan substring-matched
 * "facebook" in the quoted history. Analyzer fixed to scan cleaned bodies;
 * revert this ticket to its correct state (closed, unescalated). The
 * escalation was silent (no customer message), so no reply is needed.
 *
 * Dry-run by default. Pass --apply to mutate.
 */
import { createAdminClient } from "./_bootstrap";

const TICKET = "246163b4-becc-4e1a-ba3c-da222d524ed5";
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data: before } = await admin.from("tickets")
    .select("status, escalated_to, escalated_at, escalation_reason, assigned_to, closed_at").eq("id", TICKET).single();
  console.log(`=== ${APPLY ? "APPLY" : "DRY RUN"} — Melissa 246163b4 ===`);
  console.log("BEFORE:", JSON.stringify(before));

  if (!APPLY) {
    console.log("\nWould set: status=closed, escalation cleared, assigned_to=null. Re-run with --apply.");
    return;
  }

  // Restore the positive-close state (it was closed at 12:27 before the
  // 12:30 false escalation). Keep the original closed_at if present.
  const { error } = await admin.from("tickets").update({
    status: "closed",
    escalated_to: null,
    escalated_at: null,
    escalation_reason: null,
    assigned_to: null,
    closed_at: before?.closed_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET);
  if (error) throw new Error(`update failed: ${error.message}`);

  await admin.from("ticket_messages").insert({
    ticket_id: TICKET, direction: "outbound", visibility: "internal", author_type: "system",
    body: "[Correction] Reverted false auto-escalation (\"customer threat language\") — the threat scan matched \"facebook\" in the quoted order-confirmation footer, not the customer's text. Analyzer fixed to scan cleaned bodies. Ticket restored to its positive close.",
  });

  const { data: after } = await admin.from("tickets")
    .select("status, escalated_to, assigned_to, escalation_reason, closed_at").eq("id", TICKET).single();
  console.log("AFTER:", JSON.stringify(after));
}
main().then(() => process.exit(0)).catch((e) => { console.error("✗", e); process.exit(1); });
