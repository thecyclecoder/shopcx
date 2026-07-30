/**
 * One-off — the customer-facing reply on ticket 5ed394f3 (Jim Leone) after the SC133086 refund
 * landed. Answers both of his asks: the refund, and whether SC134983 shipped. Goes through the
 * tickets-reply SDK (threaded delivery), never a raw insert. Dry-run unless --apply.
 */
import { createAdminClient } from "./_bootstrap";
import { sendThreadedReply } from "../src/lib/tickets-reply";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET = "5ed394f3-3af2-45ce-9bd3-857bb11b99aa";
const APPLY = process.argv.includes("--apply");

const message = [
  "Your refund went through today, Jim. $139.84 is back on your card for order SC133086 — that's the balance after the $89.42 pricing adjustment already refunded on June 21, so the full $229.26 you paid is now returned.",
  "Your bank should show it within 5 to 10 business days.",
  "That refund should have processed automatically when your return scanned back to us on July 3. It didn't, and that one is on us — thank you for following up.",
  "On your normal order SC134983 from July 18: it hasn't shipped yet, so there's no tracking number to send you. You'll get a tracking email the moment it leaves our warehouse.",
  "Suzie, Customer Support at Superfoods Company",
].join("\n\n");

async function main() {
  console.log(APPLY ? "SENDING:\n" : "DRY RUN — would send:\n");
  console.log(message);
  if (!APPLY) return;
  const admin = createAdminClient();
  const res = await sendThreadedReply(admin, { workspaceId: WS, ticketId: TICKET, message });
  console.log("\nresult:", JSON.stringify(res));
}
main().catch((e) => { console.error(e); process.exit(1); });
