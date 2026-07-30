import { createAdminClient } from "./_bootstrap";
import { sendThreadedReply } from "../src/lib/tickets-reply";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "dfa77b28-7ba0-4269-9455-953c94eded2b";

const MESSAGE = [
  "Christine, your refund is done. I've issued the full $257.83 back to the card you paid with for order SC134613 — no store credit, and nothing deducted for the return label.",
  "Depending on your bank it should post within 5 to 10 business days.",
  "Your subscription is cancelled, so there will be no further charges. The return label is already paid for, so send the box back whenever it's convenient — your refund isn't waiting on it.",
  "Julie at Superfoods Company",
].join("\n\n");

async function main() {
  const admin = createAdminClient();
  const res = await sendThreadedReply(admin, { workspaceId: WS, ticketId: TICKET_ID, message: MESSAGE });
  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
