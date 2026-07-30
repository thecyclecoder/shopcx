/**
 * One-off: CEO-directed full cash refund on Christine Wier's latest order
 * SC134613 ($257.83) — ticket dfa77b28-7ba0-4269-9455-953c94eded2b.
 *
 * The playbook stood firm on store-credit-only; the founder overrode it.
 * Full amount, no label deduction. refundOrder() stamps the two open
 * returns on this order as refunded, so the returns Inngest issue-refund
 * step can't double-pay when the package lands.
 */
import "./_bootstrap";
import { refundOrder } from "../src/lib/refund";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const ORDER_ID = "aa50de2c-fca7-4026-ba8a-c389d7de1e6d"; // SC134613
const AMOUNT_CENTS = 25783;
const TICKET_ID = "dfa77b28-7ba0-4269-9455-953c94eded2b";

async function main() {
  const res = await refundOrder(
    WS,
    ORDER_ID,
    AMOUNT_CENTS,
    "Founder-approved full cash refund — 9 months of renewal notices undeliverable (email shut down) + no login path to self-cancel",
    {
      source: "founder",
      customerId: "bb93794e-84d9-4ee1-b2ea-a79fb71c3c01",
      requestKey: `founder-full-refund-${TICKET_ID}-SC134613`,
      eventProperties: { ticket_id: TICKET_ID, order_number: "SC134613", tier: "founder_override" },
    },
  );
  console.log(JSON.stringify(res, null, 2));
  if (!res.success) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
