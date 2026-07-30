/**
 * One-off — close + de-escalate ticket 5ed394f3 (Jim Leone) after the CEO ruling was executed:
 * $139.84 refunded on SC133086, return 36a20358 stamped refunded, customer replied. Founder-
 * authorized 2026-07-20. Goes through the tickets-mutate SDK, never a raw update.
 */
import { createAdminClient } from "./_bootstrap";
import { closeTicket } from "../src/lib/tickets-mutate";

const TICKET = "5ed394f3-3af2-45ce-9bd3-857bb11b99aa";

async function main() {
  const admin = createAdminClient();
  await closeTicket(admin, TICKET, {
    reason:
      "CEO ruling executed: $139.84 refunded on SC133086 (the remaining balance after the $89.42 Jun-21 grandfathered-pricing refund), return 36a20358 stamped refunded, customer replied re: refund + SC134983 still processing.",
  });
  const { data } = await admin
    .from("tickets")
    .select("status, escalated_to, escalated_at, closed_at, escalation_reason")
    .eq("id", TICKET)
    .maybeSingle();
  console.log(JSON.stringify(data, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
